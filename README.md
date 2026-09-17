# exp-bugbash-extension

Generic Chrome/Edge (Manifest V3) capture extension for **any** Novaworks bug bash — not specific
to any one consuming repo.

**Taking part in a bug bash?** See [`USER_GUIDE.md`](USER_GUIDE.md) for install + usage
instructions. This README is the design/development reference.

## Status: first cut, runnable locally

A working extension exists under [`src/`](src/) — Capture / Queue / History / Settings tabs,
`chrome.tabs.captureVisibleTab()` capture, submit to a configured intake service, an in-popup
clarification answer flow, a real Sign in with Microsoft flow, and a background poll that notifies
on two kinds of change: a new clarification question, and an item marked fixed/unsolved. Everything
past this section is the original design spec this build started from — still accurate as the
target shape, kept as-is rather than rewritten now.

### First-run onboarding (no pasted tokens)

Opening the popup for the first time shows a two-step gate, not the Capture/Queue/History tabs —
someone with no idea what a "tenant ID" or "access token" is (a PM, a marketer, anyone just trying
the bug bash) only ever has to do two things:

1. **Paste the intake service's URL.** The extension calls that service's own `GET /auth/config` to
   discover whether it needs auth at all, and if so, its Entra ID tenant/client ID — nothing here is
   typed by the filer.
2. **Click "Sign in with Microsoft"** (skipped entirely if the service reports `auth_disabled`). This
   opens a real Microsoft sign-in window via `chrome.identity.launchWebAuthFlow` — an OAuth2
   authorization-code + PKCE flow, no client secret, no manually-obtained token. The resulting access
   token (and a refresh token, if the tenant grants one) live in extension storage; the background
   poll and popup silently refresh it before it expires, only falling back to another interactive
   sign-in if the refresh itself is rejected.

**Settings** (once connected) only shows the connected service, a **Sign out**, and a
**Change service** button — signing out or changing service just re-opens this same gate.

### Entra ID app registration requirements

For the Sign in with Microsoft step to work, the intake service's own Entra ID app registration
needs, one time, from whoever administers it:

- A **"Single-page application"** platform redirect URI equal to
  `https://<extension-id>.chromiumapp.org/` (the value `chrome.identity.getRedirectURL()` returns —
  visible on `chrome://extensions` once this extension is loaded, as its ID). This is Chrome's
  documented redirect target for `launchWebAuthFlow`, not a URL this project can host. **Must be
  "Single-page application," not "Mobile and desktop applications"** — confirmed live: the token
  exchange (`src/oauth.js`) is a `fetch()` POST from the extension's own JS, a genuine cross-origin
  browser request carrying `Origin: chrome-extension://<id>`, which Microsoft's token endpoint
  rejects for a "Mobile and desktop applications"-registered redirect URI with `AADSTS9002326:
  Cross-origin token redemption is permitted only for the 'Single-Page Application' client-type` —
  the interactive login itself completes fine; only the token exchange right after it fails, with no
  other visible symptom.
- The app registration's own delegated permission (`<client-id>/.default`) grantable to a signed-in
  user, and `offline_access` allowed, so the extension can silently refresh instead of forcing a
  fresh interactive login roughly every hour.
- No client secret is used or needed — this is a public-client PKCE flow, matching what a browser
  extension is allowed to do safely.

### Running it locally

1. Start [`exp-bugbash-intake-py`](https://github.com/Novaworks-ai/exp-bugbash-intake-py) locally
   (see its own README) — for local trial, run it with `AUTH_DISABLED=true` so every request is
   treated as one dev filer and the Sign in step is skipped entirely.
2. Load this extension unpacked: `chrome://extensions` → enable Developer mode → **Load unpacked**
   → select this repo's root directory (the one containing `manifest.json`).
3. Open the extension popup → paste `http://localhost:8000` (or whatever port you ran the backend
   on) → **Continue**. Against `AUTH_DISABLED=true` this drops straight into the Capture tab.
4. **Capture** tab → **Capture this page** → add a description → **Submit**.
5. **Queue** tab shows it; if the critique engine has an open question, clicking the item opens an
   in-popup detail view with an answer box — answering re-runs critique/routing immediately. A new
   question also raises a notification within a minute even with the popup closed; clicking it jumps
   straight to that item's detail view.
6. Mark an item resolved directly against the backend to see the fix-ready notification, e.g.:
   `curl -X PATCH http://localhost:8000/captures/<id>/resolution -H "Content-Type: application/json" -d '{"resolution":"fixed"}'`
   — the background poll picks it up within a minute (or click **Refresh** on the **History** tab).

To exercise the real Entra ID path locally, run the backend with `AUTH_DISABLED=false` plus real
`ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID` values and a real app registration configured as above.

### Known gaps in this first cut

- No offline queueing (matches the non-goal below) and no retry — a failed submit must be redone by
  hand.
- The background poll's new-question notification doesn't distinguish "asked while I was away" from
  "asked seconds ago" — both fire the same way once the 1-minute alarm ticks past it.

### Future asks

- **A "stream of changes" feed under Open items** — filers have twice asked (independently) for
  something showing what changed recently, ideally a collapsible accordion, rather than relying
  solely on toast notifications and the toolbar badge count to notice a status change. The live
  panel-refresh fix (popup.js reacting to `chrome.storage.onChanged`) and the notification-alarm
  reliability fix both address *getting notified something changed*, but neither adds a visible
  history/feed of *what* changed and *when*. Needs a developer to specify the design before an
  agent builds it — open questions include: one bug-bash-wide feed or per-item; what counts as an
  entry (status transitions? new questions? resolutions?); how far back it should show; and how it
  interacts with the existing History tab.

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
