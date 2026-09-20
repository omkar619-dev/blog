---
title: "A dead consumer can't report its own lag"
description: I wanted to know when a Kafka consumer stopped keeping up, so I had each consumer publish its own lag. The library refused. That refusal turned out to be the correct answer to a question I'd asked the wrong way round — and when I fixed it, the metric immediately found a consumer that had been doing nothing for hours.
---

A few weeks ago my chat project's persister — the process that copies messages out of Kafka into Postgres — wasn't running. For several hours. Nothing told me.

Not the gateway, not the browser, no error anywhere. The gateway's promise is *"this message reached Kafka"*, and it kept that promise perfectly. Whether anything **consumed** the message is a separate guarantee, and nothing in the system was watching it.

It surfaced much later as a completely unrelated-looking symptom: *"my messages disappear when I switch rooms."* History replay reads Postgres, Postgres is filled by the persister, so an idle persister looks exactly like lost messages. Nothing was lost — it all drained out of Kafka the instant the persister came back. But I'd spent the intervening time looking at the replay code.

So: export consumer lag. The gap between the newest offset in a partition and the last offset a consumer group has committed. One number that catches both a consumer that has died and one that is merely too slow.

I wrote it the obvious way.

## The library said no

Each consumer already holds a `kafka.Reader`. Give it a `/metrics` endpoint, poll `ReadLag`, publish a gauge. Fifty lines.

```text
metrics: could not read lag for "persister": unavailable when GroupID is set
metrics: could not read lag for "persister": unavailable when GroupID is set
metrics: could not read lag for "persister": unavailable when GroupID is set
```

`kafka-go` refuses to compute lag for a reader that belongs to a consumer group. My first reading was "annoying library limitation, find the workaround."

There is a workaround, in fact — two of them. `Reader.Lag()` returns a number without complaining. So does the `HighWaterMark` field on every message you fetch. Either would have compiled, run, and produced a gauge that looked entirely reasonable.

Both are wrong, and wrong in the specific way that matters.

## Why every number inside the process is useless here

`Reader.Lag()` returns the lag **of the last message that was read**. `HighWaterMark` comes attached to a fetched message. Both update when the consumer consumes.

So picture the failure I'm trying to detect. The consumer stops making progress. It stops fetching. And therefore:

**the number stops updating, and freezes at whatever it was when things were last fine.**

A frozen `0` renders as a flat green line. It is indistinguishable from a consumer that is perfectly keeping up. The metric goes blind at precisely the moment it was built to see.

That's what the refusal was telling me. Not "this is hard", but **"a process that has stopped cannot tell you that it has stopped."** The question needed asking of something else.

## Measuring from outside

So the lag exporter became a separate process that never consumes anything. It asks Kafka directly, using Kafka's own bookkeeping:

- `ListOffsets` — the newest offset in each partition of the topic
- `OffsetFetch` — the offset each consumer group has committed

Subtract, sum across partitions, publish. Neither call needs the consumer to be alive, because neither call goes anywhere near the consumer. Kafka already knows both halves; the consumer was never the right thing to ask.

One detail that isn't obvious: a group that has **never committed anything** gets `-1` back from `OffsetFetch`. Treat that as zero and a consumer that never started at all reports perfect health — the single worst case to miss. It's measured from the log's first offset instead.

## The obvious alert is also wrong

With the metric working, the rule practically writes itself:

```yaml
expr: delta(chat_go_consumer_lag[10m]) > 0
```

Lag is growing, therefore something is falling behind. It reads correctly and it would have missed the real bug completely.

Here's what I actually found, the first day the exporter ran:

```text
chat_go_consumer_lag{group="bot"}       0
chat_go_consumer_lag{group="indexer"}   10
chat_go_consumer_lag{group="persister"} 0
```

The indexer embeds every message via a local LLM server, and that server lives on a different machine — one that was switched off. So the indexer was stuck. But my chat room is quiet: **no new messages were arriving, so the lag wasn't growing.** It sat at exactly 10, dead flat, for hours.

`delta() > 0` would have said nothing at all.

What actually separates *stuck* from *busy* isn't growth, it's **time spent behind**. A working consumer returns to zero within seconds. A stopped one never does.

```yaml
expr: chat_go_consumer_lag > 0
for: 15m
```

Plus a second rule at a high threshold for the different problem — a consumer that is alive and losing ground, which is about capacity rather than a dead dependency.

## The pod was perfectly healthy the whole time

This is the part worth sitting with:

```text
NAME                               READY   STATUS    RESTARTS   AGE
chat-go-indexer-5445bd9546-ps25r   1/1     Running   0          2h
```

Ready. Running. Zero restarts. Any liveness probe I could have written would have called it healthy, because it *was* healthy — the process was up, the loop was turning, and it was doing exactly what I told it to do:

```text
index attempt 5 failed: Post "http://192.168.29.30:11434/api/embeddings":
  dial tcp 192.168.29.30:11434: connect: no route to host — retrying in 16s
index attempt 6 failed: ... — retrying in 30s
index attempt 7 failed: ... — retrying in 30s
```

Retrying forever and never committing is deliberate. Offsets record how far you got, not which messages you handled, so skipping past a failure would permanently step over those messages. The consumer is correct. It just isn't making progress, and no health check distinguishes those.

Fixing the dependency drained the backlog in under a second, the gauge went to zero, and the alert resolved itself — which is worth watching too. An alert that never clears teaches you to ignore it, and then the next real failure goes unnoticed for exactly the same reason the first one did.

## And one more level up

If the exporter itself can't reach Kafka, every gauge holds its last value. Flat line at zero. Reads as perfect health.

That is the same invisible-failure shape as the original outage, one layer higher — so it gets its own metric and its own alert:

```yaml
expr: increase(chat_go_consumer_lag_read_errors_total[10m]) > 0
```

The annotation says what matters: treat lag as **unknown**, not as zero.

## Lessons

1. **A component cannot be the source of truth about its own liveness.** Anything measured inside a process stops updating when that process stops, which is the one moment you need it. If the failure mode is "X stopped", the measurement has to come from something that isn't X.
2. **A library refusing to answer is sometimes the answer.** I read `unavailable when GroupID is set` as an obstacle and went looking for a way round it. It was telling me the question was malformed, and both available workarounds would have produced a confidently wrong number.
3. **Alert on time-spent-behind, not on growth.** Growth assumes traffic. A stuck consumer in a quiet system has perfectly flat lag, and the intuitive `delta() > 0` is silent for exactly as long as nobody is talking.
4. **"Healthy" and "making progress" are different claims.** A liveness probe answers the first. Nothing about a running process, zero restarts, and a turning loop implies the second — and correct retry logic makes a stuck consumer look *more* healthy, not less.
5. **Watch the watcher.** A monitoring system that fails silently produces reassuring flat lines, which is worse than no monitoring at all, because now you believe something.
6. **A metric's first day is a test of the metric.** I expected three zeros and a screenshot. I got a broken consumer I hadn't known about, which is the only kind of evidence that the thing actually works.
