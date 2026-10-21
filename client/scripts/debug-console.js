/**
 * In-page debug console for devices without dev tools (e.g. mobile browsers).
 *
 * Captures console output, uncaught errors and unhandled promise rejections
 * from page load, and shows them in a panel opened with the "Debug" button.
 * The log can be copied or shared. Access tokens are redacted.
 *
 * Add ?debug=1 to the URL to also turn on verbose Webex SDK logging.
 */

const MAX_ENTRIES = 500;
const entries = [];
let panel = null;
let logEl = null;

export function isVerboseDebug() {
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

function redact(text) {
  return text
    .replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]")
    .replace(/(access_token["'=:\s]+)[\w.~+/=-]{12,}/gi, "$1[redacted]")
    .replace(/(accessToken["'=:\s]+)[\w.~+/=-]{12,}/gi, "$1[redacted]");
}

function stringify(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function record(level, args) {
  const time = new Date().toISOString().slice(11, 23);
  const message = redact(args.map(stringify).join(" "));

  entries.push({ time, level, message });

  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }

  if (logEl) {
    appendRow(entries[entries.length - 1]);
  }
}

function formatAll() {
  const header = [
    `URL: ${window.location.origin}${window.location.pathname}`,
    `UA: ${navigator.userAgent}`,
    "",
  ];

  return header
    .concat(entries.map((e) => `${e.time} [${e.level}] ${e.message}`))
    .join("\n");
}

function appendRow(entry) {
  const row = document.createElement("div");
  row.className = `debug-row debug-row--${entry.level}`;
  row.textContent = `${entry.time} ${entry.message}`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function install() {
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);

    console[level] = (...args) => {
      record(level, args);
      original(...args);
    };
  }

  window.addEventListener("error", (event) => {
    record("error", [
      `Uncaught: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
      event.error || "",
    ]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    record("error", ["Unhandled rejection:", event.reason]);
  });
}

async function shareLog(statusEl) {
  const text = formatAll();

  try {
    if (navigator.share) {
      await navigator.share({ title: "Webex Chromecast debug log", text });
      return;
    }

    await navigator.clipboard.writeText(text);
    statusEl.textContent = "Copied to clipboard";
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }

    // Clipboard API unavailable (e.g. non-secure context): select the text.
    const area = document.createElement("textarea");
    area.className = "debug-fallback";
    area.value = text;
    logEl.replaceChildren(area);
    area.select();
    statusEl.textContent = "Select all and copy";
  }
}

function buildPanel() {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "debug-toggle";
  toggle.textContent = "Debug";

  panel = document.createElement("section");
  panel.className = "debug-panel";
  panel.hidden = true;

  const bar = document.createElement("div");
  bar.className = "debug-bar";

  const status = document.createElement("span");
  status.className = "debug-status";

  const makeButton = (label, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "debug-btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  };

  bar.append(
    makeButton("Share / copy", () => shareLog(status)),
    makeButton("Clear", () => {
      entries.length = 0;
      logEl.replaceChildren();
      status.textContent = "";
    }),
    makeButton("Close", () => {
      panel.hidden = true;
    }),
    status,
  );

  logEl = document.createElement("div");
  logEl.className = "debug-log";

  panel.append(bar, logEl);

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;

    if (!panel.hidden) {
      logEl.replaceChildren();
      entries.forEach(appendRow);
    }
  });

  document.body.append(toggle, panel);
}

install();

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", buildPanel);
} else {
  buildPanel();
}
