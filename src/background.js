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

importScripts("settings.js", "oauth.js", "api.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
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

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const captureId = notificationId.replace(/^bugbash-(resolved|question)-/, "");
  await chrome.storage.local.set({ [PENDING_CAPTURE_KEY]: captureId });
  chrome.notifications.clear(notificationId);
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

  const resolvedItems = await listCaptures(true);
  await notifyResolved(resolvedItems);
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
  const stored = await chrome.storage.local.get(SEEN_RESOLVED_KEY);
  const seen = new Set(stored[SEEN_RESOLVED_KEY] || []);

  const newlyResolved = resolvedItems.filter((item) => !seen.has(item.id));
  for (const item of newlyResolved) {
    const title = item.resolution === "fixed" ? "Bug Bash: fix ready" : "Bug Bash: item unresolved";
    chrome.notifications.create(`bugbash-resolved-${item.id}`, {
      type: "basic",
      iconUrl: "../icons/icon128.png",
      title,
      message: item.description ? item.description.slice(0, 120) : "Open the extension for details.",
    });
    seen.add(item.id);
  }

  await chrome.storage.local.set({ [SEEN_RESOLVED_KEY]: Array.from(seen) });
}
