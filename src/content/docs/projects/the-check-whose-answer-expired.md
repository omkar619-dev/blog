---
title: "The check whose answer expired"
description: Three bugs in my chat project, months apart, in two different languages. A cancelled context that couldn't stop a blocked read, a cleanup path the stuck goroutine never reached, and a JavaScript guard that went stale while a camera permission dialog was open. Same bug, three costumes.
---

I found the third one and recognised it immediately, which is the only reason this is worth writing down. Three bugs, spread over about six weeks, in Go and in JavaScript, presenting as three completely unrelated symptoms:

- everyone in the room receiving every message **twice**
- a client the server had decided to disconnect **sitting there connected and silent**
- a video call failing with `InvalidStateError: PeerConnection cannot create an answer in a state other than have-remote-offer`

They're the same bug. Each one is a decision made at one moment and acted on at a later moment, with something changing in between — and in each case the code was written as though those two moments were the same moment.

## One: a cancelled context can't stop a blocked read

My chat gateway holds **one Redis subscription per room per process**, and fans each message out in memory to that room's local sockets. When the last person leaves a room, the subscription should be torn down.

The teardown looked fine:

```go
cancel()          // stop the pump goroutine
// ... the pump's deferred ps.Close() will run on its way out
```

The pump goroutine sits in a loop calling `ReceiveMessage`, which blocks on a socket read. The reasoning was: cancel the context, `ReceiveMessage` returns an error, the loop exits, the deferred `Close` runs.

It doesn't.

**Cancelling a context sets a flag and closes a channel. It does not interrupt a goroutine that is parked in a read.** Cancellation in Go is cooperative — it takes effect at the next point where somebody checks, and a blocked socket read has no such point. The goroutine stayed parked. The subscription stayed open.

Then a later message on that channel woke the orphaned pump, which duly broadcast it into whatever room object happened to be in the map by then. Two pumps, one room, every member receiving two copies.

It presented as duplicated messages in the browser, and my first instinct was to blame the front end. One command settled it:

```text
> PUBSUB NUMSUB room:1
1) "room:1"
2) (integer) 2
```

Two subscriptions to one channel, from a single gateway process. Combined with DevTools showing **one** WebSocket receiving the same frame twice, the client was eliminated in about thirty seconds.

The fix is to close the thing the goroutine is blocked *on*:

```go
r.ps.Close()      // closing the connection is what interrupts the read
cancel()          // kept, but no longer load-bearing
```

Plus a belt-and-braces check in `broadcast`: compare the pump's room pointer against the current entry in the map, and drop the message if they differ. A lingering pump then can't deliver into its own replacement.

## Two: a cleanup path the stuck goroutine never reached

The hub disconnects a reader that falls too far behind — a bounded queue, then eviction, rather than an unbounded buffer that turns one slow client into a memory leak.

Except evicted clients stayed connected. Open socket, no messages, no error. Exactly the state the policy exists to prevent.

The hub was closing its end of the subscription and then relying on cleanup code sitting at the end of the socket's read loop. But **an evicted reader is, by definition, a reader that isn't reading.** It's blocked inside a write, or blocked waiting for something that will never come. It never comes back round to the top of the loop where the cleanup lives.

I measured the delay at one point as thirty-seven seconds. Not a race — a code path that simply doesn't execute while the goroutine is stuck, which is the only condition under which it's needed.

The fix was to stop putting the cleanup somewhere the stuck goroutine has to travel to, and give it its own goroutine with nothing to block on:

```go
go func() {
    select {
    case <-sub.Evicted():
        conn.CloseNow()
    case <-ctx.Done():
    }
}()
```

**A cleanup path that only runs when the goroutine isn't stuck is not a cleanup path.**

There's a second thing in here I nearly missed. When I first thought I'd fixed it, I couldn't tell whether eviction was happening late or happening promptly and *closing* late — because the only log line was in a defer that ran at teardown. It had no timestamp of its own. One `log.Printf` at the moment of the decision settled two failed attempts.

## Three: a guard that went stale behind a permission dialog

Months later, different language, no Kafka or Redis in sight.

Two of us pressed "call" at roughly the same time, and one side died with:

```text
could not answer: InvalidStateError — Failed to execute 'createAnswer' on
'RTCPeerConnection': PeerConnection cannot create an answer in a state other
than have-remote-offer or have-local-pranswer.
```

My first guess was WebRTC *glare* — both peers offering simultaneously, a genuinely well-known problem. It wasn't that. The code already declined an incoming offer when a call was in progress:

```js
function onOffer(fromId, sdp) {
  if (pc) { sendSignal(fromId, 'hangup', {}); return; }
  // ... show the ringing panel
}
```

And `startCall` guarded the same way:

```js
async function startCall(otherId, otherName) {
  if (pc) { callStatus('already on a call'); return; }
  // ...
  const stream = await getMedia();        // <- camera permission dialog
  pc = newPeerConnection(otherId);        // <- pc is assigned HERE
  // ...
}
```

Look at the gap between the guard and the assignment. `await getMedia()` is where the browser puts up "*Use camera & microphone?*" and waits for a human to click. That's seconds. **For the entire time a call is being set up, `pc` is still `null`, so every guard that asks `if (pc)` answers "no".**

So: I press call, the dialog opens, `pc` is null. The other person's offer arrives, `onOffer` sees `pc === null` and shows the ringing panel. I accept. `acceptCall` builds a peer connection, assigns `pc`, sets the remote description. Then my original `getMedia()` resolves, `startCall` carries on and **overwrites `pc`** with a fresh connection holding a local offer. `acceptCall`'s next line calls `createAnswer()` on it — and that object is in `have-local-offer`, not `have-remote-offer`.

The error message was completely accurate. It just described the final state rather than how two functions came to share one variable.

The fix is a flag set **synchronously, before any `await`**:

```js
if (pc || callBusy) { callStatus('already on a call'); return; }
callBusy = true;                 // before the first await, and that's the point
```

`callBusy` is `pc` for the window in which `pc` doesn't exist yet. It closes exactly the gap the real guard can't see.

## The shape

In Go the gap was a goroutine parked in a syscall, where a cancelled context and an unreachable line of code are both invisible. In JavaScript it was an `await`, where the event loop happily runs somebody else's function in the middle of yours. Different runtimes, and the single-threaded one is not the safer one — `await` is a yield point whether or not it looks like one.

Every instance is the same sentence: **a fact was established, then something else happened, then the fact was used.** Nothing checked whether it was still true.

And each fix is the same move in a different dialect — shrink the gap, or make the claim before yielding. Close the socket rather than signalling a goroutine that can't hear you. Put the cleanup where no blocked code has to reach it. Set the flag before the `await`, not after.

## Lessons

1. **Cancellation is cooperative, and a blocked read does not cooperate.** If a goroutine is parked in I/O, close the thing it's parked on. `cancel()` alone will politely do nothing.
2. **Cleanup must not live on a path the stuck code can't reach.** Ask where the goroutine actually *is* when the cleanup is needed. If the answer is "blocked, halfway through an iteration", then the top of the loop is the wrong place.
3. **`await` is a yield point.** Any state checked before it may be different after it, and in a browser those gaps are measured in human reaction time, not microseconds. A permission dialog is seconds of window for something else to run.
4. **Log the decision, not just the consequence.** Without a timestamp on the moment of eviction, "evicted late" and "evicted promptly, closed late" are indistinguishable. One `log.Printf` at the decision point ended two failed debugging attempts.
5. **Measure the disputed quantity directly.** I blamed the front end for the duplicate messages. `PUBSUB NUMSUB` answered the actual question — how many subscriptions exist — in one command, and no amount of reading client code would have.
6. **Recognising the shape is the whole return on writing this down.** The first one cost an evening. The third one I spotted from the error message, because I'd seen the pattern twice before wearing different clothes.
