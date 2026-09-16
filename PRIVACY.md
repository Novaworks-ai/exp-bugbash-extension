# Bug Bash Capture — Privacy Policy

_Last updated: 2026-09-16_

Bug Bash Capture is an internal Novaworks tool. It lets a tester capture a screenshot and a short
description of a bug during a bug-bash session, and send that report to an intake service **the
tester's own organization configures and hosts** — never a service this extension's authors run or
have access to.

## What the extension captures

- A screenshot of the currently visible browser tab, taken only when the user clicks "Capture this
  page."
- The free-text bug description the user types.
- The captured page's URL and title.

The extension never captures data automatically, in the background, or from tabs the user hasn't
explicitly chosen to capture.

## Where that data goes

All of the above is sent only to the intake service URL the user (or their organization) enters in
the extension's Settings tab — a self-hosted backend the extension's authors do not operate,
control, or receive any data from. No data is sent to any third party by the extension itself.

## Authentication

Signing in uses Microsoft Entra ID via `chrome.identity.launchWebAuthFlow` — a standard OAuth2
authorization-code + PKCE flow directly against Microsoft's own login page. The extension never
sees or stores the user's password; it stores only the resulting access and refresh tokens, in the
browser's own extension storage, used solely to authenticate requests to the configured intake
service.

## Why the extension requests broad host permissions

The intake service's URL is a user-supplied setting, not a fixed domain — different bug-bash
deployments point at different self-hosted backends. Broad host permissions let the extension reach
whichever URL is configured, and Microsoft's own login/token endpoints for the OAuth flow above;
the extension does not read, modify, or transmit page content from any site beyond the
screenshot/description a user explicitly submits.

## Data retention and deletion

The extension stores settings and auth tokens locally in the browser only. Submitted captures are
retained by whichever intake service the user configured, under that organization's own retention
policy — not by this extension. Uninstalling the extension removes all locally stored data.

## Contact

Questions about this extension: open an issue at
[github.com/Novaworks-ai/exp-bugbash-extension](https://github.com/Novaworks-ai/exp-bugbash-extension).
