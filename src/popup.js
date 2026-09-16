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

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `panel-${name}`);
  });
  if (name === "queue") refreshQueue();
  if (name === "history") refreshHistory();
}

async function refreshConnectBadge() {
  const { backendUrl, authToken } = await getSettings();
  const dot = $("connect-dot");
  const label = $("connect-label");
  if (!backendUrl) {
    dot.className = "dot dot-off";
    label.textContent = "Not configured";
    return;
  }
  try {
    await pingBackend();
    dot.className = "dot dot-on";
    label.textContent = authToken ? "Connected" : "Connected (no token)";
  } catch (err) {
    dot.className = "dot dot-off";
    label.textContent = "Unreachable";
  }
}

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

async function loadSettingsIntoForm() {
  const settings = await getSettings();
  $("backend-url").value = settings.backendUrl;
  $("auth-token").value = settings.authToken;
}

async function handleSaveSettings() {
  const statusEl = $("settings-status");
  await setSettings({
    backendUrl: $("backend-url").value.trim(),
    authToken: $("auth-token").value.trim(),
  });
  showStatus(statusEl, "Saved.", "ok");
  refreshConnectBadge();
}

async function handleConnectClick() {
  const statusEl = $("settings-status");
  const backendUrl = $("backend-url").value.trim();
  if (!backendUrl) {
    showStatus(statusEl, "Set the intake service URL first.", "error");
    return;
  }
  await setSettings({ backendUrl });
  showStatus(
    statusEl,
    "This build doesn't drive a full OAuth flow. Against a local instance running " +
      "with AUTH_DISABLED=true, leave Access token blank and just Save. Against a " +
      "real deployment, paste an Entra ID access token into Access token, then Save.",
    "info"
  );
}

async function handleTestConnection() {
  const statusEl = $("settings-status");
  showStatus(statusEl, "Testing…", "info");
  await handleSaveSettings();
  try {
    await pingBackend();
    showStatus(statusEl, "Connected.", "ok");
  } catch (err) {
    showStatus(statusEl, `Connection failed: ${err.message}`, "error");
  }
  refreshConnectBadge();
}

function wireUp() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  $("btn-capture").addEventListener("click", handleCaptureClick);
  $("btn-retake").addEventListener("click", handleCaptureClick);
  $("btn-submit").addEventListener("click", handleSubmitClick);
  $("btn-refresh-queue").addEventListener("click", refreshQueue);
  $("btn-refresh-history").addEventListener("click", refreshHistory);
  $("btn-save-settings").addEventListener("click", handleSaveSettings);
  $("btn-connect").addEventListener("click", handleConnectClick);
  $("btn-test-connection").addEventListener("click", handleTestConnection);
  $("btn-detail-back").addEventListener("click", closeDetail);
  $("btn-detail-answer-submit").addEventListener("click", handleDetailAnswerSubmit);
}

(async function init() {
  wireUp();
  await loadSettingsIntoForm();
  await refreshConnectBadge();
})();
