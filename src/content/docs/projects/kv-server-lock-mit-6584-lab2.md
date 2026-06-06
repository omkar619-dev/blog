---
title: A Key/Value Server + Distributed Lock (MIT 6.5840 Lab 2)
description: Building a linearizable KV store and a lock with at-most-once writes over an unreliable network — the version-number trick, the ErrMaybe "fog", and the Go gotchas (map-copy, type-shadowing) that ate the most time.
---

This is the second lab in [MIT 6.5840](https://pdos.csail.mit.edu/6.824/) (distributed systems), after [Lab 1: MapReduce](/projects/mapreduce-mit-6584-lab1/). Lab 2 builds a single-machine **key/value server** that keeps writes *at-most-once* even when the network drops messages, and then builds a **distributed lock** on top of it.

Less code than MapReduce, more thinking. The whole lab orbits one question that I now find genuinely beautiful: **how do you make a write safe to retry when you can't tell whether it already happened?** That question — and the honest, slightly unsatisfying answer the lab forces you to live with — is the point.

No solution code here (course collaboration policy). This is the mental model, the failure reasoning, and the Go potholes I fell into.

---

## Table of contents

- [Why build a KV server by hand](#why-build-a-kv-server-by-hand)
- [The model: a notebook with edit-counters](#the-model-a-notebook-with-edit-counters)
- [Linearizability, in one sentence](#linearizability-in-one-sentence)
- [The flaky post office, and the word "maybe"](#the-flaky-post-office-and-the-word-maybe)
- [The lock: a sign-in sheet with your name on it](#the-lock-a-sign-in-sheet-with-your-name-on-it)
- [Real gotchas encountered](#real-gotchas-encountered)
- [What this leaves on the table](#what-this-leaves-on-the-table)
- [Closing](#closing)

---

## Why build a KV server by hand

The honest answer in two halves.

**The career half**: a versioned key/value store with compare-and-swap is the atom that bigger systems are made of. etcd, ZooKeeper, Consul — the coordination layer under Kubernetes and friends — are this idea, replicated. Building the single-machine version by hand means that when I later operate (or build on) those systems, "conditional put," "at-most-once," and "linearizable" aren't buzzwords; they're things I've implemented and debugged. And Lab 2 is the on-ramp to the labs that matter most for where I'm headed — Lab 3 (Raft) and Lab 4, which replicates a server like this one into a fault-tolerant cluster.

**The engineering half**: I wanted to feel why *exactly-once* writes are hard. The lab makes you build *at-most-once* instead, and forces you to return an error literally named `ErrMaybe` — "your write might or might not have happened, I can't tell." Sitting with why that ambiguity is unavoidable (without more machinery) taught me more than any amount of reading about idempotency.

---

## The model: a notebook with edit-counters

The cleanest way I found to hold the whole server in my head: it's a **shared notebook**.

- Each **page** has a name (the key) and a **value** written on it.
- Each page also has an **edit-counter** in the corner — how many times it's been written. That counter is the *version*.
- **Get** = read a page.
- **Put** = write a page — but with one rule that is the entire ballgame.

> A `Put` succeeds **only if the version you send equals the page's current counter.** On success, the value is overwritten and the counter ticks up by one.

That's compare-and-swap. A `Put` isn't "set this page to X." It's "set this page to X, *but only if the page is still where I last saw it*." Exactly like an edit-conflict in Google Docs.

The one framing that's worth getting right (I had it slightly wrong at first): **a non-existent key is conceptually at version 0.** So "create" isn't a special opcode — it falls straight out of the same rule. `Put(key, value, 0)` on a missing key succeeds *because 0 equals the implicit current version 0*, and the page is born at counter 1. The full table:

| Page state | Your version | Result |
|---|---|---|
| missing (implicit v0) | `0` | create at counter **1** → `OK` |
| missing | `> 0` | `ErrNoKey` (you referenced a page that isn't there) |
| exists | `== counter` | overwrite, counter+1 → `OK` |
| exists | `!= counter` | `ErrVersion` (page changed since you looked) |

`ErrNoKey` is an *existence* problem; `ErrVersion` is a *staleness* problem. Keeping those two distinct is half the points in Phase 1.

**Why the counter is the whole trick:** it makes a duplicated write harmless. Mail a letter "write 'hello' on page x, I saw counter 5." The server does it (counter → 6) and mails back "done!" — but the reply gets lost. You don't know if it worked, so you resend the *same* letter ("…I saw counter 5"). Now the page is at 6, so `5 ≠ 6` → the server rejects it and changes nothing. **The letter arrived twice; the page was written once.** At-most-once, achieved with a single integer comparison and no per-client bookkeeping.

---

## Linearizability, in one sentence

The lab's headline guarantee sounds scary and is actually simple: the system behaves **as if a single shopkeeper served one customer at a time**, even with a crowd at the counter.

The rule that matters: **if my operation finished before yours started, you must see my result.** (Deposit money, get the receipt; your subsequent balance check *must* include it.) Concurrent operations — ones that overlap in time — can be ordered either way, as long as *some* single order explains every value returned.

Why it's *easy* here: one server with one mutex literally processes requests one at a time. That actual execution order **is** a valid single-threaded story, by construction. The serialization point is just "when the locked section ran." Free.

The forward hook: this is only free because there's **one** copy of the data. Replicate it across machines (Lab 3/4) and there's no shared mutex — just a network that reorders and drops things. Getting separate machines to agree on that single order is *consensus*, and Raft is the machine that manufactures it. Lab 2's linearizability is the gift; the later labs make you earn it.

---

## The flaky post office, and the word "maybe"

This is the heart of the lab. The network is a post office that randomly loses letters — sometimes the request, sometimes the reply. Your only signal is whether a round-trip *completed* (`Call` returns true) or not (false). And `false` is **ambiguous**: you can't tell whether your request never arrived, or it arrived and did the work but the reply got eaten.

So the client retries until it gets a reply. For a **read**, that's trivially safe — reading a page twice changes nothing. For a **write**, the version trick makes resends safe too… up to one genuinely unsolvable case:

A client **resends** a write and gets back `ErrVersion`. Two different histories produce that *identical* observation:

- **(a)** Your first letter actually succeeded (the page changed because of *you*), and only the "done!" reply was lost. → your write happened.
- **(b)** Someone else changed the page before your letter ever arrived. → your write never happened.

From the client's seat, (a) and (b) are byte-for-byte indistinguishable. The one fact that would separate them lives only on the server, and the only message that could carry it back is the reply that got lost. This is an **information wall**, not a coding gap. So the honest thing the client returns is `ErrMaybe` — "maybe it worked, maybe it didn't."

The rule that falls out:

- `ErrVersion` on your **first** attempt → return `ErrVersion`. Clean: it was rejected on arrival, definitely didn't apply.
- `ErrVersion` on a **resend** → return `ErrMaybe`. You're in the fog.
- `OK` (even on a resend) → just `OK`. No fog.

The one load-bearing detail in the code is a single boolean — *is this attempt a resend?* — flipped the moment a `Call` comes back empty. Get that placement right and the rest is easy; get it wrong (e.g., laundering a *first*-attempt `ErrVersion` into `ErrMaybe`) and you've broken the contract.

**Why not just make it exactly-once and delete `ErrMaybe`?** Because the server keeps no per-client memory. To erase the ambiguity it would need a dedup table — client IDs, sequence numbers, and the stored reply for each — so a duplicate request replays the original answer instead of being re-evaluated. That's real machinery (and exactly what the later Raft KV lab builds). Lab 2 deliberately stops short so you *feel* why `ErrMaybe` is forced on you. Earn the ache now; the cure lands later as obvious instead of magic.

---

## The lock: a sign-in sheet with your name on it

Here's the part I liked most: a distributed lock with **no new server features at all**. The lock is just a *key*, used like a sign-in sheet on a meeting-room door.

- The value on the sheet is **your unique id** (a random string) when you hold it, or empty when it's free.
- **Acquire**: read the sheet; if it's free, write your id — using a version-conditioned `Put`. If two clients grab a free sheet at the same version, only one's write matches the version and wins; the other gets `ErrVersion` and waits. The CAS *is* the mutual exclusion.
- **Release**: write the sheet back to empty.

Why store your *id* rather than a boolean "taken" flag? Because of the post office. If your acquire-`Put` comes back `ErrMaybe`, you don't know if your name stuck — so you **go look at the sheet**. If you see *your own id*, your write landed and you hold the lock; no other client could ever have written your unique id. A boolean couldn't tell you *whose* lock it is, so it couldn't resolve the ambiguity. The id turns "maybe" into a definite yes/no with a single read.

The payoff was concrete: when I got to Phase 4 (the lock on the unreliable network), the unreliable tests **passed with zero changes.** My Phase 2 `Acquire` already looped and already had a "is this my id?" check — so an `ErrMaybe` simply caused another loop, another read, and the id-check resolved it. The read-back I would have "added" for the failure case was already there because I'd stored the id from the start. Designing for the failure case early meant the failure case cost nothing.

---

## Real gotchas encountered

The instructive potholes, in roughly the order they bit.

### 1. `package slices is not in GOROOT` — my Go was three years stale

The 2026 lab's tester imports `slices` (a standard-library package since **Go 1.21**). My WSL had **Go 1.18** from Ubuntu's `apt`, which doesn't have it. Lab 1 didn't use `slices`, so it slipped by; Lab 2's tester did, and the build died.

- **Root cause:** distro package managers ship ancient Go. `apt`'s version lagged years behind.
- **Fix:** ignore `apt`, install the current Go from the official tarball into `/usr/local/go`, put it first on `PATH`.
- **Lesson:** for Go specifically, never rely on the distro package. Grab it from go.dev. (Also: a newer Go didn't break Lab 1 — Go's backward compatibility is real.)

### 2. "server 1, clnts 1527" — the map-value-is-a-copy trap

After Phase 1, the concurrency test failed with a cryptic line: the server's final version was **1**, but the clients had done **1527** successful puts. Decoding that message *was* the debugging: the version should equal the number of writes, so a version frozen at 1 meant **writes weren't persisting.**

The cause is a classic Go pothole. I'd written, on the update path:

```text
e := store[key]      // e is a COPY of the struct
e.value = newValue   // mutates the copy
e.version = e.version + 1
// ...and never wrote e back into the map
```

Reading `map[key]` hands you a **copy** of the value, not a reference into the map. Mutating the copy leaves the map untouched, so the counter never advanced.

- **Root cause:** Go map values are copies; you can't mutate them in place (Go won't even let you write `map[k].field = x` — map values aren't addressable).
- **Fix:** read-copy → modify → **write the struct back**: `store[key] = entry{value: ..., version: e.version + 1}`.
- **Lesson:** two, actually. (1) Mutating a struct you read out of a map is a silent no-op — always write back. (2) The test messages are precise; "server N vs clients M" told me exactly *what* was wrong before I knew *why*. Learning to read the failure is the skill.

### 3. The variable that shadowed its own type

While fixing #2, I tried to write `entry{value: ..., version: ...}` (a struct literal) and the compiler insisted `entry is not a type`. I'd named my local variable `entry` — the same word as my `entry` *type*. Once `entry, ok := store[k]` declares a variable named `entry`, that name refers to the *variable* for the rest of the function, so `entry{...}` can no longer mean the type.

- **Root cause:** a local variable shadowing a type name in the same scope.
- **Fix:** name the variable `e`, leaving `entry` free as the type.
- **Lesson:** don't reuse type names as variable names. Subtle, silent until you need the type as a literal.

### 4. `rpc redeclared` / `undefined: kvtest1` — imports, the boring time-sink

The single biggest time-drain wasn't logic — it was *imports in the wrong file*. I added an import to `server.go` that already had it (→ "rpc redeclared"), then over-corrected and deleted imports the file genuinely used, then referred to a package as `kvtest1` when it's actually named `kvtest`.

Two real lessons buried in that mess:

- **Imports are per-file.** The error path tells you which file (`kvsrv1/server.go:9`) — *read the filename first*. Adding an import to one file does nothing for another.
- **A Go package's name is its `package` declaration, not its folder.** The folder is `kvtest1`, but the code inside declares `package kvtest`, so you write `kvtest.IKVClerk` — not `kvtest1.`. (Same pattern across the repo: folder `tester1` → `package tester`.) That mismatch produced "undefined: kvtest1" while the import sat right there looking fine.

The meta-lesson: when you're new to a layout, paste whole correct files rather than doing line-by-line import surgery. I burned more time on `import` blocks than on the actual distributed-systems logic — a humbling but useful reminder that environment friction is a real part of the job, not a footnote.

### 5. The pleasant one: Phase 4 cost nothing

Covered above, but worth listing as a "gotcha" in reverse: the unreliable-lock phase passed with no new code because the id-as-value design from Phase 2 already handled `ErrMaybe` via the read-back loop.

- **Lesson:** building the *failure-case* affordance early (storing identity in the data, not a bare flag) can make the hard later phase free. Foresight in the data model pays compound interest.

---

## What this leaves on the table

- **Exactly-once writes (killing `ErrMaybe`).** Add a per-client dedup table on the server — client id + sequence number → stored reply — so a duplicate replays the original answer instead of being re-evaluated. This is the obvious next step and exactly what the Raft-backed KV lab builds.
- **Lease-based lock recovery.** Right now, if a client holding the lock dies, the lock is stuck forever (the lab says clients don't crash, so it's ignored). A real lock attaches a *lease* that expires, so the server can reclaim it. ZooKeeper/etcd do this.
- **Replication.** The whole point of the next labs: take this single, crash-vulnerable server and replicate it across machines with Raft, so it survives failures while *still* looking linearizable to clients.

```
Lab 1: MapReduce        ✅
Lab 2: KV Server + Lock ✅   ← this post
Lab 3: Raft             ☐   consensus — the hard one
Lab 4: KV + Raft        ☐   a fault-tolerant, replicated version of THIS server
Lab 5: Sharded KV       ☐
```

Lab 2 is the seed of Lab 4. The server I just built is precisely the thing that gets replicated next — which is why getting the version/at-most-once semantics right by hand now matters.

---

## Closing

What stuck from Lab 2 isn't the code — the server is a map under a mutex, the lock is a key you write your name on. It's the *reasoning under failure*. The version counter that makes a duplicate write a no-op. The `ErrMaybe` fog that no amount of cleverness can dispel without the server remembering clients. The realization that storing my id (not a boolean) in the lock turned an unsolvable "did my write land?" into a one-read answer — and made the final phase free.

And an honest tally of where the time actually went: maybe a third on distributed-systems thinking, two-thirds on environment and Go mechanics — a stale Go version, a map-copy that silently dropped writes, a shadowed type name, and a genuinely embarrassing amount of `import`-block thrashing. That ratio is itself a lesson. The "systems" part is the interesting part; the "make the toolchain and the language stop fighting you" part is most of the clock. Both are the job.

Next stop, eventually: Raft — where linearizability stops being free.

— Built and documented in June 2026 by [Omkar](https://github.com/omkar619-dev).
