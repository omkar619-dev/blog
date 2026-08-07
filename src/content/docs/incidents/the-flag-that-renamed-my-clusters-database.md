---
title: "The flag that renamed my cluster's database"
description: >-
  Every kubectl command started failing with a missing-table error. The pods were all
  still running, the disk was 90% empty, and the database file was exactly where it
  should be — at 4 KB instead of 11 MB. One mistyped flag had moved my cluster's memory
  somewhere else while it was still using it.
---

Every `kubectl` command against my homelab cluster started returning the same thing:

```text
$ kubectl get nodes
Error from server: rpc error: code = Unknown desc = no such table: kine

$ kubectl get pods -A
Error from server: rpc error: code = Unknown desc = no such table: kine
```

Not "connection refused", not a timeout. The API server was up and answering — it just couldn't read its own datastore.

## What kine is, and why that error is alarming

k3s doesn't ship etcd by default. It runs **kine**, a shim that speaks the etcd API on the front and writes to SQLite on the back. One file, `/var/lib/rancher/k3s/server/db/state.db`, one table, `kine`, and inside it **every object in the cluster** — every Deployment, Secret, PVC, ServiceAccount.

So `no such table: kine` doesn't mean "a query failed." It means the API server opened its database and found nothing in it.

## Ruling out the boring explanation

SQLite misbehaves when it can't write, so disk first:

```text
$ df -h /
Filesystem                         Size  Used Avail Use% Mounted on
/dev/mapper/ubuntu--vg-ubuntu--lv  466G   42G  401G  10% /
```

Not that. And worth noting the error was specific: a full disk gives you `database or disk is full`. **"No such table" means the file opened cleanly and is simply empty** — a very different failure.

## The directory listing that explained everything

```text
$ sudo ls -lh /var/lib/rancher/k3s/server/db/
drwx------ 3 root root 4.0K Aug  7 06:00 etcd
-rw-r--r-- 1 root root 4.0K Aug  7 06:09 state.db
-rw-r--r-- 1 root root  11M Aug  7 06:19 state.db.migrated
-rw-r--r-- 1 root root    0 Aug  7 06:09 state.db-wal
```

Three things in one screen:

- `state.db` is **4 KB** — an empty SQLite file with no tables in it
- `state.db.migrated` is **11 MB** — that's the real cluster
- there's now an `etcd/` directory that has never existed on this box

`.migrated` is not a name I chose. It's the name **k3s gives the old SQLite file after migrating the datastore to embedded etcd.**

## What I'd actually done

Earlier that morning I had run `k3s server --cluster-init` by hand. I was poking at something unrelated and didn't think about what the flag meant.

`--cluster-init` switches k3s from SQLite to **embedded etcd** — it's how you start a multi-server HA control plane. Part of that migration is reading everything out of `state.db`, writing it into etcd, and renaming the old file to `state.db.migrated` so it won't be picked up again.

It did all of that. The `etcd/` directory has a 4 MB snapshot and a 62 MB write-ahead log, so the migration genuinely worked.

The problem is what else was running.

## Two k3s processes disagreeing about reality

The **systemd** service had been up since 02:59 that morning, and its unit file says nothing about etcd:

```text
ExecStart=/usr/local/bin/k3s server \
    '--write-kubeconfig-mode' \
    '644'
```

No `--cluster-init`, no `--datastore-endpoint`. That service was running kine, against SQLite, the whole time.

So my manual command migrated the data and renamed the file — **out from under a live process that was still using it.** kine reopened the path it had been told to use, found nothing there, and created a fresh empty database. From that moment the API server was reading a 4 KB file with no tables while 11 MB of cluster state sat next to it under a different name.

The pods never noticed. containerd keeps running containers alive without the API server, so every workload stayed up for the nine hours the control plane was blind. Nothing had crashed. The cluster had simply forgotten what it was supposed to be running.

## The recovery, and the one thing not to do

The dangerous move here is the obvious one: restart k3s and see if it sorts itself out.

**Don't.** If kine starts and finds no `kine` table, it creates one. You'd get a healthy-looking cluster, both nodes `Ready`, and absolutely nothing in it — and now with a *second* empty database muddying which file is which.

With the service stopped, the recovery is four moves:

```bash
# 1. copy everything first — this is the only irreversible mistake available
sudo mkdir -p /root/k3s-rescue
sudo cp -av /var/lib/rancher/k3s/server/db/ /root/k3s-rescue/

# 2. move the empty database aside (rename, never delete)
sudo mv /var/lib/rancher/k3s/server/db/state.db \
        /var/lib/rancher/k3s/server/db/state.db.empty-broken

# 3. move etcd out of the way, or k3s may decide it's an etcd cluster
sudo mv /var/lib/rancher/k3s/server/db/etcd \
        /var/lib/rancher/k3s/server/db/etcd.disabled

# 4. restore the real database
sudo mv /var/lib/rancher/k3s/server/db/state.db.migrated \
        /var/lib/rancher/k3s/server/db/state.db
```

Step 3 matters more than it looks. Leave `etcd/` in place and k3s may conclude it's an etcd-backed cluster and ignore SQLite entirely, which puts you back where you started with an extra layer of confusion.

A small trap in steps 2–4: that directory is `drwx------ root root`, so `cd` into it fails as a normal user — which silently breaks any `&&` chain you were relying on. **`sudo` elevates the command, not the shell that builds its arguments.** Absolute paths, one command per line.

## Verify before you start, not after

This is the part I'd skip if I were in a hurry, and it's the part that turns a hopeful restart into a confident one:

```text
$ sudo sqlite3 /var/lib/rancher/k3s/server/db/state.db ".tables"
kine

$ sudo sqlite3 /var/lib/rancher/k3s/server/db/state.db "SELECT count(*) FROM kine;"
1797
```

That count briefly worried me — I'd expected tens of thousands. **It's normal.** kine compacts roughly every five minutes, deleting superseded revisions, so a compacted table holds about one row per live key plus recent history. For a small cluster, ~1,800 keys is right.

Better than counting rows is looking at them:

```text
$ sudo sqlite3 .../state.db "SELECT name FROM kine WHERE name LIKE '/registry/namespaces/%';"
/registry/namespaces/argocd
/registry/namespaces/default
/registry/namespaces/kube-system
/registry/namespaces/minio
/registry/namespaces/newsfeed
/registry/namespaces/studentsystemgo
/registry/namespaces/uptime-kuma
```

That's unambiguously my cluster. Now it's safe to start.

```text
$ sudo systemctl start k3s && sleep 45 && kubectl get nodes
NAME                STATUS   ROLES           AGE     VERSION
omkarhomelabnewpc   Ready    worker          4d20h   v1.35.5+k3s1
omkarhomelaboldpc   Ready    control-plane   77d     v1.35.5+k3s1
```

All six ArgoCD Applications came back `Synced`/`Healthy`, 29 pods, 9 PersistentVolumes still `Bound`. Nothing lost.

## Why I went back to SQLite rather than forward to etcd

The etcd data was valid. Finishing the migration was an option. I didn't take it.

That control plane is a Core 2 Duo with 4 GB of RAM. **etcd is fsync-heavy and memory-hungry**, and k3s defaults to SQLite on small hardware for exactly that reason. My logs already showed kine straining under load:

```text
retrying of unary invoker failed ... error="rpc error: code = DeadlineExceeded"
retrying of unary invoker failed ... error="keepalive ping failed to receive ACK within timeout"
```

etcd would be worse, not better. And embedded etcd's actual benefit is **quorum across three or more servers** — on a single control plane it's all of the cost and none of the availability.

## What this really exposed

The recovery went cleanly, which is the least interesting part. What it surfaced is that I had spent a week building backups for the wrong things.

I had automated dumps of Postgres, a cold archive of MariaDB, and nightly snapshots of Uptime Kuma — all landing in MinIO on a different machine and a different physical disk. Good work, and none of it would have helped here. **The two things holding my cluster together had no backup at all:**

**The datastore itself.** `state.db` is every workload definition in one file. I got lucky: the migration *renamed* it rather than deleting it. A less polite failure — a corrupt page, an abrupt power cut on a box I power-cycle daily — and my only recovery path would have been rebuilding from the GitOps repo.

**The sealed-secrets private key.** This one is worse, and I hadn't thought about it at all. My GitOps repo is public, which is fine because every secret in it is encrypted — but the key that decrypts them lives in a Secret *inside the cluster*. Lose the cluster, lose the key, and every SealedSecret in that repo becomes permanently unreadable. Not "restore from backup" unreadable. Gone.

Both now get backed up. The datastore has an online SQLite snapshot pushed to object storage:

```bash
sudo sqlite3 /var/lib/rancher/k3s/server/db/state.db \
  ".backup '/tmp/k3s-state-$(date +%Y%m%d-%H%M%S).db'"
```

`.backup` is SQLite's online backup API and takes a consistent snapshot of a live database — `cp` on a running SQLite file can capture a torn one.

The sealed-secrets key gets exported and stored **off the cluster entirely**, because a backup that only survives the scenarios you already survived isn't a backup.

## Lessons

1. **Read what a flag does to state before you type it.** `--cluster-init` isn't a mode switch you can undo by removing it — it performs a one-way data migration and renames the source file. The flag was gone from my next command; the consequences weren't.
2. **A running process doesn't notice its file being renamed.** Unix renames are cheap and silent, and nothing tells the process holding that path that its data now lives elsewhere. Never mutate state a live service owns.
3. **"No such table" is not "no such file."** The distinction ruled out disk-full, permissions, and corruption in one step, and pointed straight at *the file is there and it's empty* — which is a very specific set of causes.
4. **Never restart a service to "see if it fixes itself" when its state is missing.** Half the time it will helpfully initialise fresh state on top of your problem.
5. **Rename, never delete, during recovery.** Every file I moved aside is still sitting there under a `.broken` suffix. That's what made it possible to be wrong safely.
6. **Verify the data before handing it back to the service.** Two `sqlite3` queries turned "I think this is the right file" into "this is definitely my cluster." Thirty seconds, and it changes the character of the whole operation.
7. **Back up the thing that describes everything else.** I had backups of my databases and none of my cluster. The application data was never actually at risk in this incident — PVs, object storage and Postgres files all live outside the datastore. What was at risk was the record of what should exist, which is the one thing I hadn't copied.
