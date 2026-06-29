---
title: A Social Feed You SSH Into — One Domain Core, Two Front Doors
description: A friend asked if he could SSH into my feed. Building the terminal app was the easy part — the interesting part was doing it without duplicating a single line of business logic, by pulling the domain out of my HTTP handlers into a service core that both the REST API and the SSH TUI sit in front of.
---

A friend, half-joking: *"your feed's just a backend with a REST API… could I `ssh` into it and read it in my terminal?"* Yes — and you can do more than read: **like, comment, reply, follow, delete, all over SSH, with your SSH key as the login.** But here's the part worth writing about: building the terminal UI was the easy bit. The interesting bit was making sure it reused *all* of the backend — zero duplicated logic — which forced a refactor I should have done anyway.

(This rides on top of the whole [news-feed](/projects/designing-news-feed-schema/) — same Postgres, same everything. It adds a *front door*, not a feature.)

## The idea, and the trap

The Go ecosystem has a lovely set of libraries from [Charm](https://charm.sh): **wish** (an SSH server you write in Go), **Bubble Tea** (a terminal-UI framework), **Lip Gloss** (styling). Together: someone runs `ssh feed.example.com` and a TUI of the feed appears in *their* terminal. wish even hands you the client's **public key** on connect — so the SSH key can *be* the login.

So the TUI needs to read posts and write likes/comments/follows/deletes. The lazy way: have the TUI talk straight to Postgres and run the inserts itself.

That's a trap, and naming *why* is the whole point of this post. My write paths aren't plain inserts — each carries real machinery:

- creating a post writes a [transactional-outbox event](/projects/the-dual-write-bug-and-the-outbox/) so it gets fanned out and embedded;
- a like runs a [Redis hot-counter](/projects/likes-and-the-hot-counter-problem/) with a cold-seed from the table;
- a delete enforces ownership;
- a comment can be a [nested reply](/projects/threaded-comments-recursive-cte/) via a self-referencing parent.

If the TUI re-implemented those, I'd have **two divergent copies** of my logic — and the TUI's copy would quietly skip the outbox (no fan-out), skip the counter, skip the ownership check. That bug isn't hypothetical; it's *guaranteed* the moment you copy-paste domain logic into a second caller.

So the real question was never "how do I write CRUD in a TUI." It was: **how does a second interface reuse the logic the first one already has?**

## The fix: a domain core, two adapters

The answer is **ports and adapters** (hexagonal architecture). Pull the business logic out of the HTTP handlers into a package of plain functions — `internal/service` — and let *both* the HTTP handlers and the SSH TUI call them.

A service function looks like this:

```go
func Like(ctx context.Context, q sqlc.Querier, counter *cache.Client, userID, postID int64) (LikeResult, error)
```

No `http.ResponseWriter`, no `ssh.Session` — just domain inputs and a domain result (plus a *sentinel error* the caller translates). The HTTP handler shrinks to a translator:

```go
res, err := service.Like(r.Context(), queries, counter, userID, postID)
if errors.Is(err, service.ErrPostNotFound) { errorJSON(w, 404, "post not found"); return }
writeJSON(w, LikeResponse{Liked: res.Liked, LikeCount: res.Count})
```

…and the TUI calls the **exact same function** — it just renders the result as a line of green text instead of JSON.

### Domain vs. delivery — the line that matters

Doing this forces you to sort every feature into one of two buckets, and that sorting *is* the senior move:

| Feature | Shared (domain)? | In the TUI? |
|---|:--:|---|
| fan-out, outbox, embeddings | ✅ | yes — via the shared `CreatePost` |
| hot-counter likes | ✅ | yes |
| comment threading, ownership checks | ✅ | yes |
| **idempotency keys** | ❌ delivery (HTTP) | no — and correctly |
| **rate limiting** | ❌ delivery (HTTP) | no |
| **JWT auth** | ❌ delivery (HTTP) | no — the SSH key replaces it |

The ❌ rows aren't losses. **Idempotency keys** guard against *a network client retrying a request whose HTTP response was lost* — a TUI keypress isn't that, so bolting it on would be *wrong*. Rate limiting is public-endpoint abuse protection. JWT is HTTP's login; the TUI's login is the key. Each concern lives with its adapter; the domain stays clean.

### The one subtlety: who owns the transaction

Creating a post writes the post *and* an outbox event, atomically. But the HTTP handler also wants to write an idempotency-key row in that *same* transaction. If `service.CreatePost` opened and committed its own transaction, the handler couldn't slip its row in.

So the service takes a `sqlc.Querier` and **does not own the transaction** — the *caller* does:

```go
// runs on whatever the caller passes: the pool, OR a transaction
func CreatePost(ctx context.Context, q sqlc.Querier, authorID int64, content string) (sqlc.Post, error)
```

The HTTP handler does `pool.Begin` → `CreatePost(tx, …)` → add idempotency row → `commit`. The TUI does `pool.Begin` → `CreatePost(tx, …)` → `commit`. Same domain code, each caller wrapping its own concerns. That "caller owns the boundary" choice is what makes the reuse actually work.

## The SSH server: your key is the login

With the logic shared, the front door is tiny. wish accepts every key, and we *identify* (not gate) the user by it:

```go
wish.WithPublicKeyAuth(func(_ ssh.Context, _ ssh.PublicKey) bool { return true }),
// ...then, per connection:
authKey := strings.TrimSpace(string(gossh.MarshalAuthorizedKey(s.PublicKey())))
if u, err := queries.GetUserBySSHKey(ctx, authKey); err == nil {
	userID, username = u.ID, u.Username   // recognized → you can act
}                                         // unknown key → read-only guest
```

A small `ssh_keys` table maps a public key to a user. **No password, no token** — register your public key once, and from then on `ssh` *is* your authenticated session. The interview line writes itself: *"same backend, two front doors — REST and SSH — and the SSH key replaces the JWT."*

## The TUI: an Elm loop with modes

Bubble Tea uses the **Elm Architecture**: a `Model` (state), `Update(msg, model) → model` (events in, new state out), and `View(model) → string` (render). The runtime loops: draw → wait for a key → update → draw.

To support typing *and* a comment thread, the model became a small **state machine** with a `mode` — list / input / comments — and `Update` routes each keypress by mode. The actions are one-liners onto the service:

```go
case "l": m = m.toggleLike(1)     // → service.Like
case "d": m = m.deleteSelected()  // → service.DeletePost (ownership enforced)
case "f": m = m.followAuthor()    // → service.FollowUser
case "n": // open a text box → service.CreatePost inside a transaction
```

And the bit my friend was smuggest about — **replying to a comment**. In the thread view, `r` grabs the selected comment's id and passes it as the new comment's parent:

```go
parentID := m.comments[m.commentCursor].ID
service.AddComment(ctx, q, postID, userID, &parentID, content)  // &parentID ⇒ a reply
```

Reload the thread and the [recursive CTE](/projects/threaded-comments-recursive-cte/) returns it one `depth` deeper — so it renders **indented under its parent**: a real nested thread, in a terminal you SSH'd into.

## The honest caveats

- **The service calls run synchronously inside `Update`**, briefly blocking the UI. For single fast queries it's invisible; the idiomatic Bubble Tea fix is to return a `tea.Cmd` that does the work off-loop and sends a result message back. Known shortcut.
- **The SSH server is trusted to mint identity from keys** — fine for a self-hosted, single-operator app; a multi-tenant version would need a proper key-registration flow.
- The thread view shows `user #<id>`, not usernames — the tree query returns author ids; joining names is a small follow-up.
- I lost ten minutes to a *great* bug: the mouse wheel sends an escape sequence whose leading `Esc` byte my code read as the "quit" key — so **scrolling closed the SSH session**. Capturing mouse events properly (and not quitting on a bare `Esc`) fixed it.

## The lesson

The novelty — a feed you SSH into — was a weekend's fun. The thing worth keeping is the refactor it forced: **if adding a second interface means copy-pasting your business logic, your business logic is in the wrong place.** Move it to a domain core, make the interfaces thin translators, and a second front door costs almost nothing — *and* it sharpens your design, because you have to decide, feature by feature, what's domain and what's merely delivery.

It's all in the [repo](https://github.com/omkar619-dev/news-feed-go) — `internal/service` is the core, `cmd/ssh` is the terminal adapter, and the HTTP handlers are now thin translators over the same functions.
