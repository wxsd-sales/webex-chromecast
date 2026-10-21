const CONFIG = {
  clientId: "Cce526cdd8b3ecbf6fb4bb706db92e1848fd9a0069877bfbacbfcc86ec4820977",
  oauthAuthorizeUrl: "https://webexapis.com/v1/authorize",
  oauthRedirectUri: `${window.location.origin}${window.location.pathname}`,
  /**
   * `spark:all` + `spark:kms` are required for the Webex Web SDK to register and
   * join meetings with media. The `meeting:schedules_read` scope lets the app
   * list the signed-in user's scheduled and in-progress meetings via REST.
   */
  oauthScopes: [
    "spark:all",
    "spark:kms",
    "meeting:schedules_read",
    "meeting:preferences_read"
  ],
  storagePrefix: "webex-chromecast",
  hashDeviceKey: "meeting",
  /** Hash fragment keys returned by Webex implicit grant (not query string). */
  oauthCallbackParams: [
    "access_token",
    "token_type",
    "expires_in",
    "scope",
    "state",
    "error",
    "error_description",
  ],
};

function createUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function encodeOAuthState({ nonce, deviceId }) {
  const payload = { n: nonce };

  if (deviceId) {
    payload.deviceId = deviceId;
  }

  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);

  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeOAuthState(stateValue) {
  if (!stateValue) {
    return null;
  }

  try {
    const base64 = stateValue.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json);

    if (!payload?.n || typeof payload.n !== "string") {
      return null;
    }

    return {
      nonce: payload.n,
      deviceId:
        typeof payload.deviceId === "string" && payload.deviceId.trim()
          ? payload.deviceId.trim()
          : null,
    };
  } catch {
    return null;
  }
}

export function isHostedWebApp() {
  return (
    window.location.protocol === "http:" ||
    window.location.protocol === "https:"
  );
}

class OAuth {
  #config;
  #storageKeys = ["access_token", "expires_at", "token_type", "scopes"];

  constructor(config = CONFIG) {
    this.#config = config;
  }

  get config() {
    return this.#config;
  }

  #storageKey(key) {
    return `${this.#config.storagePrefix}_${key}`;
  }

  #getSessionItem(key) {
    return sessionStorage.getItem(this.#storageKey(key));
  }

  #setSessionItem(key, value) {
    sessionStorage.setItem(this.#storageKey(key), value);
  }

  #removeSessionItem(key) {
    sessionStorage.removeItem(this.#storageKey(key));
  }

  #getLocalItem(key) {
    return localStorage.getItem(this.#storageKey(key));
  }

  #setLocalItem(key, value) {
    localStorage.setItem(this.#storageKey(key), value);
  }

  #removeLocalItem(key) {
    localStorage.removeItem(this.#storageKey(key));
  }

  #getHashParams() {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;

    return new URLSearchParams(hash);
  }

  #stripOAuthCallbackParams(hashParams) {
    this.#config.oauthCallbackParams.forEach((key) => hashParams.delete(key));
  }

  isOAuthCallbackHash() {
    const hashParams = this.#getHashParams();

    return hashParams.has("access_token") || hashParams.has("error");
  }

  getHashDeviceId() {
    if (this.isOAuthCallbackHash()) {
      return null;
    }

    const deviceId = this.#getHashParams().get(this.#config.hashDeviceKey);

    return deviceId?.trim() || null;
  }

  setHashDeviceId(deviceId) {
    const url = new URL(window.location.href);

    if (!deviceId) {
      url.hash = "";
      window.history.replaceState({}, document.title, url.toString());
      return;
    }

    const hashParams = this.isOAuthCallbackHash()
      ? new URLSearchParams()
      : this.#getHashParams();

    this.#stripOAuthCallbackParams(hashParams);
    hashParams.set(this.#config.hashDeviceKey, deviceId);
    const serialized = hashParams.toString();

    url.hash = serialized ? `#${serialized}` : "";
    window.history.replaceState({}, document.title, url.toString());
  }

  clearHashDeviceId() {
    const url = new URL(window.location.href);
    const hashParams = this.#getHashParams();

    hashParams.delete(this.#config.hashDeviceKey);
    const serialized = hashParams.toString();

    url.hash = serialized ? `#${serialized}` : "";
    window.history.replaceState({}, document.title, url.toString());
  }

  cleanOAuthParamsFromUrl({ deviceId } = {}) {
    const url = new URL(window.location.href);
    const hashParams = this.#getHashParams();

    this.#stripOAuthCallbackParams(hashParams);

    if (deviceId) {
      hashParams.set(this.#config.hashDeviceKey, deviceId);
    }

    const serialized = hashParams.toString();
    url.hash = serialized ? `#${serialized}` : "";
    window.history.replaceState({}, document.title, url.toString());
  }

  getStoredCredentials() {
    const accessToken = this.#getLocalItem("access_token");

    if (!accessToken) {
      return null;
    }

    return {
      accessToken,
      expiresAt: Number(this.#getLocalItem("expires_at")) || 0,
      tokenType: this.#getLocalItem("token_type") || "Bearer",
      scopes: String(this.#getLocalItem("scopes") || "")
        .split(/\s+/)
        .filter(Boolean),
    };
  }

  saveCredentials(credentials) {
    if (!credentials?.accessToken) {
      return;
    }

    this.#setLocalItem("access_token", credentials.accessToken);
    this.#setLocalItem("expires_at", String(credentials.expiresAt || ""));
    this.#setLocalItem("token_type", credentials.tokenType || "Bearer");
    this.#setLocalItem(
      "scopes",
      Array.isArray(credentials.scopes) ? credentials.scopes.join(" ") : "",
    );
  }

  clearCredentials() {
    this.#storageKeys.forEach((key) => this.#removeLocalItem(key));
    this.#removeSessionItem("oauth_nonce");
    this.#removeSessionItem("pending_device_id");
  }

  isExpired(credentials) {
    return Boolean(
      credentials?.expiresAt && Date.now() > credentials.expiresAt,
    );
  }

  consumeRedirectCredentials() {
    if (!this.isOAuthCallbackHash()) {
      return null;
    }

    const hashParams = this.#getHashParams();
    const oauthError = hashParams.get("error");

    if (oauthError) {
      const pendingDeviceId = this.#getSessionItem("pending_device_id") || null;

      this.cleanOAuthParamsFromUrl({
        deviceId: pendingDeviceId || undefined,
      });
      this.#removeSessionItem("oauth_nonce");
      this.#removeSessionItem("pending_device_id");

      return {
        ok: false,
        reason: "oauth_error",
        message: hashParams.get("error_description") || oauthError,
        pendingDeviceId,
      };
    }

    const accessToken = hashParams.get("access_token");

    if (!accessToken) {
      return null;
    }

    const decodedState = decodeOAuthState(hashParams.get("state"));
    const expectedNonce = this.#getSessionItem("oauth_nonce");

    this.#removeSessionItem("oauth_nonce");

    if (
      !decodedState ||
      !expectedNonce ||
      decodedState.nonce !== expectedNonce
    ) {
      const fallbackDeviceId = this.#getSessionItem("pending_device_id");
      this.#removeSessionItem("pending_device_id");
      this.cleanOAuthParamsFromUrl({
        deviceId: fallbackDeviceId || undefined,
      });

      return {
        ok: false,
        reason: "state_mismatch",
        message:
          "Webex sign-in blocked: OAuth state was missing or did not match.",
        pendingDeviceId: fallbackDeviceId || null,
      };
    }

    const pendingDeviceId =
      decodedState.deviceId ||
      this.#getSessionItem("pending_device_id") ||
      null;

    this.#removeSessionItem("pending_device_id");

    const expiresIn = Number(hashParams.get("expires_in"));
    const scopeText =
      hashParams.get("scope") || this.#config.oauthScopes.join(" ");
    const tokenType = hashParams.get("token_type") || "Bearer";

    const credentials = {
      accessToken,
      expiresAt:
        Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
      tokenType,
      scopes: scopeText.split(/\s+/).filter(Boolean),
    };

    this.saveCredentials(credentials);
    this.cleanOAuthParamsFromUrl({ deviceId: pendingDeviceId || undefined });

    return {
      ok: true,
      credentials,
      pendingDeviceId,
    };
  }

  /**
   * @returns {{
   *   ok: boolean,
   *   credentials?: object,
   *   pendingDeviceId?: string|null,
   *   reason?: string,
   *   message?: string
   * }}
   */
  initialize() {
    const redirectResult = this.consumeRedirectCredentials();

    if (redirectResult) {
      return redirectResult;
    }

    const bookmarkDeviceId = this.getHashDeviceId();
    const stored = this.getStoredCredentials();

    if (!stored) {
      return {
        ok: false,
        reason: "none",
        message: bookmarkDeviceId
          ? "Sign in with Webex to control your bookmarked device."
          : "Sign in with Webex to find your personal devices.",
        pendingDeviceId: bookmarkDeviceId,
      };
    }

    if (this.isExpired(stored)) {
      this.clearCredentials();

      return {
        ok: false,
        reason: "expired",
        message: "Stored Webex sign-in expired. Sign in again.",
        pendingDeviceId: bookmarkDeviceId,
      };
    }

    return {
      ok: true,
      credentials: stored,
      pendingDeviceId: bookmarkDeviceId,
    };
  }

  /**
   * @param {{ deviceId?: string|null }} [options]
   * @returns {string|null} Error message for the UI, or null on redirect
   */
  startLogin(options = {}) {
    if (!this.#config.clientId) {
      return "Webex sign-in blocked: no OAuth client ID is configured.";
    }

    if (!isHostedWebApp()) {
      return "Webex sign-in needs this app to be served from http:// or https://.";
    }

    const deviceId = options.deviceId?.trim() || this.getHashDeviceId() || null;

    if (deviceId) {
      this.#setSessionItem("pending_device_id", deviceId);
    } else {
      this.#removeSessionItem("pending_device_id");
    }

    const nonce = createUuid();
    this.#setSessionItem("oauth_nonce", nonce);

    const state = encodeOAuthState({ nonce, deviceId });
    const params = new URLSearchParams({
      client_id: this.#config.clientId,
      response_type: "token",
      redirect_uri: this.#config.oauthRedirectUri,
      scope: this.#config.oauthScopes.join(" "),
      state,
    });

    window.location.assign(
      `${this.#config.oauthAuthorizeUrl}?${params.toString()}`,
    );

    return null;
  }

  async revokeToken(accessToken) {
    if (!accessToken) {
      return;
    }

    await fetch(
      "https://idbroker.webex.com/idb/oauth2/v1/tokens/me?authtoken=true",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
  }
}

export default OAuth;
