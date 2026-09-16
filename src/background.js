// Polls the configured intake service for two kinds of change since the last
// check: a capture moved to a resolved state (fixed / unsolved), or the
// critique loop asked a new clarification question that hasn't been shown
// yet. Both raise a notification. The intake service is the one source of
// truth for status — this never talks to whatever fixing pipeline is behind
// it.

const POLL_ALARM = "bugbash-poll-captures";
const SEEN_RESOLVED_KEY = "seenResolvedIds";
const SEEN_QUESTION_ROUNDS_KEY = "seenQuestionRounds"; // { [captureId]: highestRoundSeen }
const PENDING_CAPTURE_KEY = "pendingCaptureId"; // set on notification click, read by popup.js

// Resolved captures the filer hasn't acknowledged yet -- shown as a count
// badge on the toolbar icon (see updateBadge), since a chrome.notifications
// toast is easy to miss/dismiss and gives no lasting sign that a fix is
// waiting. Cleared by popup.js on open.
const UNREAD_RESOLVED_KEY = "unreadResolvedIds";
const BADGE_COLOR = "#4f46e4";

// A capture can sit in "ready" indefinitely if it's routed to a focus area
// no fixing agent is actually servicing -- from the filer's side that's
// indistinguishable from "stuck", so surface it rather than leaving them
// wondering. One-shot per capture (STALE_NOTIFIED_KEY), not repeated on
// every poll.
const STALE_READY_MS = 15 * 60 * 1000;
const STALE_NOTIFIED_KEY = "staleNotifiedIds";

importScripts("settings.js", "oauth.js", "api.js");

// Log-correlation trace header: if the filer has configured a target app
// (Settings) and granted permission for its origin, every request to that
// site carries X-Bugbash-Trace-Id so the intake service can grep its own
// logs for it (see exp-bugbash-intake-py's app/log_source.py). Session-
// scoped rules don't survive a browser restart, hence reapplying on
// onStartup too, not just onInstalled/storage changes.
const TRACE_HEADER_RULE_ID = 1;

async function applyTraceHeaderRule() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [TRACE_HEADER_RULE_ID] });

  const settings = await getSettings();
  if (!settings.targetAppUrl) return;

  const granted = await hasOriginPermission(settings.targetAppUrl);
  if (!granted) return; // permission was revoked since the URL was saved

  const traceId = await getOrCreateTraceId();
  const domain = new URL(normalizeBackendUrl(settings.targetAppUrl)).hostname;

  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: TRACE_HEADER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "X-Bugbash-Trace-Id", operation: "set", value: traceId }],
        },
        condition: {
          requestDomains: [domain],
          resourceTypes: [
            "main_frame",
            "sub_frame",
            "xmlhttprequest",
            "script",
            "stylesheet",
            "image",
            "font",
            "object",
            "ping",
            "csp_report",
            "media",
            "websocket",
            "other",
          ],
        },
      },
    ],
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.targetAppUrl || changes.traceId)) {
    applyTraceHeaderRule().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  applyTraceHeaderRule().catch(() => {});
  updateBadge().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  applyTraceHeaderRule().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollCaptures().catch(() => {
      // Network errors here are expected when no backend is configured yet,
      // it's unreachable, or sign-in has lapsed — fail quietly, the popup
      // surfaces connectivity/auth state on open.
    });
  }
});

async function updateBadge() {
  const stored = await chrome.storage.local.get(UNREAD_RESOLVED_KEY);
  const unread = stored[UNREAD_RESOLVED_KEY] || [];
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: unread.length ? String(unread.length) : "" });
}

async function markResolvedRead(captureId) {
  const stored = await chrome.storage.local.get(UNREAD_RESOLVED_KEY);
  const unread = (stored[UNREAD_RESOLVED_KEY] || []).filter((id) => id !== captureId);
  await chrome.storage.local.set({ [UNREAD_RESOLVED_KEY]: unread });
  await updateBadge();
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const captureId = notificationId.replace(/^bugbash-(resolved|question|stale)-/, "");
  await chrome.storage.local.set({ [PENDING_CAPTURE_KEY]: captureId });
  chrome.notifications.clear(notificationId);
  await markResolvedRead(captureId);
  if (chrome.action.openPopup) {
    try {
      await chrome.action.openPopup();
      return;
    } catch (_) {
      // openPopup requires the window to have focus in some Chrome versions —
      // fall through to opening the backend's own revisit page instead.
    }
  }
  const { backendUrl } = await getSettings();
  if (backendUrl) {
    chrome.tabs.create({ url: `${normalizeBackendUrl(backendUrl)}/web/captures/${captureId}` });
  }
});

async function pollCaptures() {
  const settings = await getSettings();
  if (!isConnected(settings)) return;

  const items = await listCaptures(false); // status=open: awaiting-clarification or ready-but-unresolved
  await notifyNewQuestions(items);
  await notifyStaleReady(items);

  const resolvedItems = await listCaptures(true);
  await notifyResolved(resolvedItems);
}

async function notifyStaleReady(openItems) {
  const stored = await chrome.storage.local.get(STALE_NOTIFIED_KEY);
  const notified = new Set(stored[STALE_NOTIFIED_KEY] || []);
  const now = Date.now();

  for (const item of openItems) {
    if (item.status !== "ready" || notified.has(item.id)) continue;
    const age = now - new Date(item.updated_at).getTime();
    if (age < STALE_READY_MS) continue;

    chrome.notifications.create(`bugbash-stale-${item.id}`, {
      type: "basic",
      iconUrl: "../icons/icon128.png",
      title: "Bug Bash: still waiting",
      message: item.focus_area
        ? `This report has been ready for a while with no fix yet (routed to "${item.focus_area}"). It may be outside the current fixing capacity for that area.`
        : "This report has been ready for a while with no fix yet.",
    });
    notified.add(item.id);
  }

  await chrome.storage.local.set({ [STALE_NOTIFIED_KEY]: Array.from(notified) });
}

async function notifyNewQuestions(openItems) {
  const stored = await chrome.storage.local.get(SEEN_QUESTION_ROUNDS_KEY);
  const seenRounds = stored[SEEN_QUESTION_ROUNDS_KEY] || {};

  for (const item of openItems) {
    if (item.status !== "awaiting-clarification") continue;
    const openRound = (item.clarifications || []).find((c) => c.answer === null || c.answer === undefined);
    if (!openRound) continue;

    const lastSeen = seenRounds[item.id] || 0;
    if (openRound.round <= lastSeen) continue;

    chrome.notifications.create(`bugbash-question-${item.id}`, {
      type: "basic",
      iconUrl: "../icons/icon128.png",
      title: "Bug Bash: a question about your report",
      message: openRound.question,
    });
    seenRounds[item.id] = openRound.round;
  }

  await chrome.storage.local.set({ [SEEN_QUESTION_ROUNDS_KEY]: seenRounds });
}

async function notifyResolved(resolvedItems) {
  const stored = await chrome.storage.local.get([SEEN_RESOLVED_KEY, UNREAD_RESOLVED_KEY]);
  const seen = new Set(stored[SEEN_RESOLVED_KEY] || []);
  const unread = new Set(stored[UNREAD_RESOLVED_KEY] || []);

  const newlyResolved = resolvedItems.filter((item) => !seen.has(item.id));
  for (const item of newlyResolved) {
    const title = item.resolution === "fixed" ? "Bug Bash: fix ready" : "Bug Bash: item unresolved";
    // Prefer the fixer's own note -- it's what to check against, e.g. what
    // changed and how to verify -- falling back to the original report when
    // there isn't one.
    const body = item.resolution_note || item.description;
    chrome.notifications.create(`bugbash-resolved-${item.id}`, {
      type: "basic",
      iconUrl: "../icons/icon128.png",
      title,
      message: body ? body.slice(0, 200) : "Open the extension for details.",
    });
    seen.add(item.id);
    unread.add(item.id);
  }

  await chrome.storage.local.set({
    [SEEN_RESOLVED_KEY]: Array.from(seen),
    [UNREAD_RESOLVED_KEY]: Array.from(unread),
  });
  await updateBadge();
}
