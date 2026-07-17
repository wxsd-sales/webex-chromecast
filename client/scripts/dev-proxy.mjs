/**
 * Local dev proxy for Webex REST APIs (avoids browser CORS on localhost).
 *
 * Usage:
 *   node scripts/dev-proxy.mjs
 *
 * Keep Live Server on http://localhost:5500 (or similar) and run this on port 8787.
 * The app auto-routes API calls through http://localhost:8787 when served locally.
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = Number(process.env.WEBEX_DEV_PROXY_PORT || 8787);
const TARGET_ORIGIN = "https://webexapis.com";

const ALLOW_LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function isAllowedOrigin(origin) {
  return Boolean(origin && ALLOW_LOCAL_ORIGIN.test(origin));
}

function setCorsHeaders(res, origin) {
  if (!isAllowedOrigin(origin)) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function copyResponseHeaders(upstreamHeaders, res, origin) {
  const skip = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "access-control-allow-origin",
  ]);

  for (const [key, value] of Object.entries(upstreamHeaders)) {
    if (!skip.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }

  setCorsHeaders(res, origin);
}

function proxyRequest(req, res) {
  const origin = req.headers.origin || "";
  setCorsHeaders(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    TARGET_ORIGIN,
  );

  const headers = { ...req.headers };

  delete headers.host;
  delete headers.connection;
  delete headers.origin;
  delete headers.referer;
  // Ask Webex for uncompressed JSON; piping gzip without matching headers breaks fetch().json().
  delete headers["accept-encoding"];

  const upstream = https.request(
    targetUrl,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      copyResponseHeaders(upstreamRes.headers, res, origin);
      res.writeHead(upstreamRes.statusCode || 502);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (error) => {
    console.error("[dev-proxy] upstream error:", error.message);
    setCorsHeaders(res, origin);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        message: `Proxy failed to reach Webex API: ${error.message}`,
      }),
    );
  });

  req.pipe(upstream);
}

const server = http.createServer(proxyRequest);

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(
    `Webex dev proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`,
  );
  console.log(`Forwarding to ${TARGET_ORIGIN}`);
  console.log(
    "Serve the app with Live Server, then open it — API calls use the proxy automatically on localhost.",
  );
});
