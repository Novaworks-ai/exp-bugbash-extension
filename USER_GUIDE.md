# User Guide

For anyone taking part in a bug bash using this extension — not specific to any one team's
deployment. Ask whoever is running your bug bash ("your organizer") for anything deployment-specific
this guide doesn't cover: which URL to connect to, how to install it, and how to sign in.

## Installing

Your organizer will tell you which of these applies to your bash:

**Option A — Chrome Web Store link.** If your organizer gives you a Chrome Web Store link, just
open it and click **Add to Chrome** (or **Add to Edge**). That's it — updates arrive automatically.

**Option B — Load unpacked (always the most up-to-date version).** Use this if your organizer says
the Chrome Web Store listing isn't available yet, or asks you to use a specific newer version:

1. Go to this repo's [Releases page](../../releases) and download the `.zip` for the version your
   organizer tells you to use (or the latest one, if unspecified).
2. Unzip it — you'll get a folder containing `manifest.json`, `src/`, `icons/`.
3. Open `chrome://extensions` (or `edge://extensions` in Microsoft Edge).
4. Turn on **Developer mode** (top-right corner).
5. Click **Load unpacked** and select the unzipped folder — the one whose top level has
   `manifest.json` directly in it, not a parent folder.
6. The extension's icon appears in your toolbar. Pin it if you don't see it (puzzle-piece icon →
   pin).

If your organizer sends you a newer version later, repeat these steps with the new zip, or click
**Reload** on the extension's card at `chrome://extensions` after replacing the unzipped folder's
contents.

## First-time setup

1. Click the extension's icon.
2. Paste the intake service URL your organizer gave you, click **Continue**.
3. If prompted, click **Allow** on the one-time permission dialog — this lets the extension talk to
   that specific service (it doesn't request access to every site you visit).
4. If your bash uses real sign-in, click **Sign in with Microsoft** and complete the login. If your
   organizer said sign-in isn't needed for this bash, you'll skip straight to the Capture tab.

You only do this once — it's remembered until you use **Settings → Change service**.

## Using it

**Capture tab** — report a bug:

- **Pin & Capture** lets you click the exact element your report is about first — click it, then a
  window opens with the screenshot and that element already marked; draw on it if you want to point
  out anything else before continuing.
- **Capture** grabs a screenshot of whatever tab is currently active and visible, as-is.
- **Upload…** lets you attach an existing image file instead (or in addition — click
  **+ Add screenshot** or **Upload…** in the preview screen to attach more than one).
- Fill in **Steps to reproduce** and **Additional information** (what you expected to happen,
  anything else worth noting) — the more concrete these are, the less likely you'll be asked a
  follow-up question.
- Click **Submit**.

**Queue tab** — your open reports:

- Shows everything you've submitted that isn't resolved yet.
- If a report needs more detail, it'll show a question — click the item to open it and answer in
  the box that appears. Answering re-runs the automatic review immediately.
- A small green or red dot next to a routed item shows whether someone's actually connected and
  working that queue right now — green means an agent is on it, red means nobody currently is (your
  report is still safely queued either way, this just sets expectations on timing). No dot at all
  means it hasn't been routed to a queue yet.
- A small 🐞/💡/💬 tag shows how the automatic review classified your report — defect, idea/
  improvement, or other (kudos, a question, anything that isn't really a bug). It's informational
  only; it doesn't change how your report gets handled.

**History tab** — your resolved reports, once someone's picked them up and marked them fixed (or
explicitly not going to be fixed this round).

**Notifications** — you'll get a toast when a report needs an answer or gets resolved, and a small
number badge on the toolbar icon for anything resolved you haven't looked at yet (opening the
extension, or clicking the notification, clears it).

**Settings tab**:

- Shows your connected service, with **Sign out** / **Change service** buttons.
- **Target app (for log correlation)** is optional — only fill this in if your organizer
  specifically asks you to. It's the URL of the app you're actually testing (different from the
  intake service above), and lets the team correlate your bug report with that app's own logs
  around the time you hit it.

## Troubleshooting

- **Stuck on "Signing in..." or the Continue button seems to do nothing after a permission
  prompt**: this is a known browser quirk — the permission dialog can close the popup mid-action.
  Just reopen the extension; it resumes automatically once permission's granted, without needing to
  retype anything.
- **No toast notification, but you do see a badge count**: the extension successfully detected the
  update — the toast itself may be getting suppressed by your OS's notification settings for your
  browser (check System Settings → Notifications on macOS, or the equivalent on your OS), or a
  Focus/Do Not Disturb mode. The badge count is the reliable signal either way.
- **"Couldn't reach that service"**: double check the URL your organizer gave you, and that you have
  network access to it (a local/internal bug-bash deployment may require VPN, or only be reachable
  during the bash itself).
- Anything else: ask your organizer — deployment specifics (auth requirements, network access,
  which version to use) vary per bash and aren't something this guide can cover generically.
