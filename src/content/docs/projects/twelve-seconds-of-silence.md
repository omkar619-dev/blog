---
title: "Twelve seconds of silence"
description: I built driftlab to test streaming client libraries under faults. Its first network test made nats.go's push ordered consumer go quiet for twelve seconds after a short outage, with no error and no lost message. Two of my predictions failed along the way, and each one became an upstream issue.
---

Eight seconds after I cut a consumer's network line, I let it through again. The client reconnected a tenth of a second later. Then nothing happened for twelve seconds:

```text
 0.040s  nemesis   invoke cut
 8.042s  nemesis   ok cut
 8.151s  consumer  reconnect
20.017s  consumer  deliver value 51, stream_seq 51
```

That's the timeline of one run, trimmed. Nothing was lost: message 51 was exactly the right next one, with no gap and no duplicate. And there was no error anywhere. As far as the application could tell, the stream had simply gone quiet.

## What driftlab is

Jepsen asks whether a server keeps its promises. I wanted a narrower question: does the client library I import keep *its* promises? Jepsen's [NATS 2.12.1 analysis](https://jepsen.io/analyses/nats-2.12.1) tested JetStream's durability through the Java client, and it left consumer-side delivery out of scope: whether a single consumer misses messages, or gets them out of order. That's exactly where [nats.go issue 2107](https://github.com/nats-io/nats.go/issues/2107) lived: an ordered consumer silently skipping 80 messages while the server did nothing wrong. It was fixed in v1.54.0 in September.

driftlab splits the job in two. A **driver** runs one scenario against a real nats-server and writes a history: a JSON line for every publish and its ack, every delivery, every fault it injected and every error the client reported. A separate **checker** reads that history afterwards and judges it. Every acked message must arrive, in stream order, with no skips and no duplicates, and the consumer must catch up on its own.

Before trusting it with anything new, I calibrated it on that known bug. The checker had to fail v1.53.1 and pass v1.54.0. It did, down to the issue's own numbers:

```text
verdict failed, 0 of 101 publishes unknown
poll-skip consumer ops=[226 228]: expected stream_seq 21, got 101: 80 skipped, 0 delivered late, 80 never delivered
```

**A checker that has never caught a real bug is untested**, so this mattered more than any new result could.

## A cut line, and a prediction that failed

The next round of scenarios broke the network. The consumer gets its own connection, routed through toxiproxy, so a fault can hit it alone while the producer keeps publishing, and keeps getting acks, over a direct line.

nats.go has two ordered consumers: the older push one, `js.Subscribe(subj, cb, nats.OrderedConsumer())`, and a pull one in the newer `jetstream` package. My prediction for an 8-second cut was dull. Both reconnect within a couple of seconds of the line coming back, refetch whatever they missed, and carry on.

The pull consumer did exactly that, in 0.15 seconds. The push consumer took twelve.

Confident prediction. Also wrong.

## Five seconds on the server, ten on the client

The silence had a suspiciously round edge. Delivery came back at 20.0 seconds after subscribing, run after run. That pointed at a timer.

The push ordered consumer runs an activity check every ten seconds, twice its five-second heartbeat interval, and it rebuilds its consumer only when a whole interval passes with no message and no heartbeat. As far as I can tell, nothing rebuilds it when the connection comes back. So after reconnecting, it waits for the next check.

But why was there nothing to receive in the meantime? The client re-subscribes when it reconnects, so the server should start delivering again. Unless the consumer on the server isn't there any more. I polled the stream's consumer count during a cut:

```text
18:32:32  consumer_count 1
18:32:33  consumer_count 0
```

Five to six seconds into the cut, it dropped to zero. The ordered consumer is created without an `InactiveThreshold`, so the server cleans it up after the default five seconds without interest. **The client came back to a subscription with nothing behind it.** No messages, not even heartbeats, and the only thing that would ever notice was a timer that fires every ten seconds.

That predicts a sharp edge at five seconds, so I measured both sides of it:

| cut | messages flowing again after the reconnect |
|---|---|
| 3 s | 1.1 s |
| 4 s | 0.03 s |
| 6 s | 14.0 s |
| 8 s | 12.0 s |

Under five seconds, the consumer survives and delivery resumes as soon as the client reconnects. Over five, it waits for the twenty-second check. The `jetstream` consumer avoids all of this: it rebuilds its consumer the moment the connection comes back, and it asks the server to keep the old one for five minutes anyway.

## Who this actually hurts

A twelve-second pause with no data loss sounds mild until you look at what's built on that consumer. In nats.go, KV watchers, the "tell me when this key changes" API, use the push ordered consumer, in the old API and in the new `jetstream` package alike. So I wrote a standalone reproducer, one Go file with an in-process proxy that can cut the connection, needing nothing but nats-server, and measured them directly:

```text
silent after a 8s cut ended:
  push-ordered   10.00s
  kv-legacy      10.00s
  kv-jetstream   10.00s
  pull-ordered    0.17s
```

That's a feature flag, a config value or a "stop the sale" switch going ten seconds stale after a network blip, with nothing to alert on.

Then I killed the server instead of the line. A restart with only five seconds of downtime left the push consumer silent for 13.8 seconds after the server was back, in four runs out of four. The ordered consumer is forced to memory storage, so it doesn't survive a restart at all, however short. That also rules out one of the fixes I'd floated: a longer `InactiveThreshold` can't help a consumer that a restart wipes anyway. Rebuilding on reconnect covers both.

It's [nats.go issue 2180](https://github.com/nats-io/nats.go/issues/2180), with the reproducer and the numbers.

## The alarm that never rang

The second prediction failed more quietly.

To slow a line rather than cut it, toxiproxy can delay everything the server sends by a fixed amount. I picked 25 seconds, longer than either consumer should tolerate. The pull consumer expects a heartbeat every five seconds, and after two missed ones it raises `ErrNoHeartbeat` and rebuilds itself. I'd even written it into the scenario's description: a delay that long "trips that reset in both".

It never did. Twenty-five seconds of total silence, and no error, no reset.

The ordered-consumer code does work out a five-second heartbeat. Then it passes your original options to the inner pull subscription, which works the heartbeat out again with the plain rule: half of the 30-second pull expiry. The pull requests it sends the server say so directly:

```text
{"expires":30000000000,"batch":500,"idle_heartbeat":15000000000}
```

Fifteen seconds, so the alarm rings after thirty, and twenty-five seconds of silence was never going to set it off. Freezing the server for 35 seconds with `docker pause` did, at 30.04 seconds.

**The number my scenario promised came from a code path whose result was thrown away.** That's [nats.go issue 2181](https://github.com/nats-io/nats.go/issues/2181). It's smaller than 2180: the public docs for the heartbeat option describe a default of half the pull expiry, so fifteen seconds may well be intended. I asked which behaviour they meant rather than calling it a bug.

## The bugs in my own harness

Not everything driftlab found was in nats.go.

- **An invalid verdict caught a race in my driver.** The first stall runs against the fixed client came back *invalid*, not clean, because the fault they declared, a pending tray overflowing, never happened. The backlog had landed before I shrank the tray, so there was nothing to overflow. A clean verdict there would have been a false pass. The checker refuses to call a run clean when a promised fault has no evidence.
- **My recovery number was blind after a fault.** It only counted messages acked before the fault ended, so after a frozen server, where nothing could be acked, it read zero whatever the consumer did next. I added a second measurement, lag: the longest any acked message waited between its ack and its delivery. On the slow line, recovery said 1 ms and lag said 30 seconds.
- **"Unknown" turned out to mean exactly that.** Seven publishes timed out during the freeze and were recorded as unknown rather than failed. All seven landed once the server woke up. Recording them as failures would have produced seven phantom anomalies, pinned on nobody.

The full matrix now runs 32 combinations, two nats.go versions by two consumer APIs by eight scenarios, and every verdict matches the expected table. The design, the history format and every result are in [the repo](https://github.com/omkar619-dev/driftlab).

## Lessons

1. **Calibrate on a known bug first.** Reproducing 2107's exact numbers is what made the later results believable, to me first of all.
2. **Write the prediction down before the run.** Both findings started as a number I'd committed to that the run contradicted. Without the prediction, twelve seconds of silence is just "a bit slow".
3. **A round number in a timing result is a timer.** Delivery always came back at 20.0 seconds after subscribing, and that pointed straight at a ten-second check.
4. **Look at the wire, not the code's intent.** The code said five seconds. The pull request on the wire said fifteen, and the wire is the one that runs.
5. **"No error" is a result.** Both behaviours lose nothing and log nothing. The only way to see them is to measure how long a consumer stays silent, which is why lag is now part of every fault run.
6. **Test your measurements like your code.** Recovery had a blind spot I only found when a scenario landed in it, and the fix came with a hand-written history that shows the difference.
