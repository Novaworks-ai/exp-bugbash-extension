let currentScreenshots = []; // [{ dataUrl, blob }, ...] -- [0] is shown in the main preview
let currentPage = null; // { url, title }

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
    await signInWithEntra(entraConfigFrom(settings));
    hideStatus(statusEl);
    await showApp();
  } catch (err) {
    showStatus(statusEl, `Sign-in failed: ${err.message}`, "error");
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

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  if (name === "queue") refreshQueue();
  if (name === "history") refreshHistory();
  if (name === "settings") refreshSettingsPanel();
}

// ---------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function takeScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab found.");
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
  currentPage = { url: tab.url || "", title: tab.title || "" };
  return { dataUrl, blob: await dataUrlToBlob(dataUrl) };
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
  currentPage = null;
}

async function handleCaptureClick() {
  const statusEl = $("capture-status");
  hideStatus(statusEl);
  try {
    const shot = await takeScreenshot();
    currentScreenshots[0] = shot;
    $("preview-img").src = shot.dataUrl;
    $("page-meta").textContent = `${currentPage.title} — ${currentPage.url}`;
    $("capture-idle").classList.add("hidden");
    $("capture-preview").classList.remove("hidden");
    renderScreenshotThumbs();
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
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentPage = { url: tab?.url || "", title: tab?.title || "" };
    } catch (_) {
      currentPage = { url: "", title: "" };
    }
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

  $("preview-img").src = currentScreenshots[0].dataUrl;
  $("page-meta").textContent = `${currentPage.title} — ${currentPage.url}`;
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
  return sections.join("\n\n");
}

async function handleSubmitClick() {
  const statusEl = $("capture-status");
  const description = buildDescription();
  if (!description) {
    showStatus(statusEl, "Add steps to reproduce or additional information before submitting.", "error");
    return;
  }
  if (!currentScreenshots.length) {
    showStatus(statusEl, "No screenshot captured. Try again.", "error");
    return;
  }
  const submitBtn = $("btn-submit");
  submitBtn.disabled = true;
  showStatus(statusEl, "Submitting…", "info");
  try {
    const result = await submitCapture({
      blobs: currentScreenshots.map((shot) => shot.blob),
      description,
      pageUrl: currentPage.url,
      pageTitle: currentPage.title,
    });
    showStatus(statusEl, `Submitted (id: ${result.id}). Watch the Queue tab for updates.`, "ok");
    setTimeout(resetCaptureForm, 1500);
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
  // `resolution` (fixed/unsolved) is the terminal state once the fixing
  // pipeline has acted; `status` (awaiting-clarification/ready) tracks the
  // critique/routing state up to that point.
  return item.resolution || item.status;
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

function renderItemList(listEl, emptyEl, items) {
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

let detailReturnTab = "queue";

async function openDetail(id) {
  const activeTab = document.querySelector(".tab.active");
  detailReturnTab = activeTab ? activeTab.dataset.tab : "queue";

  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  $("panel-detail").classList.add("active");
  hideStatus($("detail-status"));

  try {
    const item = await getCapture(id);
    renderDetail(item);
  } catch (err) {
    showStatus($("detail-status"), `Couldn't load item: ${err.message}`, "error");
  }
}

function closeDetail() {
  $("panel-detail").classList.remove("active");
  switchTab(detailReturnTab);
}

function renderDetail(item) {
  $("detail-description").textContent = item.description;
  $("detail-meta").textContent = `${item.page_title || ""} — ${item.page_url || ""}`;

  const statusRow = $("detail-status-row");
  statusRow.innerHTML = "";
  statusRow.appendChild(statusBadge(item.status));
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
    const kind = item.resolution === "fixed" ? "ok" : "error";
    let msg = item.resolution === "fixed" ? "Fixed — try the original action again." : "Marked unsolved.";
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
  } catch (err) {
    showStatus(statusEl, `Couldn't send answer: ${err.message}`, "error");
  }
}

async function refreshQueue() {
  const listEl = $("queue-list");
  const emptyEl = $("queue-empty");
  try {
    const items = await listCaptures(false);
    renderItemList(listEl, emptyEl, items);
  } catch (err) {
    listEl.innerHTML = "";
    emptyEl.textContent = `Couldn't load: ${err.message}`;
    emptyEl.classList.remove("hidden");
  }
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

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function wireUp() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  $("btn-capture").addEventListener("click", handleCaptureClick);
  $("btn-retake").addEventListener("click", handleCaptureClick);
  $("btn-add-screenshot").addEventListener("click", handleAddScreenshotClick);
  $("btn-upload-screenshot").addEventListener("click", handleUploadScreenshotClick);
  $("btn-upload-screenshot-idle").addEventListener("click", handleUploadScreenshotClick);
  $("screenshot-upload-input").addEventListener("change", handleScreenshotUploadChange);
  $("btn-submit").addEventListener("click", handleSubmitClick);
  $("btn-refresh-queue").addEventListener("click", refreshQueue);
  $("btn-refresh-history").addEventListener("click", refreshHistory);
  $("btn-detail-back").addEventListener("click", closeDetail);
  $("btn-detail-answer-submit").addEventListener("click", handleDetailAnswerSubmit);

  $("btn-gate-continue").addEventListener("click", handleGateContinue);
  $("btn-gate-signin").addEventListener("click", handleGateSignIn);
  $("btn-gate-change-service").addEventListener("click", handleGateChangeService);

  $("btn-sign-out").addEventListener("click", handleSignOut);
  $("btn-change-service").addEventListener("click", handleChangeServiceFromSettings);
  $("btn-save-target-app").addEventListener("click", handleSaveTargetApp);
}

async function clearResolvedBadge() {
  // Opening the popup is the filer acknowledging whatever the toolbar badge
  // was flagging -- see UNREAD_RESOLVED_KEY in background.js.
  await chrome.storage.local.set({ unreadResolvedIds: [] });
  await chrome.action.setBadgeText({ text: "" });
}

(async function init() {
  $("version-badge").textContent = `v${chrome.runtime.getManifest().version}`;
  wireUp();
  await clearResolvedBadge();
  await resolveConnection();
})();
