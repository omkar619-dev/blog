---
title: "The machine didn't move, its address did"
description: Both SSH routes to my homelab box died at the same moment — the tailnet one and the LAN one. That looked like a dead network card. It was actually two unrelated things, and the fix was a single row in my router's DHCP table.
---

Mid-session on my homelab box, SSH stopped working. Both ways in:

```text
$ ssh oldpc          # tailnet, 100.72.182.75
ssh: connect to host 100.72.182.75 port 22: Connection timed out

$ ssh oldpc-lan      # LAN, 192.168.29.123
ssh: connect to host 192.168.29.123 port 22: Connection timed out
```

Two independent routes failing at the same instant is a useful signal. Tailscale breaking shouldn't affect the LAN path; a changed LAN address shouldn't affect the tailnet path. **When two independent paths fail together, suspect the thing they share** — which pointed straight at the network interface.

That box runs on a USB-Ethernet adapter (the onboard NIC is dead) with a documented habit of resetting itself:

```text
usb usb2-port2: disabled by hub (EMI?), re-enabling
```

Confident diagnosis. Also wrong.

## What the console actually said

The box has a monitor attached, which earned its keep here. Logging in locally:

```text
System load:  0.69
Memory usage: 49%
Processes:    270
IPv4 address for enx00e04c36023e: 192.168.29.124
```

Perfectly healthy. And the address was **`.124`**, not the `.123` my SSH config pointed at. The interface was up the whole time — the machine had simply been renumbered underneath me.

## Two separate causes wearing one costume

**Cause 1: my laptop had dropped off the tailnet.** Checking from the box:

```text
$ tailscale status
100.72.182.75   omkarhomelaboldpc   linux    -
100.80.139.111  laptop-cr1pnpsg     windows  offline, last seen 1d ago
```

The *server* was fine. My **laptop** wasn't on the tailnet at all, and a machine that isn't on the tailnet can't route to tailnet addresses. I'd spent time investigating the remote end of a problem that lived on the end I was typing on.

**Cause 2: the DHCP lease moved.** And this explains why the tailnet path died *too* — Tailscale had negotiated a direct connection pinned to the old LAN address:

```text
100.72.182.75  omkarhomelaboldpc  active; direct 192.168.29.123:41641
```

When `.123` stopped being that machine, the direct path went stale and had to renegotiate. So the LAN change took out both routes, which is exactly the symptom I'd read as "shared hardware failure."

## Why the address kept moving

This was the *third* address that box had held:

```text
192.168.1.105  →  192.168.0.232  →  192.168.29.123  →  192.168.29.124
```

Two different things were going on. The `192.168.0.x → 192.168.29.x` jump changed the whole **subnet** — that's a different router, not lease churn. (`192.168.29.1` is the JioFiber default gateway.)

The `.123 → .124` hop was ordinary DHCP behaviour, and I caused it. The router's config:

```text
DHCP Mode:        DHCP Server
Start IP Address: 192.168.29.2
End IP Address:   192.168.29.254
Lease Time:       22 hours
```

Addresses are **22-hour rentals**. A device normally renews and keeps the same one — but I'd rebooted the box (unrelated GPU driver work), and on the next request the router still had `.123` marked as leased to the previous session, so it handed out the next free address. Nothing malfunctioned. DHCP did exactly what DHCP does.

## The collateral damage nobody reports

An IP that moves silently breaks everything that hardcoded it, and **none of those things raise an alarm**:

- `ssh oldpc-lan` — loud, I noticed immediately
- My chat project's `OLLAMA_URL` default — loud, the bot errored
- **My News Feed deployment's ArgoCD `ollamaURL`, still pointing at `192.168.0.232`** — completely silent. That address had been dead for a day. Embeddings were failing on every new post, so semantic search was quietly degrading on my deployed portfolio project, with no error anywhere I was looking.

That last one is the real lesson of this incident. The outage I noticed took twenty minutes. The outage I didn't notice had been running for a day.

## The fix: reserve the address

Note the DHCP pool above spans `.2` to `.254` — **the entire usable subnet**. There is no "outside the pool" to park a static address in, so a reservation is the only option. In the router's `LAN → LAN IPv4 Reserved IPs`:

| Computer Name | IP Address | MAC Address |
|---|---|---|
| omkarhomelaboldpc | 192.168.29.124 | 00:e0:4c:36:02:3e |

The **MAC address** is what makes this durable. It's burned into the adapter and never changes, so the router can always recognise the machine regardless of what it's currently called or addressed as. Reserving the address it *already had* also means nothing downstream needed updating.

For application config I went further and switched to the **tailnet address**, `100.72.182.75`. Tailscale assigns that for the life of the node — it has never changed and structurally can't drift with DHCP. The tradeoff is a dependency on Tailscale being up at both ends, which is precisely what bit me an hour earlier, so it's a genuine trade rather than a free win. The reservation is the fix; the tailnet address is the fix that works without router access.

## Lessons

1. **When two independent paths fail simultaneously, suspect the shared layer — but verify which layer.** I got the reasoning right and the conclusion wrong: the shared thing wasn't the failing NIC, it was the LAN address that Tailscale's direct path was pinned to.
2. **Check your own end first.** My laptop was offline on the tailnet. I went looking at the server. Thirty seconds of `tailscale status` from *either* side would have said so immediately.
3. **A monitor on a headless box is worth keeping.** The MOTD printed the new IP the instant I logged in locally. No amount of probing from the network side would have told me that, because the network side is what was wrong.
4. **DHCP reservations aren't optional for infrastructure.** Anything other machines address by IP needs a fixed one. A 22-hour lease means every reboot is a coin flip, and reboots are exactly when you're least in the mood to debug networking.
5. **Audit what else hardcoded that address.** The SSH failure announced itself. The broken embeddings on my deployed app didn't, and wouldn't have, until someone tried to search and got poor results. When an address changes, grep for the old one everywhere — including inside cluster manifests.
