let currentScreenshot = null; // { dataUrl, blob }
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
  currentScreenshot = { dataUrl, blob: await dataUrlToBlob(dataUrl) };
}

function resetCaptureForm() {
  $("description").value = "";
  $("capture-idle").classList.remove("hidden");
  $("capture-preview").classList.add("hidden");
  hideStatus($("capture-status"));
  currentScreenshot = null;
  currentPage = null;
}

async function handleCaptureClick() {
  const statusEl = $("capture-status");
  hideStatus(statusEl);
  try {
    await takeScreenshot();
    $("preview-img").src = currentScreenshot.dataUrl;
    $("page-meta").textContent = `${currentPage.title} — ${currentPage.url}`;
    $("capture-idle").classList.add("hidden");
    $("capture-preview").classList.remove("hidden");
  } catch (err) {
    showStatus(statusEl, `Couldn't capture the page: ${err.message}`, "error");
  }
}

async function handleSubmitClick() {
  const statusEl = $("capture-status");
  const description = $("description").value.trim();
  if (!description) {
    showStatus(statusEl, "Add a short description before submitting.", "error");
    return;
  }
  if (!currentScreenshot) {
    showStatus(statusEl, "No screenshot captured. Try again.", "error");
    return;
  }
  const submitBtn = $("btn-submit");
  submitBtn.disabled = true;
  showStatus(statusEl, "Submitting…", "info");
  try {
    const result = await submitCapture({
      blob: currentScreenshot.blob,
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
    meta.appendChild(when);
    meta.appendChild(statusBadge(displayStatus(item)));
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
}

(async function init() {
  wireUp();
  await resolveConnection();
})();
