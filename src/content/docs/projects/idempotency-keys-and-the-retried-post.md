---
title: Idempotency Keys — Stopping a Retried POST From Posting Twice
description: A client posts, the server saves it and replies 201 — then the response is lost on the way back. The client retries, and now there are two posts. Here's why POST isn't safe to retry, and how an idempotency key plus one unique constraint makes it so.
---

The [outbox post](/projects/the-dual-write-bug-and-the-outbox/) closed one reliability gap: making sure a post's event can't be lost *after* the post is created. This one closes a different gap on the other side of the request — making sure the post isn't created **twice**. Same theme (*a write should survive a crash or a retry*), different boundary.

## The bug you'll never see in your own logs

A client sends `POST /posts`. The server creates the post, commits, sends back `201 Created`. Then the response is lost on the way home — flaky mobile network, a timeout, the app gets backgrounded mid-flight. From the client's side, **a lost response and a real failure look identical** — both are just "no answer." So a well-written client does the sensible thing and **retries**. And now there are two identical posts, and nothing in your logs looks wrong: two valid requests, two `201`s.

The root cause: **`POST` isn't idempotent.** Every `POST /posts` creates a *new* resource, so sending it twice creates two. (Contrast `GET`, `PUT`, `DELETE` — idempotent by definition: doing them twice lands you in the same state. `POST` is the dangerous verb, and "the response got lost" is the everyday way it bites.)

## The fix: a ticket the client brings back

Borrow the idea from a coat check. You hand over your coat, you get ticket #42. Come back, hand the clerk #42, and they return *the same coat* — they don't go find a second identical one.

An **idempotency key** is that ticket. The client generates a unique key (a UUID) for each *logical* operation and sends it in a header:

```
Idempotency-Key: ef3415be-7f16-4ad2-a22e-b5fb8531be3e
```

On a retry it sends the **same** key. The server remembers `key → response`: first time, do the work and store the result; every time after, replay the stored result and create nothing. The create happens **at most once**, no matter how many times the client retries. (This is exactly how Stripe stops a retried "charge ₹500" from billing your card twice — the canonical example, and a good one to name in an interview.)

## Where it stores — and the part that's actually clever

A table keyed by `(user, key)`:

```sql
CREATE TABLE idempotency_keys (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    response_status INT NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
);
```

Scoping the key per user means one user's key can't collide with another's. But that composite primary key is doing double duty, and the second job is the clever one. Here's the handler, stripped down — the key insert happens **in the same transaction as the post**:

```go
tx, _ := pool.Begin(ctx)
defer tx.Rollback(ctx)              // a no-op once we commit
q := sqlc.New(tx)

post, _ := q.CreatePost(ctx, ...)                  // (1)
body, _ := json.Marshal(post)
err := q.InsertIdempotencyKey(ctx, userID, key, 201, body)   // (2) same tx
if isUniqueViolation(err) {         // 23505 — someone already used this key
    tx.Rollback(ctx)                // ← undoes the post TOO (same transaction)
    return replayStoredResponse(userID, key)
}
tx.Commit(ctx)                      // post + key become durable together
```

Now the nasty case: the client double-fires and **two identical requests hit the server at the same instant.** Both pass the "have I seen this key?" check (neither has committed yet). Both try to insert the post and the key. But the key's unique constraint means **only one can win** — the second `InsertIdempotencyKey` hits a `23505` unique violation. And because that insert is in the *same transaction* as the post, the rollback throws away **everything**, including the post the loser was creating. The loser then replays the winner's stored response. Two simultaneous retries, **exactly one post.**

That's the whole trick, and it's worth saying slowly: **the shared transaction binds the post's fate to the uniqueness check.** If you recorded the key as a separate step *after* committing the post, the post would already exist and you'd have your duplicate. The atomicity is what makes it safe. (Same lesson as my signup handler: let the database's unique constraint be the source of truth, not a check-then-act — which always has a race.)

## Fast path vs. correctness

Two layers, and it matters which does what:

- A quick read up front — *"seen this key? replay it"* — handles the common case (an ordinary retry) without even opening a transaction. This is **only an optimization.**
- The **unique constraint inside the transaction** is the **correctness guarantee.** It catches the race the fast-path read can miss (two requests both read "not seen," both proceed). Never lean on the read alone — the constraint is what actually holds the line.

## The honest caveats

- **I don't fingerprint the body.** Strictly, if a client reuses a key with a *different* body, that's a client bug, and the textbook move is to store a hash of the request and return `422` on mismatch. I store the response, not a request hash — a known gap.
- **The table grows forever** without a sweeper. Keys are only useful for a short retry window (minutes), so production expires them with a TTL or a periodic delete. I haven't built the reaper yet — bounded and known, not silent.
- **It's at-most-once for the *create*.** If the first request dies *after* commit but before the bytes reach the client, the retry gets the stored response — which is exactly the point.
- A generic middleware is the alternative for many endpoints; I did it inline because folding the key insert into the post's transaction is what buys the *atomic* dedup, and a middleware can't easily share that transaction.

## The lesson

A write has three boundaries where it can go wrong, and each needs its own fix: the **consumer** (make it idempotent, so redelivery is harmless), the **producer** (the [outbox](/projects/the-dual-write-bug-and-the-outbox/), so the event can't be lost), and the **client** (idempotency keys, so a retry can't duplicate). One idea runs under all three — *the database constraint is the source of truth, and "at-least-once + idempotent" is the contract that makes retries safe instead of dangerous.*

It's all in the [repo](https://github.com/omkar619-dev/news-feed-go) — the table, the transactional handler, and the `Idempotency-Replayed` header it sets on a replay.
