// Thin wrapper around the configured intake service's API. Every call reads
// the backend URL + token from settings — nothing here is a constant.

async function rawFetch(path, options, token) {
  const { backendUrl } = await getSettings();
  if (!backendUrl) {
    throw new Error("No intake service configured. Set one up first.");
  }
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${normalizeBackendUrl(backendUrl)}${path}`, { ...options, headers });
}

// Sends the request with the current token; on a 401 (expired/rejected
// token) tries one silent refresh via the stored Entra refresh token and
// retries once before giving up. Callers never see the intermediate 401.
async function authorizedFetch(path, options = {}) {
  const settings = await getSettings();
  if (settings.authDisabled) {
    return rawFetch(path, options, null);
  }

  const res = await rawFetch(path, options, settings.authToken);
  if (res.status !== 401 || !settings.authRefreshToken) {
    return res;
  }

  try {
    await refreshEntraToken(entraConfigFrom(settings), settings.authRefreshToken);
  } catch (_) {
    return res; // refresh failed — surface the original 401, popup shows sign-in again
  }
  const refreshed = await getSettings();
  return rawFetch(path, options, refreshed.authToken);
}

async function parseErrorDetail(res) {
  try {
    const body = await res.json();
    return body.detail || JSON.stringify(body);
  } catch (_) {
    return res.statusText;
  }
}

async function apiRequest(path, options = {}) {
  const res = await authorizedFetch(path, options);
  if (!res.ok) {
    throw new Error(`${res.status} ${await parseErrorDetail(res)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function submitCapture({ blobs, description, pageUrl, pageTitle }) {
  const form = new FormData();
  blobs.forEach((blob, i) => form.append("screenshots", blob, `capture-${i}.png`));
  form.append("description", description);
  form.append("page_url", pageUrl);
  form.append("page_title", pageTitle);

  // Only sent when a target app is actually configured -- that's the only
  // case background.js's trace-header rule is active, so an unset traceId
  // would just be a value nothing ever wrote into any log anyway.
  const settings = await getSettings();
  if (settings.targetAppUrl && settings.traceId) {
    form.append("trace_id", settings.traceId);
  }

  const res = await authorizedFetch("/capture", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`${res.status} ${await parseErrorDetail(res)}`);
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
