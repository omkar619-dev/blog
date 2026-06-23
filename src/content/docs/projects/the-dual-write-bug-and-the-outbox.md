---
title: The Dual-Write Bug Hiding in My Post Handler — and the Transactional Outbox
description: Creating a post wrote to Postgres, then published to RabbitMQ — two systems, no shared transaction. A crash in the two-line gap between them silently lost the event. Here's the bug, the pattern that makes it impossible, and the live crash test that proved it.
---

There was a bug in my `POST /posts` handler for months, and I'd even left a comment admitting it: *"the post is already committed; if publishing fails we just log it… known gap."* It's one of the most ordinary bugs in backend work — so ordinary it has a name, the **dual-write problem** — and the fix is a pattern worth knowing cold: the **transactional outbox**. This post is the bug, the fix, and the crash test where I killed the relay mid-flight to prove an event couldn't be lost.

(Builds on the feed's [async fan-out](/projects/fanning-out-the-feed-with-rabbitmq/): when you post, the web request doesn't fan the post out to every follower inline — it drops a `post.created` event on RabbitMQ and a background worker does the slow fan-out and embedding. This post is about making sure that event is *never lost*.)

## The two-line bug

Here's what creating a post used to do, stripped to its bones:

```go
post, _ := db.CreatePost(ctx, ...)        // (1) INSERT → commits to Postgres
publisher.PublishPostCreated(ctx, event)  // (2) send event to RabbitMQ
```

Read those two lines as what they are: **two writes to two completely separate systems, with nothing tying them together.** Postgres commits at line (1). RabbitMQ receives at line (2). And in the gap between them, anything can happen:

- **The process dies between (1) and (2).** The post is committed and sitting in Postgres — but the event was never sent. The worker never fans it out (it never reaches a single follower's timeline) and never embeds it (**it's invisible to semantic search**). The post exists as a ghost. Silently. Nobody errors.
- **RabbitMQ is briefly down at (2).** `PublishPostCreated` returns an error, my handler hits its `log.Printf`, shrugs, and returns `201 Created` to the user. Same outcome: post saved, event gone.

The insidious part is that **the user sees success either way.** They posted, they got a 201, the post is in the database. The only symptom is that their post quietly never shows up in anyone's feed — and there's no error anywhere to tell you why.

## Why you can't just wrap it in a transaction

The obvious instinct: *"put both writes in one transaction."* You can't. A database transaction is a guarantee Postgres makes about **its own** writes. RabbitMQ is a different process on the other side of a network socket — there's no transaction that spans a database *and* a message broker. (Distributed transactions / two-phase commit technically exist, but they're slow, operationally heavy, and broadly avoided for exactly this kind of thing.)

So that's the dual-write problem in one sentence: **any time you must write to two independent systems and keep them consistent, a crash in the gap leaves them out of sync, and you have no single transaction to lean on.**

## The trick: the only thing you *can* make atomic

Here's the move. The one thing you can absolutely make atomic is **two writes to the same database in one transaction.** So stop trying to write to two systems at once. Write the event as a **row in your own database**, in the *same transaction* as the post:

```sql
CREATE TABLE outbox (
    id           BIGSERIAL PRIMARY KEY,
    event_type   TEXT NOT NULL,
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ            -- NULL = not yet published
);
```

And the new handler — the post **and** the event commit together, or neither does:

```go
tx, _ := pool.Begin(ctx)
defer tx.Rollback(ctx)            // a no-op once we've committed; safe to always defer
q := sqlc.New(tx)                 // queries bound to THIS transaction

post, _ := q.CreatePost(ctx, ...)                       // (1)
payload, _ := json.Marshal(PostCreatedEvent{post.ID, userID})
q.InsertOutboxEvent(ctx, "post.created", payload)       // (2) — same tx

tx.Commit(ctx)   // post + event become durable TOGETHER: both, or neither
```

That's the whole idea. There is now **no possible state** where a post exists without its event, or an event exists without its post. If the process dies before `Commit`, the deferred `Rollback` throws both away. The gap is gone — not patched, *gone* — because there's only one write now, to one system, under one transaction.

A small but real wrinkle worth flagging: this handler now takes the `*pgxpool.Pool`, not the `Querier` interface I pass everywhere else — because *starting a transaction* needs the concrete pool, not the interface. That's the honest trade-off of transaction logic, and it's exactly the pressure that pushes people toward a repository layer. I kept it inline for clarity.

## The relay: getting it from the table to the broker

Of course the event still has to reach RabbitMQ eventually. That's a **separate process — the relay** — and its only job is to drain the outbox:

```sql
-- the relay claims a batch of pending events
SELECT id, event_type, payload
FROM outbox
WHERE published_at IS NULL
ORDER BY id
LIMIT 50
FOR UPDATE SKIP LOCKED;
```

```
loop:
  begin tx
  rows ← fetch pending (query above)
  for each row:
      publish to RabbitMQ
      UPDATE outbox SET published_at = NOW() WHERE id = row.id
  commit
  sleep briefly if there was nothing to do
```

Two details carry the weight here:

- **`FOR UPDATE SKIP LOCKED`** locks the rows this relay claims and *skips* any rows another relay already holds. That one clause means I can run **several relays in parallel** and no two of them will ever grab the same event. (It's also the cleanest job-queue trick Postgres gives you — worth memorising.)
- **At-least-once, on purpose.** If the relay publishes a row but dies *before* the `UPDATE`, that row is still `published_at IS NULL`, so next loop it gets published **again**. The event can arrive twice. That's fine — because my worker is **idempotent**: fan-out is `INSERT … ON CONFLICT DO NOTHING`, embedding is an upsert. A duplicate event does no harm. This is the contract the whole pattern rests on: *the producer guarantees at-least-once; the consumer must be idempotent.*

## I tested it by killing the relay mid-flight

A pattern you can't see is a pattern you don't trust, so I ran the failure on purpose:

1. **Relay up**, create a post → its outbox row's `published_at` flips from `NULL` to a timestamp within about a second. Normal path.
2. **Stop the relay**, create another post → the row sits at `published_at = NULL`. **Parked, not lost.** This is the exact moment that used to vanish into thin air — now it's a durable row waiting patiently.
3. **Restart the relay** → within a second it drains the backlog and stamps `published_at`. The event *survived the outage*, and the post got fanned out and embedded as if nothing had happened.

That row sitting at `NULL` through a deliberate outage, then publishing itself the moment the relay came back, is the entire value of the pattern made visible in one column.

## A bonus I didn't expect: the web tier stopped talking to the broker

Once posts publish via the outbox, my API handler has **no reason to touch RabbitMQ at all** — it only writes to Postgres. So I deleted the broker connection from the web service entirely. The web tier now depends on exactly one thing (the database), the relay and worker own everything message-broker-shaped, and the API even boots fine when RabbitMQ is down. Decoupling that falls out for free is the nicest kind.

## The honest caveats

- **At-least-once, not exactly-once.** Duplicates *will* happen; the design only works because consumers are idempotent. If yours aren't, the outbox alone won't save you.
- **A little latency.** Events go out on the relay's next poll, not the instant you post. For async fan-out and embedding — already background work — that's invisible. For something a user waits on, tune the interval.
- **Polling has a ceiling.** A relay doing `SELECT … WHERE published_at IS NULL` every second is simple and perfect at my scale. At serious throughput you'd switch to **Change Data Capture** (e.g. Debezium tailing the Postgres write-ahead log) so you stop polling and start streaming — same pattern, fancier plumbing. Knowing the upgrade path matters more than building it early.
- My relay holds the transaction open while it publishes the batch — fine at low volume, the first thing I'd revisit under load.

## The lesson

The bug was never exotic. It's the most common shape of silent data loss there is: **write two systems, hope both succeed, get unlucky once.** The transactional outbox turns that hope into a guarantee by collapsing the two writes into one local transaction plus a relay — and it asks for exactly one thing in return: **idempotent consumers**, so an at-least-once duplicate is a shrug instead of a corruption.

If you ever catch yourself writing "save to the DB, *then* tell the other system" — stop. That word *then* is the gap, and the gap is where your events go to die.

It's all in the [repo](https://github.com/omkar619-dev/news-feed-go) — the `outbox` table, the transactional handler, and `cmd/relay`.
