// Serves lab/ as a static site on localhost so the graph lab can be opened in
// a browser. The lab is a static page (REBOOT.md lab tech ruling) — this adds
// no server-side logic, it only hands out lab/index.html and lab/dist/lab.js.
//
//   npm run lab        # build the bundle first (tsc + webpack)
//   npm run lab:serve  # then open the printed URL
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "lab");
const PORT = Number(process.env.LAB_PORT) || 5173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

if (!fs.existsSync(path.join(ROOT, "dist", "lab.js"))) {
  console.error("lab/dist/lab.js is missing — run `npm run lab` first.");
  process.exit(1);
}

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel === "/") rel = "/index.html";

    const file = path.resolve(ROOT, "." + rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end("not found: " + rel);
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        // The bundle is rebuilt constantly; never let the browser cache it.
        "Cache-Control": "no-store"
      });
      res.end(body);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`graph lab: http://127.0.0.1:${PORT}`);
    console.log("rebuild with `npm run lab`, then reload the page.");
  });
