// Injected into the MAIN world (real page context, not the isolated content-
// script world) of whichever origin the filer configured as their "Target
// app" in Settings -- see background.js's applyConsoleCaptureScript(). Runs
// at document_start so it's in place before the page's own scripts can log
// anything.
//
// A MAIN-world script has no access to chrome.* APIs (that's what "isolated
// world" content scripts are for) -- it can only leave data somewhere the
// page itself can reach. It stashes into window.__bugbashConsoleBuffer;
// popup.js reads that back out via a one-shot chrome.scripting.executeScript
// call (also world: "MAIN") when "Capture this page" is clicked, since a
// single injected function's return value IS relayed back to the caller
// regardless of world -- only ongoing messaging needs isolated-world APIs.
(function () {
  if (window.__bugbashConsoleCaptureInstalled) return; // idempotent -- a
  // dynamically registered content script can re-run on navigation within
  // the same matched origin (SPA route changes, etc.)
  window.__bugbashConsoleCaptureInstalled = true;

  const MAX_ENTRIES = 50;
  window.__bugbashConsoleBuffer = [];

  function push(level, message) {
    const buffer = window.__bugbashConsoleBuffer;
    buffer.push({ level, message: String(message).slice(0, 2000), timestamp: Date.now() });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }

  const originalError = console.error.bind(console);
  console.error = function (...args) {
    push("console.error", args.map(String).join(" "));
    return originalError(...args);
  };

  const originalWarn = console.warn.bind(console);
  console.warn = function (...args) {
    push("console.warn", args.map(String).join(" "));
    return originalWarn(...args);
  };

  window.addEventListener("error", (event) => {
    push("uncaught exception", event.message || String(event.error));
  });

  window.addEventListener("unhandledrejection", (event) => {
    push("unhandled promise rejection", event.reason ? String(event.reason) : "(no reason given)");
  });
})();
