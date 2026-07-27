---
title: 'The GPU was there all along: a dropped driver branch and a 53× speedup'
description: My RAG bot took 2m11s to answer one question on a 2008 machine. The GPU sitting in that machine had been invisible for months because a routine apt upgrade walked the NVIDIA driver past the point where it supported the card. Fixing that, plus one VRAM setting, took the answer to 3 seconds.
---

I'd just got the `@bot` RAG assistant in my Go chat project answering questions grounded in the room's own history. It worked. It also took **2 minutes 11 seconds** per answer, which is not a chat bot, it's a batch job.

**The setup:** a salvaged 2008 desktop — Core 2 Duo, **no AVX2**, 4 GB of DDR2 — running k3s, Ollama, and a GeForce GT 1030 that I had written off as useless. Embeddings (`all-minilm`, 23M params) were fast on it. Generation (`qwen2.5:1.5b`) was not:

```text
eval rate:        1.02 tokens/s
prompt eval rate: 1.33 tokens/s
```

At 1.33 tok/s for prompt processing, a RAG prompt of ~160 tokens costs **two minutes before the model writes a single word**. I assumed the CPU was simply too old and started planning to move generation to another machine.

## The clue I'd been ignoring for weeks

Every few seconds the physical console scrolled this:

```text
NVRM: The NVIDIA GeForce GT 1030 GPU installed in this system is
NVRM:   supported through the NVIDIA 580.xx Legacy drivers. Please
NVRM:   visit http://www.nvidia.com/object/unix.html for more
NVRM:   information.  The 610.43.02 NVIDIA driver will ignore this GPU.
```

I'd been treating this as cosmetic noise — I'd even silenced it with a `kernel.printk` tweak so I could read the console. It isn't cosmetic. It says the GPU is **being ignored**, which is why Ollama had been running CPU-only this whole time.

**Read the message literally:** driver `610.43.02` is installed, and this card needs the **580.xx legacy** branch.

## Root cause: NVIDIA dropped Pascal, and apt kept upgrading

The GT 1030 is `GP108` — **Pascal**, compute capability **6.1**. NVIDIA moved Maxwell, Pascal and Volta to *legacy* status with the **580** branch, meaning 580 is the **last** branch that supports these cards. 590, 595, 610 dropped them entirely.

So how did a Pascal box end up on 610? This:

```text
$ grep -rhE "^deb" /etc/apt/sources.list.d/ | grep -i cuda
deb ... https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/
```

NVIDIA's own CUDA repository, which always ships the newest driver branch, plus an installed `cuda-drivers` metapackage that depends on `nvidia-driver` (the *unversioned* one). A routine `apt upgrade` faithfully walked my driver forward, straight past the point where my hardware was supported. Nothing failed loudly. The GPU just quietly stopped existing.

**`cuda-drivers` was also invisible to the obvious check:**

```text
$ dpkg -l | grep -i nvidia     # 21 packages... and cuda-drivers is NOT among them
```

There's no "nvidia" in the name. I only found it when `apt purge` listed it as a dependency being removed.

## Three traps on the way to the fix

**1. `ubuntu-drivers` recommends the wrong thing.**

```text
$ ubuntu-drivers devices
model    : GP108 [GeForce GT 1030]
driver   : nvidia-driver-555 - third-party non-free recommended
driver   : nvidia-driver-580 - third-party non-free
```

It flags **555** as recommended. 555 would work — anything ≤580 supports Pascal — but that recommendation isn't reasoning about my card's legacy status. NVIDIA's own kernel message named 580, which is both the newest that works *and* the branch that'll get security updates longest. **Trust the hardware's error message over the packaging heuristic.**

**2. Do not install the `-open` variant.** `nvidia-driver-580-open` uses NVIDIA's open-source kernel modules, which require **Turing or newer**. Install that on Pascal and you reboot into exactly the same "will ignore this GPU" loop, having changed nothing.

**3. Verify DKMS *before* rebooting.** This is the step that turns a five-minute fix into an evening of confusion if you skip it:

```text
$ dkms status
nvidia/580.173.02, 6.8.0-124-generic, x86_64: installed
nvidia/580.173.02, 6.8.0-134-generic, x86_64: installed
```

DKMS compiles the kernel module against each installed kernel. If that build fails, you reboot into a machine with no driver and no obvious reason why.

## The fix

```text
$ sudo apt-get purge -y '^nvidia-.*' '^libnvidia-.*'    # dry-run this first, read the list
$ sudo apt-get autoremove -y
$ sudo apt-get install -y nvidia-driver-580
$ dkms status                                            # verify BEFORE rebooting
$ sudo apt-mark hold nvidia-driver-580 nvidia-dkms-580 cuda-drivers
$ sudo reboot
```

The **purge by regex** matters: leaving 610-era userspace libraries next to a 580 kernel module is the classic way to get a driver that loads but doesn't work. And the **hold** is the actual durable fix — without it, the next `apt upgrade` repeats the whole thing. My card can't use anything past 580, so freezing there isn't laziness, it's correct.

```text
$ nvidia-smi
| NVIDIA-SMI 580.173.02    Driver Version: 580.173.02    CUDA Version: 13.0 |
|   0  NVIDIA GeForce GT 1030   |   10MiB / 2048MiB  |  0%  Default        |
```

## A second red herring: "skipping CUDA device"

Ollama's log immediately produced something that looks fatal:

```text
skipping CUDA device — compute capability not in compiled architectures
  device="NVIDIA GeForce GT 1030" cc=610 archs="[750 800 860 ...]" libDirs="[.../cuda_v13]"

inference compute ... library=CUDA compute=6.1 name=CUDA0 description="NVIDIA GeForce GT 1030"
  libdirs=ollama,cuda_v12 total="1.9 GiB" available="1.9 GiB"
```

**The second line is the one that counts.** CUDA code is compiled ahead of time for specific compute capabilities. Ollama's `cuda_v13` build targets 7.5 and newer, so it skipped my 6.1 card — then fell back to its **`cuda_v12`** build, which still includes Pascal, and registered the GPU with 1.9 GiB available.

That's the *same pattern as the driver, one layer up*: old hardware survives on a legacy path, and the log about the modern path being skipped reads like an error when it's the fallback working correctly.

## Still not fast: a third of the model was on the CPU

First GPU benchmark: eval `1.02 → 3.67 tok/s`. Better, but far less than I expected. Then:

```text
$ ollama ps
NAME            SIZE     PROCESSOR          CONTEXT
qwen2.5:1.5b    1.4 GB   33%/67% CPU/GPU    4096
```

It didn't all fit. Between the model weights, CUDA context, compute buffers and a **KV cache sized for a 4096-token context**, 1.9 GiB wasn't enough — and the leftover third running on a Core 2 Duo throttled everything. A relay team with one runner on crutches.

My RAG prompts are a system prompt plus three retrieved messages plus a question: about 300 tokens. I did not need 4096.

```text
# /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_CONTEXT_LENGTH=2048"
Environment="OLLAMA_KEEP_ALIVE=30m"
```

A **drop-in** rather than editing the packaged unit, so an Ollama upgrade won't wipe it. (`systemctl set-environment` looks equivalent and isn't — it doesn't survive a reboot.)

## The payoff, and the thing I actually learned

```text
prompt eval rate: 70.97 tokens/s     (was 1.33)
eval rate:         4.66 tokens/s     (was 1.02)
```

**Prompt processing got 53× faster. Generation got 4.6×.** That gap isn't noise — it's the fundamental asymmetry of LLM inference, and I'd never seen it this starkly:

- **Prefill** (reading your prompt) processes every input token **in parallel** — nothing in the prompt depends on anything else in it. It's **compute-bound**, and parallel arithmetic is exactly what GPU cores are for.
- **Decode** (writing the answer) produces one token at a time, and each token requires reading **the entire model** from memory first. It's **memory-bandwidth-bound and strictly serial**. More cores don't help, because you can't compute word 10 before word 9 exists.

Which means output length *is* latency. Measured across three real answers:

| Answer | ≈ tokens | Time |
|---|---|---|
| 27 chars | ~7 | 3s |
| 97 chars | ~24 | 5s |
| 188 chars | ~47 | 10s |

Almost perfectly linear at ~4.66 tok/s. The cheapest way to make my bot feel faster isn't better hardware — it's telling the model to be brief.

**End to end: a RAG answer went from 2m11s to 3s.**

## Lessons

1. **A log line that says your hardware is being ignored is not cosmetic.** I silenced that NVRM spam with a `printk` tweak so I could read the console — treating the alarm as the problem. It had been telling me the exact fix, including the version number, for weeks.
2. **Vendor repos ship the newest thing, which isn't always the right thing.** NVIDIA's CUDA repo plus an unversioned metapackage will happily upgrade you past your own hardware's support window. If your GPU is legacy, `apt-mark hold` is part of the install, not an afterthought.
3. **Verify the kernel module built before you reboot.** `dkms status` is five seconds and turns "why is my display broken" into "the build failed, here's why."
4. **Prefill and decode are different workloads.** Fast embeddings on a box tell you nothing about generation on that box — one is a single parallel pass, the other is hundreds of serial ones. I'd used "embeddings are fine here" as evidence the CPU was adequate. It wasn't evidence of anything.
5. **Check what actually fit before blaming the hardware.** `ollama ps` and its `PROCESSOR` column turned "the GPU barely helps" into "two-thirds of the model is on the GPU and the other third is holding it back." One context-length setting recovered a 20× difference in prefill.
