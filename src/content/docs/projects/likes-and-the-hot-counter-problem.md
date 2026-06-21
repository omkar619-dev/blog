---
title: Likes at Scale — the Hot-Counter Problem
description: Adding likes to a feed looks like CRUD. The interesting part is the count — why a single like_count column melts under load, and how "Postgres is the truth, Redis is a fast copy" keeps it both correct and quick.
---

Adding likes felt like the most boring item on my list: a join table, two endpoints, done. Then a friend asked the question that makes likes interesting — *"how do you stop the feed from recommending garbage?"* — and answering it dragged me through two things I didn't expect a *like button* to teach: **how you count at scale**, and **how engagement becomes a ranking signal**. This post is mostly the first one, because that's where the real engineering hides.

(For where this fits: the [schema post](/projects/designing-news-feed-schema/) built the feed itself; this bolts the engagement layer on top.)

## The boring 80%

A like is a relationship — *user X liked post Y* — exactly the shape of a follow. So it's a junction table:

```sql
CREATE TABLE likes (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_likes_post ON likes(post_id);
```

The composite primary key means **you can like a post at most once** — idempotency baked into the schema, the same trick I used for follows. The writes lean on it:

```sql
-- LikePost
INSERT INTO likes (user_id, post_id) VALUES ($1, $2)
ON CONFLICT (user_id, post_id) DO NOTHING
RETURNING post_id;

-- UnlikePost
DELETE FROM likes WHERE user_id = $1 AND post_id = $2
RETURNING post_id;
```

The `RETURNING` is the one clever bit: it hands back a row **only if something actually changed** — a new like inserted, or an existing like deleted. Double-tap the button and the second call hits `ON CONFLICT DO NOTHING`, returns nothing, and I *know* it was a no-op. That "did the state really change?" signal matters in a minute.

That's the easy 80%. Now the part that's actually a systems question.

## The hard part: showing the count

Nobody asks "how do I store a like." The real question is **how do you show `1,204,591 likes` on a viral post without melting?** Four answers, and knowing the ladder is the whole point:

1. **`COUNT(*)` on every read.** `SELECT COUNT(*) FROM likes WHERE post_id = X`. Always correct — but on a post with two million likes, every render scans two million rows. Fine small, a disaster large.
2. **A denormalized `like_count` column** on `posts`, bumped per like: `UPDATE posts SET like_count = like_count + 1 WHERE id = X`. Reads are instant now — but that `UPDATE` takes a **row lock** on one row, and a viral post at 10,000 likes/sec means 10,000 writers **fighting over the same lock.** They serialize. One hot row, one bottleneck — the classic "hot row" problem.
3. **A Redis counter.** `INCR likes:{post_id}` — atomic, in-memory, zero DB row contention. This is where I landed.
4. **Sharded counters.** Split the counter into N rows `(post_id, shard)`, bump a *random* shard, `SUM` to read — contention spread N ways. The escalation past Redis, for when even that isn't enough.

The honest framing — and a thing I think separates senior from junior — is that this is a **ladder you climb only as far as you need.** Most apps never leave rung 1.

## What I built: Postgres is the truth, Redis is a fast copy

I keep the count in two places, each doing what it's good at:

- The **`likes` table** is the permanent record — one row per like. **The truth.** My search ranking reads it via `COUNT(*)`, so ranking is *always* correct.
- A **Redis counter** `likes:{post_id}` is a single fast number — the **display** read. `GET` is O(1); no `COUNT(*)` on the hot path.

They stay in sync with `INCR`/`DECR`, but **only on a real change** — which is exactly what that `RETURNING` gave me:

```go
delta := 0
_, err = queries.LikePost(ctx, params)
switch {
case err == nil:                    delta = 1   // a NEW like → +1
case errors.Is(err, pgx.ErrNoRows): delta = 0   // already liked → no-op, don't double-count
default:                            /* 23503 (FK) → 404, else 500 */
}
```

### The trap: never blind-`INCR` a cold counter

Here's the bug I almost shipped. Redis is a *cache* — it can be empty: a fresh start, or the key evicted under memory pressure. Call that **cold**. Now picture a post with 5 likes already in the table, but no `likes:{id}` key in Redis. Someone likes it. If I blindly `INCR`:

> `INCR` on a missing key starts it at **1**. So the counter now reads `1` — on a post that truly has `6`. I just **undercounted**, because the blank counter forgot everything already in the table.

The fix is **seed, don't blind-bump** — when the key is missing, rebuild it from the source of truth:

```go
cur, found, _ := counter.GetInt(ctx, key)
if found {
    return counter.Incr(ctx, key) // warm → apply the delta (or Decr)
}
// cold → the table already reflects the committed like; trust it
n, _ := queries.CountPostLikes(ctx, postID)
counter.Set(ctx, key, n, 0)       // ttl 0 = we manage it by hand
return n
```

Because the like is written to the table *before* I touch Redis, the `COUNT(*)` already includes it — so the seed is correct, no extra increment needed. Warm keys are cheap `INCR`s; cold keys rebuild themselves from Postgres. **The cache can always be reconstructed from the truth** — which is the entire reason the truth lives in Postgres and not Redis.

## Closing the loop: likes as a ranking signal

I added likes *now* not for the button but for the [ranking](/projects/designing-news-feed-schema/). My semantic search re-ranks results by `relevance × recency × engagement`, and until likes existed, "engagement" was a stand-in — the author's follower count. A proxy.

Now it's real. The engagement factor reads the durable like count straight from the table:

```sql
ORDER BY
    relevance
    * EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / 604800.0)                 -- recency
    * (1 + LN(1 + (SELECT COUNT(*) FROM likes WHERE post_id = candidates.id)))  -- engagement
    DESC
```

Two equally-relevant, equally-fresh posts — one liked, one not — and the liked one ranks higher. That's the answer to my friend's question: **relevance finds the candidates; engagement (plus recency) decides quality order.** And note it reads the *table*, not Redis — ranking gets correctness, display gets speed. Each tier does its job.

## The honest caveats

- A crash *between* the table commit and the Redis `INCR` drifts the **displayed** count by one. The table is untouched, and ranking uses the table, so it's purely cosmetic — and a periodic reconcile (`SET` from `COUNT(*)`) heals it. I haven't built that yet; it's a known, *bounded* gap, not a silent one.
- The `LN` on engagement is deliberate. A post with 10,000 likes shouldn't bury a fresh, perfectly-relevant one with 3. Log scale keeps engagement a *nudge*, not a sledgehammer.

## Where this sits, and the lesson

Likes are done end-to-end in [news-feed-go](https://github.com/omkar619-dev/news-feed-go): table, idempotent endpoints, the Redis hot-counter, and engagement wired into search ranking. Sharded counters come *only if* a load test ever tells me I need them — not because the column looked important.

The lesson that keeps repeating in this project: **the hard part of a feature is almost never storing the thing — it's how many copies of the count you keep, and which one you trust when they disagree.** For likes, the answer is: trust Postgres, let Redis be fast, and make sure the fast copy can always be rebuilt from the true one.
