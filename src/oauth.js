// Real Microsoft Entra ID sign-in for the capture extension — a filer never
// obtains or pastes an access token by hand. Discovery (tenant/client ID)
// comes from the configured intake service's own /auth/config; the login
// itself is an OAuth2 authorization-code + PKCE flow through
// chrome.identity.launchWebAuthFlow, which is Chrome's supported way to run
// a public-client (no client-secret) OAuth flow from an extension.

function base64UrlEncode(bytes) {
  let str = "";
  bytes.forEach((b) => (str += String.fromCharCode(b)));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafeString(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Fetches the intake service's public OAuth discovery info. No auth header —
// this must be reachable before any login exists.
async function fetchAuthConfig(backendUrl) {
  const res = await fetch(`${normalizeBackendUrl(backendUrl)}/auth/config`);
  if (!res.ok) {
    throw new Error(`Couldn't reach the intake service (HTTP ${res.status}).`);
  }
  return res.json();
}

function entraScope(clientId) {
  // Requests the app registration's own delegated permission plus a refresh
  // token (offline_access) so the extension doesn't force a re-login every
  // ~hour. Assumes the deployment's Entra app registration exposes this
  // default scope — see README "Entra ID app registration requirements."
  return `openid profile email offline_access ${clientId}/.default`;
}

async function exchangeCodeForToken({ tenantId, clientId, authority, redirectUri, code, verifier }) {
  const tokenUrl = `${authority.replace(/\/+$/, "")}/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: entraScope(clientId),
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const parsed = await res.json();
  if (!res.ok) {
    throw new Error(parsed.error_description || parsed.error || "Token exchange failed.");
  }
  return parsed;
}

async function storeTokenResponse(tokenResponse) {
  const expiresAt = Date.now() + (tokenResponse.expires_in || 3600) * 1000;
  await setSettings({
    authToken: tokenResponse.access_token,
    authTokenExpiresAt: expiresAt,
    authRefreshToken: tokenResponse.refresh_token || "",
  });
}

// Interactive sign-in: opens Microsoft's real login page in the browser
// (chrome.identity.launchWebAuthFlow) and returns once the user has signed
// in and consented.
async function signInWithEntra(authConfig) {
  const tenantId = authConfig.entra_tenant_id;
  const clientId = authConfig.entra_client_id;
  const authority = authConfig.entra_authority || "https://login.microsoftonline.com";
  if (!tenantId || !clientId) {
    throw new Error(
      "This intake service didn't report an Entra ID tenant/client ID — its admin needs to set ENTRA_TENANT_ID/ENTRA_CLIENT_ID."
    );
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomUrlSafeString(48);
  const challenge = await sha256Base64Url(verifier);
  const state = randomUrlSafeString(16);

  const authUrl = new URL(`${authority.replace(/\/+$/, "")}/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", entraScope(clientId));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  const redirectedTo = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!redirectedTo) {
    throw new Error("Sign-in was cancelled.");
  }

  const redirectedUrl = new URL(redirectedTo);
  const error = redirectedUrl.searchParams.get("error");
  if (error) {
    throw new Error(redirectedUrl.searchParams.get("error_description") || error);
  }
  const code = redirectedUrl.searchParams.get("code");
  const returnedState = redirectedUrl.searchParams.get("state");
  if (!code || returnedState !== state) {
    throw new Error("Sign-in didn't return a valid authorization code.");
  }

  const tokenResponse = await exchangeCodeForToken({
    tenantId,
    clientId,
    authority,
    redirectUri,
    code,
    verifier,
  });
  await storeTokenResponse(tokenResponse);
  return tokenResponse;
}

// Silent renewal via the refresh token — no UI, used before a poll or when a
// stored token is close to expiring. Throws if there's no refresh token or
// the refresh itself is rejected (e.g. revoked) — callers fall back to
// showing the interactive sign-in step.
async function refreshEntraToken(authConfig, refreshToken) {
  const tenantId = authConfig.entra_tenant_id;
  const clientId = authConfig.entra_client_id;
  const authority = authConfig.entra_authority || "https://login.microsoftonline.com";
  if (!refreshToken) throw new Error("No refresh token stored.");

  const tokenUrl = `${authority.replace(/\/+$/, "")}/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: entraScope(clientId),
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const parsed = await res.json();
  if (!res.ok) {
    throw new Error(parsed.error_description || parsed.error || "Token refresh failed.");
  }
  if (!parsed.refresh_token) parsed.refresh_token = refreshToken;
  await storeTokenResponse(parsed);
  return parsed;
}
