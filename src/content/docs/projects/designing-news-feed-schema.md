---
title: Designing a News Feed in Go — Schema Decisions
description: How I structured the database for a Twitter/Reddit-style feed in Postgres — the follow graph, the timelines table, and the fan-out decision that drives the whole design.
---

In the [last post](/projects/choosing-postgres-pgvector-over-mongodb/) I decided *where* the data lives: one Postgres instance with `pgvector`, serving both the relational queries and the vector search. This post is about *how I shaped it* — because in a feed, the schema isn't dictated by the data. It's dictated by one read that has to be fast.

## The read that dictates everything

Every social product has one query that runs more than all the others combined: **load my feed.** Open the app, pull to refresh — that's the hot path. Posting, following, liking — all of those happen far less often than people *scrolling*.

So the schema question isn't "how do I model a post?" That part's easy. The real question is: **how do I make the feed read cheap, and what am I willing to pay elsewhere to get it?** Everything below is a consequence of answering that.

## The relational core: users, posts, follows

The three boring tables first, because they're the foundation.

```sql
CREATE TABLE users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_posts_author_created ON posts (author_id, created_at DESC);
```

Nothing surprising yet. The `(author_id, created_at DESC)` index is for profile pages ("show me everything *this* user posted, newest first") — and, as it turns out, for half of the feed strategy too.

The interesting one is the follow graph:

```sql
CREATE TABLE follows (
    follower_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows (followee_id);
```

A follow is a **directed edge**: A follows B doesn't mean B follows A. The composite primary key `(follower_id, followee_id)` does double duty — it enforces "you can't follow someone twice" *and* gives me a fast answer to "who does A follow?" (the PK is ordered by `follower_id`, so that's a range scan).

The `CHECK (follower_id <> followee_id)` is a small thing I'm glad I added at the schema level rather than in app code: you can't follow yourself, enforced by the database, no exceptions, no forgotten edge case.

But the line that actually matters for the whole system is the secondary index:

```sql
CREATE INDEX idx_follows_followee ON follows (followee_id);
```

That answers the *reverse* question — **"who follows B?"** — and that question is the entire fan-out problem.

## Timelines: the part that actually matters

Here's the fork in the road. When user B posts, how does it reach the feeds of everyone who follows B? There are two classic answers, and they're mirror images of each other.

**Fan-out-on-read (pull).** Store nothing extra. When someone opens their feed, look up everyone they follow, grab those users' recent posts, merge-sort by time, return the top N. Writes are trivial (a post is just one row in `posts`). But reads are *expensive*, and they get worse the more people you follow — a user following 2,000 accounts triggers a 2,000-way gather-and-merge on every refresh. The hot path is the slow path. That's backwards.

**Fan-out-on-write (push).** Precompute every feed. When B posts, immediately write a copy of that post reference into the timeline of *every follower of B*. Reads become trivial — a feed is one indexed scan of one table. But writes are now expensive: if B has 50,000 followers, one post becomes 50,000 inserts. And you pay in storage, because the same post reference now lives in thousands of rows.

The table for the push strategy is this:

```sql
CREATE TABLE timelines (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,        -- denormalised from posts
    PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_timelines_user_created ON timelines (user_id, created_at DESC);
```

This is the precomputed feed: one row per *(person who should see this post, post)*. Reading a feed becomes the cheapest possible query —

```sql
SELECT post_id FROM timelines
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 30;
```

— a single index range scan. No joins, no merge, no scaling with follow count. That's the whole prize.

### The celebrity problem, and the hybrid

Pure push has one ugly failure mode: the celebrity. If an account with two million followers posts, fan-out-on-write means two million inserts for a single tweet. That's a write storm that can stall the database and delay the post for everyone.

So the real answer — the one Twitter and Instagram landed on — is a **hybrid**:

- **Normal accounts → push.** When they post, fan out into their followers' `timelines`. Most accounts have modest follower counts, so this is cheap, and it keeps the common-case read fast.
- **Celebrity accounts (followers above some threshold) → pull.** Don't fan out at all. Their posts stay only in `posts`. At read time, I fetch the small set of celebrities a user follows and merge their recent posts into the pushed timeline on the fly.

The beauty is that the schema above already supports both. The `timelines` table handles the pushed majority; the `(author_id, created_at DESC)` index on `posts` handles the pulled celebrities. A feed read becomes "the precomputed rows, merged with a handful of on-demand celebrity posts" — fast in the common case, bounded in the worst case.

That's the decision: **hybrid fan-out, push by default, pull above a follower threshold.**

## The indexes, and why each one exists

I try not to add an index until a query asks for it, so each one here maps to a real access pattern:

- `idx_timelines_user_created` — **the feed read.** The single most important index in the whole schema.
- `idx_follows_followee` — **the fan-out write.** "Who follows the user who just posted?" Without this, every post is a sequential scan of the follow table.
- `idx_posts_author_created` — **profiles + the pull path** for celebrity posts.
- `idx_post_embeddings_hnsw` (from the last post) — **"related posts"** vector search.

Four tables, four indexes, four jobs.

## Denormalisation and other small crimes

A couple of deliberate compromises worth being honest about:

**I copied `created_at` into `timelines`.** It already lives on `posts`. Duplicating it means I can order a feed without joining back to `posts` just to sort it. The cost is a denormalised column I have to populate correctly at fan-out time — acceptable, because a post's creation time never changes, so there's no update-anomaly risk. This is the cheap kind of denormalisation: copying an immutable value.

**`BIGINT GENERATED ALWAYS AS IDENTITY`, not `UUID`.** Sequential bigints keep the indexes compact and give good insert locality (new rows cluster at the end of the B-tree instead of scattering, the way random UUIDs do). I don't need the "generate IDs on the client / hide row counts" properties UUIDs buy, so I didn't pay for them.

## What this costs me

No design is free, and the `timelines` table is where the bill lands:

- **Write amplification.** One post by a well-followed (but non-celebrity) account is still hundreds or thousands of inserts. That's why the fan-out *can't* run inside the post request — it has to be a background worker fed by a queue, so posting stays fast and the fan-out happens asynchronously.
- **Storage growth.** Denormalised feed copies grow much faster than `posts` itself. The mitigation is trimming: cap each user's timeline at, say, the most recent few hundred entries and let older rows age out, since nobody scrolls back two years.
- **Propagation on delete/edit.** Delete a post and its `timelines` copies need to go too. The `ON DELETE CASCADE` foreign key handles the correctness; I just have to accept the cascade's write cost.

## When I'd change my mind

If the `timelines` table ever outgrew a single Postgres — write contention on fan-out, or storage I couldn't trim fast enough — the move is to push timelines into something built for that access pattern (Redis sorted sets, or a wide-column store like Cassandra, which is exactly what large feeds use) while keeping the relational core in Postgres. The way I keep that option cheap is to put feed reads and writes behind an interface *now*, so the storage swap doesn't leak into the rest of the code. Same discipline as the vector-store escape hatch from the last post — design the seam before you need it.

## Where this sits in the build

The schema above is in place and migrated. `users`, `posts`, and `follows` are live, signup and follow endpoints work, and feed *reads* against `timelines` are wired. The genuinely hard part — the asynchronous fan-out worker that *populates* `timelines`, with the celebrity threshold logic — is what I'm building now, and it'll get its own post once I've hit the inevitable problems.

I'm writing the fan-out strategy up as an ADR in the [repo](https://github.com/omkar619-dev/news-feed-go) alongside the schema, same as the datastore decision. Turns out the hardest schema choices aren't about how to store a thing — they're about how many copies of it you're willing to keep.
