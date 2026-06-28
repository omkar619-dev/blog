---
title: Fifty Copies, One Cluster — Catching Astroturf With Embeddings
description: A friend asked whether he could game my feed by posting fifty reworded copies of the same story. The defense turned out to be free — the same embeddings that power search also make coordinated spam impossible to hide.
---

Back in the [semantic search post](/projects/semantic-search-and-ranking/) a friend poked a hole I promised to come back to: *"couldn't I just game the feed by posting fifty copies of a baseless story?"* I said the defense would reuse the embeddings I already had. This is me making good on that — and the satisfying part is it needed **no new data, no new table, nothing.** Just the vectors that were already sitting there.

## The attack

**Astroturfing**: flood the feed with many near-identical posts to fake consensus and game the ranking — fifty slightly-reworded copies of "brand X is dangerous." A naive system sees fifty *separate* posts, counts fifty bits of engagement, and amplifies the lie. And the attacker rewords each copy, so a dumb exact-text check (`content = content`) never catches them.

## The insight (and it's free)

Here's the thing the attacker can't dodge: **near-identical *meaning* produces near-identical *embeddings*.** I already turn every post into a 384-number vector for [semantic search](/projects/semantic-search-and-ranking/). Reword *"brand X phones are catching fire"* into *"PSA: brand X is a fire hazard"* and the **words** change — but the **meaning-fingerprint barely moves.** So fifty astroturfed copies don't scatter across vector space; they collapse into one **tight cluster.**

The same vectors that find what's *relevant* expose what's a *copy* — opposite job, same tool.

## Detection: a threshold, not a top-N

I already had a "related posts" query — *given a post, return the top-N nearest by cosine distance.* Near-duplicate detection is a deliberately different question, and the difference is the whole teaching point:

| | "related" | "duplicates" |
|---|---|---|
| asks | what's most *similar*? | what's a *copy*? |
| returns | top-N nearest (always something) | everything under a distance **threshold** (maybe nothing) |

So the query filters on an **absolute cosine distance** instead of taking the top N:

```sql
WITH target AS (SELECT embedding FROM post_embeddings WHERE post_id = $1)
SELECT p.id, p.content,
       (e.embedding <=> (SELECT embedding FROM target)) AS distance
FROM posts p
JOIN post_embeddings e ON e.post_id = p.id
WHERE p.id != $1
  AND (e.embedding <=> (SELECT embedding FROM target)) < $threshold   -- the cutoff
ORDER BY distance;
```

**The threshold *is* the definition of "copy."** Anything closer than it, we call a near-duplicate. (Cosine distance runs `0` = identical meaning to `2` = opposite.)

## What it actually catches

I planted five reworded copies of a fake *"brand X phones are catching fire"* story and asked for the cluster around one of them:

```
 id    distance  content
1041   0.105     Warning: brand X phones keep catching fire, please avoid buying
1042   0.105     Do not buy brand X phones, they are literally catching fire
1043   0.120     brand X phones catch fire, stay far away from them
1044   0.167     PSA: brand X phones are a fire hazard, do not purchase
```

All five reworded copies sit at **0.10–0.17** — even though I changed every word. Then I asked for duplicates of a normal, unique post (a mushroom risotto recipe): **empty.** No false positives. And unrelated posts in the corpus sit beyond **0.5** — so my `0.25` threshold landed cleanly in the *gap* between "reworded copy" and "different topic."

That gap is exactly why the endpoint **returns the distances**: you don't guess the threshold, you *look at real numbers* and put the line in the valley between them.

## The honest caveats

- **The threshold is the whole game, and it's a tuning problem.** Too tight and you miss heavier rewrites; too loose and you flag genuinely-similar-but-distinct posts as spam. There's no universal number — it depends on the embedding model and your tolerance for false positives. Returning the distance is how you tune it honestly instead of by vibes.
- **This is *detection*, not yet *enforcement*.** Right now it surfaces the cluster via `GET /posts/{id}/duplicates`. Turning it into a defense is the next step: flag near-dups on ingest, collapse a cluster to a single entry in search results (fifty copies show as one), and weight ranking by **author trust, not raw count** so one account's cluster can't fake consensus.
- **It's an arms race.** An attacker who varies the *meaning* more — not just the words — spreads the cluster out and slips under a fixed threshold. Embedding-distance raises the *cost* of astroturfing; it doesn't end it.
- HNSW is approximate, so at scale a near-dup could occasionally be missed. Fine for defense-in-depth; not a hard guarantee.

## The lesson

The best part of this feature is that it cost almost nothing: **the infrastructure I built for relevance was already a spam detector, waiting to be asked the right question.** Near-identical meaning can't hide in vector space, however you reword it. The same model that decides what's *worth surfacing* also decides what's a *coordinated copy* — you just point it at a threshold instead of a top-N.

It's all in the [repo](https://github.com/omkar619-dev/news-feed-go) — the `FindNearDuplicates` query and the `/posts/{id}/duplicates` endpoint.
