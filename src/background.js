// Polls the configured intake service for captures that moved to a resolved
// state (fixed / unsolved) since the last check, and raises a notification.
// The intake service is the one source of truth for status — this never
// talks to whatever fixing pipeline is behind it.

const POLL_ALARM = "bugbash-poll-resolved";
const SEEN_KEY = "seenResolvedIds";

importScripts("settings.js", "api.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollForResolved().catch(() => {
      // Network errors here are expected when no backend is configured yet
      // or it's unreachable — fail quietly, the popup surfaces connectivity.
    });
  }
});

async function pollForResolved() {
  const { backendUrl } = await getSettings();
  if (!backendUrl) return;

  const items = await listCaptures(true);
  const stored = await chrome.storage.local.get(SEEN_KEY);
  const seen = new Set(stored[SEEN_KEY] || []);

  const newlyResolved = items.filter((item) => !seen.has(item.id));
  for (const item of newlyResolved) {
    const title = item.resolution === "fixed" ? "Bug Bash: fix ready" : "Bug Bash: item unresolved";
    chrome.notifications.create(`bugbash-${item.id}`, {
      type: "basic",
      iconUrl: "../icons/icon128.png",
      title,
      message: item.description ? item.description.slice(0, 120) : "Open the extension for details.",
    });
    seen.add(item.id);
  }

  await chrome.storage.local.set({ [SEEN_KEY]: Array.from(seen) });
}
