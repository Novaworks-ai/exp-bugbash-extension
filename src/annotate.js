// Standalone window (opened via chrome.windows.create from popup.js's
// openAnnotateWindow) for the "Pin & Capture" flow's drawing step -- a
// popup/side panel is too narrow (as small as ~350px) for freehand drawing
// to be usable, the same reason the Entra sign-in flow gets its own real
// browser window instead of running inside the extension surface. Receives
// the screenshot + pin via chrome.storage.session (a data URL is too big
// for a URL query param) written by popup.js right before this window opens,
// and reports its result back the same way pin-picker.js does: a
// chrome.runtime.sendMessage, not a return value, since nothing here is
// available until the filer actually finishes drawing.

const PENDING_KEY = "bugbashPendingAnnotate";

let ctx = null;
let baseImageData = null;
let drawing = false;

function canvasScale() {
  const canvas = document.getElementById("annotate-canvas");
  return canvas.width / canvas.getBoundingClientRect().width;
}

function pointerPos(e) {
  const canvas = document.getElementById("annotate-canvas");
  const rect = canvas.getBoundingClientRect();
  const scale = canvasScale();
  return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
}

function onPointerDown(e) {
  drawing = true;
  const { x, y } = pointerPos(e);
  ctx.beginPath();
  ctx.moveTo(x, y);
}

function onPointerMove(e) {
  if (!drawing) return;
  const { x, y } = pointerPos(e);
  ctx.lineTo(x, y);
  ctx.stroke();
}

function onPointerUp() {
  drawing = false;
}

function handleClear() {
  if (!ctx || !baseImageData) return;
  ctx.putImageData(baseImageData, 0, 0);
}

function handleCancel() {
  chrome.runtime.sendMessage({ type: "bugbash-annotate-cancelled" });
  window.close();
}

async function handleUse() {
  const canvas = document.getElementById("annotate-canvas");
  const dataUrl = canvas.toDataURL("image/png");
  chrome.runtime.sendMessage({ type: "bugbash-annotate-done", dataUrl });
  window.close();
}

async function init() {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY];
  await chrome.storage.session.remove(PENDING_KEY);

  if (!pending || !pending.dataUrl) {
    document.body.innerHTML =
      '<p style="padding:24px;font:14px sans-serif;">Nothing to annotate -- close this window and try "Pin &amp; Capture" again.</p>';
    return;
  }

  const { dataUrl, pin } = pending;
  document.getElementById("annotate-selector").textContent = pin ? pin.selector : "(none)";

  const canvas = document.getElementById("annotate-canvas");
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Couldn't load the screenshot."));
    img.src = dataUrl;
  });

  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  if (pin) {
    const dpr = pin.devicePixelRatio || 1;
    const px = pin.point.x * dpr;
    const py = pin.point.y * dpr;
    ctx.save();
    ctx.strokeStyle = "#e8823f";
    ctx.fillStyle = "#e8823f";
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.arc(px, py, 14 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#d92d20";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  document.getElementById("btn-annotate-clear").addEventListener("click", handleClear);
  document.getElementById("btn-annotate-cancel").addEventListener("click", handleCancel);
  document.getElementById("btn-annotate-use").addEventListener("click", handleUse);
}

init().catch((err) => {
  document.body.innerHTML = `<p style="padding:24px;font:14px sans-serif;color:#b91c1c;">${err.message}</p>`;
});
