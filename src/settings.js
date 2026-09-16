// Shared settings access — chrome.storage.local is the only place backend
// config or the access token ever live. Never hardcode either.
const DEFAULTS = {
  backendUrl: "",
  authToken: "",
};

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function setSettings(partial) {
  await chrome.storage.local.set(partial);
}

function normalizeBackendUrl(url) {
  return url.replace(/\/+$/, "");
}
