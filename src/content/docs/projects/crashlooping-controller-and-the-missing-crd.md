---
title: The Controller That Crash-Looped 336 Times — and the CRD That Was Never Installed
description: I moved my homelab to a new house, ran a health check, and found an ArgoCD pod that had restarted 336 times. The obvious suspect was the RAM I'd just fixed. It wasn't. Here's the whole SRE loop — ruling out OOM, reading the clock, following the logs — down to a missing CRD, and the annotation-size gotcha that dropped it at install time.
---

I'd just moved my homelab — a 2008 Core 2 Duo running k3s and ArgoCD (the [GitOps setup I wrote about here](/projects/gitops-argocd-homelab/)) — into a new house. Before trusting it again, I ran the usual health sweep. Most of it was fine. One line wasn't: an ArgoCD pod that had restarted **336 times**.

The obvious suspect was the RAM — I'd *just* discovered, and fixed, that the box was secretly running on half its memory. Case closed, surely. It wasn't. The gap between "surely" and the actual cause is the whole point of this post.

## The red herring: the RAM I'd just fixed

First thing the health check turned up:

```
$ free -h
               total        used        free   available
Mem:           1.9Gi       1.5Gi        67Mi      409Mi
Swap:          3.8Gi       805Mi       3.0Gi
```

1.9 GiB total. This machine is supposed to have 4 GB. `dmidecode` explained it:

```
Size: 2 GB            Locator: DIMM0
Size: No Module Installed   Locator: DIMM1
```

One stick, one empty slot. A DIMM had worked loose — the box had just survived a car ride across town. Shut down, reseat, boot:

```
$ free -h
               total        used        free   available
Mem:           3.8Gi       1.3Gi       1.6Gi      2.5Gi
Swap:          3.8Gi          0B       3.8Gi
```

4 GB back, 2.5 GiB free, swap untouched. For weeks on 2 GB the cluster had been quietly OOM-thrashing — the high restart counts scattered across every pod (`metrics-server` 19, `svclb-traefik` 31) were the scar tissue from the kernel repeatedly killing things to survive.

So when I saw **336 restarts** on `argocd-applicationset-controller`, the story wrote itself: starved box, OOM-killed pod, now fixed. The story was wrong.

## Ruling out the obvious (read the termination reason)

Before believing my own narrative, I asked the pod how it actually died:

```bash
kubectl -n argocd describe pod argocd-applicationset-controller-... | grep -A6 "Last State"
```

```
Last State:     Terminated
  Reason:       Error
  Exit Code:    1
  Started:      Mon, 20 Jul 2026 14:01:02 +0000
  Finished:     Mon, 20 Jul 2026 14:03:02 +0000
Restart Count:  336
```

**`Reason: Error`, not `OOMKilled`.** That one word settles it. If the kernel had killed this container for exceeding memory, Kubernetes labels the termination `OOMKilled` — explicitly. It didn't. The process *chose* to exit, with code 1. My RAM fix was real, but this pod's problem was never about memory. First instinct disproved in a single command.

## The clock was the clue

Look again at those two timestamps: started `14:01:02`, finished `14:03:02`. **Exactly 120 seconds.** And it was the same every cycle.

Crashes aren't usually punctual. A panic fires the instant the bad thing happens — some ragged interval, not a tidy two-minute schedule. A round, repeatable lifetime means something is *timing it out*, not something breaking at random. I didn't know what yet, but I knew the shape: a deadline, not a fault. Hold that thought.

## The logs said it plainly

`--previous` failed (the crashed container had already been garbage-collected), but the live container runs for ~2 minutes before dying, so there's a window to catch it:

```bash
kubectl -n argocd logs argocd-applicationset-controller-... --tail=50
```

```
"ArgoCD ApplicationSet Controller is starting" version "v3.4.3"
"Starting EventSource" source: "kind source: *v1alpha1.ApplicationSet"
error "failed to get restmapping: no matches for kind \"ApplicationSet\"
       in version \"argoproj.io/v1alpha1\""
      "if kind is a CRD, it should be installed before calling Start"
   ... (that error, once every 10 seconds) ...
error "timed out waiting for cache to be synced for Kind *v1alpha1.ApplicationSet"
"problem running manager"        → exit 1
```

There it is: **`no matches for kind "ApplicationSet"`.** The cluster's API server has never heard of an ApplicationSet. The controller's entire job is to watch ApplicationSet objects — and that object type does not exist on this cluster.

## Why a missing CRD makes a controller crash-loop

A quick rung of theory, because this is the satisfying part.

A **CRD** (Custom Resource Definition) is how you teach Kubernetes a new *kind* of object. ArgoCD normally installs three: `Application`, `AppProject`, and `ApplicationSet`. Until the CRD is applied, the API server literally has no such type.

Controllers built on **controller-runtime** (which ArgoCD's are) don't hit the API on every event — they build a local in-memory **cache** (an informer) of the resources they watch and keep it in sync. To build that cache, the manager first resolves the kind through the RESTMapper. No CRD → no kind → the informer can *never* sync, because it's waiting on a resource type that doesn't exist.

And controller-runtime has a **default cache-sync timeout of exactly two minutes.** Miss it and the manager gives up and exits with an error. That's the punctual 120 seconds from the `describe` output — not a liveness probe, not a panic, but a startup deadline the controller had no way to meet. The `Application` CRD *is* installed (which is why the rest of ArgoCD is perfectly healthy); only `ApplicationSet`'s is missing, so only that one controller is stuck.

## Why the CRD was missing (the install-time gotcha)

ArgoCD ships three CRDs. Mine had two. The likely culprit is a sharp edge of plain `kubectl apply`: client-side apply stashes a full copy of the object in a `kubectl.kubernetes.io/last-applied-configuration` **annotation**, and annotations are capped at **256 KB**. ArgoCD's CRDs are large; applying a big one can fail with `metadata.annotations: Too long: must have at most 262144 bytes`. Two of the three scraped under the limit; `ApplicationSet` didn't, and the install quietly carried on without it.

The fix that avoids the entire class of problem is **`kubectl apply --server-side`**, which doesn't use that annotation at all.

## The fix, chosen on purpose

Two honest options:

- **I don't use ApplicationSets** — my apps are plain manifests, no App-of-Apps pattern yet. So the correct move is to stop running a controller that has nothing to do:
  ```bash
  kubectl -n argocd scale deploy argocd-applicationset-controller --replicas=0
  ```
  Reversible with `--replicas=1` the day I adopt the pattern.
- **If I wanted the feature**, install the missing CRD — server-side, matching the controller version — and the controller heals itself the moment the kind exists:
  ```bash
  kubectl apply --server-side \
    -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.3/manifests/crds/applicationset-crd.yaml
  ```

I scaled it to zero. A controller crash-looping for a feature you don't use isn't a bug to fix — it's a component to remove.

## The lesson

Three things I'm keeping from this one:

1. **Don't blame the thing you just touched.** I'd fixed the RAM ten minutes earlier, and it made the perfect scapegoat. The termination reason — `Error`, not `OOMKilled` — killed that theory in one line. Read the reason before you write the story.
2. **Timing is a signal.** A crash at a round, repeatable interval isn't random; it's a timeout. The 120 seconds told me it was a *deadline* before the logs told me *which* deadline.
3. **A controller is only as installed as its CRDs.** The Deployment can be flawless and the workload still impossible, because the resource it watches was never registered.

The tidy version — the one that's actually an interview answer: *ruled out OOM from the termination reason, used the exact two-minute lifetime as a clue, pulled the logs, found a controller watching a CRD that was never installed, and either removed it or installed the CRD server-side to dodge the annotation limit that dropped it at install.* Cause, not symptom.

— Debugged and documented in July 2026 by [Omkar](https://github.com/omkar619-dev).
