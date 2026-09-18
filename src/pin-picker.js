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

  // Injected into every frame (see injectPinPicker's allFrames: true in
  // popup.js) since the real content on a page like ServiceNow's classic UI
  // lives inside an iframe, not the top frame -- but only the top frame
  // should show the "click here" hint banner, or a page with nested frames
  // would show one overlapping banner per frame.
  let hint = null;
  if (window.top === window) {
    hint = document.createElement("div");
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
  }
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
  //
  // Crosses shadow boundaries with the informal ">>>" deep-combinator (the
  // same convention Playwright/WebdriverIO use for this) rather than
  // stopping at the shadow host -- confirmed live on ServiceNow's developer
  // portal (built on web components): a plain el.parentElement walk silently
  // stops at the host, e.g. reporting the whole "dps-app" element for a
  // click on its own internal "Home" link, which is a real but different
  // element ordinary querySelector can never reach anyway (it doesn't
  // pierce shadow roots either) -- ">>>" at least documents *which* shadow
  // root to descend into and what to look for once there, instead of losing
  // that information entirely.
  function cssSelectorFor(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      const root = node.getRootNode();
      if (root instanceof ShadowRoot && !node.parentElement) {
        // node is the shadow root's own top-level child with no further
        // light-DOM parentElement inside that root -- cross back out to the
        // host and mark the crossing, then keep walking up the host's own
        // (light-DOM) ancestry as usual.
        parts.unshift(">>>");
        node = root.host;
        continue;
      }
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

  // Sums each ancestor frame's own position within ITS parent's viewport
  // (getBoundingClientRect is always viewport-relative, so this already
  // accounts for any intermediate frame's own scroll position) to convert a
  // point in *this* frame's coordinates into the top window's -- needed
  // because captureVisibleTab screenshots the whole tab's top-level
  // viewport, but a click inside a nested frame (allFrames: true injects
  // into every one) reports clientX/clientY relative to that frame alone.
  // Confirmed live: without this, a pin placed well down the page inside a
  // frame landed near the top of the actual screenshot instead. Stops (and
  // returns whatever it already accumulated) at the first cross-origin
  // ancestor, since window.frameElement is inaccessible there -- a known,
  // unavoidable gap, same as any other cross-origin-iframe limitation.
  function frameOffset() {
    let win = window;
    let offsetX = 0;
    let offsetY = 0;
    while (win !== win.top) {
      let frameEl;
      try {
        frameEl = win.frameElement;
      } catch (_) {
        break;
      }
      if (!frameEl) break;
      const r = frameEl.getBoundingClientRect();
      offsetX += r.left;
      offsetY += r.top;
      win = win.parent;
    }
    return { offsetX, offsetY };
  }

  function cleanup() {
    clearHighlight();
    if (hint) hint.remove();
    document.documentElement.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.__bugbashPinPickerActive = false;
  }

  // composedPath()[0], not e.target: inside an open shadow root, e.target is
  // "retargeted" to the shadow HOST for any listener outside that root (see
  // cssSelectorFor's comment) -- composedPath() is the one thing that still
  // reports the true innermost element that was actually under the cursor.
  function deepTarget(e) {
    const path = e.composedPath ? e.composedPath() : null;
    return (path && path[0]) || e.target;
  }

  function onMouseMove(e) {
    const target = deepTarget(e);
    if (target && target.id !== HINT_ID) applyHighlight(target);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = deepTarget(e);
    const rect = target.getBoundingClientRect();
    const { offsetX, offsetY } = frameOffset();
    const result = {
      selector: cssSelectorFor(target),
      point: { x: e.clientX + offsetX, y: e.clientY + offsetY },
      rect: { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height },
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
