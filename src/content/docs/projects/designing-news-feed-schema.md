---
title: Designing a News Feed in Go — Schema Decisions
description: The real schema behind a Twitter/Reddit-style feed in Postgres — the follow graph, idempotent writes, cursor pagination, and the timelines table the whole design bends around.
---

In the [last post](/projects/choosing-postgres-pgvector-over-mongodb/) I decided *where* the data lives: one Postgres instance with `pgvector`, serving both the relational queries and the vector search. This post is about *how I shaped it* — because in a feed, the schema isn't dictated by the data. It's dictated by one read that has to be fast.

This is also the point where the project stopped being a diagram. Phases 0 and 1 are done: schema, `pgx` pool, `sqlc`-generated queries, JWT auth, and the full relational core — users, posts, follows, profiles. So everything below is the schema as it actually runs, not as I hoped it would look.

## The read that dictates everything

Every social product has one query that runs more than all the others combined: **load my feed.** Open the app, pull to refresh — that's the hot path. Posting, following, liking all happen far less often than people *scrolling*.

So the schema question isn't "how do I model a post?" That part's easy. The real question is: **how do I make the feed read cheap, and what am I willing to pay elsewhere to get it?** Everything below is downstream of that one question.

## The relational core

The three tables that hold everything up:

```sql
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC);

CREATE TABLE follows (
    follower_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX idx_follows_follower ON follows(follower_id);
```

`BIGSERIAL`, not UUIDs — sequential bigints keep the B-tree indexes compact and give good insert locality (new rows land at the end of the index instead of scattering the way random UUIDs do). I don't need client-generated IDs or to hide row counts, so I didn't pay for them.

A follow is a **directed edge**: A→B doesn't imply B→A. The composite primary key `(follower_id, followee_id)` enforces "you can't follow someone twice" and, because it leads with `follower_id`, answers "who does A follow?" as a clean range scan.

## Two beats from Phase 1 I'm glad I got right

These aren't schema *tables*, but they're schema-adjacent decisions that'll save me pain later.

### Idempotent follows

Following is a button people double-tap, and clients retry on flaky networks. So the write has to be safe to repeat:

```sql
-- FollowUser
INSERT INTO follows (follower_id, followee_id)
VALUES ($1, $2)
ON CONFLICT (follower_id, followee_id) DO NOTHING;

-- UnfollowUser
DELETE FROM follows
WHERE follower_id = $1 AND followee_id = $2;
```

Following someone you already follow is a successful no-op, not a duplicate-key error. Unfollowing someone you don't follow affects zero rows, not an error. Both operations are **idempotent** — the same request twice lands you in the same state. (If that word rings a bell from my [MIT KV-server post](/projects/kv-server-lock-mit-6584-lab2/), it should — same idea, different layer.)

### Cursor pagination, not OFFSET

The naive way to page through a user's posts is `LIMIT 20 OFFSET 40`. It works until it doesn't: `OFFSET` makes the database *walk and discard* all the skipped rows, so page 500 gets slower than page 1, and rows shifting under you cause duplicates and gaps. So I use a cursor — a bookmark of the last row you saw:

```sql
-- ListUserPostsAfter: posts strictly OLDER than the (created_at, id) bookmark
SELECT id, author_id, content, created_at
FROM posts
WHERE author_id = @author_id
  AND (created_at, id) < (@cursor_created_at, @cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT @page_limit;
```

The interesting bit is the **row-value comparison** `(created_at, id) < (cursor_time, cursor_id)`. Two posts can share a `created_at` down to the microsecond, and a sort that isn't fully deterministic will drop or repeat rows at page boundaries. Adding `id` as a tiebreaker makes the ordering total — `id` is unique, so `(created_at, id)` is never ambiguous. Pages can't overlap or skip, and every page costs the same regardless of depth. (All of this is `sqlc`, so the queries are checked against the schema at compile time — a typo'd column is a build error, not a 2am pager.)

And profiles fetch their info and follower/following/post counts in a single query via correlated subqueries, rather than four round-trips — small, but it's the kind of thing that compounds on the hot path.

## Timelines: the part that actually matters

Here's the fork in the road. When user B posts, how does it reach the feeds of everyone who follows B? Two classic answers, mirror images of each other:

**Fan-out-on-read (pull).** Store nothing extra. On feed load, look up everyone you follow, gather their recent posts, merge-sort, return the top N. Writes are trivial; reads are *expensive* and get worse the more you follow — a user following 2,000 accounts triggers a 2,000-way gather on every refresh. The hot path becomes the slow path. Backwards.

**Fan-out-on-write (push).** Precompute every feed. When B posts, write a reference into the timeline of *every follower of B*. Reads become one indexed scan; writes get expensive (50,000 followers → 50,000 inserts) and you pay in storage.

I went with **push**, and the table is this:

```sql
CREATE TABLE timelines (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id     BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_timelines_user_inserted ON timelines(user_id, inserted_at DESC);
```

One row per *(person who should see this post, post)*. A feed read becomes the cheapest query in the system —

```sql
SELECT post_id FROM timelines
WHERE user_id = $1
ORDER BY inserted_at DESC
LIMIT 30;
```

— a single index range scan that doesn't care how many people you follow. That's the whole prize.

### One subtle choice: `inserted_at`, not the post's `created_at`

Notice the feed orders by `inserted_at` — *when the row landed in your timeline* — not the post's own `created_at`. For live posting they're effectively the same. But they diverge in the cases that matter: a backfill, a delayed worker, or merging a just-followed account's history. Ordering by `inserted_at` means "newest *to you*," which is the behaviour I want — but it's a real decision with a real edge: a backfilled old post can surface at the top of your feed because it only just entered your timeline. I'd rather own that trade-off explicitly than discover it as a bug.

### The celebrity problem (and where this goes next)

Pure push has one ugly failure mode: the celebrity. An account with two million followers posting means two million inserts for one post — a write storm. The standard fix, and where I'm heading, is a **hybrid**: push for normal accounts, but for accounts above a follower threshold, *don't* fan out — leave their posts in `posts` and pull them in at read time, merging with the pushed timeline. The schema already supports both: `timelines` for the pushed majority, `idx_posts_author_created` for the pulled celebrities.

That fan-out worker — a separate `cmd/worker` binary fed by RabbitMQ — is the next phase, and the genuinely hard part. [It gets its own post](/projects/fanning-out-the-feed-with-rabbitmq/) once I've hit the inevitable problems.

## Indexing, honestly

Each index maps to a real access pattern — with one caveat I'll own up to:

- `idx_timelines_user_inserted` — **the feed read.** The single most important index in the schema.
- `idx_posts_author_created` — **profile pages, cursor pagination, and the pull path** for celebrity posts.
- `idx_post_embeddings_hnsw` (from the last post) — **"related posts"** vector search.
- `idx_follows_follower` — and here's the honest bit: the primary key *already* leads with `follower_id`, so this index is doing less than its name suggests. The index this table will actually need is on **`followee_id`** — "who follows the author who just posted?" is exactly the fan-out write query, and right now nothing indexes it well. That's a refinement landing with the fan-out worker, and a good reminder that you should add indexes when a query asks for them, not when a column looks important.

## Where this sits in the build

Phases 0 and 1 are done and running on Postgres 16 (primary + read replica) with `pgx` and `sqlc`: signup, login, JWT auth, post CRUD with cursor pagination, idempotent follow/unfollow, and profiles. The `timelines` and `post_embeddings` tables exist in the schema — designed — but their machinery doesn't yet: the **fan-out worker** that populates timelines, and the **hybrid search** (Postgres BM25 full-text + dense `pgvector` retrieval fused with RRF) that lights up `post_embeddings`. Those are the next phases, and each one's hard part will land here as its own post.

Each real decision goes in the [repo](https://github.com/omkar619-dev/news-feed-go) as an ADR. The recurring lesson so far: the hardest schema calls aren't about how to store a thing — they're about how many copies of it you're willing to keep, and which timestamp you trust.
