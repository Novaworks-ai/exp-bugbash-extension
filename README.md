# exp-bugbash-extension

Generic Chrome/Edge (Manifest V3) capture extension for **any** Novaworks bug bash — not specific
to any one consuming repo.

## Status: first cut, runnable locally

A working extension exists under [`src/`](src/) — Capture / Queue / History / Settings tabs,
`chrome.tabs.captureVisibleTab()` capture, submit to a configured intake service, an in-popup
clarification answer flow, and a background poll that raises a notification once an item is marked
fixed/unsolved. Everything past this section is the original design spec this build started from —
still accurate as the target shape, kept as-is rather than rewritten now.

### Running it locally

1. Start [`exp-bugbash-intake-py`](https://github.com/Novaworks-ai/exp-bugbash-intake-py) locally
   (see its own README) — for local trial, run it with `AUTH_DISABLED=true` so every request is
   treated as one dev filer and no token is needed.
2. Load this extension unpacked: `chrome://extensions` → enable Developer mode → **Load unpacked**
   → select this repo's root directory (the one containing `manifest.json`).
3. Open the extension popup → **Settings** tab → set **Intake service URL** to
   `http://localhost:8000` (or whatever port you ran the backend on) → **Save**. Leave **Access
   token** blank against an `AUTH_DISABLED=true` backend.
4. **Capture** tab → **Capture this page** → add a description → **Submit**.
5. **Queue** tab shows it; if the critique engine has an open question, clicking the item opens an
   in-popup detail view with an answer box — answering re-runs critique/routing immediately.
6. Mark an item resolved directly against the backend to see the fix-ready notification, e.g.:
   `curl -X PATCH http://localhost:8000/captures/<id>/resolution -H "Content-Type: application/json" -d '{"resolution":"fixed"}'`
   — the background poll picks it up within a minute (or click **Refresh** on the **History** tab).

### Known gaps in this first cut

- **Auth** is a plain bearer token pasted into Settings, not a real in-extension Entra ID OAuth
  Connect flow — fine for local trial against an `AUTH_DISABLED=true` backend or a manually-obtained
  token, not yet what a real multi-tester bug bash needs.
- No offline queueing (matches the non-goal below) and no retry — a failed submit must be redone by
  hand.

Everything below this point is the original pre-build spec, kept as the design record.

---

This README is the spec this repo started from, per the design worked out
in `local-sn`'s
[`problems/049-manual-exploratory-testing.md`](https://github.com/Novaworks-ai/local-sn/blob/main/problems/049-manual-exploratory-testing.md)
and its own published architecture diagram ("Bug Bash Pipeline"). That design was framed around
`local-sn`'s own bug bash — everything below generalizes it so the same extension can be pointed at
a different backend for a different Novaworks team's own bug bash.

## What this is

Companion to
[`exp-bugbash-intake-py`](https://github.com/Novaworks-ai/exp-bugbash-intake-py). Lets a tester
capture a bug in place — a screenshot plus a short description — during any Novaworks bug bash,
without needing to know how to write up a formal report for whatever repo or tracker the target
team actually uses.

## What needs to happen

1. **Manifest V3 scaffold** — a popup styled after a dev-tool extension (a branded header with a
   version badge, a tab bar, a Connect flow was the visual reference used during design, not a
   requirement to copy exactly). Suggested tabs: Capture / Queue / History / Settings.
2. **Capture** — `chrome.tabs.captureVisibleTab()` plus a free-text description and the page
   URL/title, sent as `multipart/form-data` to the *configured* intake endpoint.
3. **Auth** — OAuth against whatever the configured intake service requires (Entra ID is the first
   real target, matching `exp-bugbash-intake-py`'s own default) — stored in extension storage after
   a Connect flow, never hardcoded.
4. **Settings tab — the actual generic-ness lever.** The intake service's base URL (and whatever
   auth config it needs) is a *setting*, not a constant. This is what makes one build of this
   extension usable across completely different Novaworks bug bashes, each pointed at its own
   backend deployment.
5. **Clarification loop** — surface open questions the critique step asks back, and let the filer
   answer inline. The actual delivery mechanism needs deciding jointly with
   `exp-bugbash-intake-py` (see that repo's README) — most likely a revisit-able page keyed by
   capture id that a background script polls, or is pushed to.
6. **Fix-ready notification** — show "fixed — retry" for a capture the filer submitted, once the
   intake service reports it (see the architecture diagram: the intake service is the one that
   notifies, never the fixing pipeline directly).

## Non-goals for v1

- Chrome/Edge (Manifest V3) only — no Firefox/Safari support.
- No offline queueing of captures — if the network's down, the capture fails loudly and visibly,
  not silently queued for later (matches `local-sn`'s own
  [`decisions/0027`](https://github.com/Novaworks-ai/local-sn/blob/main/decisions/0027-no-non-working-shims-defer-instead.md)
  "no non-working shims, defer instead" convention).

## Generic-by-design checklist (read before writing any code)

- [ ] Backend URL is a Settings field, never hardcoded anywhere in the extension.
- [ ] No consuming-team-specific branding or copy in the UI — "Bug Bash" as the generic product
      name; a per-deployment display name/logo is a nice-to-have config, not assumed.
- [ ] Nothing in the extension assumes the fixing pipeline behind the configured backend is any
      particular technology — the extension only ever talks to the intake service's own API.

## Prior art

- [`local-sn/problems/049-manual-exploratory-testing.md`](https://github.com/Novaworks-ai/local-sn/blob/main/problems/049-manual-exploratory-testing.md)
  — the original design conversation and rationale, `local-sn`-specific framing kept as a worked
  example.
- [`exp-bugbash-intake-py`](https://github.com/Novaworks-ai/exp-bugbash-intake-py) — the backend
  this extension talks to; read its README for the shared-store/critique/routing contract.
