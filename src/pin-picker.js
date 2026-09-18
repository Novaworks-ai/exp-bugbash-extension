// Injected on demand (chrome.scripting.executeScript, "Pin & Capture" flow
// only -- not a declarative content script, so it never runs unless a filer
// actually asks for it) to let the filer click the exact element their
// report is about before the screenshot is taken. Reports back over
// chrome.runtime.sendMessage rather than returning a value from
// executeScript, since the result depends on a future user click/Escape
// press, not anything available synchronously when this file finishes
// running.
//
// Wrapped in an IIFE (not top-level let/const) because re-injecting this
// file into the same tab a second time (filer clicks "Pin & Capture" again
// after cancelling) would otherwise throw "already declared" in that
// frame's isolated world -- a guard flag on window is what actually
// prevents a second run from starting a second, overlapping picker.
(function () {
  if (window.__bugbashPinPickerActive) return;
  window.__bugbashPinPickerActive = true;

  const HIGHLIGHT_OUTLINE = "2px solid #4f46e4";
  const HINT_ID = "__bugbash-pin-hint";

  let lastTarget = null;
  let lastTargetPrevOutline = "";
  let lastTargetPrevOffset = "";

  const hint = document.createElement("div");
  hint.id = HINT_ID;
  hint.textContent = "Click the element your report is about — Esc to cancel";
  Object.assign(hint.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "2147483647",
    background: "#181611",
    color: "#fff",
    font: "13px -apple-system, sans-serif",
    padding: "6px 14px",
    borderRadius: "999px",
    pointerEvents: "none",
    boxShadow: "0 2px 10px rgba(0,0,0,.3)",
  });
  document.documentElement.appendChild(hint);
  document.documentElement.style.cursor = "crosshair";

  function clearHighlight() {
    if (!lastTarget) return;
    lastTarget.style.outline = lastTargetPrevOutline;
    lastTarget.style.outlineOffset = lastTargetPrevOffset;
    lastTarget = null;
  }

  function applyHighlight(el) {
    if (el === lastTarget) return;
    clearHighlight();
    lastTarget = el;
    lastTargetPrevOutline = el.style.outline;
    lastTargetPrevOffset = el.style.outlineOffset;
    el.style.outline = HIGHLIGHT_OUTLINE;
    el.style.outlineOffset = "-2px";
  }

  // Same shape as devtools' own "Copy selector": prefer a unique #id
  // anywhere up the tree, otherwise build a tag(+nth-of-type when the tag
  // repeats among its siblings) chain from the element up to <body>. Not
  // meant to survive a redesign of the page -- it only needs to point a
  // fixing-pipeline agent at the right spot in *today's* markup.
  function cssSelectorFor(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTagSiblings.length > 1) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function cleanup() {
    clearHighlight();
    hint.remove();
    document.documentElement.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.__bugbashPinPickerActive = false;
  }

  function onMouseMove(e) {
    if (e.target && e.target.id !== HINT_ID) applyHighlight(e.target);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = e.target;
    const rect = target.getBoundingClientRect();
    const result = {
      selector: cssSelectorFor(target),
      point: { x: e.clientX, y: e.clientY },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      // The popup's own window.devicePixelRatio is the WRONG value here --
      // it's a different window than the tab being captured. captureVisibleTab
      // scales its output by *this* page's ratio, so the pin marker has to be
      // scaled by the same number to land in the right spot on that image.
      devicePixelRatio: window.devicePixelRatio || 1,
    };
    cleanup();
    chrome.runtime.sendMessage({ type: "bugbash-pin-picked", ...result });
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cleanup();
    chrome.runtime.sendMessage({ type: "bugbash-pin-cancelled" });
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
})();
