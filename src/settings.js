// Shared settings access — chrome.storage.local is the only place backend
// config, Entra ID discovery, and tokens ever live. Never hardcoded.
const DEFAULTS = {
  backendUrl: "",

  // Discovered from {backendUrl}/auth/config the first time a filer connects
  // — never typed by hand. See src/oauth.js.
  authDisabled: false,
  entraTenantId: "",
  entraClientId: "",
  entraAuthority: "https://login.microsoftonline.com",

  // Populated by a real Sign in with Microsoft flow (src/oauth.js), not a
  // pasted token.
  authToken: "",
  authTokenExpiresAt: 0, // ms epoch
  authRefreshToken: "",
};

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function setSettings(partial) {
  await chrome.storage.local.set(partial);
}

async function clearAuth() {
  await chrome.storage.local.set({
    authToken: "",
    authTokenExpiresAt: 0,
    authRefreshToken: "",
  });
}

async function clearService() {
  await chrome.storage.local.remove(Object.keys(DEFAULTS));
}

function normalizeBackendUrl(url) {
  return url.replace(/\/+$/, "");
}

// A token is only trustworthy for a little longer than "not yet expired" —
// leave a margin so an in-flight request doesn't get a token that expires
// mid-air.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

function isTokenValid(settings) {
  return Boolean(settings.authToken) && Date.now() < settings.authTokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS;
}

function isConnected(settings) {
  if (!settings.backendUrl) return false;
  return settings.authDisabled || isTokenValid(settings);
}

function entraConfigFrom(settings) {
  return {
    auth_disabled: settings.authDisabled,
    entra_tenant_id: settings.entraTenantId,
    entra_client_id: settings.entraClientId,
    entra_authority: settings.entraAuthority,
  };
}
