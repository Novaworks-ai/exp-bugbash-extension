let currentScreenshots = []; // [{ dataUrl, blob }, ...] -- [0] is shown in the main preview
let currentPage = null; // { url, title }
let currentConsoleErrors = []; // [{ level, message, timestamp }, ...] -- see fetchConsoleErrors
// True when currentPage wasn't necessarily populated from a live
// "Capture this page" -- i.e. an uploaded screenshot or a text-only report --
// which gates the "Include this page's info" checkbox (a live capture is
// always about the current page, so it never applies there). Reset in
// takeScreenshot() / handleScreenshotUploadChange() / handleTextOnlyClick().
let pageMetaOptional = false;

function $(id) {
  return document.getElementById(id);
}

function showStatus(el, message, kind) {
  el.textContent = message;
  el.className = `status ${kind}`;
  el.classList.remove("hidden");
}

function hideStatus(el) {
  el.classList.add("hidden");
}

// ---------------------------------------------------------------------
// Connect gate: ask for the intake service URL, then (unless it runs with
// auth disabled) drive a real Sign in with Microsoft flow. This is the
// extension's only path to getting connected — nothing is usable until
// this resolves, and there is no separate place asking for a pasted token.
// ---------------------------------------------------------------------

function showGateStep(name, serviceUrl) {
  $("gate").classList.remove("hidden");
  $("app-shell").classList.add("hidden");
  $("gate-step-url").classList.toggle("hidden", name !== "url");
  $("gate-step-login").classList.toggle("hidden", name !== "login");
  if (name === "login") {
    $("gate-service-label").textContent = `Signing in to ${serviceUrl}`;
  }
}

const PENDING_CAPTURE_KEY = "pendingCaptureId"; // set by background.js on notification click

// A native chrome.permissions.request() dialog steals focus, which closes
// this popup (and tears down whatever async function was running) before it
// can save anything. Persisting the typed URL here first means reopening the
// popup can resume the connect flow automatically instead of asking the
// filer to type the same URL again.
const PENDING_BACKEND_URL_KEY = "pendingBackendUrl";

// Same focus-stealing dialog problem as PENDING_BACKEND_URL_KEY, for the
// Settings > target app Save button.
const PENDING_TARGET_APP_URL_KEY = "pendingTargetAppUrl";

async function showApp() {
  $("gate").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
  await refreshConnectBadge();
  await refreshSettingsPanel();
  // Queue lives right in #panel-main now (no separate tab to click into it
  // any more), so it needs loading up front rather than on tab-switch.
  await refreshQueue();
  await refreshFocusAreas();
  await openPendingCaptureIfAny();
}

async function openPendingCaptureIfAny() {
  const stored = await chrome.storage.local.get(PENDING_CAPTURE_KEY);
  const pendingId = stored[PENDING_CAPTURE_KEY];
  if (!pendingId) return;
  await chrome.storage.local.remove(PENDING_CAPTURE_KEY);
  await openDetail(pendingId);
}

async function resolveConnection() {
  const settings = await getSettings();

  if (!settings.backendUrl) {
    const stored = await chrome.storage.local.get(PENDING_BACKEND_URL_KEY);
    const pendingUrl = stored[PENDING_BACKEND_URL_KEY];
    if (pendingUrl) {
      $("gate-backend-url").value = pendingUrl;
      if (await hasOriginPermission(pendingUrl)) {
        // Permission was already granted before this popup got torn down by
        // the native prompt last time -- resume instead of asking again.
        showGateStep("url");
        await completeConnect(pendingUrl, $("gate-url-status"));
        return;
      }
    }
    showGateStep("url");
    return;
  }

  if (settings.authDisabled) {
    showApp();
    return;
  }

  if (isTokenValid(settings)) {
    showApp();
    return;
  }

  if (settings.authRefreshToken) {
    try {
      await refreshEntraToken(entraConfigFrom(settings), settings.authRefreshToken);
      showApp();
      return;
    } catch (_) {
      // Refresh token is gone/revoked — fall through to an interactive login.
    }
  }

  showGateStep("login", settings.backendUrl);
}

async function handleGateContinue() {
  const statusEl = $("gate-url-status");
  const backendUrl = $("gate-backend-url").value.trim();
  if (!backendUrl) {
    showStatus(statusEl, "Enter the intake service's URL first.", "error");
    return;
  }
  hideStatus(statusEl);

  // Save before requesting permission -- see PENDING_BACKEND_URL_KEY.
  await chrome.storage.local.set({ [PENDING_BACKEND_URL_KEY]: backendUrl });

  const granted = await requestOriginPermission(backendUrl);
  if (!granted) {
    showStatus(statusEl, "Permission to contact that service is required to continue.", "error");
    return;
  }

  await completeConnect(backendUrl, statusEl);
}

async function completeConnect(backendUrl, statusEl) {
  showStatus(statusEl, "Checking…", "info");
  try {
    const config = await fetchAuthConfig(backendUrl);
    await setSettings({
      backendUrl,
      authDisabled: Boolean(config.auth_disabled),
      entraTenantId: config.entra_tenant_id || "",
      entraClientId: config.entra_client_id || "",
      entraAuthority: config.entra_authority || "https://login.microsoftonline.com",
    });
    await chrome.storage.local.remove(PENDING_BACKEND_URL_KEY);
    hideStatus(statusEl);
    if (config.auth_disabled) {
      await showApp();
    } else {
      showGateStep("login", backendUrl);
    }
  } catch (err) {
    showStatus(statusEl, `Couldn't reach that service: ${err.message}`, "error");
  }
}

async function handleGateSignIn() {
  const statusEl = $("gate-login-status");
  const settings = await getSettings();

  const granted = await requestOriginPermission(settings.entraAuthority);
  if (!granted) {
    showStatus(statusEl, "Permission to contact Microsoft's sign-in service is required to continue.", "error");
    return;
  }

  showStatus(statusEl, "Opening Microsoft sign-in…", "info");
  try {
    // Delegated to background.js: the Microsoft sign-in window it opens
    // steals focus and closes this popup mid-await, same as a native
    // permission dialog -- the service worker isn't torn down by that, so it
    // runs the flow to completion and stores the token regardless of
    // whether this popup is still around to see the response.
    const response = await chrome.runtime.sendMessage({ type: "start-entra-signin" });
    if (response?.error) {
      showStatus(statusEl, `Sign-in failed: ${response.error}`, "error");
      return;
    }
    hideStatus(statusEl);
    await showApp();
  } catch (err) {
    // The popup closing mid-flow (see above) surfaces here as a disconnected
    // message port -- not a real failure. Reopening the popup will find the
    // token already stored by background.js, via resolveConnection()'s
    // isTokenValid check, with no further click needed.
  }
}

async function handleGateChangeService() {
  await clearService();
  await chrome.storage.local.remove(PENDING_BACKEND_URL_KEY);
  $("gate-backend-url").value = "";
  hideStatus($("gate-url-status"));
  hideStatus($("gate-login-status"));
  showGateStep("url");
}

async function refreshConnectBadge() {
  const settings = await getSettings();
  const status = $("connect-status");
  const dot = $("connect-dot");
  const label = $("connect-label");
  status.classList.remove("hidden");
  refreshUiModeControls(settings.uiMode);

  if (!isConnected(settings)) {
    dot.className = "dot dot-off";
    label.textContent = "Not connected";
    return;
  }
  try {
    await pingBackend();
    dot.className = "dot dot-on";
    label.textContent = settings.authDisabled ? "Connected (no login)" : "Connected";
  } catch (err) {
    dot.className = "dot dot-off";
    label.textContent = "Unreachable";
  }
}

async function refreshSettingsPanel() {
  const settings = await getSettings();
  $("settings-backend-url-display").textContent = settings.backendUrl;
  $("settings-auth-mode").textContent = settings.authDisabled
    ? "This service runs with auth disabled — every filer is treated as one dev user."
    : "Signed in with Microsoft Entra ID.";
  $("btn-sign-out").classList.toggle("hidden", settings.authDisabled);
  $("settings-target-app-url").value = settings.targetAppUrl || "";

  const stored = await chrome.storage.local.get(PENDING_TARGET_APP_URL_KEY);
  const pendingUrl = stored[PENDING_TARGET_APP_URL_KEY];
  if (pendingUrl && (await hasOriginPermission(pendingUrl))) {
    // Permission was already granted before the native prompt tore down the
    // popup last time (see PENDING_TARGET_APP_URL_KEY) -- finish the save
    // instead of leaving it looking like nothing happened.
    $("settings-target-app-url").value = pendingUrl;
    await setSettings({ targetAppUrl: pendingUrl });
    await chrome.storage.local.remove(PENDING_TARGET_APP_URL_KEY);
    showStatus(
      $("settings-target-app-status"),
      "Saved — a trace header will be added to requests on that site.",
      "ok"
    );
  }
}

function refreshUiModeControls(uiMode) {
  const btn = $("btn-toggle-ui-mode");
  if (uiMode === "sidepanel") {
    btn.textContent = "📌";
    btn.title = "Pinned as a side panel — click to switch back to a popup";
  } else {
    btn.textContent = "📍";
    btn.title = "Currently a popup — click to pin as a side panel";
  }
}

async function handleToggleUiMode() {
  const settings = await getSettings();
  const newMode = settings.uiMode === "sidepanel" ? "popup" : "sidepanel";
  await setSettings({ uiMode: newMode });
  refreshUiModeControls(newMode);

  if (newMode === "sidepanel") {
    // Flip which one future icon clicks open (background.js mirrors
    // uiMode into chrome.sidePanel.setPanelBehavior), and also open the
    // side panel right now -- chrome.sidePanel.open() needs a user gesture,
    // which this click handler is. The popup closes itself right after,
    // since showing both at once would just be the same UI twice.
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  }
  // Switching back to popup mode: nothing to close programmatically --
  // Chrome has no API to close an open side panel from script. It stays
  // open until the user closes it manually; the toolbar icon opens the
  // popup again starting with the next click.
}

async function handleSignOut() {
  await clearAuth();
  hideStatus($("settings-status"));
  await resolveConnection();
}

async function handleChangeServiceFromSettings() {
  await clearService();
  await chrome.storage.local.remove(PENDING_BACKEND_URL_KEY);
  await resolveConnection();
}

async function handleSaveTargetApp() {
  const statusEl = $("settings-target-app-status");
  const url = $("settings-target-app-url").value.trim();
  hideStatus(statusEl);

  if (!url) {
    await chrome.storage.local.remove(PENDING_TARGET_APP_URL_KEY);
    await setSettings({ targetAppUrl: "" });
    showStatus(statusEl, "Cleared — no trace header will be injected.", "info");
    return;
  }

  // Save before requesting permission -- see PENDING_TARGET_APP_URL_KEY.
  await chrome.storage.local.set({ [PENDING_TARGET_APP_URL_KEY]: url });

  const granted = await requestOriginPermission(url);
  if (!granted) {
    showStatus(statusEl, "Permission is required to add the trace header on that site.", "error");
    return;
  }

  await setSettings({ targetAppUrl: url });
  await chrome.storage.local.remove(PENDING_TARGET_APP_URL_KEY);
  showStatus(statusEl, "Saved — a trace header will be added to requests on that site.", "ok");
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

// No more tab bar -- Capture and Queue live together in #panel-main,
// always visible at once (most useful in the side panel, open persistently
// alongside whatever page is being tested). History and Settings are
// reached via their own header icon buttons instead, each a full-screen
// panel with its own Back button, same pattern #panel-detail already used.
// Tracked so the storage.onChanged listener below (added for the live-refresh
// fix) knows whether History is the panel currently visible, without having
// to re-query the DOM for whichever element has the "active" class.
let currentPanelName = "main";

function showPanel(name) {
  currentPanelName = name;
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
}

// Critique runs asynchronously now (exp-bugbash-intake-py's
// app/critique_worker.py) -- a capture's status can keep changing in the
// background for a while after it was last fetched (e.g. right after
// answering a clarification), so the queue list can be stale by the time
// you come back to it. Refresh on the way home, same as openHistory/
// openSettings already do for their own panels, instead of leaving it
// showing whatever was last fetched (real bug filed live: the list badge
// still said "awaiting-clarification" for an item the detail view, freshly
// fetched, already showed as "ready").
async function goHome() {
  showPanel("main");
  await refreshQueue();
}

async function openHistory() {
  showPanel("history");
  await refreshHistory();
}

async function openSettings() {
  showPanel("settings");
  await refreshSettingsPanel();
}

// ---------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// activeTab is granted once, when the extension surface is opened -- a
// popup reopens (and re-grants it for whatever tab is active) every time,
// but the side panel is a single persistent document, so switching tabs
// while it stays open leaves it holding a grant for the tab it was FIRST
// opened on, not the one now showing. captureVisibleTab then fails with
// "Either the '<all_urls>' or 'activeTab' permission is required." Recover
// by requesting permission and retrying.
//
// This must request the literal "<all_urls>" pattern (via
// requestCapturePermission), not the narrow per-hostname pattern
// originPatternFor/requestOriginPermission use elsewhere in settings.js, and
// not a scheme-wide pattern like "https://*/*" either: Chromium's
// captureVisibleTab permission check (PermissionsData::CanCaptureVisiblePage)
// only looks for a granted host-permission entry that is literally the
// special <all_urls> pattern -- it is not satisfied by the union of however
// many scheme- or host-specific patterns are granted alongside it. A prior
// fix requested only the scheme matching the current tab's URL (e.g.
// "https://*/*" for an https:// page); that shows a permission dialog that
// "succeeds" and even reports granted via chrome.permissions.contains, but
// still leaves the retried captureVisibleTab call failing with the exact
// same error, since neither "http://*/*" nor "https://*/*" is the literal
// <all_urls> token the check requires.
async function takeScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found.");
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
  } catch (err) {
    if (!/activeTab/.test(err.message) || !tab.url) throw err;
    let granted = false;
    try {
      granted = await requestCapturePermission();
    } catch (_) {
      granted = false;
    }
    if (!granted) {
      throw new Error(
        `${err.message} Allow access to this page and try again.`
      );
    }
    dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
  }
  currentPage = { url: tab.url || "", title: tab.title || "" };
  pageMetaOptional = false;
  return { dataUrl, blob: await dataUrlToBlob(dataUrl), tabId: tab.id };
}

// Best-effort read of the active tab's URL/title, used to prefill
// currentPage for the two entry points where it's optional (upload,
// text-only) -- never throws, since a failure here just means the checkbox
// starts blank rather than blocking the report.
async function readActiveTabMeta() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { url: tab?.url || "", title: tab?.title || "" };
  } catch (_) {
    return { url: "", title: "" };
  }
}

// Shows/hides the big screenshot preview (and the "Retake" button, which
// makes no sense with nothing to retake) based on whether there's a
// screenshot at all -- the text-only entry point reaches #capture-preview
// with zero, and "+ Add screenshot"/"Upload…" can add one afterward.
function syncMediaPreview() {
  const hasScreenshot = currentScreenshots.length > 0;
  $("preview-img").classList.toggle("hidden", !hasScreenshot);
  $("btn-retake").classList.toggle("hidden", !hasScreenshot);
  if (hasScreenshot) $("preview-img").src = currentScreenshots[0].dataUrl;
}

function renderScreenshotThumbs() {
  const listEl = $("screenshot-thumbs");
  listEl.innerHTML = "";
  // currentScreenshots[0] is shown in the big preview above (Retake replaces
  // it); everything past that shows here as a small removable thumbnail.
  currentScreenshots.slice(1).forEach((shot, i) => {
    const index = i + 1;
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.src = shot.dataUrl;
    img.alt = `Screenshot ${index + 1}`;
    const remove = document.createElement("button");
    remove.className = "thumb-remove";
    remove.textContent = "×";
    remove.title = "Remove this screenshot";
    remove.addEventListener("click", () => {
      currentScreenshots.splice(index, 1);
      renderScreenshotThumbs();
    });
    li.appendChild(img);
    li.appendChild(remove);
    listEl.appendChild(li);
  });
}

function resetCaptureForm() {
  $("repro-steps").value = "";
  $("additional-info").value = "";
  $("capture-idle").classList.remove("hidden");
  $("capture-preview").classList.add("hidden");
  hideStatus($("capture-status"));
  $("screenshot-upload-input").value = "";
  currentScreenshots = [];
  renderScreenshotThumbs();
  syncMediaPreview();
  currentPage = null;
  pageMetaOptional = false;
  $("include-page-meta").checked = true;
  $("page-meta-toggle-row").classList.add("hidden");
  currentConsoleErrors = [];
  renderConsoleErrorsHint();
}

// Whether pageUrl/pageTitle should actually be sent: always true for a live
// capture (the whole point is the current page); for an uploaded screenshot
// or a text-only report, only when the "Include this page's info" checkbox
// is checked.
function shouldIncludePageMeta() {
  return !pageMetaOptional || $("include-page-meta").checked;
}

// Keeps #page-meta's text and the checkbox's visibility in sync with
// currentPage / pageMetaOptional. The checkbox only makes sense (and is
// only shown) when page info is optional -- see pageMetaOptional.
function renderPageMeta() {
  $("page-meta-toggle-row").classList.toggle("hidden", !pageMetaOptional);
  $("page-meta").textContent = shouldIncludePageMeta()
    ? `${currentPage.title} — ${currentPage.url}`
    : "";
}

function renderConsoleErrorsHint() {
  const el = $("console-errors-hint");
  if (currentConsoleErrors.length) {
    el.textContent = `${currentConsoleErrors.length} console error(s)/warning(s) auto-captured from this page.`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

async function handleCaptureClick() {
  const statusEl = $("capture-status");
  hideStatus(statusEl);
  try {
    const shot = await takeScreenshot();
    currentScreenshots[0] = shot;
    syncMediaPreview();
    renderPageMeta();
    $("capture-idle").classList.add("hidden");
    $("capture-preview").classList.remove("hidden");
    renderScreenshotThumbs();

    // Best-effort: only returns anything if this tab's origin is the
    // filer's configured "Target app" (Settings) -- silently empty
    // otherwise, which is the normal case for most captures.
    currentConsoleErrors = await fetchConsoleErrors(shot.tabId);
    renderConsoleErrorsHint();
  } catch (err) {
    showStatus(statusEl, `Couldn't capture the page: ${err.message}`, "error");
  }
}

async function handleAddScreenshotClick() {
  const statusEl = $("capture-status");
  hideStatus(statusEl);
  try {
    const shot = await takeScreenshot();
    currentScreenshots.push(shot);
    renderScreenshotThumbs();
    syncMediaPreview();
  } catch (err) {
    showStatus(statusEl, `Couldn't capture the page: ${err.message}`, "error");
  }
}

function handleUploadScreenshotClick() {
  $("screenshot-upload-input").click();
}

async function handleScreenshotUploadChange(event) {
  const statusEl = $("capture-status");
  const files = Array.from(event.target.files || []);
  event.target.value = ""; // allow picking the same file again later
  if (!files.length) return;

  // Uploading from the idle screen (no live capture yet) starts the report
  // from the uploaded image instead -- still record which tab it came from,
  // same as a live capture would.
  if (!currentScreenshots.length) {
    currentPage = await readActiveTabMeta();
    pageMetaOptional = true;
    $("include-page-meta").checked = true;
  }

  try {
    for (const file of files) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      currentScreenshots.push({ dataUrl, blob: file });
    }
  } catch (err) {
    showStatus(statusEl, `Couldn't read that file: ${err.message}`, "error");
    return;
  }

  syncMediaPreview();
  renderPageMeta();
  $("capture-idle").classList.add("hidden");
  $("capture-preview").classList.remove("hidden");
  renderScreenshotThumbs();
}

// Entry point for a report with no screenshot at all -- goes straight to
// the description form with #preview-img hidden (see syncMediaPreview).
// Page info is optional here too, same as an uploaded screenshot: there's
// no image to say it's "about" the current tab, so the filer can uncheck
// it via the same "Include this page's info" checkbox/toggle.
async function handleTextOnlyClick() {
  currentScreenshots = [];
  currentPage = await readActiveTabMeta();
  pageMetaOptional = true;
  $("include-page-meta").checked = true;
  renderPageMeta();
  syncMediaPreview();
  $("capture-idle").classList.add("hidden");
  $("capture-preview").classList.remove("hidden");
  renderScreenshotThumbs();
}

// The intake service's API still takes one `description` string -- these two
// fields are purely a UI split (to nudge the filer toward what the critique
// engine actually asks a follow-up question for) and get combined here.
function buildDescription() {
  const repro = $("repro-steps").value.trim();
  const additional = $("additional-info").value.trim();
  const sections = [];
  if (repro) sections.push(`Steps to reproduce:\n${repro}`);
  if (additional) sections.push(`Additional information:\n${additional}`);
  if (currentConsoleErrors.length) {
    const formatted = currentConsoleErrors.map((e) => `[${e.level}] ${e.message}`).join("\n");
    sections.push(`Console errors (auto-captured):\n${formatted}`);
  }
  return sections.join("\n\n");
}

// Reads back whatever src/console-capture.js has buffered on the given tab
// -- silently returns [] if that script was never injected there (the tab
// isn't the configured Target app origin) or permission's since been
// revoked. Not an error case: most captures won't have a target app
// configured at all.
async function fetchConsoleErrors(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => window.__bugbashConsoleBuffer || [],
    });
    return results?.[0]?.result || [];
  } catch (_) {
    return [];
  }
}

async function handleSubmitClick() {
  const statusEl = $("capture-status");
  const description = buildDescription();
  if (!description) {
    showStatus(statusEl, "Add steps to reproduce or additional information before submitting.", "error");
    return;
  }
  // A screenshot is no longer mandatory -- the backend accepts zero of them,
  // and the only way to reach this form with none is the "text-only report"
  // entry point (handleTextOnlyClick), which is an intentional choice, not a
  // failed capture. The description check above still keeps a totally empty
  // report from going out.
  const submitBtn = $("btn-submit");
  submitBtn.disabled = true;
  showStatus(statusEl, "Submitting…", "info");
  try {
    const includePageMeta = shouldIncludePageMeta();
    const result = await submitCapture({
      blobs: currentScreenshots.map((shot) => shot.blob),
      description,
      pageUrl: includePageMeta ? currentPage.url : "",
      pageTitle: includePageMeta ? currentPage.title : "",
    });
    showStatus(statusEl, `Submitted (id: ${result.id}). See it in the queue below.`, "ok");
    setTimeout(resetCaptureForm, 1500);
    await refreshQueue();
  } catch (err) {
    showStatus(statusEl, `Submit failed: ${err.message}`, "error");
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Queue / History / Detail
// ---------------------------------------------------------------------

function displayStatus(item) {
  // `resolution` (fixed/unsolved/duplicate/deferred/partial) is the terminal state
  // once the fixing pipeline has acted; `status`
  // (submitted/awaiting-clarification/ready/resolved) tracks the
  // critique/routing state up to that point. Neither one on its own says
  // whether a "ready" item has actually been picked up yet -- claim_next()
  // sets `claimed_by` without changing `status` (still "ready"), so a
  // claimed-but-not-yet-resolved item looked identical to an unclaimed one.
  // `claimed` is derived here, client-side, from the fields already in the
  // API response -- no backend/status-enum change needed.
  if (item.resolution) return item.resolution;
  if (item.status === "ready" && item.claimed_by) return "claimed";
  return item.status;
}

function statusBadge(status) {
  const span = document.createElement("span");
  span.className = `badge badge-${status}`;
  span.textContent = status.replace(/-/g, " ");
  return span;
}

function focusAreaTag(item) {
  const span = document.createElement("span");
  span.className = "tag";
  // Not yet routed (still awaiting-clarification) or the intake service's
  // catch-all bucket -- either way there's no specific queue name to show.
  span.textContent = item.focus_area && item.focus_area !== "unclassified" ? item.focus_area : "unrouted";
  return span;
}

// Real per-agent connect/disconnect presence (GET /admin/agents), not a
// guess -- built once per Queue refresh, then looked up per item below.
function buildOnlineFocusAreas(agents) {
  const online = new Set();
  let anyWildcard = false;
  for (const agent of agents) {
    if (!agent.connected) continue;
    for (const area of agent.focus_areas || []) {
      if (area === "*") anyWildcard = true;
      else online.add(area);
    }
  }
  return { online, anyWildcard };
}

// null = presence unknown (fetch failed, or this list doesn't show it at
// all -- History, where it's irrelevant). true/false once known.
function isFocusAreaCovered(item, presence) {
  if (!presence || !item.focus_area || item.focus_area === "unclassified") return null;
  if (presence.anyWildcard) return true;
  return presence.online.has(item.focus_area);
}

function presenceDot(item, presence) {
  const covered = isFocusAreaCovered(item, presence);
  if (covered === null) return null;
  const span = document.createElement("span");
  span.className = `presence-dot ${covered ? "presence-online" : "presence-offline"}`;
  span.title = covered
    ? `A connected agent is working the "${item.focus_area}" queue.`
    : `No agent is currently connected for "${item.focus_area}".`;
  return span;
}

function renderItemList(listEl, emptyEl, items, presence) {
  listEl.innerHTML = "";
  if (!items.length) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  for (const item of items) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.description || "(no description)";
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const when = document.createElement("span");
    when.textContent = new Date(item.created_at).toLocaleString();
    const badges = document.createElement("span");
    badges.className = "item-badges";
    const dot = presenceDot(item, presence);
    if (dot) badges.appendChild(dot);
    badges.appendChild(focusAreaTag(item));
    badges.appendChild(statusBadge(displayStatus(item)));
    meta.appendChild(when);
    meta.appendChild(badges);
    li.appendChild(title);
    li.appendChild(meta);
    li.addEventListener("click", () => openDetail(item.id));
    listEl.appendChild(li);
  }
}

async function openDetail(id) {
  showPanel("detail");
  hideStatus($("detail-status"));

  try {
    const item = await getCapture(id);
    renderDetail(item);
  } catch (err) {
    showStatus($("detail-status"), `Couldn't load item: ${err.message}`, "error");
  }
}

function renderDetail(item) {
  $("detail-description").textContent = item.description;
  $("detail-meta").textContent = `${item.page_title || ""} — ${item.page_url || ""}`;

  const statusRow = $("detail-status-row");
  statusRow.innerHTML = "";
  // Use the same resolution-aware status as the Queue/History lists
  // (displayStatus prefers `resolution` over `status`) -- otherwise a
  // resolved item shows a stale "ready"/"awaiting-clarification" badge here
  // while the list already shows its terminal resolution (e.g. "duplicate").
  statusRow.appendChild(statusBadge(displayStatus(item)));
  if (item.focus_area) {
    const area = document.createElement("span");
    area.className = "hint";
    area.style.marginLeft = "6px";
    area.textContent = `focus: ${item.focus_area} (${item.lane || "unrouted"})`;
    statusRow.appendChild(area);
  }

  const complexityEl = $("detail-complexity");
  if (item.estimated_complexity || item.blast_radius) {
    complexityEl.classList.remove("hidden");
    let text = `complexity: ${item.estimated_complexity || "unknown"}, blast radius: ${item.blast_radius || "unknown"}`;
    if (item.complexity_rationale) text += ` — ${item.complexity_rationale}`;
    complexityEl.textContent = text;
  } else {
    complexityEl.classList.add("hidden");
  }

  const resolutionEl = $("detail-resolution");
  if (item.resolution) {
    let kind = "error";
    if (item.resolution === "fixed" || item.resolution === "duplicate") kind = "ok";
    else if (item.resolution === "deferred" || item.resolution === "partial") kind = "info";
    let msg;
    if (item.resolution === "fixed") {
      msg = "Fixed — try the original action again.";
    } else if (item.resolution === "duplicate") {
      msg = item.duplicate_of
        ? `Duplicate of an already-fixed report (${item.duplicate_of}).`
        : "Duplicate of an already-fixed report.";
    } else if (item.resolution === "deferred") {
      msg = "Deferred — needs a developer's go-ahead before anyone takes it on.";
    } else if (item.resolution === "partial") {
      msg = "Partially fixed — part of this report is still open.";
    } else {
      msg = "Marked unsolved.";
    }
    if (item.resolution_note) msg += ` ${item.resolution_note}`;
    if (item.pr_url) msg += ` (${item.pr_url})`;
    showStatus(resolutionEl, msg, kind);
  } else {
    hideStatus(resolutionEl);
  }

  const clarEl = $("detail-clarifications");
  clarEl.innerHTML = "";
  let openQuestion = null;
  for (const c of item.clarifications || []) {
    const div = document.createElement("div");
    div.className = "clar-round";
    const q = document.createElement("div");
    q.className = "clar-question";
    q.textContent = `Q${c.round}: ${c.question}`;
    div.appendChild(q);
    if (c.answer) {
      const a = document.createElement("div");
      a.className = "clar-answer";
      a.textContent = c.answer;
      div.appendChild(a);
    } else {
      openQuestion = c;
    }
    clarEl.appendChild(div);
  }

  const answerBox = $("detail-answer-box");
  if (openQuestion && !item.resolution) {
    answerBox.classList.remove("hidden");
    $("detail-question").textContent = openQuestion.question;
    $("detail-answer").value = "";
    answerBox.dataset.captureId = item.id;
  } else {
    answerBox.classList.add("hidden");
  }
}

async function handleDetailAnswerSubmit() {
  const answerBox = $("detail-answer-box");
  const id = answerBox.dataset.captureId;
  const answer = $("detail-answer").value.trim();
  const statusEl = $("detail-status");
  if (!answer) {
    showStatus(statusEl, "Enter an answer first.", "error");
    return;
  }
  try {
    const updated = await answerClarification(id, answer);
    renderDetail(updated);
    showStatus(statusEl, "Answer sent.", "ok");
    setTimeout(goHome, 1500);
  } catch (err) {
    showStatus(statusEl, `Couldn't send answer: ${err.message}`, "error");
  }
}

async function refreshQueue() {
  const listEl = $("queue-list");
  const emptyEl = $("queue-empty");
  try {
    const items = await listCaptures(false);
    // Best-effort: a failed agents fetch shouldn't block showing the queue
    // itself -- items just render without a presence dot in that case.
    let presence = null;
    try {
      presence = buildOnlineFocusAreas(await listAgents());
    } catch (_) {
      presence = null;
    }
    renderItemList(listEl, emptyEl, items, presence);
  } catch (err) {
    listEl.innerHTML = "";
    emptyEl.textContent = `Couldn't load: ${err.message}`;
    emptyEl.classList.remove("hidden");
  }
}

// Renders the optional top info line from GET /focus_areas' bug_bash_info --
// always plain, non-clickable text now (per filer feedback: too many links).
// bug_bash_info_url, if set, is surfaced separately at the bottom of the
// banner as a single "Additional information" link -- see
// renderBugBashInfoLink.
function renderBugBashInfo(info) {
  const el = $("focus-areas-info");
  el.textContent = "";
  if (!info) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = info;
  el.classList.remove("hidden");
}

// Renders the single "Additional information" link at the bottom of the
// banner from bug_bash_info_url, if set. This is now the *only* link the
// banner ever shows -- per-area `url`s and bug_bash_info are always plain
// text (see renderFocusAreaList / renderBugBashInfo).
function renderBugBashInfoLink(infoUrl) {
  const el = $("focus-areas-info-link");
  el.innerHTML = "";
  if (!infoUrl) {
    el.classList.add("hidden");
    return;
  }
  const link = document.createElement("a");
  link.href = infoUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Additional information";
  el.appendChild(link);
  el.classList.remove("hidden");
}

// Builds the " · "-joined focus-area list as plain text -- per filer
// feedback, an area's `url` (if set) is no longer rendered as a link; it's
// left in the data model but ignored here.
function renderFocusAreaList(areas) {
  const el = $("focus-areas-list");
  el.textContent = areas.map((area) => area.label).join(" · ");
}

// Bug bash "starts with no context" otherwise -- this is the test scope
// (focus areas a report may get routed into) so a first-time filer sees it
// as soon as #panel-main opens, without hunting through Settings.
async function refreshFocusAreas() {
  const bannerEl = $("focus-areas-banner");
  const { focusAreasBannerDismissed } = await getSettings();
  if (focusAreasBannerDismissed) {
    bannerEl.classList.add("hidden");
    return;
  }

  try {
    const { areas, bug_bash_info, bug_bash_info_url } = await listFocusAreas();
    const visible = areas.filter((area) => area.key !== "unclassified");
    renderBugBashInfo(bug_bash_info);
    renderBugBashInfoLink(bug_bash_info_url);
    const hasInfo = Boolean(bug_bash_info || bug_bash_info_url);
    if (visible.length === 0) {
      $("focus-areas-heading").classList.add("hidden");
      $("focus-areas-list").innerHTML = "";
      // Keep the banner up if there's still a top info line (or bottom
      // link) to show even with no (or only "unclassified") focus areas
      // configured.
      bannerEl.classList.toggle("hidden", !hasInfo);
      return;
    }
    $("focus-areas-heading").classList.remove("hidden");
    renderFocusAreaList(visible);
    bannerEl.classList.remove("hidden");
  } catch (_) {
    // Best-effort context only -- a failed fetch just means no banner, same
    // as refreshQueue's presence-fetch fallback.
    bannerEl.classList.add("hidden");
  }
}

async function handleDismissFocusAreas() {
  await setSettings({ focusAreasBannerDismissed: true });
  $("focus-areas-banner").classList.add("hidden");
}

async function refreshHistory() {
  const listEl = $("history-list");
  const emptyEl = $("history-empty");
  try {
    const items = await listCaptures(true);
    renderItemList(listEl, emptyEl, items);
  } catch (err) {
    listEl.innerHTML = "";
    emptyEl.textContent = `Couldn't load: ${err.message}`;
    emptyEl.classList.remove("hidden");
  }
}

// Same keys background.js's poll (pollCaptures -> notifyNewQuestions /
// notifyStaleReady / notifyResolved) writes to chrome.storage.local on every
// poll cycle -- see SEEN_RESOLVED_KEY, SEEN_QUESTION_ROUNDS_KEY,
// UNREAD_RESOLVED_KEY, STALE_NOTIFIED_KEY there. Mirrored here as plain
// strings rather than imported, since popup.js and background.js run in
// separate script contexts (popup document vs. service worker).
//
// Without this, a side panel that's been sitting open the whole time never
// hears about what a background poll just learned: the toolbar badge count
// (driven by background.js's own storage.onChanged-independent updateBadge
// call) updates fine, but #queue-list only ever gets re-rendered when
// something in *this* document calls refreshQueue -- e.g. on open, or a
// manual Refresh click. Real bug filed live: an item got resolved, the badge
// showed "1", but the already-open panel's Open items list kept showing it
// as "ready" until Refresh was clicked.
const POLL_WRITTEN_KEYS = new Set([
  "seenResolvedIds",
  "seenQuestionRounds",
  "unreadResolvedIds",
  "staleNotifiedIds",
]);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // chrome.storage.onChanged fires for every local write, including ones
  // this popup document makes itself (settings, pending-URL bookkeeping,
  // clearResolvedBadge's own unreadResolvedIds reset on open) -- filter down
  // to the specific keys the background poll writes so this doesn't turn
  // into a network refetch on every unrelated write, or a loop back into
  // itself (refreshQueue/refreshHistory don't write any of these keys, so
  // there's no cycle, but keep the filter tight regardless).
  if (!Object.keys(changes).some((key) => POLL_WRITTEN_KEYS.has(key))) return;
  // Also skip while the app shell isn't showing yet (e.g. during the
  // connect gate, or clearResolvedBadge's write during init) -- nothing
  // visible needs refreshing yet, and showApp's own refreshQueue call will
  // run once it does.
  if ($("app-shell").classList.contains("hidden")) return;

  refreshQueue().catch(() => {});
  if (currentPanelName === "history") {
    refreshHistory().catch(() => {});
  }
});

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function wireUp() {
  $("btn-capture").addEventListener("click", handleCaptureClick);
  $("btn-retake").addEventListener("click", handleCaptureClick);
  $("btn-add-screenshot").addEventListener("click", handleAddScreenshotClick);
  $("btn-upload-screenshot").addEventListener("click", handleUploadScreenshotClick);
  $("btn-upload-screenshot-idle").addEventListener("click", handleUploadScreenshotClick);
  $("btn-text-only").addEventListener("click", handleTextOnlyClick);
  $("screenshot-upload-input").addEventListener("change", handleScreenshotUploadChange);
  $("include-page-meta").addEventListener("change", renderPageMeta);
  $("btn-submit").addEventListener("click", handleSubmitClick);
  $("btn-cancel-capture").addEventListener("click", resetCaptureForm);
  $("btn-refresh-queue").addEventListener("click", refreshQueue);
  $("btn-refresh-history").addEventListener("click", refreshHistory);
  $("btn-dismiss-focus-areas").addEventListener("click", handleDismissFocusAreas);
  $("btn-detail-answer-submit").addEventListener("click", handleDetailAnswerSubmit);

  // The only way back from History/Settings/Detail -- no separate Back
  // button on each; clicking the brand always returns to #panel-main.
  $("btn-home").addEventListener("click", goHome);
  $("btn-open-history").addEventListener("click", openHistory);
  $("btn-open-settings").addEventListener("click", openSettings);

  $("btn-gate-continue").addEventListener("click", handleGateContinue);
  $("btn-gate-signin").addEventListener("click", handleGateSignIn);
  $("btn-gate-change-service").addEventListener("click", handleGateChangeService);

  $("btn-sign-out").addEventListener("click", handleSignOut);
  $("btn-change-service").addEventListener("click", handleChangeServiceFromSettings);
  $("btn-save-target-app").addEventListener("click", handleSaveTargetApp);
  $("btn-toggle-ui-mode").addEventListener("click", handleToggleUiMode);
}

async function clearResolvedBadge() {
  // Opening the popup is the filer acknowledging whatever the toolbar badge
  // was flagging -- see UNREAD_RESOLVED_KEY in background.js.
  await chrome.storage.local.set({ unreadResolvedIds: [] });
  await chrome.action.setBadgeText({ text: "" });
}

(async function init() {
  $("version-badge").textContent = `v${chrome.runtime.getManifest().version}`;
  // Same popup.html serves both surfaces -- manifest.json's side_panel
  // points at "?panel=1" specifically so this document can tell which one
  // it actually is (there's no other reliable way to distinguish them) and
  // apply the side-panel-only width rule (see popup.css's body.side-panel).
  if (new URLSearchParams(location.search).has("panel")) {
    document.body.classList.add("side-panel");
  }
  wireUp();
  await clearResolvedBadge();
  await resolveConnection();
})();
