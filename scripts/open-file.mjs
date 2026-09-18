// OCS WebMCP — open a real DWG/DXF through the WebMCP tools, exactly as an agent would, and report
// what it sees. MIT licensed. See LICENSE.
//
// Usage: npm run build && node scripts/open-file.mjs <file.dwg|file.dxf> [--keep]
// Writes e2e-out/open-<name>/: report.json, view.png (zoomed to extents), and the open log.
// The approve click on the confirm dialog stands in for the human.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const file = process.argv[2];
if (!file || !/\.(dwg|dxf)$/i.test(file)) { console.error("usage: node scripts/open-file.mjs <file.dwg|file.dxf>"); process.exit(2); }
const ROOT = resolve(import.meta.dirname, "..");
const name = basename(file);
const OUT = resolve(ROOT, "e2e-out", `open-${name.replace(/[^\w.-]/g, "_")}`);
mkdirSync(OUT, { recursive: true });
const PORT = 8791, CDP = 9338;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bytes = readFileSync(file);
const server = spawn(process.execPath, [resolve(ROOT, "scripts/serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "ocs-webmcp-open-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run",
    "--disable-extensions", "--enable-features=WebMCPTesting", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
const cleanup = () => { chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };

const report = { file: name, bytes: bytes.length, header: bytes.subarray(0, 6).toString("latin1"), steps: [] };
try {
    let targets;
    for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); } catch { await sleep(200); } }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    let n = 0; const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => {
        const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluate failed");
        return r.result?.result?.value;
    };
    await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    for (let i = 0; i < 180; i++) { await sleep(1000); if (await ev(`document.documentElement.dataset.ocsWebmcpReady ?? null`)) break; }

    // The file travels exactly as an agent would send it: base64 in the tool arguments.
    await ev(`window.__b64 = ${JSON.stringify(bytes.toString("base64"))}`);
    const tool = async (toolName, input = {}, approve = false, timeoutMs = 180_000) => {
        await ev(`(() => { window.__r = null; (async () => { const t = (await document.modelContext.getTools()).find(t => t.name === ${JSON.stringify(toolName)});
            const args = ${JSON.stringify(input)}; if (args.base64 === "__FILE__") args.base64 = window.__b64;
            return await document.modelContext.executeTool(t, JSON.stringify(args)) })().then(v => window.__r = (typeof v === 'string' ? v : JSON.stringify(v)), e => window.__r = 'THREW ' + e) })()`);
        if (approve) {
            for (let i = 0; i < 100 && !(await ev(`document.querySelector('[data-ocs-confirm]').open`)); i++) await sleep(100);
            await ev(`document.querySelector('[data-ocs-approve]').click()`);
        }
        const t0 = Date.now();
        let raw = null;
        while (!raw && Date.now() - t0 < timeoutMs) { await sleep(200); raw = await ev(`window.__r`); }
        const ms = Date.now() - t0;
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        const content = parsed?.content ?? [];
        const text = content.find((c) => c.type === "text")?.text ?? raw;
        const image = content.find((c) => c.type === "image") ?? null;
        let json = null;
        try { json = JSON.parse(text); } catch {}
        report.steps.push({ tool: toolName, ms, isError: parsed?.isError ?? true, result: json ?? String(text).slice(0, 2000) });
        console.log(`${parsed?.isError === false ? "✓" : "✗"} ${toolName} (${ms} ms) ${String(text).replace(/\s+/g, " ").slice(0, 220)}`);
        return { json, text, image, isError: parsed?.isError };
    };

    const opened = await tool("ocs_open_drawing", { name, base64: "__FILE__" }, true);
    const counts = await tool("ocs_count_entities");
    await tool("ocs_query_records", { collection: "layers", paths: ["/name", "/color", "/is_off", "/frozen"], limit: 100 });
    await tool("ocs_query_records", { collection: "block_records", paths: ["/name"], limit: 100 });
    const fit = await tool("ocs_set_view", { view: "zoom_extents" });
    const view = await tool("ocs_capture_view", { format: "png", max_width: 1600 });
    if (view.image) writeFileSync(resolve(OUT, "view.png"), Buffer.from(view.image.data, "base64"));
    const hist = await tool("ocs_get_history", { last: 20 });
    report.summary = {
        opened: !opened.isError,
        entities: counts.json?.total ?? null,
        by_type: counts.json?.by_type ?? null,
        camera_after_fit: fit.json?.camera_after ?? null,
        load_log: (hist.json?.entries ?? []).map((e) => e.text).filter((t) => /open|parse|recover|error|warn|entities/i.test(t)),
    };
    ws.close();
} catch (err) {
    report.error = String(err?.stack ?? err);
    console.error(report.error);
} finally {
    writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 1));
    cleanup();
    console.log(`\n→ ${resolve(OUT)}`);
}
