const http = require("http");
const fs = require("fs");
const path = require("path");
const { handler } = require("./netlify/functions/api");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, html) => {
        if (e2) send(res, 404, "Not found");
        else send(res, 200, html, { "Content-Type": "text/html; charset=utf-8" });
      });
      return;
    }
    send(res, 200, data, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const event = {
      path: urlPath,
      rawUrl: `${origin}${req.url}`,
      httpMethod: req.method,
      headers: { ...req.headers, origin },
      body: raw || null,
      queryStringParameters: Object.fromEntries(new URL(req.url, origin).searchParams),
    };
    try {
      const result = await handler(event);
      const headers = result.headers || {};
      send(res, result.statusCode || 200, result.body || "", headers);
    } catch (err) {
      send(res, 500, JSON.stringify({ code: "SERVER_ERROR", message: "Something went wrong." }), {
        "Content-Type": "application/json",
      });
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`CoupleGame running at http://localhost:${PORT}`);
});
