---
title: Hybrid Search — and the Eval Harness That Wouldn't Flatter Me
description: I added keyword search on top of my vector search, fused the two with Reciprocal Rank Fusion, then built an eval harness to prove it helped. It didn't — and learning to read that honest zero taught me more than a win would have.
---

My [last post](/projects/semantic-search-and-ranking/) ended on a promise: stop saying *"I think the search is good"* and start measuring it, because **"I think it's good" isn't a number.** This is that eval harness. The twist I didn't see coming: the first real thing it did was tell me the feature I'd just built was **useless** — and learning to read that honest zero, instead of explaining it away, was the actual lesson.

(It builds straight on the [semantic search](/projects/semantic-search-and-ranking/) from that post — same Postgres, same `pgvector`.)

## First, the feature I was testing: hybrid search

Vector search is brilliant at *meaning* — a query for `cat` finds a post about a `kitten`. But it has a blind spot that's easy to miss until it bites you: **it's bad at exact, rare tokens.** Search for an error code like `ORA-12154`, a version string like `pgx v5.7.1`, a SKU — strings with no real "meaning" — and the embedding model blurs them into a vague neighbourhood. You don't want the *vibe* of `ORA-12154`; you want the one post that literally contains it.

The fix is an old one: **keyword search**, strong exactly where vectors are weak. Postgres does it natively — `to_tsvector` turns each post into a bag of normalised words, a **GIN index** (an inverted index: word → the posts containing it, like the index at the back of a textbook) makes lookups instant, and `ts_rank` orders the matches.

One detail worth tattooing on, because it surprised me: **full-text search matches whole words, not substrings.** `pgxpool` is a single token, so a search for `pgx` does *not* match it (whereas `LIKE '%pgx%'` would). That's a feature for precision — `cat` won't drag in `category` — and a gotcha to design around.

## Fusing two rankings without comparing apples to oranges

Now I had two ranked lists per query — one from vectors, one from keywords — and had to merge them into one. The naive move, *add the two scores and sort*, is broken: cosine distance runs 0–2 where **smaller is better**; `ts_rank` is unbounded where **bigger is better**. Adding them is adding rupees to kilograms.

**Reciprocal Rank Fusion (RRF)** sidesteps the whole mess by throwing the raw scores away and keeping only each result's **rank** — "1st place" means the same thing on both rulers. Each post scores:

```
score = sum over each list of  1 / (k + rank)      (k = 60)
```

Picture two judges — one scoring meaning, one scoring exact words. A post *both* rank decently beats a post only one judge loved. The `k = 60` flattens the top so a single list's #1 can't steamroll everything (rank 1 → 1/61, rank 2 → 1/62 — almost equal). No score normalisation, one knob, and it's what real hybrid stacks use.

It worked on the first try, visibly: a post containing the exact phrase *"pgx connection pool"* that pure vector search had **completely missed** jumped to #1 once the keyword arm and RRF kicked in. Feature shipped. 🎉

Except — that's *one* anecdote. And one anecdote is not a number.

## "I think it's good" isn't a number

A unit test answers *correctness*: did `/search/hybrid` return 200 and well-formed JSON? It says nothing about **quality** — all ten results could be about cooking pasta and the test still passes green. To grade quality you need what a teacher needs: **an answer key.**

So I built one. `eval/labels.json` is ~17 queries, each tagged with the post id(s) that *should* win and a relevance grade (`2` = perfect, `1` = related). `eval/seed.sql` is a 28-post corpus to search. `cmd/eval` runs every query against both endpoints and grades the rankings with three standard metrics:

- **Precision@k** — of the top *k*, what fraction are relevant. Blunt: ignores order.
- **MRR** (Mean Reciprocal Rank) — `1 / (position of the first relevant result)`, averaged. Only cares how fast you hit the first good one.
- **nDCG@k** — the gold standard. Sum each result's relevance grade *discounted by position* (`grade / log₂(position+1)`), then divide by the score of the perfect ordering. That division normalises every query to **0–1** (1.0 = flawless order), so queries with different numbers of right answers are comparable. It's the only one of the three that rewards both *order* and *how* relevant each hit is.

The output is a table with a **lift** column: `hybrid − semantic`. Positive means the keyword arm helped. Here's where it got interesting — and humbling.

## Run 1: hybrid made it *worse* (−0.044)

First run, the nDCG lift came back **negative**. Read literally: adding keyword search hurt. The instinct is to panic or rip it out. The right move is to ask *what did I actually compare?*

I'd compared `/search` against `/search/hybrid` — but those differ in **two** ways, not one. `/search` carries the recency-and-engagement re-rank from the [last post](/projects/semantic-search-and-ranking/); my hybrid path used pure cosine with **no** re-rank. So the −0.044 was mostly measuring *the re-rank I'd accidentally dropped*, not the keyword arm. That's a **confounded experiment** — two variables moved at once, so the result pins on neither.

The clue that gave it away: one query, *"hiking in the mountains,"* cratered from 1.000 to 0.631 — because without the re-rank, an old unlabelled "backpacking in the mountains" post outranked my labelled answer. Nothing to do with keywords.

The fix is the oldest rule in experiments: **change one variable.** I added a `?mode=semantic|keyword|hybrid` switch so both sides share the *exact same* vector component and differ only in the keyword arm.

## Run 2: hybrid did *nothing* (+0.000)

Controlled this time. The lift came back **exactly zero.** Every query, identical.

Not a bug — the truth about my corpus, for two reasons. **Saturation:** 28 clean posts on distinct topics means there's usually one obviously-right answer, and vectors already rank it #1. You can't beat 1.000. And the rare codes I'd planted as keyword-bait? **Subword tokenisation** — the embedding model chops `ORA-12154` into pieces (`ORA`, `12`, …), and since only one post shares those pieces, vector search finds it trivially too. The keyword arm had nothing left to fix.

This is the moment most "I added hybrid search!" posts quietly don't get written, because the honest result is *it didn't help here.* So I asked the real question: is there **any** condition where it does?

## Run 3: the one real win (+0.059)

There is — and it isn't about ranking. I added one post — *"migrating our auth to PASETO tokens…"* — and **deliberately left it un-embedded**, modelling the real gap between a post being created and the background worker computing its vector. In a live system that gap is *guaranteed*: the worker always runs after the write.

Now watch a search for `PASETO`:

- **Vector search is structurally blind to it.** No vector means it cannot be returned — not ranked low, *impossible to surface.* nDCG `0.000`.
- **The keyword arm finds it instantly** — the word is right there in the text. Hybrid puts it at #1. nDCG `1.000`.

Overall lift: **+0.059** on nDCG and MRR. But read the fine print, because it *is* the point: that one query swung 0 → 1, spread across 17 queries — `1.0 / 17 = 0.059`. **The entire lift is a single case.** The other 16 stayed flat. So +0.059 is **not** "hybrid ranks better" — it's *coverage*: hybrid can find a post that vector search can't see at all. Resilience, not reranking. I wrote that caveat down instead of putting "+6% nDCG!" on a slide.

| Run | What I compared | nDCG lift | What it really meant |
|---|---|:--:|---|
| 1 | `/search` vs `/search/hybrid` | **−0.044** | confounded — I'd also dropped the re-rank |
| 2 | `mode=semantic` vs `mode=hybrid` | **+0.000** | clean test; vectors already saturate a small corpus |
| 3 | + one un-embedded post | **+0.059** | all from one query — coverage, not ranking |

## The honest caveats

- The lift is **one query out of seventeen.** On fully-indexed content, hybrid was flat. I'm not dressing that up.
- A real *ranking* win needs a **large, dense corpus** — thousands of posts where an exact-term match gets buried under meaning-similar near-misses. My 28-post toy corpus can't manufacture that pile-up, so it honestly can't show it.
- nDCG is only as good as its answer key, and mine is small (~17 queries) — a single mislabelled post moves the number, which is exactly what bit Run 1.

## The lesson

Hybrid search earns its keep in two specific places: **large, dense corpora** (where exact matches get buried) and **resilience** (when embeddings lag or the model's down, the keyword arm still works). On a small, clean corpus it does neither — and the eval said so to my face.

But the real takeaway isn't about search at all: **change one variable at a time, and report the number you actually get.** An eval harness that only ever confirms your feature is a vanity metric. The one I trust is the one that opened by calling my new feature useless — because the next time it tells me something *did* work, I'll believe it.

It's all in the [repo](https://github.com/omkar619-dev/news-feed-go) — the `?mode` switch, the labelled set, and `cmd/eval` printing that lift column.
