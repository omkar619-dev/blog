---
title: GitOps with ArgoCD on a 4 GB Homelab
description: Adding ArgoCD-managed GitOps to a self-hosted k3s cluster, migrating Uptime Kuma as the first service. Real gotchas, ArgoCD's reconciliation behaviour, and what GitOps actually buys on a 2008 Core 2 Duo.
---

This is the next step after Phase 1.5 (see `k8s-deployment.md`). The k3s cluster on the 2008 Core 2 Duo has been running StudentSystemGo for ~12 days, deployed by a self-hosted GitHub Actions runner doing `helm upgrade --install`. That's imperative deployment dressed up as automation — the runner is the thing that decides cluster state by running commands, and there's no continuous reconciliation if something drifts.

This phase moves the cluster onto **GitOps**: Git becomes the source of truth, ArgoCD continuously reconciles, and `kubectl apply` from a human is the exception, not the path. First service migrated under the new model: **Uptime Kuma**, the monitor for everything else in the homelab.

The post that follows is the actual walkthrough — what I built today (4 hours of focused work), what broke, what I learned about ArgoCD's internals along the way.

---

## Table of contents

- [Why GitOps when Helm + CI already worked](#why-gitops-when-helm--ci-already-worked)
- [Architecture overview](#architecture-overview)
- [The actual setup sequence](#the-actual-setup-sequence)
- [Real gotchas encountered](#real-gotchas-encountered)
- [ArgoCD reconciliation — what the 3-minute default actually means](#argocd-reconciliation--what-the-3-minute-default-actually-means)
- [What this leaves on the table](#what-this-leaves-on-the-table)
- [Closing](#closing)

---

## Why GitOps when Helm + CI already worked

The honest answer in two halves.

**The career half**: Platform Engineer JDs I'm targeting (Razorpay, Atlassian, Booking, ClickPost) treat GitOps as table stakes. ArgoCD or FluxCD shows up under "Mandatory Requirements" not "Strongly Preferred." A homelab that uses Helm but applies it imperatively is one rung below — same artefacts, weaker operational model. The migration is a 4-hour investment to flip that signal.

**The engineering half**: Helm + CI is imperative — the runner decides desired state by executing a command at a moment in time. After that, nothing reconciles. If I kubectl-edit a Deployment by hand at 2am, the cluster diverges from git and stays diverged until the next CI run overwrites it (or doesn't, if the change wasn't in the values file the runner reads). GitOps fixes the gap:

- **Continuous reconciliation** — ArgoCD compares the cluster to git every 3 minutes (default; configurable). Drift is auto-corrected unless I disable selfHeal.
- **Single source of truth** — `kubectl get application -n argocd uptime-kuma -o yaml | grep revision` tells me the exact commit SHA the cluster is on. There's no "what version is actually running?" mystery.
- **Audit trail comes for free** — every cluster change is a git commit, with author, message, and diff. Better than scrolling through Actions logs.
- **Rollback is `git revert`** — not "manually re-run the previous Helm upgrade with the correct values file."
- **UI for free** — ArgoCD ships a UI that visualises the resource graph (Application → Deployment → ReplicaSet → Pod → ConfigMap → PVC), with health and sync state per node. Useful for debugging, useful in demos.

The honest downsides:

- **ArgoCD itself costs ~600 MB of RAM** in its idle state. On 4 GB total, with k3s control plane (~400 MB) and StudentSystemGo (~700 MB) and OS (~500 MB), there's not a lot of headroom left.
- **Reconciliation latency** — git push to cluster change isn't instant. Default polling is 3 minutes, which surprised me the first time (more on this below).
- **Another component to debug** — when something doesn't apply, the question shifts from "did the manifest apply?" to "did ArgoCD see the commit? did the sync succeed? did the manifest reach the cluster?" Three new failure modes layered on top of "is the resource correct?"

For homelab scale, GitOps is unambiguously overkill on technical merit. For Platform Engineer career signal, it's the obvious next step. I'm doing this for the second reason, with eyes open about the first.

---

## Architecture overview

The flow from a `git push` to a pod running on the cluster:

```
┌─────────────────────────────────────────────────────────┐
│  GitHub repo (private)                                  │
│  omkar619-dev/omkar-homelab-gitops                      │
│  ├── apps/                                              │
│  │   └── uptime-kuma/                                   │
│  │       ├── namespace.yaml                             │
│  │       ├── pvc.yaml                                   │
│  │       ├── deployment.yaml                            │
│  │       └── service.yaml                               │
│  └── infrastructure/                                    │
│      └── argocd/                                        │
│          └── uptime-kuma-application.yaml               │
└────────────────┬────────────────────────────────────────┘
                 │ git push origin main
                 │
                 │ (ArgoCD repo-server polls every 3 min,
                 │  or webhook if configured)
                 ▼
┌─────────────────────────────────────────────────────────┐
│  ArgoCD running in the argocd namespace                 │
│  ├── argocd-server          (UI + API)                  │
│  ├── argocd-repo-server     (clones git, renders YAML) │
│  ├── argocd-application-    (reconciles Apps to cluster)│
│  │   controller                                         │
│  ├── argocd-dex-server      (auth)                      │
│  ├── argocd-notifications-                              │
│  │   controller                                         │
│  ├── argocd-applicationset-                             │
│  │   controller                                         │
│  └── argocd-redis           (caching)                   │
└────────────────┬────────────────────────────────────────┘
                 │ kubectl apply (server-side, with
                 │  argocd.argoproj.io/tracking-id label)
                 ▼
┌─────────────────────────────────────────────────────────┐
│  k3s cluster (Old PC, Core 2 Duo, 4 GB)                 │
│  ├── argocd ns         — ArgoCD itself                  │
│  ├── studentsystemgo ns — Phase 1.5 workload            │
│  │   (still managed by Helm + CI, not yet GitOps)       │
│  ├── kube-system ns     — coredns, traefik, etc.        │
│  └── uptime-kuma ns     — NEW, fully GitOps-managed     │
│        ├── Deployment   — louislam/uptime-kuma:1        │
│        ├── PVC          — 2 Gi for SQLite + history     │
│        └── Service      — NodePort :30001               │
└─────────────────────────────────────────────────────────┘
```

What `kubectl get application -n argocd` returns once the loop is closed:

```
NAME          SYNC STATUS   HEALTH STATUS
uptime-kuma   Synced        Healthy
```

That row is the entire promise of GitOps. The cluster reports back: "I match what's in git, and the running workload is healthy." Anything else is a sync error or a health degradation, both with structured diagnostics in the UI.

---

## The actual setup sequence

The cluster already existed. So Phase 1 (install k3s) was skipped — I had a 12-day-old k3s control plane already running StudentSystemGo. Steps that mattered:

### 1. Install ArgoCD

The official install manifest, applied to a dedicated namespace:

```bash
kubectl create namespace argocd
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

This deploys all seven ArgoCD components: server, repo-server, application-controller (StatefulSet), notifications-controller, applicationset-controller, dex-server, and redis. First image pull on the Core 2 Duo's 2 Mbps USB-Ethernet took ~31 seconds for the 195 MB `quay.io/argoproj/argocd:v3.4.3` image. Total time from `apply` to all pods Ready: ~3 minutes.

### 2. Get the admin password and expose the UI

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d ; echo

kubectl port-forward svc/argocd-server -n argocd 8080:443 --address 0.0.0.0 &
```

The `--address 0.0.0.0` is needed because by default port-forward only binds to loopback. I'm SSH'd in from a laptop and need to reach the UI from outside the box.

Login at `https://<old-pc-ip>:8080`. The cert is self-signed — browser warns, click through.

### 3. Create the GitOps repo

Private repo on GitHub, then clone:

```bash
mkdir -p ~/omkar-homelab-gitops
cd ~/omkar-homelab-gitops
git init
git remote add origin git@github.com:omkar619-dev/omkar-homelab-gitops.git

mkdir -p bootstrap infrastructure/argocd apps/uptime-kuma
```

Folder convention:

- `bootstrap/` — one-time manifests to install ArgoCD itself (chicken-and-egg manifests)
- `infrastructure/argocd/` — `Application` CRs that tell ArgoCD what to watch
- `apps/<service>/` — actual K8s resources per application

### 4. Connect ArgoCD to the repo

In the UI: Settings → Repositories → CONNECT REPO → HTTPS, with a GitHub Personal Access Token as the password. PAT scope: `repo`.

Once it shows Successful, ArgoCD's repo-server can clone the repo. Without this step, every subsequent Application will fail with `failed to list refs: authentication required: Repository not found` — which is GitHub's misleading way of saying "this is private and you didn't auth."

### 5. Write Uptime Kuma's K8s manifests

Four files in `apps/uptime-kuma/`:

`namespace.yaml`:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: uptime-kuma
```

`pvc.yaml` — 2 GB persistent volume on k3s's `local-path` provisioner:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uptime-kuma-data
  namespace: uptime-kuma
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path
  resources:
    requests:
      storage: 2Gi
```

`deployment.yaml` — single replica, resource limits tight enough to fit alongside StudentSystemGo:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: uptime-kuma
  namespace: uptime-kuma
spec:
  replicas: 1
  selector: { matchLabels: { app: uptime-kuma } }
  template:
    metadata: { labels: { app: uptime-kuma } }
    spec:
      containers:
        - name: uptime-kuma
          image: louislam/uptime-kuma:1
          ports: [{ containerPort: 3001 }]
          volumeMounts:
            - { name: data, mountPath: /app/data }
          resources:
            requests: { memory: 128Mi, cpu: 100m }
            limits:   { memory: 300Mi, cpu: 500m }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: uptime-kuma-data }
```

`service.yaml` — NodePort 30001, since I haven't set up Ingress routing for this service yet:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: uptime-kuma
  namespace: uptime-kuma
spec:
  type: NodePort
  selector: { app: uptime-kuma }
  ports:
    - { port: 3001, targetPort: 3001, nodePort: 30001 }
```

### 6. The Application manifest — what ArgoCD actually watches

`infrastructure/argocd/uptime-kuma-application.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: uptime-kuma
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/omkar619-dev/omkar-homelab-gitops.git
    targetRevision: main
    path: apps/uptime-kuma
  destination:
    server: https://kubernetes.default.svc
    namespace: uptime-kuma
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

`automated.prune: true` — if a resource is removed from git, ArgoCD deletes it from the cluster. `selfHeal: true` — if someone kubectl-edits a managed resource by hand, ArgoCD reverts it back to what git says. Both are off by default; turning them on is what makes ArgoCD actually authoritative.

Then:

```bash
kubectl apply -f infrastructure/argocd/uptime-kuma-application.yaml
git add . && git commit -m "Add uptime-kuma via GitOps" && git push origin main
```

3 minutes later (or immediately, if I clicked REFRESH in the UI), ArgoCD pulled the repo, rendered the four resource manifests, applied them to the cluster, and reported `Synced` + `Healthy`. Uptime Kuma's first-time setup page rendered at `http://<old-pc-ip>:30001`.

That's the loop. From here, deploying a new service is: write YAML, commit, push, wait.

---

## Real gotchas encountered

The reason I'm documenting this in detail is because the bugs I hit are textbook Platform Engineer debugging. Worth writing down.

### 1. "Repository not found" — wrong repo name in Application manifest

After the first commit, the Application showed:

```
Status: Failed to load target state: failed to generate manifest for source 1
of 1: rpc error: code = Unknown desc = failed to list refs: authentication
required: Repository not found.
```

The error says "authentication required" AND "Repository not found." Misleading: GitHub returns "Repository not found" for private repos when the requester is unauthenticated, even if the repo exists. So this looks like an auth problem when it can also be a typo problem.

In my case, it was the typo:

```bash
$ kubectl get application -n argocd -o yaml | grep repoURL
  repoURL: https://github.com/omkar619-dev/homelab.git    # WRONG
```

But the actual repo is:

```bash
$ git remote get-url origin
https://github.com/omkar619-dev/omkar-homelab-gitops.git   # RIGHT
```

I'd copy-pasted my own placeholder name from a planning doc into the Application manifest. ArgoCD was trying to clone a repo that doesn't exist. With private-repo auth, GitHub responds with "not found" — same response it gives for "you don't have access."

**Fix**: edit the Application source file, commit, kubectl apply, sync.

**Lesson**: when ArgoCD says "authentication required: Repository not found," check the URL letter-by-letter before chasing PAT scopes. Trust the literal text of the error after disambiguating GitHub's intentionally-ambiguous response.

### 2. `kubectl edit` opens vi and I didn't know how to exit

While debugging the wrong repo URL, I ran `kubectl edit application -n argocd uptime-kuma`. Kubernetes opens the resource in `$KUBE_EDITOR`, defaulting to `$EDITOR`, defaulting to `vi`. I'd been using `nano` for all my homelab editing and reflexively typed text into the file. Vi happily ignored the commands and inserted "writequit" into the YAML.

**Fix**: `Esc` to exit insert mode, `:wq` to write and quit. Or `:q!` to abandon changes.

Set it permanently:
```bash
echo 'export KUBE_EDITOR=nano' >> ~/.bashrc
source ~/.bashrc
```

**Lesson**: small competency, large embarrassment cost. Worth learning vi's three keystrokes (`i` to insert, `Esc`, `:wq`) since editor-popups are unavoidable in K8s operations (`kubectl edit`, `git rebase -i`, `crontab -e`). Cost me 5 minutes the first time.

### 3. ArgoCD's 3-minute reconciliation default is real

After fixing the repo URL and pushing the corrected manifest, the cluster didn't update. The UI still showed `Synced` against the OLD commit. I assumed something was broken.

It wasn't broken. ArgoCD's `argocd-cm` ConfigMap has a `timeout.reconciliation` field that defaults to `180s`. The application-controller polls each Application's git source every 180 seconds. Between pushes, it doesn't notice — it's just not looking.

```bash
$ kubectl get configmap argocd-cm -n argocd \
    -o jsonpath='{.data.timeout\.reconciliation}'
# empty output → using default 180s
```

The UI has a REFRESH button (next to SYNC) that forces an immediate git poll. Hitting REFRESH after every push sidesteps the 3-minute wait. The better long-term answer is a GitHub webhook that POSTs to ArgoCD on every push — but that requires ArgoCD's API to be reachable from GitHub, which means exposing it via Cloudflare Tunnel (deferred to a later phase).

**Fix for impatient debugging**: in the UI, REFRESH → then SYNC. Or shorten the interval:
```bash
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"timeout.reconciliation":"60s"}}'
kubectl rollout restart statefulset argocd-application-controller -n argocd
```

**Lesson**: GitOps isn't real-time by default. The polling-vs-webhook distinction is the difference between 5-second feedback and 3-minute feedback. For dev iteration, configure webhooks or shorten the poll. For production, leave it at 3 minutes to be gentle on the git host.

### 4. Image pulls dominate first-deploy wall time

The Uptime Kuma pod sat in `ContainerCreating` for nearly 4 minutes after the first sync. Initially I assumed something was wrong with the PVC binding or the resource scheduling.

It was just the image pull. `louislam/uptime-kuma:1` is ~250 MB compressed. Over the Core 2 Duo's USB-Ethernet at ~2 Mbps measured throughput, that's a minimum ~17 minutes of pure transfer time. In practice Docker Hub serves with some parallelism and the actual measured time was closer to 3-4 minutes including container creation, PVC mount, and Uptime Kuma's first-boot SQLite init.

The right way to verify is `kubectl describe pod -n uptime-kuma <pod-name>` and read the Events section — you see `Pulling image` followed by `Pulled image (in Xs)` with the actual duration. No mystery, just slow.

**Fix**: wait. Or pre-pull on the node:
```bash
sudo k3s ctr -n=k8s.io images pull docker.io/louislam/uptime-kuma:1
```

After the first pull, subsequent deploys are near-instant because the image is in containerd's local cache. The 4 minutes is a one-time cost per image.

**Lesson**: on slow hardware/network, image-pull time dominates wall-clock time for first deploys. Build observability around it (`kubectl describe`, Events) before assuming a bug.

### 5. Resource conflict: cluster has Helm-managed app and new GitOps-managed app side by side

Background: StudentSystemGo lives in the `studentsystemgo` namespace and is deployed by a Helm chart run from a GitHub Actions self-hosted runner. Uptime Kuma is now in `uptime-kuma` namespace, deployed by ArgoCD watching the new git repo.

These don't conflict directly — different namespaces, different management surfaces. But the cluster now has two competing answers to "where is the source of truth for what runs here":

- For StudentSystemGo: the CI runner's Helm command and its local values files
- For Uptime Kuma: the git repo ArgoCD watches

If I ever want to query "what version of every workload is supposed to be running?" — the answer is split. ArgoCD can tell me about Uptime Kuma's commit SHA. For StudentSystemGo I'd have to look at the last Actions run's logs.

**Fix**: migrate StudentSystemGo to GitOps too. Move the Helm chart into the GitOps repo and create an `Application` of `helm` source type pointing at it. ArgoCD natively supports Helm — it renders the chart with values and applies the result, same as `helm upgrade` would. The CI runner becomes redundant (or repurposes to "kubectl apply the bootstrap Application after a cluster rebuild").

**Lesson**: the slowest part of a GitOps migration isn't the first service, it's the last. Each parallel-managed workload is a divergence point. The benefits of GitOps compound only when everything is on GitOps. Plan to migrate workloads steadily; don't leave half the cluster in the old model long-term.

Deferred to next month.

---

## ArgoCD reconciliation — what the 3-minute default actually means

Worth a section on its own because the answer surprised me.

The 3 minutes isn't an idle delay — it's the interval at which the application-controller (StatefulSet, single replica by default) compares every Application's desired state (rendered from git) against actual cluster state. The work it does per cycle:

1. **Refresh** — clone or pull the git repo via the repo-server pod. Repo-server caches manifests, so most refreshes are cheap.
2. **Render** — for `directory` source types (raw YAML), parse the files. For `helm` source, run `helm template`. For `kustomize`, run `kustomize build`.
3. **Compare** — diff rendered manifests against the live resources in the cluster. If selfHeal is on, prepare a sync operation for any drift.
4. **Sync if needed** — apply the diffs. This is `kubectl apply --server-side` under the hood, with `app.kubernetes.io/instance` and `argocd.argoproj.io/tracking-id` labels added.
5. **Health check** — query each resource's status. For Deployments, "Healthy" means `status.observedGeneration == metadata.generation && availableReplicas == replicas`. Per resource type, ArgoCD has built-in health rules; custom Lua rules can be added via the `argocd-cm` ConfigMap.

You can watch this happen in real time:

```bash
kubectl logs -n argocd statefulset/argocd-application-controller -f \
  | grep -i "Refreshing\|Comparing\|Performing sync"
```

For 30-second iteration during heavy dev:

```bash
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"timeout.reconciliation":"30s"}}'
kubectl rollout restart statefulset argocd-application-controller -n argocd
```

Then for steady-state, return to 180s. The tradeoff is API load on git (more pulls), CPU on the controller (more diffs), and quota with hosted git providers (GitHub rate-limits repo clones for high-frequency callers). 180s is a sane default that scales to ~100s of Applications without GitHub complaining.

A GitHub webhook makes this entire conversation moot — when you push, GitHub POSTs to `https://<argocd-host>/api/webhook`, ArgoCD reconciles immediately, sync happens in 5-15 seconds. The polling exists as a fallback for when webhooks aren't configured (or your push doesn't reach the hook for whatever reason).

---

## What this leaves on the table

Honest accounting of what's not done yet, roughly in priority:

1. **GitHub webhook → ArgoCD** — get reconciliation latency from 3 minutes to ~10 seconds. Requires ArgoCD's API to be reachable from GitHub, which means a Cloudflare Tunnel route. Probably next weekend.
2. **Migrate StudentSystemGo to GitOps** — get the cluster to a single management surface. The Helm chart already exists; it's just a matter of creating an `Application` of `helm` source type pointing at the chart in the repo. Estimated ~2 hours but with non-zero risk of stateful workload disruption.
3. **Migrate the rest of the Docker Compose services** — Pi-hole, Portainer, Filebrowser, Homepage, Jellyfin, Stash. One per weekend at most. Pi-hole last, because if it breaks, my home DNS dies and I lose internet for everyone.
4. **kube-prometheus-stack via ArgoCD** — the observability layer. This is the next big project. Conservatively ~10 hours of work, and requires the RAM upgrade first (the stack adds ~1.5 GB and I'd be out of headroom otherwise).
5. **TLS via cert-manager + Let's Encrypt** — get rid of self-signed cert warnings on the ArgoCD UI and prepare for any service that needs HTTPS for browser security features (e.g., service workers, secure cookies).
6. **Pod disruption budgets, NetworkPolicies, OPA/Kyverno** — production-grade polish. Probably never necessary at homelab scale; useful as portfolio demonstrations of "I've worked with these."

Items 1, 2, and 4 are the meaningful next steps. The rest is polish.

---

## Closing

Four focused hours of work today. Headline deliverables:

- ArgoCD installed and running on the existing k3s cluster
- Private GitHub repo with clean folder convention (`bootstrap/`, `infrastructure/`, `apps/`)
- Uptime Kuma fully migrated from Docker Compose to GitOps-managed Kubernetes
- Verified the push-to-sync loop with a real config change (memory limit bump)
- Documented gotchas — repo URL typo, vi editor escape, reconciliation interval, image pull dominance, dual-management surface

What changed about how I run the cluster: now I edit YAML in git, commit, push. The cluster matches that within minutes, with no other action from me. If it doesn't match, ArgoCD tells me precisely which resource is out of sync and why. The runner that deploys StudentSystemGo via Helm is now the legacy path; the GitOps loop is the future path.

The 3-minute reconciliation default and the "Repository not found" error were the two things that broke my initial mental model and forced me to actually understand ArgoCD's internals. Both are documented in the official manual but reading them in context (something I built doesn't work the way I expected) sticks differently than reading them out of context (here's how ArgoCD works, in case you ever build something with it).

The Core 2 Duo is still slow. The first image pull took 4 minutes. The cluster now has ArgoCD's ~600 MB layered on top of everything else, eating maybe 60% of my 4 GB. The next workload to add (kube-prometheus-stack) is going to require the RAM upgrade that's been on my list. But the architectural shape is right — git is the source of truth, the cluster reconciles, the resume bullet got measurably stronger today.

— Built and documented in June 2026 by [Omkar](https://github.com/omkar619-dev).
