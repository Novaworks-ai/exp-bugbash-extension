# CLAUDE.md

Guidance for Claude Code (and anyone else) working in this repo. Bootstrap file — expand with real
conventions as they solidify; for now this exists mainly for the caution below.

## This repo is PUBLIC

`exp-bugbash-extension` (`Novaworks-ai/exp-bugbash-extension`) is a public GitHub repo, and its
releases are the real installable artifact — anyone, including outside this org, can get it via
GitHub releases and (once submitted) the Chrome Web Store listing. Treat everything committed here
as visible to the world:

- Never commit secrets, real tenant/client IDs, internal URLs, or anything Novaworks-internal-only
  — including in commit messages and code comments, not just file contents.
- `exp-bugbash-intake-py` (the backend this extension talks to) is a **private**, sibling repo —
  don't assume anything decided or written there is safe to reference, copy, or link to verbatim
  from here.
