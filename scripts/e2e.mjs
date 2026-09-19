// OCS WebMCP — end-to-end test through REAL WebMCP (document.modelContext.getTools/executeTool)
// in headless Chrome with --enable-features=WebMCPTesting. MIT licensed. See LICENSE.
//
// It drives the confirm dialog like a human would (clicks Approve / Decline), and checks the
// drawing afterwards, not just the tool's own reply.
//
// Usage: npm run build && npm run test:e2e      (writes e2e-out/log.json and e2e-out/final.png)

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    check("getTools() lists 24 tools", tools.length === 24, tools.map((t) => t.name).join(", "));

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

    r = await call("ocs_add_text", { x: 0, y: -10, height: 5, text: "E2E NOTE WITH SPACES" }, true);
    const note = json((await call("ocs_query_records", { type: "Text", paths: ["/value"] })).raw)?.records?.map((x) => x.values["/value"]);
    const afterText = json((await call("ocs_get_state")).raw);
    check("ocs_add_text places a multi-word note and ends the command", json(r.raw)?.added === 1 && note?.includes("E2E NOTE WITH SPACES") && afterText?.active_command == null && afterText?.text_editor_open === false, `${JSON.stringify(note)} active_command=${JSON.stringify(afterText?.active_command)} text_editor_open=${afterText?.text_editor_open} reply=${payload(r.raw).replace(/\s+/g, " ").slice(0, 500)}`);
    await call("ocs_undo", {}, true);

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

    // A real zoom-to-fit test: a fresh drawing whose extents are known, the camera must move to
    // their centre, and the drawn pixels must cover much more of the view afterwards. (An earlier
    // version only checked that the screenshot changed, which the "Zoom Extents" log line alone
    // satisfies.)
    await call("ocs_new_drawing", {}, true);
    await call("ocs_run_command", { cmd: "PLINE 0,0 100,0 100,50 0,50 C" }, true);
    await call("ocs_run_command", { cmd: "CIRCLE 50,25 20" }, true);
    const beforeFit = imgOf((await call("ocs_capture_view", { format: "png", max_width: 1280 })).raw);
    r = await call("ocs_set_view", { view: "zoom_extents" });
    const fit = json(r.raw);
    const afterFit = imgOf((await call("ocs_capture_view", { format: "png", max_width: 1280 })).raw);
    const bright = (b64) => ev(`(async () => { const i = new Image(); i.src = 'data:image/png;base64,' + ${JSON.stringify(b64)}; await i.decode();
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
        // viewport only: right of the Properties panel, between the ribbon/tabs and the command line
        const x0 = Math.round(i.width * 0.21), x1 = Math.round(i.width * 0.88), y0 = Math.round(i.height * 0.20), y1 = Math.round(i.height * 0.86);
        const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data, W = x1 - x0; let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
        for (let k = 0, p = 0; k < d.length; k += 4, p++) { if (d[k] > 170 && d[k+1] > 170 && d[k+2] > 170) { const x = p % W, y = (p / W) | 0; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y } }
        return maxx < 0 ? { w: 0, h: 0 } : { w: +((maxx - minx) / W).toFixed(3), h: +((maxy - miny) / (y1 - y0)).toFixed(3) } })()`);
    const bb0 = beforeFit ? await bright(beforeFit.data) : null, bb1 = afterFit ? await bright(afterFit.data) : null;
    const centred = fit?.camera_after?.target?.[0] === 50 && fit?.camera_after?.target?.[1] === 25;
    check("zoom_extents moves the camera to the drawing's centre", fit?.moved === true && centred, JSON.stringify({ before: fit?.camera_before, after: fit?.camera_after }));
    check("zoom_extents makes the drawing fill the view", bb1?.w > 0.6 && bb1?.w > (bb0?.w ?? 0) + 0.2, `drawn-pixel extent (fraction of viewport) before=${JSON.stringify(bb0)} after=${JSON.stringify(bb1)}`);
    if (beforeFit) writeFileSync(resolve(OUT, "zoom-before.png"), Buffer.from(beforeFit.data, "base64"));
    if (afterFit) writeFileSync(resolve(OUT, "zoom-after.png"), Buffer.from(afterFit.data, "base64"));

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

    // ── step-by-step commands, measure, spatial query, layers, batch (fresh drawing) ──
    await call("ocs_new_drawing", {}, true);
    const countOf = async () => json((await call("ocs_count_entities")).raw)?.by_type ?? {};
    r = await call("ocs_batch", { steps: [
        { tool: "ocs_run_command", input: { cmd: "LINE 0,0 20,0 " } },
        { tool: "ocs_run_command", input: { cmd: "LINE 20,0 20,20 " } },
        { tool: "ocs_run_command", input: { cmd: "CIRCLE 50,25 10" } },
    ] }, true);
    let byType = await countOf();
    check("ocs_batch runs 3 edits under ONE approval, dialog lists every step", json(r.raw)?.ran === 3 && byType.Line === 2 && byType.Circle === 1 && /^1\. ocs_run_command/m.test(r.shown ?? "") && /^3\. ocs_run_command/m.test(r.shown ?? ""), `dialog=${JSON.stringify(r.shown)} count=${JSON.stringify(byType)}`);

    r = await call("ocs_batch", { steps: [{ tool: "ocs_run_command", input: { cmd: "CIRCLE 0,0 1" } }] }, false);
    check("declined ocs_batch runs nothing", /REFUSED/.test(payload(r.raw)) && (await countOf()).Circle === 1, payload(r.raw).slice(0, 80));

    const lines = json((await call("ocs_query_records", { type: "Line", paths: ["/start", "/end"] })).raw)?.records ?? [];
    const [hA, hB] = lines.map((x) => x.handle);
    r = await call("ocs_spatial_query", { near: [49, 36], limit: 1 });
    const nearest = json(r.raw)?.entities?.[0];
    check("ocs_spatial_query near finds the circle", nearest?.type === "Circle", payload(r.raw).slice(0, 160));
    r = await call("ocs_spatial_query", { intersections: [hA, hB] });
    const ip = json(r.raw)?.intersections?.[0]?.point;
    check("ocs_spatial_query intersections of the two lines = [20,0]", ip?.[0] === 20 && ip?.[1] === 0, payload(r.raw).slice(0, 160));
    r = await call("ocs_measure", { handles: [nearest?.handle] });
    const m = json(r.raw)?.measurements?.[0]?.curve;
    check("ocs_measure circle r=10: area πr², length 2πr", Math.abs(m?.area - Math.PI * 100) < 1e-6 && Math.abs(m?.length - 20 * Math.PI) < 1e-6, JSON.stringify(m));

    r = await call("ocs_command_steps", { cmd: "FILLET", steps: [{ kind: "selection" }] }, true);
    const stAfterBad = json((await call("ocs_get_state")).raw);
    check("ocs_command_steps refuses a step the prompt does not accept, and leaves nothing running", /accepts/.test(payload(r.raw)) && stAfterBad?.active_command == null && (await countOf()).Line === 2, payload(r.raw).slice(0, 200));

    r = await call("ocs_command_steps", { cmd: "FILLET", steps: [
        { kind: "token", text: "R" }, { kind: "token", text: "5" },
        { kind: "entity", handle: hA, point: [15, 0] }, { kind: "entity", handle: hB, point: [20, 15] },
    ] }, true);
    const fil = json(r.raw);
    byType = await countOf();
    check("ocs_command_steps FILLET R5 adds an arc, reports replaced handles, auto-cancels the restart", byType.Arc === 1 && byType.Line === 2 && fil?.changes?.added?.length >= 1 && fil?.changes?.removed?.length >= 1 && !!fil?.auto_cancelled_at && fil?.still_waiting == null, `count=${JSON.stringify(byType)} changes=${JSON.stringify(fil?.changes)} auto_cancelled_at=${JSON.stringify(fil?.auto_cancelled_at)} reply=${payload(r.raw).replace(/\s+/g, " ").slice(0, 700)}`);

    const vertical = (json((await call("ocs_spatial_query", { type: "Line", near: [20, 15], limit: 1 })).raw)?.entities ?? [])[0];
    const yBefore = json((await call("ocs_measure", { handles: [vertical?.handle] })).raw)?.measurements?.[0]?.bounds?.max?.[1];
    r = await call("ocs_command_steps", { cmd: "MOVE", select: [vertical?.handle], steps: [{ kind: "point", point: [0, 0] }, { kind: "point", point: [0, -10] }] }, true);
    const yAfter = json((await call("ocs_measure", { handles: [vertical?.handle] })).raw)?.measurements?.[0]?.bounds?.max?.[1];
    check("ocs_command_steps MOVE on a selection moves it by exactly 10", Math.abs(yBefore - yAfter - 10) < 1e-9, `top y ${yBefore} → ${yAfter} · ${payload(r.raw).slice(0, 160)}`);

    r = await call("ocs_set_layer", { name: "0", visible: false }, true);
    const hidden = json(r.raw);
    r = await call("ocs_set_layer", { name: "0", visible: false }, true);
    const again = json(r.raw);
    check("ocs_set_layer hides a layer; repeating changes nothing", hidden?.visible === false && JSON.stringify(hidden?.changed) === '["off"]' && again?.visible === false && again?.changed?.length === 0, `${JSON.stringify(hidden)} then ${JSON.stringify(again)}`);
    r = await call("ocs_set_layer", { name: "0", visible: true, current: true }, true);
    check("ocs_set_layer shows it again; current layer confirmed", json(r.raw)?.visible === true && json(r.raw)?.current === true, payload(r.raw).slice(0, 160));
    r = await call("ocs_set_layer", { name: "NoSuchLayer", visible: false }, true);
    check("ocs_set_layer on a missing layer is refused", /unknown_layer/.test(payload(r.raw)), payload(r.raw).slice(0, 120));

    // Geometric constraints arrived upstream after v2026.37; check them where the build has them.
    const hasConstraints = !isError((await call("ocs_list_commands", { name: "GCPERPENDICULAR" })).raw) && /GCPERPENDICULAR/.test(payload((await call("ocs_list_commands", { search: "GCPERP" })).raw));
    if (hasConstraints) {
        await call("ocs_batch", { steps: [
            { tool: "ocs_run_command", input: { cmd: "LINE 100,0 120,0 " } },
            { tool: "ocs_run_command", input: { cmd: "LINE 120,0 130,15 " } },
        ] }, true);
        const pair = (json((await call("ocs_spatial_query", { type: "Line", bounds: [99, -1, 131, 16] })).raw)?.entities ?? []).map((e) => e.handle);
        r = await call("ocs_command_steps", { cmd: "GCPERPENDICULAR", steps: [
            { kind: "entity", handle: pair[0], point: [110, 0] }, { kind: "entity", handle: pair[1], point: [125, 7.5] },
        ] }, true);
        const ends = (json((await call("ocs_query_records", { type: "Line", where: [{ path: "/start/x", op: "gte", value: 99 }], paths: ["/start", "/end"] })).raw)?.records ?? []).map((x) => [x.values["/start"], x.values["/end"]]);
        const dir = ([a, b]) => [b.x - a.x, b.y - a.y];
        const [d1, d2] = ends.map(dir);
        const dot = d1 && d2 ? Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) : NaN;
        check("ocs_command_steps GCPERPENDICULAR makes two lines perpendicular", ends.length === 2 && dot < 1e-6, `dot=${dot} ends=${JSON.stringify(ends)} · ${payload(r.raw).replace(/\s+/g, " ").slice(0, 200)}`);
    } else {
        console.log("- skipped: geometric constraints (not in this build)");
    }

    const circlesBefore = (await countOf()).Circle;
    r = await call("ocs_batch", { steps: [
        { tool: "ocs_run_command", input: { cmd: "CIRCLE 0,0 1" } },
        { tool: "ocs_set_layer", input: { name: "NoSuchLayer", visible: false } },
        { tool: "ocs_run_command", input: { cmd: "CIRCLE 0,0 2" } },
    ] }, true);
    const circlesAfter = (await countOf()).Circle;
    check("ocs_batch stops at the first failure and says what ran", /batch_stopped/.test(payload(r.raw)) && /Step 2/.test(payload(r.raw)) && circlesAfter === circlesBefore + 1, `circles ${circlesBefore}→${circlesAfter} · ${payload(r.raw).slice(0, 220)}`);

    // ── 3D: extrude, preset views, visual style ──
    await call("ocs_new_drawing", {}, true);
    await call("ocs_run_command", { cmd: "PLINE 0,0 40,0 40,20 0,20 C" }, true);
    const plh = (json((await call("ocs_spatial_query", { type: "LwPolyline" })).raw)?.entities ?? [])[0]?.handle
        ?? (json((await call("ocs_spatial_query", {})).raw)?.entities ?? [])[0]?.handle;
    r = await call("ocs_command_steps", { cmd: "EXTRUDE", select: [plh], steps: [{ kind: "token", text: "10" }] }, true);
    const solid = (json((await call("ocs_spatial_query", {})).raw)?.entities ?? []).find((e) => /solid/i.test(e.type));
    const mass = json((await call("ocs_measure", { handles: [solid?.handle ?? "0"] })).raw)?.measurements?.[0]?.mesh;
    check("EXTRUDE via ocs_command_steps makes a 40×20×10 solid", Math.abs(mass?.volume - 8000) < 1e-3 && Math.abs(mass?.centroid?.[2] - 5) < 1e-6, `volume=${mass?.volume} centroid=${JSON.stringify(mass?.centroid)} · ${payload(r.raw).replace(/\s+/g, " ").slice(0, 160)}`);
    for (const [view, pitch] of [["iso_se", 35.264], ["iso_nw", 35.264], ["front", 0], ["right", 0], ["back", 0], ["left", 0], ["top", 90]]) {
        r = await call("ocs_set_view", { view });
        const a = json(r.raw)?.camera_after;
        check(`ocs_set_view ${view} (pitch ${pitch}°)`, !isError(r.raw) && Math.abs(a?.pitch_deg - pitch) < 1, `pitch=${a?.pitch_deg} yaw=${a?.yaw_deg} · ${isError(r.raw) ? payload(r.raw).slice(0, 200) : ""}`);
    }
    const yaws = [];
    for (const view of ["iso_se", "iso_sw", "iso_ne", "iso_nw"]) yaws.push(json((await call("ocs_set_view", { view })).raw)?.camera_after?.yaw_deg);
    check("the four isometric views face four different ways", new Set(yaws.map((y) => Math.round(y))).size === 4, JSON.stringify(yaws));
    // A shaded solid covers far more of the viewport than its wireframe does.
    const drawnShare = (b64, mime) => ev(`(async () => { const i = new Image(); i.src = 'data:${mime};base64,' + ${JSON.stringify(b64)}; await i.decode();
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
        const x0 = Math.round(i.width * 0.3), y0 = Math.round(i.height * 0.25), w = Math.round(i.width * 0.5), h = Math.round(i.height * 0.6);
        const d = g.getImageData(x0, y0, w, h).data; let lit = 0;
        for (let k = 0; k < d.length; k += 4) if ((d[k] + d[k+1] + d[k+2]) / 3 > 60) lit++;
        return +(lit / (w * h)).toFixed(4) })()`);
    await call("ocs_set_view", { view: "iso_se", style: "wireframe_2d" });
    const wire = imgOf((await call("ocs_capture_view", { max_width: 1024 })).raw);
    r = await call("ocs_set_view", { view: "iso_se", style: "shaded_with_edges" });
    const shaded = imgOf((await call("ocs_capture_view", { max_width: 1024 })).raw);
    const shareWire = wire ? await drawnShare(wire.data, wire.mimeType) : null;
    const shareShaded = shaded ? await drawnShare(shaded.data, shaded.mimeType) : null;
    if (shaded) writeFileSync(resolve(OUT, "capture-3d-shaded.jpg"), Buffer.from(shaded.data, "base64"));
    check("style shaded_with_edges really shades the solid (drawn share ≫ wireframe)", !isError(r.raw) && shareShaded > 5 * shareWire && shareShaded > 0.05, `wireframe=${shareWire} shaded=${shareShaded} · ${payload(r.raw).slice(0, 120)}`);
    await call("ocs_set_view", { view: "top", style: "wireframe_2d" });

    // open from bytes
    const DXF = ["0","SECTION","2","ENTITIES","0","LINE","8","0","10","0","20","0","30","0","11","25","21","10","31","0",
        "0","CIRCLE","8","0","10","12","20","5","30","0","40","3","0","ENDSEC","0","EOF",""].join("\r\n");
    r = await call("ocs_open_drawing", { name: "e2e-probe.dxf", text: DXF }, true);
    check("ocs_open_drawing (DXF text) opens a tab with 2 entities", json(r.raw)?.entities === 2 && /e2e-probe/.test(JSON.stringify(json(r.raw)?.opened)), payload(r.raw).slice(0, 200));

    // open by URL (the path for real-sized drawings; tool arguments have size limits)
    writeFileSync(resolve(ROOT, "dist", "e2e-sample.dxf"), DXF);
    r = await call("ocs_open_drawing", { name: "e2e-url.dxf", url: "/e2e-sample.dxf" }, true);
    check("ocs_open_drawing by url", json(r.raw)?.entities === 2 && json(r.raw)?.bytes === DXF.length, payload(r.raw).slice(0, 160));

    // Builds with upstream #1351 must take the bytes directly; older ones fall back to OPFS.
    const source = JSON.parse(readFileSync(resolve(ROOT, "dist", "ocs-source.json"), "utf8"));
    const wantMethod = source.open_from_bytes ? "data_base64" : "opfs";
    check(`ocs_open_drawing uses ${wantMethod} on this build`, json(r.raw)?.open_method === wantMethod, `build ${source.commit?.slice(0, 10)} open_from_bytes=${source.open_from_bytes} used=${json(r.raw)?.open_method}`);

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
