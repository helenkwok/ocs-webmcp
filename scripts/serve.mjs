// OCS WebMCP — static server for dist/ with the headers Open CAD Studio's web build expects.
// MIT licensed. See LICENSE.
//
// Upstream's Trunk.toml serves with Cross-Origin-Opener-Policy: same-origin and
// Cross-Origin-Embedder-Policy: require-corp (cross-origin isolation). We send both on EVERY
// response, the shell included, so the same-origin iframe keeps that isolation.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../dist");
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2", ".shx": "application/octet-stream",
    ".md": "text/markdown; charset=utf-8", ".mp4": "video/mp4",
};

if (!existsSync(ROOT)) {
    console.error("dist/ does not exist. Run `npm run build` first.");
    process.exit(1);
}

createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, {
        "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-cache",
    });
    createReadStream(path).pipe(res);
}).listen(PORT, HOST, () => console.log(`OCS WebMCP on http://${HOST}:${PORT}/`));
