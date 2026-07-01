---
title: 'server misbehaving: one DNS bug, two outages'
description: A single broken DNS upstream took down an Ollama pull and an ArgoCD sync on my k3s homelab hours apart. The second was sneaky — the host resolved fine but the cluster didn't. Here's the chain, and the Kubernetes gotcha behind it.
---

Two things broke on my homelab in one day. They looked unrelated — one was `ollama pull` refusing to download a model, the other was an ArgoCD application stuck in limbo. They turned out to be the *same* bug, wearing two different masks. This is the debugging trail, because the second half hides a Kubernetes gotcha worth knowing.

**The setup:** a single-node [k3s](https://k3s.io/) cluster on an old salvaged PC, GitOps'd by ArgoCD, reachable over Tailscale, with Ollama running local embeddings on-node.

## Symptom 1 — `ollama pull` can't resolve (morning)

```text
Error: pull model manifest: Get "https://registry.ollama.ai/.../manifests/0.5b":
dial tcp: lookup registry.ollama.ai on [fd7a:115c:a1e0::53]:53: server misbehaving
```

Read the tail: the DNS server it queried was `[fd7a:115c:a1e0::53]` — that's **Tailscale's MagicDNS** resolver. The box was funnelling *all* name resolution through MagicDNS, which had no working upstream for public names, so anything outside the tailnet came back `server misbehaving`.

The quick fix: point the host resolver at real public DNS.

```text
# /etc/resolv.conf
nameserver 1.1.1.1
nameserver 8.8.8.8
```

`ollama pull` worked. I moved on — which, as it turns out, was the mistake. I'd treated a symptom, not the cause.

## Symptom 2 — an ArgoCD app stuck `Unknown` (afternoon)

Later I went to bring more homelab services under ArgoCD, and noticed the one app already managed — `uptime-kuma` — was sitting at `SYNC STATUS: Unknown`. `kubectl describe application` gave the reason:

```text
ComparisonError: failed to list refs:
Get "https://github.com/.../omkar-homelab-gitops/info/refs?service=git-upload-pack":
dial tcp: lookup github.com on 10.43.0.10:53: server misbehaving
```

Same two words — **server misbehaving** — but a *different* DNS server this time: `10.43.0.10`. That's **CoreDNS**, the cluster's internal resolver. ArgoCD couldn't resolve `github.com`, so it couldn't fetch the GitOps repo, so it couldn't compare desired-vs-live state, so: `Unknown`.

## The twist: the host was completely fine

Here's what made this one sneaky. On the node itself:

```text
$ cat /etc/resolv.conf
nameserver 1.1.1.1
nameserver 8.8.8.8

$ getent hosts github.com
140.82.112.4    github.com
```

The host resolved `github.com` perfectly. So why couldn't the cluster? I tested resolution *from inside the cluster*, through CoreDNS, with a throwaway pod:

```text
$ kubectl run dnstest --image=busybox:1.36 --restart=Never -it --rm -- nslookup github.com
Server:    10.43.0.10
** server can't find github.com: SERVFAIL
```

CoreDNS `SERVFAIL`'d while the host succeeded. The lesson in one line: **host DNS working is not the same as cluster DNS working.** In Kubernetes you have to isolate *where* resolution breaks, and a busybox `nslookup` pod is the fastest probe for the cluster path.

## Root cause: a pod that froze a dead resolver

CoreDNS answers cluster-internal names itself and *forwards* everything else upstream. Its config (`kubectl get configmap coredns -n kube-system -o yaml`) had:

```text
forward . /etc/resolv.conf
```

It forwards to `/etc/resolv.conf` — but the **pod's** copy of that file. And here's the gotcha:

> A pod's `/etc/resolv.conf` is written **once, by kubelet, at pod-creation time**. It does **not** update when the node's file changes later.

My CoreDNS pod had last restarted ~14 hours earlier — back when the node's resolv.conf still pointed at the broken Tailscale MagicDNS. CoreDNS had frozen that dead upstream into its own copy. When I "fixed" DNS in the morning by editing the host file, CoreDNS never noticed: it was still faithfully forwarding to a resolver that no longer answered.

Same root cause as the morning — a DNS upstream with no route to public names — just one layer deeper, and invisible to any check run on the host.

## The fix

Give CoreDNS a fresh pod so it re-reads the corrected host file:

```text
$ kubectl -n kube-system rollout restart deployment coredns
deployment.apps/coredns restarted

$ kubectl run dnstest --image=busybox:1.36 --restart=Never -it --rm -- nslookup github.com
Name:    github.com
Address: 20.207.73.82
```

Resolves. A hard refresh on the ArgoCD app to re-trigger the fetch:

```text
$ kubectl -n argocd annotate application uptime-kuma argocd.argoproj.io/refresh=hard --overwrite
$ kubectl get application uptime-kuma -n argocd
NAME          SYNC STATUS   HEALTH STATUS
uptime-kuma   Synced        Healthy
```

## Takeaways

1. **A temporary fix on a flapping resolver is a time bomb.** The morning patch treated the symptom; the real problem — a DNS resolver with no working upstream — was left alive to resurface hours later in a completely different service.
2. **Host DNS ≠ pod DNS ≠ cluster DNS.** When resolution fails in Kubernetes, isolate the layer. A one-off `busybox` `nslookup` pod resolves through CoreDNS and tells you instantly whether the cluster path is the problem.
3. **Pods freeze `/etc/resolv.conf` at creation.** Fix a node's DNS and the pods depending on it won't pick it up on their own — especially CoreDNS. Restart them.
4. **Read the error literally.** "server misbehaving" plus the resolver's IP named the culprit both times: `[fd7a:...::53]` was Tailscale MagicDNS; `10.43.0.10` was CoreDNS.

## The real fix (still on my list)

Restarting CoreDNS only holds while the node's resolv.conf *stays* correct — and I've watched Tailscale flip it back. The durable fix is to stop depending on a resolver that has no upstream: either set a **Global Nameserver (`1.1.1.1`)** in the Tailscale admin so MagicDNS can actually resolve public names, or pin the node's resolver so a reboot can't re-arm it. Until that's in place, one restart of the wrong pod could bring the whole gremlin back. *(I'll update this post once it's locked in.)*
