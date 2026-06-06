---
title: MapReduce from Scratch (MIT 6.5840 Lab 1)
description: Building a fault-tolerant distributed MapReduce — coordinator/worker design, the WSL gotchas that cost hours, and the crash-recovery hang that taught me what MapReduce is actually for.
---

This is the start of working through [MIT 6.5840](https://pdos.csail.mit.edu/6.824/) (the distributed systems course, formerly 6.824). Lab 1 is MapReduce: build a coordinator and worker that, between them, reproduce Google's 2004 [MapReduce paper](http://research.google.com/archive/mapreduce-osdi04.pdf) scaled down to one machine — including recovery from workers that crash mid-task.

I went in having read the paper and watched the lectures, expecting the hard part to be the algorithm. It wasn't. The algorithm is small. The hard parts were (1) a Windows/WSL environment fight that had nothing to do with distributed systems, and (2) one genuine distributed-systems lesson — fault tolerance — that I only understood properly when my test hung for ten minutes. This is the writeup of both.

No solution code here (course collaboration policy, and frankly the code isn't the interesting part). This is about the design and the debugging.

---

## Table of contents

- [Why build MapReduce by hand in 2026](#why-build-mapreduce-by-hand-in-2026)
- [The mental model: map, shuffle, reduce](#the-mental-model-map-shuffle-reduce)
- [Architecture: coordinator and workers](#architecture-coordinator-and-workers)
- [The design decisions that matter](#the-design-decisions-that-matter)
- [Real gotchas encountered](#real-gotchas-encountered)
- [Performance observations on WSL](#performance-observations-on-wsl)
- [What this leaves on the table](#what-this-leaves-on-the-table)
- [Closing](#closing)

---

## Why build MapReduce by hand in 2026

The honest answer in two halves.

**The career half**: I'm moving toward platform engineering and, eventually, AI infrastructure. Both treat distributed systems as the baseline, not a specialty. Nobody runs MapReduce directly anymore — but the patterns it teaches (coordinator/worker task assignment, failure detection by timeout, idempotent re-execution, atomic output commits) are the same patterns inside every scheduler, queue, and distributed database I'll have to operate or build. And Lab 1 is the on-ramp to the labs that actually matter for my portfolio: Lab 3 (Raft) and Lab 4 (a fault-tolerant key-value store on top of Raft — essentially a tiny etcd).

**The engineering half**: I wanted to feel, not just read about, why distributed computation is hard. The paper says "the run-time system takes care of partitioning, scheduling, machine failures, and communication." That sentence hides the entire job. Building it surfaces what that sentence costs — and the failure-handling part especially is invisible until you write the happy path and then watch it deadlock the first time a worker dies.

The downside, to be honest: most of Lab 1's wall-clock time for me was environment debugging (WSL), not distributed systems. The actual MapReduce logic is maybe 150 lines. But the lessons that stuck were worth the friction.

---

## The mental model: map, shuffle, reduce

The whole abstraction is two functions you write:

```
map    (key, value)       → list of (key, value)
reduce (key, list(value)) → list of (value)
```

For word count, `map` takes a document and emits `(word, "1")` for every word occurrence — it does **not** count, it just stamps a "1" on each word. `reduce` takes one word and the list of all its "1"s and returns the count. Between them sits a step you don't write — the **shuffle** — which groups every value for a given key together, even when those values were produced on different machines.

The restriction is the point. By forcing computation into this rigid shape, the framework can parallelize and fault-tolerate it automatically — the programmer supplies only the 5% that's specific to their problem, and the messy 95% (distribution, failures, retries) is written once in the library. That trade — give up expressiveness, gain automatic parallelism and fault tolerance — is the entire idea.

The mechanical heart is the **M×R intermediate grid**. With M map tasks and R reduce tasks, every map task writes one file per reduce bucket, picking the bucket with `hash(key) mod R`:

```
              reduce-0      reduce-1      reduce-2
            ┌───────────┬───────────┬───────────┐
  map-0     │ mr-0-0    │ mr-0-1    │ mr-0-2    │  ← a map task writes ACROSS a row
            ├───────────┼───────────┼───────────┤
  map-1     │ mr-1-0    │ mr-1-1    │ mr-1-2    │
            ├───────────┼───────────┼───────────┤
  map-2     │ mr-2-0    │ mr-2-1    │ mr-2-2    │
            └───────────┴───────────┴───────────┘
                  │
                  ▼
            reduce task 0 reads its whole COLUMN (mr-0-0, mr-1-0, mr-2-0) → mr-out-0
```

The hash is the coordination: `hash("the") mod R` is always the same number, so every occurrence of "the" — from any map task, any input file — lands in the same column, and the reduce task for that column gathers them all. That's the shuffle, done without any central index of keys. In my run with 8 input files and `nReduce = 10`, that's 8 × 10 = 80 intermediate files, then 10 output files `mr-out-0` through `mr-out-9`.

---

## Architecture: coordinator and workers

One **coordinator** process, many **worker** processes. Workers are stateless and dumb in a loop: ask the coordinator for a task, do it, report done, repeat. The coordinator is the single source of truth for what needs doing and what's been done.

```
                    ┌──────────────────────┐
                    │     COORDINATOR      │  tracks every task's state:
                    │   (single process)   │  idle / in-progress / completed
                    └──────────┬───────────┘
          "give me a task"     │     "task 3 done"
          ┌──────────────┬─────┴──────┬──────────────┐
          ▼              ▼            ▼              ▼
     ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
     │ WORKER  │   │ WORKER  │   │ WORKER  │   │ WORKER  │
     └─────────┘   └─────────┘   └─────────┘   └─────────┘

  Phase 1 (map):    workers read input splits, write the mr-X-Y grid
  Phase 2 (reduce): workers read columns of the grid, write mr-out-Y
```

Communication is Go RPC over a Unix domain socket. Two RPCs are enough:

- `RequestTask` — worker → coordinator: "give me work." The reply is one of four kinds: a map task, a reduce task, **wait** (tasks are out but not all done — reduce can't start yet), or **exit** (everything's finished).
- `ReportTask` — worker → coordinator: "I finished task N."

The four-way reply was the first non-obvious design point. The **wait** state exists because reduce tasks cannot begin until *every* map task is complete — a reduce task reads a column across all map outputs, so if map 5 hasn't finished, the file `mr-5-Y` doesn't exist yet. So when all maps are handed out but not all *done*, late workers have to be told to hold, not handed a reduce task prematurely.

---

## The design decisions that matter

A few choices that turned out to carry the whole lab:

**The coordinator is a task state machine under a lock.** Every task is `idle → in-progress → completed`. The coordinator hands out `idle` tasks, marks them `in-progress`, and only ever moves to the reduce phase when all map tasks are `completed`. Because multiple workers hit `RequestTask` concurrently, every handler that touches this state takes a mutex first — otherwise two workers grab the same idle task, or a completion counter loses an update. Forgetting the lock is a data race the `-race` detector catches instantly.

**Idempotent completion.** `ReportTask` only marks a task completed *if it's currently in-progress*. This guard looks pointless on the happy path — but it's what makes duplicate completions safe. When a slow-but-alive worker reports a task that already got reassigned and finished by someone else, the guard stops the completion counter from being incremented twice. I built it in early and only understood why later (see gotcha 3).

**Atomic output via temp-file-then-rename.** Every task writes to a uniquely-named temporary file, then atomically renames it to the final name (`mr-X-Y` or `mr-out-Y`) once fully written. `rename` is atomic on the filesystem — either the final file exists complete, or it doesn't exist at all. So a worker that crashes mid-write never leaves a half-written file for another worker (or a reduce task) to read. This is also what makes re-execution safe: if the same task runs twice, both rename to the same name, last writer wins, and since map/reduce are deterministic the content is identical anyway.

These three — state machine under a lock, idempotent reporting, atomic commits — are the spine. The map/reduce data-munging is the easy part lifted straight from the provided sequential reference.

---

## Real gotchas encountered

The instructive failures, in the order they hit me.

### 1. Go plugins don't build on Windows

The lab loads the map/reduce application (word count, indexer) as a runtime plugin — `go build -buildmode=plugin wc.go` produces a `.so` the worker loads dynamically. On Windows:

```
-buildmode=plugin not supported on windows/amd64
```

**Root cause:** Go's `plugin` package is implemented only for Linux, macOS, and FreeBSD. Windows has no equivalent of the `dlopen` shared-object mechanism it relies on. This isn't a missing flag — it's a hard platform limitation. The lab simply cannot run natively on Windows.

**Fix:** do the lab in WSL2 (a real Linux environment), where plugins build fine.

**Lesson:** know your runtime's platform constraints before you architect around a feature. "It compiles on my machine" assumes your machine is the target platform.

### 2. Unix domain sockets don't work on the Windows filesystem (`/mnt/c`)

I cloned the repo under `/mnt/c/Users/...` so I could edit it with Windows tools. The coordinator died on startup:

```
listen error sock123: listen unix sock123: bind: operation not supported
```

**Root cause:** `/mnt/c` is the Windows NTFS drive exposed into WSL through a translation layer (drvfs/9P). The coordinator calls `net.Listen("unix", ...)` to create a Unix domain socket — a special file that the translation layer doesn't support creating. Regular file reads/writes work on `/mnt/c` (the intermediate files would have written fine), but socket creation specifically does not. Only a native Linux filesystem (ext4) supports it.

**Fix:** move the project off `/mnt/c` onto WSL's native ext4 (`~/`). Sockets bind without complaint there.

**Lesson:** two-parter. First, Unix sockets need a real Linux filesystem — not every "looks like a file" operation survives a filesystem translation layer. Second, and more generally useful: keep dev projects on the Linux-native filesystem in WSL anyway. Beyond the socket fix, `go build`, `go test`, and `git` are all noticeably faster on ext4 than across the 9P bridge to `/mnt/c`. The bug forced a move I should have made for performance regardless.

### 3. The crash-recovery hang — the actual point of the lab

Six of seven tests passed. `TestCrashWorker` — which uses an application that makes workers randomly `os.Exit()` mid-task — didn't fail, it **hung**, until the test harness panicked at its 10-minute global timeout:

```
panic: test timed out after 10m0s
```

**Root cause:** I'd built the happy path. When a worker took a task, I marked it `in-progress`. When the worker *died* before reporting done, nothing ever changed that status. The task sat `in-progress` forever. `RequestTask` only ever hands out `idle` tasks, so no other worker picked it up. The completion counter never reached its target, `Done()` never returned true, and the whole job ran until the test gave up. One dead worker deadlocks the entire computation.

This is exactly the failure MapReduce's fault tolerance exists to prevent — and I'd written everything *except* that.

**Fix:** failure detection by timeout. When a task is handed out, record when. If it's been `in-progress` longer than 10 seconds (the value the lab specifies), assume the worker is dead and reset the task to `idle` so another worker can take it. I implemented this as a small watchdog spawned per handout: it waits 10 seconds, then — only if the task is *still* in-progress — recycles it. If the worker finished in time, the task is already `completed` and the watchdog does nothing. Repeated failures self-heal: a recycled task gets handed out again, spawns a fresh watchdog, and eventually a healthy worker completes it.

This is also where gotcha-3's idempotency guard and the atomic-rename earn their keep: a reassigned task means two workers might both eventually report it (the guard prevents double-counting) and both might write its output (atomic rename means no corruption). The three decisions compose into correct recovery.

**Lesson:** the happy path is not the system. In distributed systems, the failure path *is* the system — it's most of why the thing is hard, and it's the part you can't skip. The most valuable thing I did in this lab was let the test hang and then understand *why* it could never make progress. A worker that vanishes silently is the default failure mode at scale, and "detect by timeout, recycle the task" is the foundational answer.

### 4. Go's `net/rpc` silently ignores methods with the wrong signature

A trap I avoided only because I studied the provided example handler first: Go's RPC framework registers a method **only** if its signature is exactly `func (t *T) Method(args *ArgType, reply *ReplyType) error` — pointer args, pointer reply, returns `error`, both types exported. Get any part wrong (non-pointer reply, no error return) and `rpc.Register` **silently skips it** — no warning, no error. The method just doesn't exist as far as RPC is concerned, and the caller fails with "can't find method."

**Root cause:** registration is reflection-based and best-effort; non-conforming methods are quietly excluded rather than flagged.

**Fix:** copy the exact signature shape from the starter's example handler. Don't improvise it.

**Lesson:** silent failures are the expensive ones. A loud compile error costs seconds; a silently-unregistered RPC method costs an hour of "but the method is *right there*." When a framework uses reflection to discover your code, conform to its contract precisely.

### 5. A zero-value enum that masquerades as a valid task

Small but worth recording. I defined the task-type constants with `iota`, which makes the first one `0`. The zero value of a Go `int` is also `0` — so a reply where I *forgot* to set the task-type field would silently look like a valid "map task" with an empty filename, rather than an obvious bug.

**Root cause:** Go zero-values everything; an enum whose zero value is a legitimate variant can't distinguish "deliberately set to the first variant" from "never set."

**Fix (the hardening option):** start the enum at `iota + 1`, so `0` means "nobody set this" — a detectable invalid state rather than a silent default.

**Lesson:** design your zero values on purpose. When the absence of a value and a real value are indistinguishable, you've built a silent-bug generator. (This cuts the other way too — for task *status*, I *wanted* the zero value to mean `idle`, so a freshly allocated slice is correctly all-idle for free. Same mechanism, used deliberately.)

---

## Performance observations on WSL

Run on WSL2 (Ubuntu, Go 1.18) on the laptop, project on native ext4, all tests with the `-race` detector enabled.

| Test | Time | What it exercises |
|---|---|---|
| TestWc | ~19.5 s | basic end-to-end correctness vs sequential oracle |
| TestIndexer | ~8.3 s | a different app on the same machinery |
| TestMapParallel | ~7.1 s | multiple workers mapping concurrently |
| TestReduceParallel | ~9.1 s | multiple workers reducing concurrently |
| TestJobCount | ~11.1 s | no over-scheduling (map called the right number of times) |
| TestEarlyExit | ~7.1 s | nothing exits before the job is truly done |
| TestCrashWorker | 23–43 s | recovery from workers crashing mid-task |
| Full suite | ~85–105 s | all of the above |

`TestCrashWorker` was the only one with meaningful run-to-run variance (23s to 43s across five reliability runs) — that's the random crash timing in the test app combined with the 10-second reassignment cycles. Every run still passed. The variance is a feature of the test, not flakiness in the implementation.

One harmless artifact worth noting for anyone else doing this: after the suite passes you'll see a few `dialing: ... connect: no such file or directory` lines. Those are straggler workers trying one last `RequestTask` after the coordinator has already exited and removed its socket. The lab explicitly says a handful of these per test is fine — they're the worker shutdown path, not a failure.

---

## What this leaves on the table

In rough order of how much I'd learn from each:

1. **Run it across two real machines** — the lab's no-credit challenge, and the one I'm most tempted by. The base lab is single-machine: Unix sockets and one shared local disk. Going truly distributed needs two changes — switch RPC from Unix sockets to TCP/IP (the starter has the commented-out line for it), and give the workers a genuinely shared filesystem (NFS) so a map worker on one machine writes intermediate files a reduce worker on another machine can read. I have a self-hosted homelab box alongside the laptop; treating the homelab's disk as the "GFS" and splitting workers across both machines would make the local-vs-durable-storage distinction from the paper real instead of theoretical. That's a weekend project and a better blog post than this one.
2. **The combiner optimization** — a mini-reduce on the map side to shrink intermediate data before the shuffle. Pure network-bandwidth optimization; conceptually easy, skipped because the single-machine lab doesn't reward it.
3. **Backup tasks for stragglers** — the paper's trick of launching duplicate copies of the last few in-progress tasks so a single slow machine doesn't drag out the whole job. The base lab doesn't require it (and tests that you *don't* over-schedule healthy tasks), but it's the same idea as the timeout watchdog pointed at slowness instead of death.

And then the rest of the course, which is the actual destination:

```
Lab 1: MapReduce        ✅  ← this post
Lab 2: KV Server            single-machine, concurrency
Lab 3: Raft                 consensus — the hard one
Lab 4: KV + Raft            a fault-tolerant KV store: a tiny etcd
Lab 5: Sharded KV           horizontal sharding across Raft groups
```

Lab 1 is the warm-up, but a real one — the coordinator/worker pattern, the task state machine, failure-by-timeout, and idempotent re-execution all recur, harder, in every lab after this.

---

## Closing

The thing I'll remember from Lab 1 isn't the map/reduce logic — that's a sequential program with the intermediate data spread across files instead of held in one slice. It's the ten-minute hang.

I had a system that worked perfectly as long as nothing went wrong, and the moment a worker died, it deadlocked silently and forever. Watching the test sit there until it panicked, and then reasoning through *why no progress was possible*, taught me more about distributed systems than the paper did. The fix — detect the dead worker by timeout, recycle its task, and make sure re-execution is safe via idempotent reporting and atomic writes — is small. Understanding why each piece is load-bearing is the whole lesson.

That, and an honest reminder that a lot of "distributed systems work" is actually environment work: the two gotchas that cost me the most time were Go plugins not building on Windows and Unix sockets not working on the `/mnt/c` filesystem. Neither has anything to do with MapReduce. Both are exactly the kind of yak-shave that's invisible in a tutorial and unavoidable in practice.

Next stop, eventually: Raft.

— Built and documented in June 2026 by [Omkar](https://github.com/omkar619-dev).
