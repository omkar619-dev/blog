---
title: Threaded Comments and the Recursive CTE
description: Replies-to-replies turn a comment list into a tree. Here's how I store that tree in one self-referencing table, read it back depth-first with a recursive CTE, and get cascading subtree deletes for free.
---

Comments looked like the most boring item on the list — a table, a couple of endpoints. Then I let a comment reply to *another comment*, not just to the post, and the boring feature turned interesting: **a comment thread is a tree**, and trees are one of the few shapes that make you actually think in SQL. This post is how I stored that tree in a single table, read it back with a recursive CTE, and got subtree deletes thrown in for free.

(Builds on the [schema post](/projects/designing-news-feed-schema/) — same Postgres, same `sqlc`-checked queries.)

## A tree in one table

A comment can reply to the post, or to another comment, nested as deep as people care to go. You model that with one table that **points at itself**:

```sql
CREATE TABLE comments (
    id         BIGSERIAL PRIMARY KEY,
    post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES comments(id) ON DELETE CASCADE,  -- NULL = top-level
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`parent_id` references `comments(id)` — the table references **itself**. `NULL` means top-level (a reply to the post); a value means "a reply to *that* comment." This is the **adjacency list** model: every node just knows its parent. It's the simplest possible tree, it nests infinitely deep with no schema change, and writing a comment is a plain insert.

## The hard part: reading the tree

Storing is trivial; *reading* is where it gets interesting. "Give me this comment and all its descendants" **cannot be a normal `JOIN`**, because you don't know how deep the thread goes — reply to a reply to a reply. A fixed number of JOINs caps the depth; I wanted arbitrary nesting. That's exactly what `WITH RECURSIVE` is for.

The mental model: **drop a stone in a pond.** The splash is the top-level comments. The first ripple is the replies to those. The next ripple, replies to *those*. You keep expanding until a ripple finds nothing new — then you stop.

```sql
WITH RECURSIVE thread AS (
    -- ANCHOR (the splash): top-level comments on this post
    SELECT c.id, c.parent_id, c.content, c.created_at,
           1 AS depth,
           ARRAY[c.id] AS path
    FROM comments c
    WHERE c.post_id = $1 AND c.parent_id IS NULL

    UNION ALL

    -- RECURSIVE (each ripple): replies to comments we've already collected
    SELECT c.id, c.parent_id, c.content, c.created_at,
           t.depth + 1,
           t.path || c.id
    FROM comments c
    JOIN thread t ON c.parent_id = t.id
)
SELECT id, parent_id, content, created_at, depth
FROM thread
ORDER BY path;
```

(CTE = *Common Table Expression* — the `WITH name AS (…)` scratchpad. `RECURSIVE` lets it reference itself.)

The **anchor** runs once: the top-level comments. The **recursive half** references `thread` — the results gathered *so far* — and finds the next layer: comments whose `parent_id` is something we already have. Postgres repeats that half, each pass feeding on the rows the previous pass added, until a pass adds nothing. `UNION ALL` stacks every layer into `thread`. That self-reference — a query that grows its own input until it runs dry — is the whole trick.

## Getting the order right: the `path` trick

A flat list of tree nodes is useless in the wrong order — I want each reply sitting *under* its parent. So I carry two extra columns down the recursion:

- **`depth`** — `1` for top-level, `+1` per level. The client uses it to indent.
- **`path`** — an array of ids from the root down to this node: `[1]`, then `[1,2]`, then `[1,2,3]`, while a separate root is `[4]`.

`ORDER BY path` sorts those arrays — `[1] < [1,2] < [1,2,3] < [4]` — which is **depth-first**: every comment's descendants land right after it, before the next root. Same reason sorting file paths (`/1`, `/1/2`, `/4`) groups everything under its folder. It's outline numbering. The rows come back already in render order, each tagged with a depth — the client does **zero** tree assembly.

## Delete, and the cascade I got for free

`parent_id` carries `ON DELETE CASCADE`. Because the foreign key points at the *same table*, deleting a comment cascades to its replies — which cascades to *their* replies — all the way down. So one owner-scoped delete:

```sql
DELETE FROM comments WHERE id = $1 AND author_id = $2 RETURNING id;
```

quietly removes the **entire subtree**. I tested it with a top-level comment → reply → reply-to-reply: deleting the top one wiped out all three — and the reply-to-reply was a *grandchild*, so the cascade chained two levels down on its own. The `RETURNING id` pulls double duty: the `WHERE author_id` is the ownership check, and "did a row come back?" answers "did anything actually delete?" (none → `404`).

## The alternatives (honestly)

Adjacency-list + recursive CTE is the simplest thing that works — but it isn't the only tree model:

- **Materialized path** — store the path string (`1/2/3`) on each row; reads become a `LIKE '1/2/%'` with no recursion, but moving a subtree means rewriting paths.
- **Closure table** — a side table of every ancestor→descendant pair; fast arbitrary ancestor queries, at the cost of write overhead and storage.
- **Nested sets** — clever left/right numbering; superb reads, painful inserts.

For a comment thread — write-light, usually read as a whole subtree, almost never re-parented — adjacency list + recursive CTE is the right call: zero extra tables, and the recursion only ever walks one post's comments. I'd reach for a closure table only if I needed fast "is X an ancestor of Y" across a huge tree. **Pick the tree model for the queries you actually run**, not the cleverest one.

## The nullable wrinkle (small, but real)

One Go-side annoyance worth naming: `parent_id` is nullable, and "a number that might be absent" has *three* spellings — SQL `NULL`, the driver's `pgtype.Int8{Valid:false}`, and JSON `null` (which I model as a Go `*int64`). The handler is just a translator across those three. Not hard, but it's the quiet impedance-mismatch that shows up *every* time the database allows NULL.

## The lesson

The takeaway isn't the syntax — it's that **the shape of your data dictates the query, and "tree" is a shape SQL handles fine; you just have to ask *recursively*.** A self-referencing table, `WITH RECURSIVE`, and a path-ordering trick give you arbitrarily-deep threads, returned in render order, with cascading deletes for free — no extra tables, no application-side tree-building.

It's all in the [repo](https://github.com/omkar619-dev/news-feed-go).
