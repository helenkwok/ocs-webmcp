// OCS WebMCP — end-to-end test through REAL WebMCP (document.modelContext.getTools/executeTool)
// in headless Chrome with --enable-features=WebMCPTesting. MIT licensed. See LICENSE.
//
// It drives the confirm dialog like a human would (clicks Approve / Decline), and checks the
// drawing afterwards, not just the tool's own reply.
//
// Usage: npm run build && npm run test:e2e      (writes e2e-out/log.json and e2e-out/final.png)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "e2e-out");
const PORT = 8787, CDP = 9335;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [resolve(ROOT, "scripts/serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "ocs-webmcp-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run",
    "--disable-extensions", "--enable-features=WebMCPTesting", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
const cleanup = () => { chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {} };

const results = [];
let failed = 0;
const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
};

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
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
        return r.result?.result?.value;
    };

    await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    let ready = null;
    for (let i = 0; i < 180 && !ready; i++) { await sleep(1000); ready = await ev(`document.documentElement.dataset.ocsWebmcpReady ?? null`); }
    const status = await ev(`document.querySelector('[data-ocs-status]').textContent`);
    check("shell registered tools on document.modelContext", !!ready, status);
    if (!ready) throw new Error("not ready");

    const tools = JSON.parse(await ev(`(async () => JSON.stringify((await document.modelContext.getTools()).map(t => ({ name: t.name, annotations: t.annotations }))))()`));
    check("getTools() lists 18 tools", tools.length === 18, tools.map((t) => t.name).join(", "));

    // Start a tool call WITHOUT awaiting it, so a confirm dialog can be answered meanwhile.
    const start = (name, input = {}) => ev(`(() => {
        window.__calls ??= {}; const key = ${JSON.stringify(name)} + ':' + Math.random();
        window.__calls[key] = (async () => { const t = (await document.modelContext.getTools()).find(t => t.name === ${JSON.stringify(name)});
            return await document.modelContext.executeTool(t, ${JSON.stringify(JSON.stringify(input))}); })()
            .then(v => (typeof v === 'string' ? v : JSON.stringify(v)), e => 'THREW ' + (e?.message ?? e));
        return key })()`);
    const finish = (key) => ev(`window.__calls[${JSON.stringify(key)}]`);
    const answer = async (approve) => {
        for (let i = 0; i < 100; i++) { if (await ev(`document.querySelector('[data-ocs-confirm]').open`)) break; await sleep(100); }
        const shown = await ev(`document.querySelector('[data-ocs-confirm]').open ? document.querySelector('[data-ocs-confirm] pre').textContent : null`);
        await ev(`document.querySelector(${JSON.stringify(approve ? "[data-ocs-approve]" : "[data-ocs-decline]")}).click()`);
        return shown;
    };
    const call = async (name, input, approve) => {
        const key = await start(name, input);
        const shown = approve === undefined ? null : await answer(approve);
        const raw = await finish(key);
        return { raw, shown };
    };
    const payload = (raw) => { try { const o = JSON.parse(raw); return o.content?.[0]?.text ?? raw; } catch { return raw; } };
    const json = (raw) => { try { return JSON.parse(payload(raw)); } catch { return null; } };
    const isError = (raw) => { try { return JSON.parse(raw).isError === true; } catch { return /^(REFUSED|ERROR)/.test(payload(raw)); } };

    // ── read ──
    let r = await call("ocs_get_state");
    const st0 = json(r.raw);
    check("ocs_get_state (read, no confirm)", !!st0?.documents, `documents=${JSON.stringify(st0?.documents?.map((d) => d.title))} version=${st0?.version}`);
    r = await call("ocs_get_capabilities");
    check("ocs_get_capabilities", json(r.raw)?.api === "ocs-cad-automation", `collections=${json(r.raw)?.collections?.length}`);
    r = await call("ocs_list_commands", { name: "CIRCLE" });
    check("ocs_list_commands name=CIRCLE", !isError(r.raw) && /CIRCLE/i.test(payload(r.raw)), payload(r.raw).slice(0, 120));
    r = await call("ocs_list_commands", { search: "arc" });
    const arcCmds = json(r.raw)?.commands ?? [];
    check("ocs_list_commands search=arc filters", arcCmds.length > 0 && arcCmds.every((c) => /arc/i.test(c)), `${arcCmds.length}: ${arcCmds.slice(0, 6).join(",")}`);

    // ── write, DECLINED: the handler must never run ──
    const docsBefore = st0.documents.length;
    r = await call("ocs_new_drawing", {}, false);
    const docsAfterDecline = json((await call("ocs_get_state")).raw).documents.length;
    check("declined write is REFUSED and nothing changes", /REFUSED/.test(payload(r.raw)) && docsAfterDecline === docsBefore, `dialog showed: ${JSON.stringify(r.shown)} · docs ${docsBefore}→${docsAfterDecline}`);

    // ── write, APPROVED ──
    r = await call("ocs_new_drawing", {}, true);
    check("approved ocs_new_drawing creates a drawing", !isError(r.raw) && json(r.raw)?.created?.start === false, payload(r.raw).slice(0, 160));

    r = await call("ocs_run_command", { cmd: "LINE 0,0 100,0 100,50" }, true);
    const lineRun = json(r.raw);
    check("ocs_run_command LINE adds 2 segments", lineRun?.added === 2, payload(r.raw).slice(0, 200));
    if (lineRun?.still_waiting_for_input) {
        r = await call("ocs_cancel_command", {}, true);
        check("ocs_cancel_command ends the waiting LINE", json(r.raw)?.active_command == null, payload(r.raw).slice(0, 120));
    }
    r = await call("ocs_run_command", { cmd: "CIRCLE 50,25 10" }, true);
    check("ocs_run_command CIRCLE adds 1", json(r.raw)?.added === 1, payload(r.raw).slice(0, 160));

    r = await call("ocs_count_entities");
    check("ocs_count_entities = 2 Line + 1 Circle", json(r.raw)?.by_type?.Line === 2 && json(r.raw)?.by_type?.Circle === 1, payload(r.raw));

    r = await call("ocs_query_records", { type: "Circle", paths: ["/center", "/radius"] });
    const circ = json(r.raw)?.records?.[0];
    check("ocs_query_records type=Circle with paths", circ?.values?.["/radius"] === 10, JSON.stringify(circ?.values));

    // conditional edit: radius 10 -> 15 only if it is still 10
    r = await call("ocs_set_properties", { handle: circ?.handle, updates: [{ path: "/radius", expected: 10, value: 15 }] }, true);
    const radiusNow = json((await call("ocs_query_records", { handle: circ?.handle, paths: ["/radius"] })).raw)?.records?.[0]?.values?.["/radius"];
    check("ocs_set_properties radius 10→15 (expected-guarded)", radiusNow === 15, `reply=${payload(r.raw).slice(0, 100)} · now=${radiusNow}`);

    r = await call("ocs_set_properties", { handle: circ?.handle, updates: [{ path: "/radius", expected: 99, value: 1 }] }, true);
    const radiusGuard = json((await call("ocs_query_records", { handle: circ?.handle, paths: ["/radius"] })).raw)?.records?.[0]?.values?.["/radius"];
    check("wrong `expected` is refused and nothing changes", /expected_mismatch/.test(payload(r.raw)) && radiusGuard === 15, `${payload(r.raw).slice(0, 110)} · now=${radiusGuard}`);

    const rev = json((await call("ocs_get_state")).raw)?.revision;
    r = await call("ocs_run_command", { cmd: "LINE 0,0 5,5", revision: rev - 1 }, true);
    check("agent-supplied stale revision is refused", /stale_state/.test(payload(r.raw)), payload(r.raw).slice(0, 120));

    r = await call("ocs_undo", {}, true);
    const radiusUndo = json((await call("ocs_query_records", { handle: circ?.handle, paths: ["/radius"] })).raw)?.records?.[0]?.values?.["/radius"];
    check("ocs_undo restores radius 10", radiusUndo === 10, `now=${radiusUndo} · ${payload(r.raw).slice(0, 100)}`);

    // stale revision must be refused by Open CAD Studio itself (optimistic concurrency)
    const stale = await ev(`(async () => { const f = document.getElementById('ocs').contentWindow.wasmBindings;
        const id = f.ocs_control_submit(JSON.stringify({ op: 'state' })); let s; for (let i=0;i<50;i++){ await new Promise(r=>setTimeout(r,50)); s = f.ocs_control_take(id); if (s) break }
        s = JSON.parse(s); const id2 = f.ocs_control_submit(JSON.stringify({ op: 'run', request_id: 'stale', document_id: s.document_id, revision: s.revision - 1, cmd: 'LINE 0,0 1,1' }));
        for (let i=0;i<50;i++){ await new Promise(r=>setTimeout(r,50)); const o = f.ocs_control_take(id2); if (o) return o } })()`);
    check("stale revision is rejected upstream (stale_state)", /stale_state/.test(stale ?? ""), (stale ?? "").slice(0, 100));

    // ── screenshot + recording ──
    const imgOf = (raw) => { try { return JSON.parse(raw).content?.find((c) => c.type === "image") ?? null; } catch { return null; } };
    const captionOf = (raw) => { try { return JSON.parse(JSON.parse(raw).content?.find((c) => c.type === "text")?.text ?? "null"); } catch { return null; } };
    const pixelStats = (b64, mime) => ev(`(async () => { const i = new Image(); i.src = 'data:${mime};base64,' + ${JSON.stringify(b64)}; await i.decode();
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0, s2 = 0, n = d.length / 4;
        for (let k = 0; k < d.length; k += 4) { const v = (d[k] + d[k+1] + d[k+2]) / 3; s += v; s2 += v * v }
        const m = s / n; return { w: i.width, h: i.height, mean: +m.toFixed(1), std: +Math.sqrt(s2 / n - m * m).toFixed(1) } })()`);

    r = await call("ocs_capture_view", { max_width: 1024 });
    let img = imgOf(r.raw);
    let px = img ? await pixelStats(img.data, img.mimeType) : null;
    check("ocs_capture_view returns a real (non-black) image", !!img && px.std > 5, JSON.stringify(px));
    if (img) writeFileSync(resolve(OUT, "capture.jpg"), Buffer.from(img.data, "base64"));

    r = await call("ocs_capture_view", { if_changed: true });
    check("if_changed with no change returns no image", !imgOf(r.raw) && json(r.raw)?.unchanged === true, payload(r.raw).slice(0, 120));

    await call("ocs_run_command", { cmd: "CIRCLE 50,25 30" }, true);
    r = await call("ocs_capture_view", { if_changed: true });
    check("if_changed after a change returns an image", !!imgOf(r.raw), JSON.stringify(captionOf(r.raw)));

    const beforeFit = imgOf((await call("ocs_capture_view", {})).raw);
    r = await call("ocs_set_view", { view: "zoom_extents" });
    const afterFit = imgOf((await call("ocs_capture_view", { if_changed: true })).raw);
    check("ocs_set_view zoom_extents changes the framing (no confirm)", !isError(r.raw) && !!beforeFit && !!afterFit, payload(r.raw).slice(0, 60));
    if (afterFit) writeFileSync(resolve(OUT, "capture-zoom-extents.jpg"), Buffer.from(afterFit.data, "base64"));

    r = await call("ocs_start_recording", {}, false);
    const recHiddenAfterDecline = await ev(`document.querySelector('[data-ocs-rec]').hidden`);
    check("declined recording never starts", /REFUSED/.test(payload(r.raw)) && recHiddenAfterDecline, payload(r.raw).slice(0, 80));

    r = await call("ocs_start_recording", { threshold: 0.02 }, true);
    const recVisible = await ev(`!document.querySelector('[data-ocs-rec]').hidden`);
    check("approved recording starts and shows REC", json(r.raw)?.recording === true && recVisible, payload(r.raw).slice(0, 120));
    await sleep(800);
    await call("ocs_run_command", { cmd: "LINE -40,-40 140,90" }, true);
    await sleep(800);
    await call("ocs_run_command", { cmd: "CIRCLE 120,60 15" }, true);
    await sleep(800);
    r = await call("ocs_stop_recording");
    const sheet = imgOf(r.raw), recSum = captionOf(r.raw);
    const sheetPx = sheet ? await pixelStats(sheet.data, sheet.mimeType) : null;
    const recHidden = await ev(`document.querySelector('[data-ocs-rec]').hidden`);
    const dl = await ev(`document.querySelector('[data-ocs-download]')?.textContent ?? null`);
    check("stop returns a contact sheet of changed frames", !!sheet && recSum?.contact_sheet_frames >= 2 && sheetPx.std > 5 && recSum?.stopped_by === "ocs_stop_recording", `${JSON.stringify(recSum)} sheet=${JSON.stringify(sheetPx)}`);
    check("video offered to the human, REC cleared", recSum?.video_bytes > 10000 && !!dl && recHidden, dl ?? "no link");
    if (sheet) writeFileSync(resolve(OUT, "contact-sheet.jpg"), Buffer.from(sheet.data, "base64"));
    const video = await ev(`(async () => { const a = document.querySelector('[data-ocs-download]'); const b = await (await fetch(a.href)).blob();
        const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) })()`);
    writeFileSync(resolve(OUT, /mp4/.test(dl ?? "") ? "recording-1.mp4" : "recording-1.webm"), Buffer.from(video, "base64"));

    r = await call("ocs_start_recording", { format: "mp4", max_seconds: 2 }, true);
    check("mp4 recording starts", json(r.raw)?.mime?.startsWith("video/mp4"), payload(r.raw).slice(0, 100));
    await call("ocs_run_command", { cmd: "LINE 0,-30 60,30" }, true);
    await sleep(2600);   // let max_seconds end it by itself
    r = await call("ocs_stop_recording");
    const mp4Sum = captionOf(r.raw) ?? json(r.raw);
    check("auto-stop at max_seconds finishes the recording", mp4Sum?.stopped_by?.startsWith("auto-stop") && /\.mp4$/.test(mp4Sum?.video ?? ""), JSON.stringify(mp4Sum));
    const mp4 = await ev(`(async () => { const a = document.querySelector('[data-ocs-download]'); const b = await (await fetch(a.href)).blob();
        const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s) })()`);
    writeFileSync(resolve(OUT, "recording.mp4"), Buffer.from(mp4, "base64"));

    // open from bytes
    const DXF = ["0","SECTION","2","ENTITIES","0","LINE","8","0","10","0","20","0","30","0","11","25","21","10","31","0",
        "0","CIRCLE","8","0","10","12","20","5","30","0","40","3","0","ENDSEC","0","EOF",""].join("\r\n");
    r = await call("ocs_open_drawing", { name: "e2e-probe.dxf", text: DXF }, true);
    check("ocs_open_drawing (DXF text) opens a tab with 2 entities", json(r.raw)?.entities === 2 && /e2e-probe/.test(JSON.stringify(json(r.raw)?.opened)), payload(r.raw).slice(0, 200));

    r = await call("ocs_get_history", { last: 5 });
    check("ocs_get_history", Array.isArray(json(r.raw)?.entries), payload(r.raw).slice(0, 140));

    const activity = await ev(`[...document.querySelectorAll('[data-ocs-activity] li')].map(li => li.textContent).slice(0, 8)`);
    check("activity panel records calls", activity.length > 0, activity[0]);

    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(resolve(OUT, "final.png"), Buffer.from(shot.result.data, "base64"));
    ws.close();
} catch (err) {
    check("e2e run completed", false, String(err?.stack ?? err));
} finally {
    writeFileSync(resolve(OUT, "log.json"), JSON.stringify({ when: new Date().toISOString(), failed, results }, null, 1));
    cleanup();
    console.log(`\n${failed ? `FAIL: ${failed} check(s)` : "PASS"} (${results.length} checks) → e2e-out/`);
    process.exit(failed ? 1 : 0);
}
