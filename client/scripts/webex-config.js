const DEV_PROXY_ORIGIN = "http://127.0.0.1:8787";

/**
 * Webex REST base URL for the Http client (may include /v1 suffix).
 * On localhost we default to the dev proxy to avoid browser CORS.
 *
 * Override: ?webexApi=direct | ?webexApi=proxy
 */
export function resolveWebexApiBaseUrl() {
  if (typeof window === "undefined") {
    return "https://webexapis.com/v1";
  }

  const override = new URLSearchParams(window.location.search).get("webexApi");

  if (override === "direct") {
    return "https://webexapis.com/v1";
  }

  if (override === "proxy") {
    return `${DEV_PROXY_ORIGIN}/v1`;
  }

  const { hostname } = window.location;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `${DEV_PROXY_ORIGIN}/v1`;
  }

  return "https://webexapis.com/v1";
}

export function isLocalDevProxyEnabled() {
  return resolveWebexApiBaseUrl().startsWith(DEV_PROXY_ORIGIN);
}
