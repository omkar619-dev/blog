---
title: "Four attempts to test one rejection"
description: I closed a Cross-Site WebSocket Hijacking hole in my chat gateway, then tried to prove it was closed. Four browser tests failed convincingly and proved nothing at all, because everything upstream of the check I was testing rejects in exactly the same way.
---

There was a line in my WebSocket handler that said, in effect, *let anyone in*:

```go
conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
    InsecureSkipVerify: true,
})
```

It was there because local development is annoying — `localhost` and `127.0.0.1` are different origins, and the check kept rejecting my own browser. So I turned the check off, wrote a TODO, and forgot.

That line is a **Cross-Site WebSocket Hijacking** hole, and it's worse than it looks, because of one fact that surprises most people:

**The same-origin policy does not apply to WebSockets.** There is no preflight, no `Access-Control-Allow-Origin` negotiation, no browser-side veto. Any page on the internet can run `new WebSocket('wss://your-host/ws')` and the browser will make the connection — and send your cookies with it. For WebSockets, the `Origin` header isn't advisory information the browser enforces on your behalf. It is a header the server is expected to check itself, and `InsecureSkipVerify: true` is the server declining to.

The fix is two lines:

```go
conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
    OriginPatterns: h.AllowedOrigins,
})
```

The fix took a minute. **Proving the fix worked took four failed attempts and about forty minutes**, and every single failure looked like success.

## Attempt one: the console belongs to a tab

Open DevTools, paste in a connection attempt, watch it get rejected:

```js
new WebSocket('wss://my-host/ws?ticket=...&room=1')
```

It connected. Fine — clearly the check isn't working.

Except the DevTools console I'd opened was the one attached to **my chat app's own tab**. Scripts in a console run with that tab's origin. I had just proved that a page on the allowed origin is allowed, which was never in doubt.

This is the least interesting mistake here and also the one I'd bet is most common. A console is not a neutral place to run code from. It has an address, and the address is the entire thing under test.

## Attempts two, three and four: rejected for the wrong reason

So: navigate to `example.com`, open the console *there*, run the same line. Now the origin is genuinely foreign.

```text
WebSocket connection to 'wss://my-host/ws?...' failed
```

Rejected. Fix confirmed. Post the screenshot.

Then I looked at the server log, and it wasn't a `403`. It was a `401`. The connection never reached the origin check at all — it was thrown out by the ticket lookup one step earlier, because the ticket I'd pasted was invalid.

I fixed that and hit the same wall twice more, for two more unrelated reasons:

**The console had mangled the paste.** The URL in the server log had this in it:

```text
?ticket=Zm9vYmFy%E2%80%A2%E2%80%A6
```

`%E2%80%A2` is a bullet, `%E2%80%A6` is a horizontal ellipsis. Neither is in base64. The console had displayed a long string in truncated form — with `•` and `…` as *decoration* — and I had copied the decoration along with it. A silently different string that still looks right.

**And then I sent the placeholder.** The next attempt went out with the literal text `PASTE` where the ticket should have been, because that's what my own scaffolding said and I ran it before substituting.

Four attempts. One connected for the wrong reason, three were rejected for three different wrong reasons. **In the browser, all four look identical**, which is the actual lesson here.

## Why the browser can't tell you anything

JavaScript gets close code `1006` and a generic failure event. Always. It never sees the HTTP status of a failed WebSocket handshake.

That's deliberate, and it's a security property, not an oversight. If a page could read the status code of a handshake to an arbitrary host, that's a cross-origin information leak — you could probe other people's servers and learn which endpoints exist, which reject you, and which accept. So the spec denies the page any detail at all.

Which means from the client, these are **the same event**:

- your origin was rejected
- your credential was rejected
- the host doesn't resolve
- the server is down
- TLS failed

I was reading `1006` as *"the origin check worked"*. `1006` means *"it didn't connect"*, and it has nothing else to say. Every one of my four attempts produced a result perfectly consistent with the fix working, and perfectly consistent with the fix not existing.

## curl, twice, with one header changed

The way out is to stop using an instrument that can't distinguish outcomes. `curl` shows the raw response, so `401` and `403` stop being the same thing — and, more importantly, I can run the **control** first.

Speak the handshake by hand:

```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://my-host" \
  "https://my-host/ws?ticket=$T&room=1"
```

```text
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
```

**That `101` is the whole test.** It proves the ticket is valid, the room exists, the URL is right, and the handshake is well-formed — so that when the next run fails, there is exactly one remaining explanation. Every one of my four browser attempts was missing this step, which is precisely why none of them meant anything.

Now change one header:

```bash
  -H "Origin: https://evil.example" \
```

```text
HTTP/1.1 403 Forbidden
request Origin "https://evil.example" is not authorized for Host "my-host"
```

`101` and `403`, from two commands differing in one header, with the same ticket seconds apart. That's the proof. It took about ninety seconds once I stopped trying to do it through a browser.

(One detail if you try this: `Sec-WebSocket-Key` has to be the base64 of sixteen bytes. A compliant server validates the length and will reject a made-up string with a `400` — which would have been a *fifth* wrong reason.)

## Then break it again

The last step is the one I now refuse to skip. Put `InsecureSkipVerify: true` back, restart, and re-run the failing command.

If it still returns `403`, the test is measuring something else and the whole exercise was theatre. It returned `101` — the hole reopened exactly as expected — so the `403` was genuinely caused by the thing I changed. Put the fix back, confirm `403` again, and now the result means what I want it to mean.

This has caught me before. A regression test that has only ever been green is an untested test. The cheapest way to find out whether it's exercising the real path is to reintroduce the bug and watch it go red.

## Lessons

1. **A negative result is worthless without a positive control.** "It was rejected" tells you nothing until you've shown the same request being accepted with one variable changed. Three of my four attempts were rejected by code that ran *before* the code I was testing.
2. **Everything upstream of a check also rejects, and from outside they're indistinguishable.** Auth, parsing, routing, DNS — each one produces a failure that looks exactly like the failure you're hoping for.
3. **The browser is the wrong instrument for handshake testing.** Close code `1006` is intentionally uninformative, the console mangles long pastes into look-alike strings containing `•` and `…`, and the console's origin is the tab it was opened in.
4. **Read the server's log, not the client's error.** The server knows the difference between `401` and `403`. The client is forbidden from knowing it.
5. **The same-origin policy does not protect WebSockets.** No preflight, no browser veto, cookies attached. If your server doesn't check `Origin` itself, nothing does — and a convenience flag added for local dev is a plausible way to end up shipping that.
6. **Reintroduce the bug and watch the test fail.** A test that has only ever passed hasn't been tested yet.
