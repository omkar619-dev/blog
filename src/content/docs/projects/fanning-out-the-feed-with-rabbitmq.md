---
title: Fanning Out the Feed — the RabbitMQ Worker
description: The schema post promised this one — the background worker that actually delivers a post to every follower's feed. Why POST /posts publishes an event and returns instantly, how durable queues plus manual ack/nack buy at-least-once delivery, and why that makes idempotency non-negotiable.
---

In the [schema post](/projects/designing-news-feed-schema/) I designed the feed around one table — `timelines`, one row per *(person who should see this post, post)* — and chose **fan-out-on-write**: when you post, push a reference into every follower's timeline so the feed read stays a single cheap index scan. Then I waved at the hard part and said it *"gets its own post."* This is that post: the worker that actually does the fan-out, and the delivery guarantees that make it trustworthy.

## Why this can't happen in the request

Fan-out-on-write has an ugly number hiding in it. If you post and 50,000 people follow you, "deliver this post" means **50,000 inserts** into `timelines`. If I did that inside the `POST /posts` request, the user creating the post would sit there staring at a spinner while we wrote 50,000 rows — and a celebrity with millions of followers would time out entirely. **The cost of a post can't scale with the author's follower count on the hot path.**

So the request must do the *minimum* and hand the slow work to something else. That "something else" is a **message queue** and a **background worker**.

The mental model I keep is a restaurant. The **waiter** (the web handler) takes your order, scribbles a ticket, slaps it on the rail, and immediately walks off to serve the next table — they never stand at the table waiting for the food to cook. The **cook** (the worker) works through the tickets on the rail at their own pace. The **rail** is the queue. That's the whole architecture: the waiter stays fast no matter how backed-up the kitchen is.

## The producer: publish a tiny event, return instantly

When a post is created, the web handler publishes one small message to RabbitMQ and returns `201` right away:

```go
type PostCreatedEvent struct {
    PostID   int64 `json:"post_id"`
    AuthorID int64 `json:"author_id"`
}
```

Notice how *small* that is — two ids, not the whole post. The event is a **notification that something happened**, not a copy of the data. The worker re-fetches whatever it needs from Postgres, which stays the single source of truth. (Fat messages drift out of sync with the database and bloat the broker; a thin "this happened, go look" event never lies.)

Publishing it is the instant operation the waiter does:

```go
c.ch.PublishWithContext(ctx, "", "post.fanout", false, false, amqp.Publishing{
    ContentType:  "application/json",
    Body:         body,
    DeliveryMode: amqp.Persistent, // write the message to disk → survives a broker restart
})
```

## The queue: durable *and* persistent, which are two different things

There's a subtlety here that's easy to get half-right. To survive a RabbitMQ restart you need **both**:

```go
// durable=true → the queue DEFINITION survives a broker restart
ch.QueueDeclare("post.fanout", true, false, false, false, nil)
```
```go
DeliveryMode: amqp.Persistent       // the MESSAGES inside it survive too
```

A durable queue with non-persistent messages comes back **empty** after a crash — the mailbox survives but the letters are gone. Persistent messages in a non-durable queue lose the whole queue. You need the pair: the queue *and* its contents both written to disk. Miss either and a broker restart silently drops in-flight events.

## The worker: one handler, two jobs, two different criticalities

The worker (`cmd/worker`, a separate binary) consumes those events and runs a handler for each one. It does two things — and the interesting design call is that **they don't get the same retry policy**, because they aren't equally important:

```go
handler := func(evt mq.PostCreatedEvent) error {
    // (A) FAN-OUT — the critical job
    isCeleb, _ := queries.IsCelebrity(ctx, evt.AuthorID)
    if isCeleb {
        // celebrity: DON'T fan out (that's the write-storm). Merge in at read time.
        slog.Info("skipped fan-out (celebrity)", "post_id", evt.PostID)
    } else if err := queries.FanOutPostToFollowers(ctx, ...); err != nil {
        return err            // ← critical: fail the message so it RETRIES
    }

    // (B) EMBEDDING — best-effort
    post, err := queries.GetPostByID(ctx, evt.PostID)
    if err != nil { return nil }               // ← give up, but ACK
    vec, err := embedder.Embed(ctx, post.Content)
    if err != nil { return nil }               // ← Ollama flaky? don't block the queue
    queries.UpsertPostEmbedding(ctx, ...)
    return nil
}
```

- **Fan-out is critical.** If it fails, the post never reaches a single follower's feed — that's the entire feature broken. So on failure the handler `return err`, which (as we'll see) puts the message back on the queue to retry until it works.
- **Embedding is best-effort.** A post without an embedding is merely invisible to *semantic search* — recoverable later by a backfill, and not the end of the world. So if Ollama is flaky, the handler logs it and `return nil` (acknowledges anyway) rather than wedging the whole queue behind one slow model call.

That split — *not every side-effect in a handler deserves the same retry policy* — is a genuinely senior instinct. Retrying everything forever turns one flaky dependency into a stuck pipeline.

And the **celebrity skip** is the schema post's celebrity problem, finally handled: an account over the follower threshold *doesn't* fan out (no write storm); its posts get merged into feeds at read time instead. The worker is where that decision lives.

## At-least-once delivery, and why it forces idempotency

Here's the core guarantee. The worker consumes with **manual acknowledgement** — it tells RabbitMQ "I'm done with this message" only *after* the handler succeeds:

```go
msgs, _ := ch.Consume("post.fanout", "", false /* autoAck OFF */, ...)
for msg := range msgs {
    var evt PostCreatedEvent
    if err := json.Unmarshal(msg.Body, &evt); err != nil {
        msg.Nack(false, false)   // unparseable → drop it (don't requeue a poison message)
        continue
    }
    if err := handler(evt); err != nil {
        msg.Nack(false, true)    // handler failed → REQUEUE, try again later
        continue
    }
    msg.Ack(false)              // success → remove it from the queue
}
```

Three outcomes: success → **ack** (gone). Handler error → **nack + requeue** (try again). Unparseable garbage → **nack, no requeue** (drop it, or it loops forever as a "poison message"). Because a message is only removed *after* success, nothing is lost if the worker crashes mid-handler — RabbitMQ redelivers it.

But that safety has a price, and it's the most important sentence in this post: **a message can be delivered more than once.** Worker crashes after fan-out but before ack? The message comes back and the handler runs *again*. This is **at-least-once delivery** — never zero, sometimes two.

Which means every effect in the handler **must be idempotent** — safe to run twice. And it is, by design:

```sql
-- fan-out: inserting the same (follower, post) twice is a no-op, not an error
INSERT INTO timelines (user_id, post_id)
SELECT follower_id, $1 FROM follows WHERE followee_id = $2
ON CONFLICT DO NOTHING;
```

The embedding write is an `UPSERT` for the same reason — re-embedding a post just overwrites the identical vector. Run the handler once or five times, the database lands in the same state. **At-least-once delivery is only safe because the consumer is idempotent** — the two are a matched pair, and you can't have one without the other.

## The unglamorous bit: don't crash because the broker is still booting

One real-world wrinkle that bit me: RabbitMQ takes ~30 seconds to become ready after `docker compose up`, so the very first connection attempt fails with a transient handshake error. The naive code `log.Fatal`s and the whole service dies on a dependency that's *slow*, not broken. The fix is a retry loop on startup:

```go
for attempt := 1; attempt <= 20; attempt++ {
    conn, err := amqp.Dial(url)
    if err == nil { return conn }
    time.Sleep(2 * time.Second)   // ride over the broker's boot window
}
```

Twenty tries, two seconds apart — enough to cover the cold start. Small thing, but "don't fall over because a healthy dependency was briefly slow" is the difference between a service that boots reliably and one that needs babysitting.

## The honest caveats

- **Ordering isn't guaranteed across retries.** A requeued message can be processed after a later one. For fan-out it doesn't matter (timelines order by `inserted_at`), but it's a real property to know before you rely on event order.
- **A poison message** that fails *parsing* I drop; but a message that always fails the *handler* would requeue forever. A production setup adds a dead-letter queue after N attempts. I haven't — known gap.
- **And the big one, which is the whole next post:** look back at the producer. The web handler creates the post (commits to Postgres) and *then* publishes the event — **two systems, no shared transaction.** If the process dies in the gap between the commit and the publish, the post exists but the event never goes out: a ghost post, fanned out to nobody, searchable by no one. At-least-once only protects a message *once it's on the queue*. Getting it *onto* the queue reliably is a different problem — the **dual-write** problem — and it's exactly what the [transactional outbox](/projects/the-dual-write-bug-and-the-outbox/) fixes.

## The lesson

The feed read got fast because the feed *write* got moved off the hot path: publish a thin event, return, let a worker do the heavy lifting. The guarantee that makes the worker trustworthy is **at-least-once delivery via manual ack/nack** — and the tax it charges is that **every consumer must be idempotent.** Get that pair right and a crashing, restarting, retrying worker still converges to the correct feed. Get it wrong and retries quietly corrupt it.

Next, the leak in the producer: making sure the event reaches the queue in the first place. Every decision lands in the [repo](https://github.com/omkar619-dev/news-feed-go) as an ADR.
