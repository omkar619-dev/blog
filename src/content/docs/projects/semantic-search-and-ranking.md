---
title: Search by Meaning — Local Embeddings, pgvector, and Why Relevance Isn't Quality
description: A friend asked how my feed avoids recommending garbage. Answering it meant a local embedding model, vector search inside Postgres, and a ranking that knows "relevant" and "good" are two different questions.
---

A friend poked a clean hole in my feed: *"cool that it has semantic search — but how do you stop it recommending garbage?"* He was right to ask, because the honest answer exposes something people quietly conflate: **finding what's relevant and ranking what's good are two different problems.** Semantic search solves the first. On its own it does *nothing* for the second. This post is how I built both — a local embedding model for relevance, and a ranking that layers recency and engagement on top so "on-topic" never gets mistaken for "trustworthy."

## Why keyword search wasn't enough

Search `cat` with `LIKE '%cat%'` and you miss "kitten," "feline," "my fluffy tabby." Keyword search matches *letters*; I wanted to match *meaning* — a query for `cat` should find the post that says "I adopted the cutest kitten," even though the word "cat" never appears.

## Embeddings: meaning as coordinates

An **embedding** turns a piece of text into a list of numbers — a vector — positioned so that **similar meanings sit close together.** "kitten" lands near "cat," and both land far from "quarterly tax filing." Picture every sentence dropped onto a giant map where topic decides location. Search then becomes: drop the *query* on the same map and grab the nearest posts.

I generate those vectors with a **model running locally** — [Ollama](https://ollama.com) serving `all-minilm`, which outputs **384-dimensional** vectors (that's why the column is `vector(384)`). Why local rather than a hosted API:

- **Free and offline** — no key, no per-call cost, no network hop.
- **It runs on a CPU** — `all-minilm` is tiny (~22M params); an embedding is a single forward pass, cheap even without a GPU.
- The part I actually care about for where I'm headed: it's me running **real inference**, not renting it.

The app reaches the model through an `OLLAMA_URL` env var, so the model can live wherever the hardware suits it — my laptop today, a beefier box later — **without touching code.** (Decoupling a dependency behind a configurable URL is a small thing that pays off the moment you deploy somewhere the model can't run.)

## Storing and searching: pgvector + HNSW

The vectors live in Postgres via [`pgvector`](/projects/choosing-postgres-pgvector-over-mongodb/) — no separate vector database. `<=>` is its cosine-distance operator, so nearest-neighbour search is one query:

```sql
SELECT p.id, p.content
FROM posts p
JOIN post_embeddings e ON e.post_id = p.id
ORDER BY e.embedding <=> $1   -- cosine distance; nearest (most similar) first
LIMIT 10;
```

An **HNSW index** makes that fast — it's an approximate-nearest-neighbour index that *jumps to the right neighbourhood* of the map instead of measuring distance to every vector. (Why Postgres and not Elasticsearch or a dedicated vector DB? One system, transactional consistency, no separate index to keep in sync. I'd reach for ES only when I genuinely outgrow this — choosing the simpler tool on purpose, and knowing the point at which I'd switch.)

## The hole my friend found: relevance ≠ quality

That cosine query answers exactly one question — *what's most on-topic?* It says **nothing** about whether a post is good, fresh, or trustworthy. A beautifully-sourced true post and a baseless one *about the same topic* sit at the **same distance** from the query. And his sharper jab: flood the system with fifty posts pushing a baseless story, and pure similarity will happily surface them.

So **cosine distance alone cannot stop garbage.** It's the start of a ranking system, not the whole of one.

## The fix: two-stage retrieve-then-rerank

Real ranking is never a single signal. So I split it in two:

- **Stage 1 — retrieve.** HNSW grabs the top ~100 nearest candidates by *pure* cosine distance. Fast, index-accelerated.
- **Stage 2 — re-rank.** Score *those candidates* by a blend:

```
score = relevance × recency × engagement
```

```sql
SELECT id, author_id, content, created_at
FROM (
    SELECT p.id, p.author_id, p.content, p.created_at,
           (1 - (e.embedding <=> $1)) AS relevance
    FROM posts p JOIN post_embeddings e ON e.post_id = p.id
    ORDER BY e.embedding <=> $1   -- HNSW-accelerated retrieval
    LIMIT 100
) AS candidates
ORDER BY
    relevance
    * EXP(-EXTRACT(EPOCH FROM (NOW() - created_at)) / 604800.0)                 -- recency (~1-week decay)
    * (1 + LN(1 + (SELECT COUNT(*) FROM likes WHERE post_id = candidates.id)))  -- engagement
    DESC
LIMIT 10;
```

**Why two stages and not one big `ORDER BY`?** Blending everything into the sort would *defeat the HNSW index* — it only accelerates pure distance. So I retrieve cheaply *with* the index, then re-rank a small set. That retrieve-then-rerank shape is the standard pattern behind real search and RAG systems.

The three factors:

- **relevance** — cosine similarity (`1 − distance`).
- **recency** — exponential time decay; fresh posts float up.
- **engagement** — real **likes**, log-scaled so a 10,000-like post *nudges* the ranking rather than bulldozing a fresh, perfectly-relevant one. (The Redis-backed counter feeding this is its own rabbit hole — [Likes at Scale](/projects/likes-and-the-hot-counter-problem/).)

The payoff: two equally-relevant, equally-fresh posts — one liked, one not — and the liked one ranks higher. That's the direct answer to my friend. **Relevance finds the candidates; recency and engagement decide quality order.**

## His follow-up: "couldn't I just astroturf it?"

*"Couldn't I game it by posting fifty copies of a baseless story?"* Yes — and the nice part is the **defence uses the same embeddings**: fifty near-identical posts cluster *tightly* in vector space, so you detect and dedup them; and you weight by **author trust, not raw count.** That semantic dedup is on my list. The model that finds relevance also finds coordinated spam — same tool, opposite job.

## The honest caveats

- `all-minilm` is small; a larger model would rank better. But the pipeline is **model-agnostic** (`OLLAMA_URL`), so swapping it is a config change plus a one-time re-embed backfill.
- HNSW is **approximate** — it can occasionally miss the true nearest. Fine for a feed; before trusting it anywhere precision-critical I'd measure **recall@k** with an eval harness ([that harness is the next post](/projects/hybrid-search-and-the-honest-eval/) — because "I think it's good" isn't a number).
- My dataset is small right now, so the re-rank shifts are subtle in practice. The *pipeline* is the point, not the demo.

## The lesson

The thing my friend's question actually taught me: **"relevant" and "good" are different queries, and a serious feed has to answer both.** A local embedding model plus `pgvector` finds what's on-topic; a blend of recency and engagement decides what's worth surfacing. Cosine distance is where ranking *begins*, not where it ends.

Every decision lands in the [repo](https://github.com/omkar619-dev/news-feed-go) as an ADR.
