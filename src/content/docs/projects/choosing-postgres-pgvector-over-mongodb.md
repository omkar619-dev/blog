---
title: Why I chose Postgres + pgvector over MongoDB for a news feed
description: A news feed needs both relational queries and vector similarity search. Here's why I put both in one Postgres instead of reaching for MongoDB or a dedicated vector database — and the conditions under which I'd change my mind.
---

I'm building a Twitter/Reddit-style news feed in Go as a production-shape side project. The very first real decision wasn't a framework or a queue — it was where the data lives. And it turned out to be more interesting than I expected, because a feed asks the database two questions that pull in opposite directions.

## Two query patterns, one feed

The first pattern is boringly relational:

- Who does this user follow?
- Give me the posts from those users, newest first.
- Walk this comment thread.

These are joins and ordered scans over foreign-key relationships. This is exactly what a relational database was built for.

The second pattern is not relational at all:

- "Show me posts *related* to this one."

That's a nearest-neighbour search over content embeddings — vectors, cosine distance, an approximate-nearest-neighbour index. Nothing about `JOIN` or `ORDER BY created_at` helps you here.

So I had a system that needed strong relational guarantees *and* vector similarity search. The question was whether to serve both from one store or split them.

## The options I weighed

1. **PostgreSQL + the `pgvector` extension** — relational and vector data in the same database.
2. **MongoDB + Atlas Vector Search** — document store with vector search bolted on.
3. **PostgreSQL + Pinecone** — relational data in Postgres, vectors in a dedicated vector DB.

## The decision

I went with **PostgreSQL + pgvector as a single store for both**.

The deciding factor was operational weight, not raw performance. Option 3 (Postgres + Pinecone) means two datastores to run, two failure modes to reason about, two things to back up, and a consistency gap between them — a post can exist in Postgres before its vector exists in Pinecone, and now I'm writing reconciliation logic for a project that doesn't need it yet. Option 1 collapses all of that into one engine.

A few other things tipped it:

- **ACID where it matters.** Follows and posts are relational writes I want to be transactional. Mongo can do this now, but Postgres is where it's least surprising.
- **pgvector is enough at this scale.** Its HNSW index is documented to handle several million vectors at sub-100ms p99 — comfortably above anything this project will see. I'm not going to out-scale it as a portfolio system, and I'd rather not pay the complexity tax for headroom I won't use.
- **SQL I already know.** One query language, fewer operational surprises, and `sqlc` gives me compile-time-checked queries on top.
- **No vendor lock-in, no bill.** It's a Postgres extension.

Here's the actual embeddings table and index from the schema:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE post_embeddings (
    post_id   BIGINT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    embedding vector(384)
);

CREATE INDEX idx_post_embeddings_hnsw ON post_embeddings
    USING hnsw (embedding vector_cosine_ops);
```

`vector(384)` because that's the dimensionality of the sentence-embedding model I plan to use; `vector_cosine_ops` because I care about semantic direction, not magnitude. The embedding hangs off `post_id` with a cascading delete, so a deleted post can't leave an orphaned vector behind.

## What this costs me

Choosing one store isn't free, and pretending otherwise is how you get burned later. The honest trade-offs:

- **I can't natively shard vectors across many nodes** the way a dedicated vector DB can. Acceptable now; a real constraint if this ever became large.
- **HNSW index maintenance competes with write traffic.** Heavy posting could nudge query latency while the index updates. Something to watch, not a reason to avoid it.
- **I'll need to actually monitor pgvector** once post count climbs past ~1M, rather than assuming the sub-100ms figure holds forever on my hardware.

## When I'd change my mind

If vector search ever became the bottleneck — write contention on the index, or scale past what one Postgres can hold — the move is to extract embeddings into a dedicated store (Qdrant or Pinecone) and keep all the relational data in Postgres. The way to keep that cheap later is to keep the vector operations behind an interface *now*, so swapping the implementation doesn't ripple through the codebase. That's the migration path I'm designing toward, not one I've had to take.

## Where this sits in the build

As of writing, the schema is in place, the Postgres connection pool is wired with `pgx`, `/healthz` is live (and actually pings the database before reporting OK), and the signup endpoint is next. The fan-out writer that populates the `timelines` table — the genuinely hard part — comes after that, and it'll get its own post.

This decision is written up as [ADR 0001](https://github.com/omkar619-dev/news-feed-go/blob/main/docs/adr/0001-postgres-with-pgvector-over-mongo.md) in the repo. I'm documenting each real decision as an ADR and turning the interesting ones into posts here.
