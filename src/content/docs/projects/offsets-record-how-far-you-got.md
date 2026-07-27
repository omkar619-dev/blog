---
title: 'Offsets record how far you got, not what you handled'
description: My Kafka consumer had a comment saying a failed message would be retried later. It wouldn't. Because a commit means "done through here", skipping one bad message and succeeding on the next silently erases the failure forever — in the component whose entire job was preventing data loss.
---

I was building the durability layer for my Go chat project. Messages get dual-written: to Redis for live delivery, and to a Kafka topic as the durable log. A separate `persister` process consumes that topic and writes each message into Postgres, so history survives a page refresh.

I wrote it carefully. I chose at-least-once semantics deliberately, I wrote a comment explaining the choice, and I proved it worked with a fault-injection test. And there was still a silent data-loss bug in it — in the exact component whose only job was to not lose data.

## The design I was pleased with

The `kafka-go` reader gives you two ways to consume. The simple one, `ReadMessage`, reads a message and marks it done in a single call. I deliberately didn't use it:

```go
msg, err := consumer.Fetch(ctx)   // FetchMessage — read, but DON'T mark done
// ... insert into Postgres ...
consumer.Commit(ctx, msg)         // CommitMessages — only now, mark done
```

The reasoning is the standard at-least-once argument, and I still think it's right:

| Order | Crash in between | Result |
|---|---|---|
| mark-done, then store | message marked handled, never stored | **lost** (at-most-once) |
| store, then mark-done | message stored, not marked | **duplicate** on restart (at-least-once) |

For durable storage, losing a message is unacceptable and a rare duplicate is tolerable. So: store first, commit second. I verified it by killing the persister mid-stream, sending two messages while it was dead, and restarting it — both drained from the committed offset. Zero loss.

That test passed. It just didn't test the case that was broken.

## The comment that was wrong

Here's the error path I wrote:

```go
if _, err := queries.CreateMessage(ctx, params); err != nil {
    log.Printf("insert (room %d): %v — leaving uncommitted to retry", m.RoomID, err)
    continue // do NOT commit: a restart re-processes this message
}
```

The intent reads fine: *insert failed, don't commit, we'll get it next time.* Both halves of that sentence are wrong.

**Wrong half one: `continue` doesn't retry the message.** It goes back to the top of the loop and calls `Fetch` again — which returns **the next** message, not the failed one. Within a single process run, that message is simply skipped.

**Wrong half two, and this is the real bug: the later commit erases it.** `CommitMessages(msg)` does not commit *"this specific message"*. It commits **`msg.Offset + 1`** — a single number meaning *"I am done through here."* So:

| Offset | What happens | Committed offset |
|---|---|---|
| 5 | insert **fails** → `continue`, no commit | still 5 |
| 6 | insert succeeds → commit | **7** |

Committing 7 means "done through 6". On restart the consumer resumes at 7. **Message 5 is never read again by anyone, ever.** Not delayed — gone. And nothing anywhere reports it, because from Kafka's point of view the consumer said it was finished.

The library card doesn't list which pages you read. It records **how far** you got. Skip page 5, finish page 6, write "read through 6" on the card, and page 5 has left your life.

## Why my fault-injection test missed it

Because I tested the wrong failure. I killed the **whole process** — which leaves the offset uncommitted at exactly the right place, so everything after it replays cleanly. That's the failure mode the design handles beautifully.

The broken case is a **single message failing while the process stays alive**: a transient database error, a constraint violation, a malformed row. The consumer keeps running, keeps committing, and quietly walks over the corpse.

Process-level failures are the ones you think to test, because they're dramatic and easy to cause. Per-message failures are the ones that actually happen in production, and they're the ones I hadn't simulated.

## The fix: never advance past a failure

If a commit means "done through here," then you cannot move on from a message you haven't finished. The loop has to stay put:

```go
stored := false
for attempt := 1; !stored; attempt++ {
    _, err := queries.CreateMessage(ctx, params)
    if err == nil {
        stored = true
        break
    }
    wait := broker.Backoff(attempt)   // 1s, 2s, 4s, 8s, 16s, capped at 30s
    log.Printf("insert attempt %d: %v — retrying in %s", attempt, err, wait)
    select {
    case <-ctx.Done():
        return   // shutting down; message stays uncommitted, correctly
    case <-time.After(wait):
    }
}
consumer.Commit(ctx, msg)
```

Two details worth noting. The **exponential backoff** exists so that a struggling database isn't hammered every 10ms by a consumer that's already failing — retry storms turn blips into outages. And the `select` on `ctx.Done()` means a shutdown mid-retry exits **without committing**, which is exactly right: the message stays on the log for the next process to pick up.

## The tradeoff I accepted, out loud

This introduces **head-of-line blocking**. A message that can *never* succeed — a genuine constraint violation, say — will block its partition forever, retrying every 30 seconds until someone notices.

That's a real cost, and I chose it knowingly: **blocking loudly beats losing silently.** A stalled consumer shows up in monitoring within minutes. A message deleted by an off-by-one in offset arithmetic shows up never.

The production answer is a bounded retry count plus a **dead-letter topic** — try N times, then move the poison message aside and continue. I haven't built that yet, and the honest reason is that I don't have monitoring good enough to notice a DLQ filling up, so a queue that stalls visibly is currently a better failure mode than one that quietly diverts.

## The part that surprised me: three consumers, three different contracts

I now have three consumer groups on the same topic, and the fix above is **not** right for all of them:

| Consumer | On failure | Why |
|---|---|---|
| `persister` → Postgres history | retry forever | must never lose a message |
| `indexer` → embeddings | retry forever | must never lose a message |
| `bot` → RAG replies | log it, commit, move on | best-effort |

The bot commits **whether or not it answered**. Giving it the persister's retry-forever behaviour would mean a model outage wedges the bot on one message indefinitely, blocking every other room. A missed bot reply is an annoyance; a jammed consumer is an outage.

That looked inconsistent until I could say *why*: **the reliability contract belongs to the consumer, not to the log.** One durable stream, three readers, three different answers to "what does failure mean here" — chosen per consumer based on what the data is worth. That's a feature of the log-based design, not a wart.

## The lesson

The bug wasn't in my understanding of at-least-once delivery. I had that right, I'd reasoned about it explicitly, and the happy path was correct.

The bug was in a mental model of what a commit *is*. I was picturing an acknowledgement attached to a message — "this one's handled" — when it's actually a **watermark**: a single integer per partition meaning "everything below this is done." Once you hold that model, the failure is obvious: a watermark can only move forward, so anything you step over is behind it permanently.

Two things I'd generalise:

1. **A comment describing behaviour you haven't tested is a guess with good handwriting.** Mine said "leaving uncommitted to retry" with real confidence. Writing it down made it feel verified.
2. **Test per-item failures, not just process failures.** Killing the process is the easy fault to inject and the one your design probably survives. The failure that hurts is one item going wrong while everything else keeps working — because that's the path where your error handling actually runs.
