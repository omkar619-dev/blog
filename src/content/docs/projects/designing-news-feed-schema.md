---
title: Designing a News Feed in Go — Schema Decisions
description: How I structured the database for a Twitter/Reddit-style feed in Postgres + pgvector, and the trade-offs I made.
---

# Designing a News Feed in Go — Schema Decisions

[Body to be filled as you make decisions. Start with the ADR you just wrote.]

## The two query patterns

[Adapt content from ADR 0001 — be more conversational here than in the ADR]

## Users, posts, follows — the relational core

[Show schema for these three tables]

## Timelines — the hard part

[Discuss fan-out-on-read vs fan-out-on-write]

...