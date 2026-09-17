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

  // Optional: the app under test's own URL, separate from the intake
  // service. Set only if the filer wants log correlation -- see
  // background.js's applyTraceHeaderRule(). Requires its own permission
  // grant, same runtime request pattern as backendUrl.
  targetAppUrl: "",
  // Generated once per install (see getOrCreateTraceId), sent as trace_id on
  // every submitted capture whenever targetAppUrl is set -- the same value
  // background.js injects as the X-Bugbash-Trace-Id header on requests to
  // that site, so the intake service can grep its logs for it.
  traceId: "",

  // "popup" (default) or "sidepanel" -- see background.js's
  // applySidePanelBehavior(), which mirrors this into
  // chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick }). Toggled
  // via the Settings tab's Pin/Unpin button.
  uiMode: "popup",

  // Whether the filer has dismissed the "test scope" (focus areas) banner
  // on #panel-main -- see popup.js's refreshFocusAreas(). Persisted so it
  // stays dismissed across popup open/close, same as everything else here.
  focusAreasBannerDismissed: false,
};

async function getOrCreateTraceId() {
  const { traceId } = await getSettings();
  if (traceId) return traceId;
  const newId = crypto.randomUUID();
  await setSettings({ traceId: newId });
  return newId;
}

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

// Deliberately excludes targetAppUrl/traceId -- those describe the app under
// test, independent of which intake service is configured, so switching
// intake services shouldn't silently drop trace-header injection.
const SERVICE_KEYS = [
  "backendUrl",
  "authDisabled",
  "entraTenantId",
  "entraClientId",
  "entraAuthority",
  "authToken",
  "authTokenExpiresAt",
  "authRefreshToken",
];

async function clearService() {
  await chrome.storage.local.remove(SERVICE_KEYS);
}

function normalizeBackendUrl(url) {
  return url.replace(/\/+$/, "");
}

// The extension declares no required host_permissions — only
// optional_host_permissions (see manifest.json) — so it can be reviewed
// without "access your data on all sites." Instead it requests just the
// specific origin it actually needs (the configured backend, and the Entra
// ID authority it signs in against) at the moment it learns that origin,
// via chrome.permissions.request. Once granted, that stays granted across
// restarts — the background poll never needs to re-request it.
function originPatternFor(url) {
  const parsed = new URL(normalizeBackendUrl(url));
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ":" + parsed.port : ""}/*`;
}

async function hasOriginPermission(url) {
  try {
    return await chrome.permissions.contains({ origins: [originPatternFor(url)] });
  } catch (_) {
    return false;
  }
}

// Must be called synchronously (no prior await) from within a user-gesture
// handler (a click) — chrome.permissions.request requires one and Chrome
// can silently refuse it otherwise.
async function requestOriginPermission(url) {
  try {
    return await chrome.permissions.request({ origins: [originPatternFor(url)] });
  } catch (_) {
    return false;
  }
}

// Only for the captureVisibleTab activeTab-permission recovery path in
// popup.js -- NOT a general-purpose helper, and NOT to be used for scoping
// the backend/target-app permission (that's originPatternFor/
// requestOriginPermission above, which stay narrow on purpose).
//
// chrome.tabs.captureVisibleTab's permission check (PermissionsData::
// CanCaptureVisiblePage in Chromium) does NOT ask "is this URL covered by
// some granted host permission?". It only ever sets `has_all_urls` when one
// of the extension's *granted* host-permission patterns literally is the
// special "<all_urls>" pattern (URLPattern::match_all_urls(), which Parse()
// only sets for the exact string "<all_urls>" -- see
// extensions/common/url_pattern.cc). Any number of scheme- or host-specific
// patterns, however broad, never set that flag, even together:
// "http://*/*" + "https://*/*" granted side by side is still two ordinary
// URLPatterns, neither of which is the literal <all_urls> token, so
// has_all_urls stays false and the capture keeps failing with "Either the
// '<all_urls>' or 'activeTab' permission is required." (This is why a
// previous fix that requested the matching "<scheme>://*/*" pattern didn't
// actually fix anything: it "succeeded" as a permission grant but still left
// the subsequent captureVisibleTab call failing with the exact same error --
// and requesting only the scheme matching the current tab, e.g. only
// "https://*/*" for an https:// page, is exactly the "half the permissions"
// state a filer would see after hitting this path once before.)
//
// So request the literal "<all_urls>" pattern -- it must be pre-declared in
// optional_host_permissions (see manifest.json) for chrome.permissions.request
// to allow requesting it at runtime.
async function requestCapturePermission() {
  try {
    return await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch (_) {
    return false;
  }
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
