// Thin wrapper around the configured intake service's API. Every call reads
// the backend URL + token from settings — nothing here is a constant.

async function apiRequest(path, options = {}) {
  const { backendUrl, authToken } = await getSettings();
  if (!backendUrl) {
    throw new Error("No intake service URL configured. Set one in Settings.");
  }
  const headers = options.headers || {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(`${normalizeBackendUrl(backendUrl)}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_) {
      // no JSON body, keep statusText
    }
    throw new Error(`${res.status} ${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function submitCapture({ blob, description, pageUrl, pageTitle }) {
  const form = new FormData();
  form.append("screenshot", blob, "capture.png");
  form.append("description", description);
  form.append("page_url", pageUrl);
  form.append("page_title", pageTitle);

  const { backendUrl, authToken } = await getSettings();
  if (!backendUrl) {
    throw new Error("No intake service URL configured. Set one in Settings.");
  }
  const headers = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${normalizeBackendUrl(backendUrl)}/capture`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_) {
      // ignore
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

async function listCaptures(resolved) {
  const qs = resolved === undefined ? "" : `?resolved=${resolved ? "true" : "false"}`;
  return apiRequest(`/captures${qs}`);
}

async function pingBackend() {
  return apiRequest("/healthz");
}

async function getCapture(id) {
  return apiRequest(`/captures/${encodeURIComponent(id)}`);
}

async function answerClarification(id, answer) {
  return apiRequest(`/captures/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
}
