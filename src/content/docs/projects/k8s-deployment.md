---
title: Kubernetes Deployment (Phase 1.5)
description: Migrating a Go REST API stack from Docker Compose to Helm-managed Kubernetes on AWS and a self-hosted k3s homelab cluster.
---

This document covers the migration of StudentSystemGo from **Docker Compose on AWS EC2** (Phase 1, see `deployment.md`) to **Helm-deployed Kubernetes on a self-hosted k3s cluster** (Phase 1.5). Both deployments coexist; this isn't a replacement, it's a parallel "production-shape" target that adds Kubernetes operational concepts to the project's portfolio.

The k3s cluster runs on an old 2008 Core 2 Duo PC with 4 GB DDR2 RAM — deliberately chosen to surface real-world constraints (slow CPU, tight RAM, flaky USB-Ethernet adapter) rather than glossing over them on a beefy cloud VM.

---

## Table of contents

- [Why migrate to Kubernetes](#why-migrate-to-kubernetes)
- [Architecture overview](#architecture-overview)
- [The Helm chart structure](#the-helm-chart-structure)
- [Key design decisions](#key-design-decisions)
- [Real gotchas encountered](#real-gotchas-encountered)
- [Local dev (k3d) vs production (k3s on homelab)](#local-dev-k3d-vs-production-k3s-on-homelab)
- [CI/CD architecture](#cicd-architecture)
- [Performance observations on Core 2 Duo](#performance-observations-on-core-2-duo)
- [Future improvements](#future-improvements)

---

## Why migrate to Kubernetes

The honest answer in two halves.

**The career half**: roles I'm targeting (backend + AI infra at YC-style startups) treat Kubernetes as a baseline. Demonstrating "I've shipped a real Helm chart on a real cluster" reads differently to recruiters than "I can deploy with Docker Compose."

**The engineering half**: even at small scale, Kubernetes gives you:

- **Declarative state** — `helm upgrade` re-renders the desired state; the controller reconciles. Drift is automatically corrected.
- **Rolling deploys** — zero-downtime updates via ReplicaSet rollover. Compose's `docker compose up -d` recreates containers serially and creates brief downtime windows.
- **Autoscaling** — HPA scales pods based on CPU/memory. Compose has no autoscaling.
- **Self-healing** — kubelet restarts crashed containers with exponential backoff. Compose's `restart: unless-stopped` is close but not as flexible.
- **Networking primitives** — Services, Ingress, network policies. Compose's bridge networks are limited.
- **Resource governance** — `requests` + `limits` on every pod. Compose has `mem_limit` but not `requests`.

The downsides — real and worth being honest about:

- **Complexity tax**: 6 services in Compose = ~220 lines of YAML. The same in Helm = ~800 lines across 11+ template files. More to maintain.
- **Steep learning curve**: StatefulSets, PVCs, Headless Services, init containers, Helm templating — there's a lot to learn before "hello world" works.
- **Resource overhead**: k3s control plane uses ~500 MB RAM idle. On a 4 GB box, that's ~13% of total memory before any app runs.

For an internet-facing 100-req/sec service: probably worth it. For a learning project: definitely worth it. For a side hustle that just needs to ship: Compose is fine.

---

## Architecture overview

Same six logical services as the Compose deployment, but expressed as Kubernetes resources:

```
                    ┌─────────────────────────────────────────────┐
                    │  Traefik Ingress Controller (k3s built-in) │
                    │  Host: studentsystemgo.local                │
                    └────────────────┬────────────────────────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  Service (ClusterIP) │
                          │  ssg-studentsystemgo │
                          └──────────┬──────────┘
                                     │
                          ┌──────────▼──────────┐
                          │  Deployment + HPA   │  ← scales 1-3 pods on CPU
                          │  ssg-studentsystemgo │
                          └────┬────┬────┬──────┘
                               │    │    │
            ┌──────────────────┼────┼────┼──────────────────┐
            │                  │    │    │                  │
            ▼                  ▼    ▼    ▼                  ▼
    ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐
    │ StatefulSet   │  │ StatefulSet  │  │ StatefulSet  │  │ Deployment  │
    │ mysql-primary │  │ mysql-replica│  │ redis        │  │ worker      │
    │ (writes)      │  │ (reads)      │  │ rate+cache   │  │ async jobs  │
    │   + PVC       │  │   + PVC      │  │   + PVC      │  │             │
    └───────────────┘  └──────┬───────┘  └──────────────┘  └──────┬──────┘
                              │                                   │
                       GTID replication                  consumes from
                              ▲                                   ▼
                              │                          ┌──────────────┐
                       binlog stream                     │ StatefulSet  │
                              │                          │ rabbitmq     │
                              │                          │ AMQP queue   │
                              │                          │   + PVC      │
                              │                          └──────────────┘
                              │
                       ┌──────┴────────┐
                       │  primary user │  Init script: 00-replication-user.sql
                       │  creates      │  (from ConfigMap mount)
                       └───────────────┘
```

Resources created by the chart:

| Resource type | Count | What they are |
|---|---|---|
| Deployment | 2 | app, worker |
| StatefulSet | 4 | mysql-primary, mysql-replica, redis, rabbitmq |
| Service | 5 | app (ClusterIP) + 4 headless for StatefulSets |
| ConfigMap | 2 | mysql-primary config + init SQL, mysql-replica config + init SQL |
| Secret | 4 | mysql, rabbitmq, app, cloudfront-key |
| Ingress | 1 | Traefik, host `studentsystemgo.local` |
| HorizontalPodAutoscaler | 1 | scales app deployment 1→3 on CPU |
| PVC (auto from `volumeClaimTemplates`) | 4 | one per StatefulSet for persistence |

Total: 23 resources, deployable via a single `helm install`.

---

## The Helm chart structure

```
deploy/helm/studentsystemgo/
├── Chart.yaml                              # chart metadata
├── values.yaml                             # safe defaults, committed
├── secrets.values.example.yaml             # template for sensitive overrides
├── secrets.values.yaml                     # GITIGNORED, real passwords
├── README.md                               # chart-level docs
└── templates/
    ├── _helpers.tpl                        # naming/label helper functions
    ├── NOTES.txt                           # post-install message
    ├── deployment.yaml                     # app Deployment
    ├── worker-deployment.yaml              # worker Deployment
    ├── service.yaml                        # app Service (ClusterIP)
    ├── ingress.yaml                        # Traefik Ingress
    ├── hpa.yaml                            # HorizontalPodAutoscaler
    ├── secret.yaml                         # mysql credentials Secret
    ├── rabbitmq-secret.yaml                # rabbitmq creds + pre-built AMQP URL
    ├── app-secret.yaml                     # JWT secret + app DB password
    ├── cloudfront-secret.yaml              # generated RSA key for CF
    ├── mysql-primary-statefulset.yaml      # MariaDB primary
    ├── mysql-primary-configmap.yaml        # primary.cnf + init SQL
    ├── mysql-primary-service.yaml          # headless service
    ├── mysql-replica-statefulset.yaml      # MariaDB replica
    ├── mysql-replica-configmap.yaml        # replica.cnf + replication init SQL
    ├── mysql-replica-service.yaml          # headless service
    ├── redis-statefulset.yaml              # Redis with AOF persistence
    ├── redis-service.yaml                  # headless service
    ├── rabbitmq-statefulset.yaml           # RabbitMQ + management plugin
    └── rabbitmq-service.yaml               # headless service
```

Notable choices:

- **One file per resource** (instead of multi-resource files separated by `---`). Easier to find things, easier to lint, easier to remove without surgery.
- **Component-level secret separation** — `mysql`, `rabbitmq`, `app`, `cloudfront-key`. Less blast radius if one Secret leaks; can be rotated independently.
- **`secrets.values.yaml` gitignored** — sensitive overrides live outside git. The production CI/CD pipeline reads its copy from the runner's local filesystem; the chart fails fast (via `required` template function) if a secret value isn't provided.

---

## Key design decisions

### StatefulSet vs Deployment

Four of our services (MySQL primary, MySQL replica, Redis, RabbitMQ) use **StatefulSet**, not Deployment. The differences that matter:

- **Stable network identity**: a StatefulSet pod is named `mysql-primary-0`, not `mysql-primary-abc123`. After restart it's still `-0`. The replica connects to `mysql-primary` by name and gets the same pod.
- **Stable per-pod storage**: each pod has its own PVC, automatically created from `volumeClaimTemplates`. On pod restart, the same PVC is reattached. Data persists.
- **Ordered creation/deletion**: pods are brought up `-0`, `-1`, `-2` in order, terminated in reverse. Matters for clustered databases where ordinal positions encode roles.

The app and worker are **Deployments** because they're stateless: any instance can serve any request, restarts can get new names, no per-pod disk needed.

### Headless services for StatefulSet DNS

Each StatefulSet has a paired `clusterIP: None` (headless) Service. Headless means: DNS lookup for the service name returns the pod IPs directly rather than a virtual cluster IP. Required so that `mysql-primary-0.mysql-primary.studentsystemgo.svc.cluster.local` resolves to the actual pod — and so the short form `mysql-primary` returns the right address.

The app uses the short form via DNS search domains: `DB_PRIMARY_HOST: mysql-primary` resolves cluster-internally.

### Init containers for ordering

Compose has `depends_on: condition: service_healthy` to express startup order. Kubernetes doesn't have a built-in equivalent for cross-StatefulSet ordering. Instead, **init containers** pause main container startup until a condition is met.

Two places I used them:

1. **MySQL replica** — its first-boot SQL needs to connect to primary for `CHANGE MASTER`. The replica's pod has an init container running `busybox` that does:
   ```bash
   until nc -z mysql-primary 3306; do
     sleep 2
   done
   ```
   The MariaDB container doesn't start until primary's port 3306 accepts TCP.

2. **Worker** — useless without RabbitMQ. Same `nc -z rabbitmq 5672` pattern.

Init containers are a Kubernetes-native expression of "wait until your dependency is reachable." Cheap, clean, and explicit.

### MySQL primary↔replica replication

Translating GTID replication from Compose to Helm wasn't trivial. The replica's init script does `RESET MASTER; CHANGE MASTER TO MASTER_HOST='mysql-primary' ...; START SLAVE;` — and the password was hardcoded in the Compose version's SQL file.

In Helm, we **Helm-template the password** from `values.yaml` into the SQL stored in a ConfigMap:

```yaml
# templates/mysql-replica-configmap.yaml
data:
  99-set-up-replication.sql: |
    RESET MASTER;
    CHANGE MASTER TO
      MASTER_HOST='mysql-primary',
      MASTER_PORT=3306,
      MASTER_USER='{{ .Values.mysql.replication.user }}',
      MASTER_PASSWORD='{{ .Values.mysql.replication.password }}',
      MASTER_USE_GTID=slave_pos,
      MASTER_CONNECT_RETRY=10;
    START SLAVE;
```

This works for the learning project but bakes the replication password into a ConfigMap (visible in plain text inside etcd). A production-grade approach would use an init container that reads the password from a Secret env var and generates the SQL at boot time. Future improvement.

### Secrets via `valueFrom.secretKeyRef`

Initial chart had passwords as plaintext env vars in values.yaml. Refactor in Session 5 moved sensitive values to dedicated Secret resources and the Deployment references them via:

```yaml
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: ssg-studentsystemgo-app
        key: db-password
```

The Secret itself is templated from a separate gitignored `secrets.values.yaml`. The non-sensitive env vars (DB_USER, REDIS_URL, etc.) stay in `values.yaml` for visibility.

This is the basic level of "real secrets management." Step 2 would be sealed-secrets (encrypted secrets committed to git) or External Secrets Operator pulling from AWS Secrets Manager / Vault. Deferred.

### HPA and the `replicas` field conflict

Kubernetes' HorizontalPodAutoscaler manages `Deployment.spec.replicas` once enabled. If your Deployment template also declares `replicas: N`, both Helm and the HPA try to own the field, and Helm's server-side apply detects a conflict on `subresource "scale"`.

The fix is to omit `replicas` from the Deployment when HPA is enabled:

```yaml
spec:
  {{- if not .Values.hpa.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  selector:
    ...
```

The first version of the chart hit this conflict on the first HPA-enabled `helm upgrade`. Easy fix once understood; not obvious before.

---

## Real gotchas encountered

The reason I built this on a 2008 PC was to surface failures. They came in good faith. Here are the most instructive ones.

### 1. RabbitMQ `exec` probes timed out on slow CPU

Default RabbitMQ probes use `rabbitmq-diagnostics check_running` — which spawns an Erlang remote console process inside the container. On modern CPUs this takes ~200ms. On Core 2 Duo it takes **10+ seconds**, exceeding the probe's `timeoutSeconds: 10`. The probe fails, kubelet kills the container, restart, repeat. Death spiral.

**Fix**: switch to `tcpSocket` probes that check if port 5672 accepts a TCP connection. Microseconds to execute regardless of CPU speed:

```yaml
livenessProbe:
  tcpSocket:
    port: 5672
  initialDelaySeconds: 240
  periodSeconds: 30
  failureThreshold: 5
  timeoutSeconds: 5
```

Also bumped `initialDelaySeconds` to 240 (4 minutes) to cover the observed 171-second first-boot time on this hardware.

**Lesson**: heavy `exec` probes are fine for fast hardware. On resource-constrained nodes, prefer `tcpSocket` or `httpGet`. The probe itself shouldn't be the load that fails the probe.

### 2. MySQL credential rotation needs ALTER USER, not env var changes

The MariaDB official image creates the root user with the value of `MARIADB_ROOT_PASSWORD` on **first boot only**. After that, the password is stored in the `mysql.user` table inside the PVC. Subsequent pod restarts see the new env var but `mysql.user` still has the original password.

This bit me hard during Session 5 — I rotated the password in `secrets.values.yaml`, ran `helm upgrade`, and the app crashed with `Access denied for user 'root'@... (using password: YES)`.

**Fix**: log in with the old password and rotate via DDL:

```bash
kubectl exec mysql-primary-0 -- mariadb -u root -p<OLD> -e "
  ALTER USER 'root'@'%' IDENTIFIED BY '<NEW>';
  ALTER USER 'root'@'localhost' IDENTIFIED BY '<NEW>';
  FLUSH PRIVILEGES;
"
```

GTID replication propagates `mysql.user` table changes automatically, so the replica picks up the new password too. App reconnects on next restart.

**Lesson**: stateful workloads in Kubernetes don't get fresh state on every redeploy. Credential rotation is a **two-step dance** — update the secret, then run DDL to align the stored state with the new credential. This is what real SRE work looks like.

### 3. App's Service was selecting MySQL pods too

After adding the MySQL StatefulSet, port-forward to the app Service failed with `Pod 'mysql-primary-0' does not have a named port 'http'`.

The cause: the app's Service selector was `name=studentsystemgo, instance=ssg`. Our MySQL pods had `name=studentsystemgo, instance=ssg, component=mysql-primary` — both labels match. Service forwarded to MySQL pods sometimes, which don't expose port `http`.

**Fix**: differentiate components. Added `app.kubernetes.io/component: app` label and selector to the app Deployment + Service:

```yaml
selector:
  app.kubernetes.io/name: studentsystemgo
  app.kubernetes.io/instance: {{ .Release.Name }}
  app.kubernetes.io/component: app
```

Same pattern for mysql-primary, mysql-replica, redis, rabbitmq, worker. Each gets a unique `component` label. Services and Deployments only select their own component.

**Lesson**: labels are matchable. The same set of labels on two pod types means controllers can confuse them. Always include a `component` (or equivalent) discriminator.

### 4. CloudFront private key file must exist on disk

The Go app's photo subsystem reads `CF_PRIVATE_KEY_PATH=/etc/secrets/cloudfront_private_key.pem` at startup and crashes if the file doesn't exist. Dummy `CF_KEY_PAIR_ID` and `CF_DOMAIN` env vars aren't enough.

**Fix**: a Secret with a Helm-generated RSA key, mounted as a file:

```yaml
# templates/cloudfront-secret.yaml
type: Opaque
stringData:
  cloudfront_private_key.pem: |-
{{ genPrivateKey "rsa" | indent 4 }}
```

```yaml
# Deployment volume mount
volumeMounts:
  - name: cloudfront-key
    mountPath: /etc/secrets
    readOnly: true
volumes:
  - name: cloudfront-key
    secret:
      secretName: ssg-studentsystemgo-cloudfront-key
```

The generated key isn't a real CloudFront keypair — it just satisfies the PEM-parse check at startup. In production, real CF keys would be provided via `--set-file` or an external secret manager.

### 5. Image pulls fail intermittently on k3d (Docker Desktop DNS quirks)

While iterating on the chart locally with k3d, image pulls from ghcr.io occasionally fail with `dial tcp: lookup ghcr.io: Try again`. Diagnosis: k3d nodes resolve DNS through Docker Desktop's WSL2 network, which is flaky.

**Workaround**: pre-load images into k3d's containerd cache:

```bash
docker pull ghcr.io/omkar619-dev/studentsystemgo:latest
k3d image import ghcr.io/omkar619-dev/studentsystemgo:latest -c dev
```

(The same `k3d image import` for mariadb:11, redis:7-alpine, rabbitmq:3.13-management-alpine, busybox:1.36 makes future iteration immune to ghcr.io DNS hiccups.)

For the production k3s cluster on Old PC, the same approach works via `docker save | sudo k3s ctr -n=k8s.io images import`.

### 6. Helm chart path interpretation in CI

The k3s deploy job's `helm upgrade --install ssg deploy/helm/studentsystemgo` failed with `Error: repo deploy not found`. Helm interprets `name/path` as `<repo-name>/<chart-name>` from configured repos.

**Fix**: prefix with `./` to force a path interpretation:

```bash
helm upgrade --install ssg ./deploy/helm/studentsystemgo ...
```

Small thing. Cost me 20 minutes the first time.

---

## Local dev (k3d) vs production (k3s on homelab)

I keep two clusters with different roles.

**`k3d-dev`** — k3s in Docker on my laptop. For fast iteration. Cluster spin-up + Helm install + teardown in ~90 seconds total. No GPU, no persistence between restarts.

**Old PC k3s** — the "production" cluster on the 2008 PC. Real persistent volumes, real network latency, real resource constraints.

The Helm chart is identical for both. Per-environment overrides live in separate values files:

- `values.yaml` — defaults, works on both
- `secrets.values.yaml` — environment-specific secrets (different per cluster)
- A future `prod.values.yaml` could differentiate resource limits if needed

Cluster switching via kubectl context:

```bash
kubectl config use-context k3d-dev      # local iteration
kubectl config use-context default      # Old PC k3s
```

---

## CI/CD architecture

GitHub Actions, split runner pattern:

```
push to main
    │
    ├─► Job 1: lint-and-build      [ubuntu-latest, GitHub-hosted]
    │     └─► go vet, go build
    │
    ├─► Job 2: docker-build         [ubuntu-latest, GitHub-hosted]
    │     ├─► docker buildx build
    │     └─► push to ghcr.io with :sha-XXXXXXX + :latest tags
    │
    ├─► Job 3: deploy-ec2           [ubuntu-latest, GitHub-hosted]
    │     └─► SSH to EC2, docker compose pull + up
    │
    └─► Job 4: deploy-k3s           [self-hosted runner, on Old PC]
          ├─► pre-pull image into k3s containerd
          ├─► helm upgrade --install --atomic --timeout 15m
          ├─► kubectl rollout status (verify)
          └─► curl /healthz via Tailscale + Ingress (smoke test)
```

The expensive Docker build runs on GitHub's free 4-core runners. Only the lightweight `helm upgrade` runs on Old PC, where the runner has tailnet access to the k3s API.

**Why self-hosted runner**: the Old PC k3s cluster's API server is behind Tailscale — GitHub-hosted runners can't reach it without exposing port 6443 publicly. A self-hosted runner ON the Old PC has direct access via `/etc/rancher/k3s/k3s.yaml`.

**Why not expose k3s API publicly**: it would work, but the k3s API is a high-value attack surface and I don't have the operational maturity (audit logs, IP allowlists, mTLS rotation) to expose it safely. Self-hosted runner is the cheapest correct answer.

The runner runs as a systemd service (`actions.runner.omkar619-dev-StudentSystemGo.oldpc-k3s-runner.service`), restarted on boot, idle RAM ~100 MB.

**Pre-pull step** matters: without it, the helm upgrade triggers a pull during pod rollout. Over the Old PC's slow USB-Ethernet network (~2 Mbps measured), a 12 MB image takes 1-2 minutes — long enough to combine with RabbitMQ's 3-minute boot to exceed the 5-minute default `helm --atomic` timeout. Pre-pull happens BEFORE the timer starts.

**Image tag strategy**: `image.tag=sha-${first-7-chars}` matches what docker/metadata-action publishes. Pin to the specific commit's image rather than `:latest` for reproducible deploys and easy rollback.

```yaml
- name: Helm upgrade
  env:
    KUBECONFIG: /etc/rancher/k3s/k3s.yaml
  run: |
    SHORT_SHA=$(echo ${{ github.sha }} | cut -c1-7)
    REPO_LOWER=$(echo "${{ env.IMAGE_NAME }}" | tr '[:upper:]' '[:lower:]')
    helm upgrade --install ssg ./deploy/helm/studentsystemgo \
      --namespace studentsystemgo \
      --create-namespace \
      -f /home/omkarshendge619/k3s-deploy/studentsystemgo-secrets.values.yaml \
      --set image.repository=ghcr.io/$REPO_LOWER \
      --set image.tag=sha-$SHORT_SHA \
      --atomic \
      --timeout 15m
```

`--atomic` rolls back automatically if the deploy hangs or any pod fails to become Ready. Combined with the 15m timeout, this is the safety net that prevents a half-deployed broken state.

---

## Performance observations on Core 2 Duo

Empirical numbers from the Old PC:

| Metric | Value |
|---|---|
| RabbitMQ first boot | ~171 seconds |
| RabbitMQ subsequent boots (PVC populated) | ~53 seconds |
| MariaDB primary first boot | ~90 seconds (includes init SQL run) |
| MariaDB primary subsequent boots | ~30 seconds |
| Redis startup | <10 seconds |
| Go app startup | ~5 seconds |
| Full cold deploy (all 6 pods, image-cached) | ~4 minutes |
| Idle RAM footprint (k3s + 6 pods) | ~1.5 GB |
| Network bandwidth | ~2 Mbps (USB-Ethernet, EMI-prone) |
| Disk usage | ~20 GB / 465 GB (mostly k3s + PVC data) |

The slow CPU and tight RAM make this cluster a useful learning environment. Issues that would be invisible on a c5.4xlarge (probe timeouts, image pull overlap with deploy timeout, RAM pressure under load) surface clearly here.

If I rebuild on better hardware, I'd expect a 3-5x improvement on boot times. The chart structure itself is hardware-independent — the same chart deploys cleanly to any k8s cluster (k3d, k3s, EKS, GKE).

---

## Future improvements

In rough priority order:

1. **External Secrets Operator + AWS Secrets Manager / Vault** — get plaintext secrets out of `secrets.values.yaml` entirely. The chart references Secrets by name; the operator populates them from an external KMS.
2. **cert-manager + Let's Encrypt** — replace the current `tls: false` Ingress with HTTPS via Let's Encrypt. Requires a real domain pointing at the cluster.
3. **Prometheus + Grafana scraping the existing /metrics endpoint** — currently the Phase 1 Step 10 metrics endpoint exists but isn't being scraped on the k3s cluster.
4. **Replica password rotation via init container** — generate the replication SQL at boot time from a Secret env var rather than templating into a ConfigMap.
5. **Pod disruption budgets** — `minAvailable: 1` on the app Deployment so the HPA + node drain don't simultaneously kill all replicas.
6. **NetworkPolicies** — restrict pod-to-pod traffic to only the connections that matter (app→mysql-primary, app→mysql-replica, app→redis, app→rabbitmq, worker→rabbitmq).
7. **PDB on StatefulSets** — currently a single-replica StatefulSet can be drained from under us. Real production would care.
8. **GitOps with ArgoCD** — replace the imperative `helm upgrade` step with a declarative Application CR that Argo reconciles. Strictly an upgrade in operational maturity.

The chart as it stands is genuinely deployable. The above are real-world polish, not blockers.

---

## Closing

This wasn't a tutorial follow-along. Every gotcha here came from a real "why is my pod CrashLoopBackOff" moment, often at 1am on a Sunday. The 2008 PC made some of these issues impossible to ignore where a cloud VM would have papered over them.

The Helm chart and CI/CD pipeline together represent ~30 hours of focused work across two weeks. The headline deliverables:

- Helm chart (4 StatefulSets, 4 Secrets, 2 ConfigMaps, 2 Deployments, 1 Ingress, 1 HPA, 23 resources total) — portable across any Kubernetes distribution
- Auto-deploy CI/CD via self-hosted GitHub Actions runner + Tailscale
- Documented production-shape architecture, not a toy

If you're considering a similar migration: don't underestimate scope. The chart itself takes maybe 8 hours. The remaining 22 are debugging — probe timeouts on slow hardware, credential rotation on stateful workloads, selector overlap between components, image pull races during deploys. That's where the real Kubernetes learning happens, and where I'd say I came out of this project with genuine operational intuition rather than just "I followed a tutorial."

— Built and documented in May 2026 by [Omkar](https://github.com/omkar619-dev).
