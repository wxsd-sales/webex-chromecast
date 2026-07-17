import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.resolve(webRoot, `.${decodeURIComponent(pathname)}`);

    if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
      send(response, 403, "Forbidden");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      send(response, 404, "Not Found");
      return;
    }

    response.writeHead(200, {
      "Content-Length": fileStat.size,
      "Content-Type":
        contentTypes[path.extname(filePath).toLowerCase()] ||
        "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") {
      send(response, 404, "Not Found");
      return;
    }

    console.error(error);
    send(response, 500, "Internal Server Error");
  }
});

server.listen(port, host, () => {
  console.log(`Serving web app at http://${host}:${port}/index.html`);
});

function send(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(text);
}
