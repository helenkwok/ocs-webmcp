// OCS WebMCP — record a demo video of an agent editing a real DWG, driven entirely through
// agent-browser (vercel-labs/agent-browser) as the WebMCP client. MIT licensed. See LICENSE.
//
// Every tool call goes through `agent-browser webmcp invoke`, the path any agent uses. Writes are
// invoked --detach, because they block on the confirm dialog. The script then clicks Approve or
// Decline, standing in for the human, ringing the button first so the click is visible. Captions
// are injected into the shell page for the video only.
//
// Usage: npm run build && node scripts/demo.mjs <file.dwg> [out.mp4]
// Needs: agent-browser (npm i -g agent-browser), ffmpeg on PATH.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/demo.mjs <file.dwg> [out.mp4]"); process.exit(2); }
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(process.argv[3] ?? resolve(ROOT, "e2e-out/demo", `${basename(file).replace(/\.\w+$/, "")}-agent-demo.mp4`));
mkdirSync(resolve(OUT, ".."), { recursive: true });
const PORT = 8793, URL = `http://127.0.0.1:${PORT}/`, SESSION = "ocs-demo";
const name = basename(file);
mkdirSync(resolve(ROOT, "dist/samples"), { recursive: true });
copyFileSync(file, resolve(ROOT, "dist/samples", name));

const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
const AB = process.env.AGENT_BROWSER ?? "agent-browser";
const ab = (...args) => execFileSync(AB, ["--session", SESSION, ...args], { env, encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (expr) => { const out = ab("eval", expr).split("\n").pop(); try { return JSON.parse(out); } catch { return out; } };

const server = spawn(process.execPath, [resolve(ROOT, "scripts/serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const done = () => { try { ab("close"); } catch {} server.kill(); };

// ── video-only caption bar ──────────────────────────────────────────────────────────────────
const CAPTION = `(() => { let c = document.getElementById('demo-caption'); if (!c) { c = document.createElement('div'); c.id = 'demo-caption';
  c.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-60%);z-index:9;max-width:62vw;padding:12px 20px;border-radius:10px;background:rgba(10,12,16,.88);color:#fff;font:600 21px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid #3a4150;text-align:center';
  document.body.append(c) } return c })()`;
const caption = (text, sub = "") => js(`(${CAPTION}.innerHTML = ${JSON.stringify(text)} + ${JSON.stringify(sub ? `<div style="font:400 15px/1.4 system-ui;color:#aeb6c2;margin-top:4px">${sub}</div>` : "")}, 1)`);

// ── tool helpers (agent side) ───────────────────────────────────────────────────────────────
const invoke = (tool, params) => ab("webmcp", "invoke", tool, ...(params ? ["--params", JSON.stringify(params)] : []));
const invokeDetached = (tool, params) => ab("webmcp", "invoke", tool, ...(params ? ["--params", JSON.stringify(params)] : []), "--detach").match(/^[A-F0-9]{16,}/m)[0];
const result = (id) => ab("webmcp", "result", id);
async function waitDialog() {
    for (let i = 0; i < 80; i++) { if (js(`document.querySelector('[data-ocs-confirm]').open`) === true) return; await sleep(150); }
    throw new Error("confirm dialog did not open");
}
async function human(id, approve, dwellMs) {
    await waitDialog();
    await sleep(dwellMs);                               // let the viewer read the request
    const sel = approve ? "[data-ocs-approve]" : "[data-ocs-decline]";
    // agent-browser 0.37.1 has no recording cursor, so show the human's click as a ring on the button.
    js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); b.style.outline = '4px solid ${approve ? "#4cc38a" : "#ef6b6b"}'; b.style.outlineOffset = '4px'; b.style.transform = 'scale(1.12)'; return 1 })()`);
    await sleep(900);
    ab("click", sel);
    js(`(() => { for (const b of document.querySelectorAll('[data-ocs-approve],[data-ocs-decline]')) { b.style.outline = ''; b.style.transform = '' } return 1 })()`);
    return result(id);
}

try {
    ab("set", "viewport", "1920", "1080");
    ab("open", URL);
    for (let i = 0; i < 90; i++) { if (String(js(`document.documentElement.dataset.ocsWebmcpReady ?? ''`)).includes("19")) break; await sleep(1000); }
    caption("An AI agent edits a real AutoCAD drawing in the browser", "WebMCP tools over Open CAD Studio · every change waits for a human");
    ab("record", "start", OUT);
    await sleep(3500);

    caption("The agent reads the editor state", "ocs_get_state");
    invoke("ocs_get_state");
    await sleep(2200);

    caption(`It asks to open ${name}`, "ocs_open_drawing · 2.6 MB · AutoCAD 2007 (AC1021)");
    let id = invokeDetached("ocs_open_drawing", { name, url: `/samples/${name}` });
    await waitDialog();
    caption("Nothing happens until the human approves", "the request is shown in full");
    await human(id, true, 2200);
    await sleep(1500);

    caption("It frames the drawing", "ocs_set_view · zoom_extents");
    invoke("ocs_set_view", { view: "zoom_extents" });
    await sleep(2500);

    caption("It surveys what it opened", "29,212 entities · 14 layers · 110 blocks");
    invoke("ocs_count_entities");
    invoke("ocs_query_records", { collection: "layers", paths: ["/name", "/color"], limit: 20 });
    await sleep(2800);

    caption("Edit 1: highlight the walls in magenta", "ocs_set_properties · layer Wall · colour 6 (magenta)");
    id = invokeDetached("ocs_set_properties", { collection: "layers", name: "Wall", updates: [{ path: "/color", value: { Index: 6 } }] });
    await human(id, true, 1800);
    caption("Approved: all 447 wall lines are now magenta");
    await sleep(3000);

    caption("Edit 2: the agent asks to erase everything", "ocs_run_command · ERASE ALL");
    id = invokeDetached("ocs_run_command", { cmd: "ERASE ALL" });
    await human(id, false, 2600);
    caption("Declined: the command never reached the drawing", "the agent is told REFUSED and must not retry");
    await sleep(3200);

    caption("Edit 3: mark up the kitchen for review", "ocs_run_command · RECTANG around the kitchen equipment");
    id = invokeDetached("ocs_run_command", { cmd: "RECTANG 38500,1500 59300,21800" });
    await human(id, true, 1500);
    await sleep(1200);
    caption("…and add a note", "ocs_add_text · 900 mm high");
    id = invokeDetached("ocs_add_text", { x: 38800, y: 22300, height: 900, text: "KITCHEN - CHECK CLEARANCES" });
    await human(id, true, 1500);
    await sleep(2500);

    caption("It checks its own work with a screenshot", "ocs_capture_view · returns an image to the agent");
    invoke("ocs_capture_view", { max_width: 1024 });
    await sleep(2800);

    caption("19 tools · MIT layer over unmodified Open CAD Studio (GPL-3)", "read freely · every edit approved · every call in the activity panel");
    await sleep(3500);
    ab("record", "stop");
    console.log(`✓ ${OUT}`);
} catch (err) {
    console.error(err?.stack ?? err);
    try { ab("record", "stop"); } catch {}
    process.exitCode = 1;
} finally {
    done();
}
