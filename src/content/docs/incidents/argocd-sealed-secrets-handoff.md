---
title: 'Synced but Degraded: onboarding a Helm app into ArgoCD with Sealed Secrets'
description: Bringing a hand-installed app under GitOps sounds simple — until the sealed secret refuses to overwrite the Helm-created one, the controller gives up, and an annotation nudge gets silently ignored. The cutover gotcha, and the one-command fix.
---

I had my News Feed service running on my k3s homelab via a plain `helm install`, and Uptime Kuma already under ArgoCD. Time to bring News Feed under GitOps too — and to do it *properly*: secrets encrypted in git, not plaintext. That "properly" is where twenty minutes of education happened.

## Secrets are the hard part of GitOps

GitOps means git is the source of truth for the cluster. But you can't put plaintext DB passwords in a git repo. The standard answer is **Sealed Secrets**: a controller holds a private key that never leaves the cluster; you encrypt your Secret against its public key with `kubeseal`; you commit the *ciphertext* (a `SealedSecret`); the controller decrypts it into a real Secret in-cluster. Git only ever holds encrypted data — safe even in a public repo, because only that cluster's controller can unseal it.

## The setup

Briefly, the moving parts:

- Installed the `sealed-secrets` controller + the `kubeseal` CLI.
- Sealed News Feed's Secret (`newsfeed-secrets`, keys `DB_PASSWORD` / `JWT_SECRET` / `RABBITMQ_*`) and committed the encrypted `SealedSecret` to my GitOps repo.
- Added a `secrets.create` toggle to the Helm chart so ArgoCD could tell it *"don't make your own Secret — the SealedSecret handles it."*
- Wrote a **multi-source** ArgoCD `Application`: one source pulls the Helm chart (`secrets.create=false`), the other pulls the sealed secret. Applied it.

## Synced… but Degraded

```text
NAME       SYNC STATUS   HEALTH STATUS
newsfeed   Synced        Degraded
```

`Synced` = ArgoCD applied everything from git. `Degraded` = something under it is unhealthy. But every pod was `Running`. So what was degraded?

The `SealedSecret`'s own status had the answer:

```text
Message: Resource "newsfeed-secrets" already exists and is not managed by SealedSecret
```

My earlier *manual* `helm install` had already created `newsfeed-secrets`. And Sealed Secrets **deliberately refuses to overwrite a Secret it doesn't own** — a safety feature, so it can't clobber something another tool manages. So the SealedSecret sat there unhealthy, ArgoCD aggregated that into `Degraded`, and yet the app kept serving fine (the old Secret still held the right values).

## The trap: deleting the Secret wasn't enough

Obvious fix — delete the old Secret so the controller can create its own:

```text
kubectl delete secret newsfeed-secrets -n newsfeed
```

…and it didn't come back. The controller logs explained why:

```text
"Error updating, giving up" ... "already exists and is not managed by SealedSecret"
"update suppressed, no changes in spec"
```

Two things had happened:

1. The controller had **given up** — it exhausted its retries earlier, while the Secret still existed.
2. I then tried to nudge it by adding an annotation to the SealedSecret. It **ignored me**: *"update suppressed, no changes in spec."* The controller only re-processes a SealedSecret when its **spec** changes — an annotation is metadata, not spec. My nudge was a no-op.

## The fix: restart the controller

A restart forces a full reconcile of *every* SealedSecret from scratch — an initial sync, not an "update" it can suppress:

```text
kubectl rollout restart deploy sealed-secrets-controller -n kube-system
```

Seconds later:

```text
$ kubectl get secret newsfeed-secrets -n newsfeed
NAME               TYPE     DATA   AGE
newsfeed-secrets   Opaque   4      36s          # created fresh by the controller, owned by it

$ kubectl get application newsfeed -n argocd
NAME       SYNC STATUS   HEALTH STATUS
newsfeed   Synced        Healthy
```

## Lessons

1. **Cutover order matters.** Migrating an existing Secret to Sealed Secrets? Delete the old Secret *before* applying the SealedSecret. Do it the other way and the controller hits "already exists," gives up, and won't retry on its own.
2. **Sealed Secrets won't clobber a Secret it doesn't own.** A great safety property that's mildly infuriating mid-migration — until you know it's the reason.
3. **The controller reconciles on spec changes, not metadata.** "Just annotate it to trigger a re-sync" doesn't work here. Change the spec, or restart the controller.
4. **`Synced` ≠ `Healthy`.** ArgoCD applied everything from git (Synced) but a child resource was unhealthy (Degraded). Read both columns — then follow the unhealthy resource's *own* status to the real cause.

The app was never down through any of this. But properly onboarding one service to GitOps taught me more about the Sealed Secrets ownership model in twenty minutes than the docs did — which is exactly what a homelab is for.
