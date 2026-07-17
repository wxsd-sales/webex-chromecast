const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_PAGES = 50;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

class WebexHttpError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {number} [details.status]
   * @param {string} [details.url]
   * @param {string} [details.method]
   * @param {object} [details.body]
   * @param {string} [details.trackingId]
   * @param {boolean} [details.retryable]
   * @param {Error} [details.cause]
   */
  constructor(message, details = {}) {
    super(message, { cause: details.cause });
    this.name = "WebexHttpError";
    this.status = details.status;
    this.url = details.url;
    this.method = details.method;
    this.body = details.body;
    this.trackingId = details.trackingId;
    this.retryable = Boolean(details.retryable);
  }

  static fromResponse(response, { url, method, body }) {
    const trackingId =
      response.headers.get("trackingid") ||
      response.headers.get("TrackingId") ||
      response.headers.get("Trackingid");
    const message =
      body?.message ||
      body?.errors?.[0]?.description ||
      `Request failed (${response.status})`;

    return new WebexHttpError(message, {
      status: response.status,
      url,
      method,
      body,
      trackingId,
      retryable: RETRYABLE_STATUSES.has(response.status),
    });
  }

  static fromNetwork(message, { url, method, cause }) {
    return new WebexHttpError(message, {
      url,
      method,
      retryable: true,
      cause,
    });
  }
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) {
          search.append(key, String(item));
        }
      }
      continue;
    }

    search.append(key, String(value));
  }

  return search.toString();
}

function parseRetryAfterSeconds(headerValue) {
  if (!headerValue) {
    return 1;
  }

  const seconds = parseInt(headerValue, 10);
  if (!Number.isNaN(seconds)) {
    return Math.max(1, seconds);
  }

  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }

  return 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener(
    "abort",
    () => clearTimeout(timer),
    { once: true },
  );
  return controller.signal;
}

class Http {
  #accessToken;
  #baseUrl = "https://webexapis.com";
  #useDevProxy = false;

  /**
   * @param {string} accessToken
   * @param {?string} baseUrl - e.g. https://webexapis.com/v1 or http://127.0.0.1:8787/v1
   */
  constructor(accessToken, baseUrl) {
    if (
      !accessToken ||
      typeof accessToken !== "string" ||
      !accessToken.trim()
    ) {
      throw new Error("Access token is required");
    }

    if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
      throw new Error("Base URL is required");
    }

    this.#accessToken = accessToken;
    this.#baseUrl = /v\d+$/.test(baseUrl)
      ? baseUrl.replace(/\/v\d+$/, "")
      : baseUrl.replace(/\/$/, "");
    this.#useDevProxy = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
      this.#baseUrl,
    );
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get usesDevProxy() {
    return this.#useDevProxy;
  }

  #resolveUrl(urlPath) {
    if (/^https?:\/\//i.test(urlPath)) {
      return this.#normalizePaginationUrl(urlPath);
    }

    const path = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;

    if (path.startsWith("/identity/")) {
      return `${this.#baseUrl}${path}`;
    }

    if (path.startsWith("/v1/")) {
      return `${this.#baseUrl}${path}`;
    }

    return `${this.#baseUrl}/v1${path}`;
  }

  /** Rewrite Webex absolute pagination links to the dev proxy when needed. */
  #normalizePaginationUrl(url) {
    if (!this.#useDevProxy || !url) {
      return url;
    }

    try {
      const parsed = new URL(url);

      if (parsed.origin === "https://webexapis.com") {
        return `${this.#baseUrl}${parsed.pathname}${parsed.search}`;
      }
    } catch {
      return url;
    }

    return url;
  }

  #buildRequestHeaders(extraHeaders = {}) {
    return {
      Accept: "application/json",
      ...extraHeaders,
      Authorization: `Bearer ${this.#accessToken}`,
    };
  }

  #prepareRequestBody(body, headers) {
    if (body === undefined || body === null) {
      return { body: undefined, headers };
    }

    const nextHeaders = { ...headers };

    if (typeof body !== "string") {
      nextHeaders["Content-Type"] = nextHeaders["Content-Type"] || "application/json";
      return { body: JSON.stringify(body), headers: nextHeaders };
    }

    if (body && !nextHeaders["Content-Type"]) {
      nextHeaders["Content-Type"] = "application/json";
    }

    return { body, headers: nextHeaders };
  }

  async #fetchWithRetry(fullUrl, options = {}) {
    const {
      method = "GET",
      body,
      headers: extraHeaders = {},
      retries = DEFAULT_MAX_RETRIES,
      timeout = DEFAULT_TIMEOUT_MS,
    } = options;

    const prepared = this.#prepareRequestBody(body, this.#buildRequestHeaders(extraHeaders));
    let lastResponse = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(fullUrl, {
          method,
          headers: prepared.headers,
          body: prepared.body,
          signal: createTimeoutSignal(timeout),
        });

        lastResponse = response;

        if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
          const waitSeconds =
            response.status === 429
              ? parseRetryAfterSeconds(response.headers.get("Retry-After"))
              : Math.min(attempt, 5);
          await sleep(waitSeconds * 1000);
          continue;
        }

        return response;
      } catch (error) {
        const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError";

        if (attempt < retries && !isTimeout) {
          await sleep(Math.min(attempt, 5) * 1000);
          continue;
        }

        if (isTimeout) {
          throw new WebexHttpError(`Request timed out after ${timeout}ms`, {
            url: fullUrl,
            method,
            retryable: false,
            cause: error,
          });
        }

        throw WebexHttpError.fromNetwork(
          error?.message || "Network request failed",
          { url: fullUrl, method, cause: error },
        );
      }
    }

    if (lastResponse) {
      return lastResponse;
    }

    throw new WebexHttpError("Maximum retries exceeded", {
      url: fullUrl,
      method,
      retryable: true,
      status: 429,
    });
  }

  #extractNextLink(linkHeader) {
    if (!linkHeader) {
      return null;
    }

    const linkParts = linkHeader.match(/<[^>]+>[^,]*/g) || [];

    for (const part of linkParts) {
      const urlMatch = part.match(/<([^>]+)>/);
      const relMatch = part.match(/;\s*rel=(?:"([^"]+)"|([^;\s,"]+))/i);
      const rel = relMatch?.[1] || relMatch?.[2];

      if (urlMatch && rel?.toLowerCase() === "next") {
        return this.#normalizePaginationUrl(urlMatch[1]);
      }
    }

    return null;
  }

  async #readJson(response) {
    const text = await response.text();

    if (!text.trim()) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  async #ensureOk(response, { url, method }) {
    if (response.ok) {
      return response;
    }

    const data = await this.#readJson(response);
    throw WebexHttpError.fromResponse(response, { url, method, body: data });
  }

  #invokeCallback(callback, value) {
    if (typeof callback !== "function") {
      return;
    }

    try {
      callback(value);
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * GET a single JSON document (xAPI status/schema, etc.).
   * @param {string} urlPath
   * @param {object} [params]
   * @param {object} [options]
   * @param {number} [options.timeout]
   */
  async getJson(urlPath, params = {}, options = {}) {
    const query = buildQuery(params);
    const fullUrl = this.#resolveUrl(
      `${urlPath}${query ? `?${query}` : ""}`,
    );

    const response = await this.#ensureOk(
      await this.#fetchWithRetry(fullUrl, {
        method: "GET",
        timeout: options.timeout,
      }),
      { url: fullUrl, method: "GET" },
    );

    return this.#readJson(response);
  }

  /**
   * GET and follow Webex pagination (`items` + Link rel=next).
   * @param {string} urlPath
   * @param {object} [params]
   * @param {object} [options]
   * @param {function(number): void} [options.onProgress]
   * @param {function(Array): void} [options.onComplete]
   * @param {number} [options.maxPages]
   * @param {number} [options.timeout]
   */
  async getPaginated(urlPath, params = {}, options = {}) {
    const {
      onProgress = null,
      onComplete = null,
      maxPages = DEFAULT_MAX_PAGES,
      timeout,
    } = options;

    let results = [];
    let pageCount = 0;
    const query = buildQuery(params);
    let fullUrl = this.#resolveUrl(
      `${urlPath}${query ? `?${query}` : ""}`,
    );

    while (fullUrl) {
      pageCount += 1;

      if (pageCount > maxPages) {
        throw new WebexHttpError(`Pagination exceeded ${maxPages} pages`, {
          url: fullUrl,
          method: "GET",
          retryable: false,
        });
      }

      const response = await this.#ensureOk(
        await this.#fetchWithRetry(fullUrl, {
          method: "GET",
          timeout,
        }),
        { url: fullUrl, method: "GET" },
      );
      const data = await this.#readJson(response);

      if (!Array.isArray(data?.items)) {
        throw new WebexHttpError(
          "Expected paginated response with an items array",
          {
            status: response.status,
            url: fullUrl,
            method: "GET",
            body: data,
            retryable: false,
          },
        );
      }

      results = results.concat(data.items);
      this.#invokeCallback(onProgress, results.length);

      fullUrl = this.#extractNextLink(response.headers.get("Link"));
    }

    this.#invokeCallback(onComplete, results);
    return results;
  }

  async post(url, data, options = {}) {
    const fullUrl = this.#resolveUrl(url);
    const body = data === undefined ? {} : data;

    const response = await this.#ensureOk(
      await this.#fetchWithRetry(fullUrl, {
        method: "POST",
        body,
        timeout: options.timeout,
      }),
      { url: fullUrl, method: "POST" },
    );

    return this.#readJson(response);
  }

  async put(url, data, options = {}) {
    const fullUrl = this.#resolveUrl(url);
    const body = data === undefined ? {} : data;

    const response = await this.#ensureOk(
      await this.#fetchWithRetry(fullUrl, {
        method: "PUT",
        body,
        timeout: options.timeout,
      }),
      { url: fullUrl, method: "PUT" },
    );

    return this.#readJson(response);
  }

  async delete(url, options = {}) {
    const fullUrl = this.#resolveUrl(url);

    const response = await this.#ensureOk(
      await this.#fetchWithRetry(fullUrl, {
        method: "DELETE",
        timeout: options.timeout,
      }),
      { url: fullUrl, method: "DELETE" },
    );

    return this.#readJson(response);
  }
}

export default Http;
