# Chrome Web Store listing draft

Reference copy for filling out the Chrome Web Store Developer Dashboard. Not part of the
extension itself — excluded from the packaged zip via `.gitattributes`.

## Basic info

- **Name**: Bug Bash Capture
- **Summary** (132 char max): Capture a screenshot and description of a bug during a Novaworks
  bug bash and send it straight to your team's intake queue.
- **Category**: Developer Tools
- **Language**: English
- **Visibility**: Unlisted (installable only by direct link, not searchable in the Store)

## Detailed description

> Bug Bash Capture lets you report a bug the moment you spot it, without writing a formal ticket.
>
> Click the extension icon, capture the current tab, add a short description, and submit — it goes
> straight into your bug bash's intake queue. An automated critique step may ask a quick follow-up
> question if your description is missing repro steps or expected behavior; answer it right in the
> popup. You'll get a notification once your report is picked up and marked fixed (or explicitly
> not going to be fixed this round).
>
> This extension only works against an intake service your own organization configures and hosts —
> paste that service's URL into Settings the first time you use it. It is not tied to any one
> product, team, or bug bash.
>
> Sign-in uses a real Microsoft Entra ID login (Sign in with Microsoft) — no tokens to obtain or
> paste by hand.

## Privacy policy URL

`https://github.com/Novaworks-ai/exp-bugbash-extension/blob/main/PRIVACY.md`
(GitHub Pages creation is disabled at the org level, so this uses GitHub's own rendered-Markdown
view instead of a hosted HTML page — CWS review accepts this as a valid privacy policy URL.)

## Single purpose statement (required by CWS review)

> Capture a screenshot and description of a bug and submit it to a user-configured intake
> service, and show the status of previously submitted reports.

## Permission justifications (required by CWS review — Privacy practices tab)

- **activeTab / tabs**: to capture a screenshot of the tab the user is currently reporting a bug
  on, and to read that tab's URL/title to attach as context.
- **storage**: to store the user's configured intake-service URL and their auth tokens locally,
  so they aren't re-entered on every use.
- **alarms**: to run a periodic (roughly once-a-minute) background check against the configured
  intake service for new clarification questions or resolved items.
- **notifications**: to alert the user when a clarification question or fix-ready update arrives,
  without requiring the popup to be open.
- **identity**: to run the Sign in with Microsoft OAuth2 (PKCE) flow via
  `chrome.identity.launchWebAuthFlow` — the standard, supported way for an extension to run a
  public-client OAuth login.
- **declarativeNetRequest**: to add a trace-id request header on the specific "Target app" origin
  the user opts into in Settings (for the intake service to correlate a report with that app's own
  logs) — scoped to that one user-granted origin, never applied broadly.
- **scripting**: to inject a small script (also scoped to that same user-granted "Target app"
  origin) that buffers recent console errors/warnings, so a bug report can include what the
  browser console actually showed instead of relying on the user to notice and transcribe it by
  hand. Deliberately not `debugger` (Chrome DevTools Protocol) — that permission is far more
  invasive (a persistent "this extension is debugging your browser" banner) for the same outcome.
- **optional_host_permissions (`http://*/*`, `https://*/*`)**: declared as *optional*, not
  required — nothing is granted at install. The intake service URL and the "Target app" URL are
  both user-supplied settings (different bug-bash deployments point at different self-hosted
  backends), so the exact domains aren't known ahead of time. The extension requests permission for
  just the specific origin the user enters, at the moment they enter it
  (`chrome.permissions.request`), never for "all sites" — see `src/settings.js`'s
  `requestOriginPermission`.

## Assets still needed before submitting

- [x] At least one screenshot, 1280x800 or 640x400 (PNG/JPEG) —
  `screenshots/screenshot-3-home.png` (640x400), from a real popup capture (merged
  Capture/Queue home view, v0.7.5). Screenshots 1/2 are from the pre-merge Capture/Queue/
  History/Settings tab layout (v0.2.0) — worth recapturing against current `main` before
  submitting so all listing images reflect the same UI.
- [ ] Store icon: 128x128 already exists at `icons/icon128.png`, reusable as-is.
- [ ] Support email / contact — decide which address to list (personal vs. a shared Novaworks
  inbox).

## Submission steps (once the developer account exists)

1. https://chrome.google.com/webstore/devconsole/ → New item.
2. Upload the packaged zip (`npm run` equivalent here is just `git archive` — the same
   `bug-bash-capture-vX.Y.Z.zip` the release workflow produces, or build fresh from `main`).
3. Fill in the fields above.
4. Submit for review, Visibility = Unlisted.
5. Share the resulting Store listing URL (or "Trusted testers" list) with whoever needs to install
   it once approved — no more manual unpacked-load instructions needed at that point.
