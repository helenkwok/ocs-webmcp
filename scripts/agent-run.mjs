// OCS WebMCP — run ANY agent against the tools, with a stand-in human. MIT licensed. See LICENSE.
//
// Usage:
//   npm run build   # once
//   node scripts/agent-run.mjs <task.md> [--pdf file.pdf] [--start-blank] [--out dir] [--record] [--record-from first-write|start]
//                              [--decline <regex>] [--timeout <min>] -- <agent command...>
//
// The agent command is run with these environment variables:
//   OCS_PROMPT_FILE  the full prompt: how to reach the tools, then your task
//   OCS_SESSION      the agent-browser session that has Open CAD Studio open
//   OCS_PDF_SESSION  with --pdf: a second session showing that PDF in Chrome's viewer, so the agent
//                    needs nothing but agent-browser to read the drawing
// e.g.  -- sh -c 'claude -p "$(cat "$OCS_PROMPT_FILE")" --allowedTools "Bash(agent-browser:*)" Read'
//
// The agent reaches the tools only through agent-browser's WebMCP client (`webmcp list / invoke /
// result`), the path any shell-capable agent can use. Every write opens the confirm dialog; the
// stand-in human here approves it (or declines it, if it matches --decline) and logs exactly what
// was shown. Nothing else in the page is touched by the harness.
//
// --start-blank: before the agent starts, the stand-in human dismisses Open CAD Studio's donation
// prompt and opens a blank drawing, so the editor is not left on its start page.
//
// Writes to <out>: prompt.md, agent.log, approvals.json, final.png, and with --record run.mp4
// (with --pdf: the drawing and the editor side by side, idle compressed; the editor alone is
// run-editor.mp4).
// The recording runs from the moment the editor is ready (run-full.mp4). With --record-from
// first-write (the default), run.mp4 is cut to start 2 s before the first request the human
// answered (other than an empty ocs_new_drawing), so the video does not open on minutes of the
// agent reading. (Starting the recorder at
// that moment instead does not work: agent-browser runs one command per session at a time, so
// `record start` would wait behind the agent's pending `webmcp result` and delay the approval.)

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
if (dash < 1) {
    console.error("usage: node scripts/agent-run.mjs <task.md> [--pdf file.pdf] [--out dir] [--record] [--record-from first-write|start] [--decline <regex>] [--timeout <min>] -- <agent command...>");
    process.exit(2);
}
const opts = argv.slice(0, dash), agentCmd = argv.slice(dash + 1);
const flag = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
const taskFile = opts[0];
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(flag("--out") ?? resolve(ROOT, "e2e-out", `agent-run-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const RECORD = opts.includes("--record");
const RECORD_FROM = flag("--record-from") ?? "first-write";
const PDF = flag("--pdf") ? resolve(flag("--pdf")) : null;
const START_BLANK = opts.includes("--start-blank");
const DECLINE = flag("--decline") ? new RegExp(flag("--decline"), "i") : null;
const TIMEOUT_MS = Number(flag("--timeout") ?? 45) * 60_000;
const PORT = Number(process.env.PORT ?? 8795);
const SESSION = `ocs-agent-${process.pid}`;
const PDF_SESSION = `${SESSION}-pdf`;
const URL = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = (...args) => execFileSync("agent-browser", ["--session", SESSION, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const js = (expr) => { try { return JSON.parse(ab("eval", expr)); } catch { return null; } };
const abPdf = (...args) => execFileSync("agent-browser", ["--session", PDF_SESSION, ...args], { encoding: "utf8" }).trim();

/** Page size in points, from the first /MediaBox (enough for the guide's zoom arithmetic). */
function pdfPageSize(file) {
    const m = readFileSync(file).toString("latin1").match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
    return m ? { w: Math.round(m[3] - m[1]), h: Math.round(m[4] - m[2]) } : null;
}
const page = PDF ? pdfPageSize(PDF) : null;
const pdfGuide = PDF ? `
# The drawing

The drawing is open in Chrome's PDF viewer in a SECOND session, \`${PDF_SESSION}\` (keep the
editor's session for the tools). To look at it:
- Whole sheet: \`agent-browser --session ${PDF_SESSION} screenshot <file.png>\`, then read the PNG.
- Zoom into a region: reload it with PDF open parameters, in the same tab:
  \`agent-browser --session ${PDF_SESSION} open about:blank; agent-browser --session ${PDF_SESSION} open "file://${PDF}#zoom=400,LEFT,TOP"\`,
  then screenshot. LEFT and TOP are in PDF points from the page's bottom-left corner${page ? ` (this page is ${page.w} × ${page.h} pt)` : ""};
  the zoom only applies on a fresh load, hence about:blank first. Do not close this session.
` : "";

const guide = `# How to reach the CAD editor

Open CAD Studio (a DWG/DXF CAD editor) is open in a browser that you control through the
\`agent-browser\` CLI, session \`${SESSION}\`. The editor exposes its tools over WebMCP. Use ONLY
these agent-browser commands:

- List the tools and their input schemas:
  \`agent-browser --session ${SESSION} webmcp list\`
- Call a READ tool (no approval needed):
  \`agent-browser --session ${SESSION} webmcp invoke <tool> --params '<json>'\`
- Call a WRITE tool (it waits for a human to approve it, which can take longer than the CLI's 25 s
  limit), so detach and then collect the result:
  \`id=$(agent-browser --session ${SESSION} webmcp invoke <tool> --params '<json>' --detach)\`
  \`agent-browser --session ${SESSION} webmcp result "$id"\`   (run it again if it says timed_out)
- See the screen: \`agent-browser --session ${SESSION} screenshot <file.png>\`, then read the PNG.
  (ocs_capture_view also works, but through the CLI it prints the image as base64 text.)

Do not click, type or run JavaScript in the page yourself: work only through the tools. A write
the human declines comes back as REFUSED; do not retry it. Group related edits with ocs_batch
so the human approves a whole step at once instead of each call.

${pdfGuide}
# Your task

`;
writeFileSync(resolve(OUT, "prompt.md"), guide + readFileSync(taskFile, "utf8"));

const server = spawn(process.execPath, [resolve(ROOT, "scripts/serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const approvals = [];
let agent = null, stopApprover = false;
const cleanup = () => {
    try { ab("close"); } catch {}
    if (PDF) try { abPdf("close"); } catch {}
    server.kill();
};

try {
    await sleep(500);
    ab("set", "viewport", "1600", "1000");
    // Pin the session to this tab, so nothing the page opens can pull the agent's session away.
    ab("--pin-tab", "open", URL);
    let ready = "";
    for (let i = 0; i < 120 && !ready; i++) { ready = js(`document.documentElement.dataset.ocsWebmcpReady ?? ''`) ?? ""; if (!ready) await sleep(1000); }
    if (!ready) throw new Error("the WebMCP shell did not become ready");
    console.log(`ready: ${ready} tools · session ${SESSION} · out ${OUT}`);
    if (START_BLANK) {
        // The human's own setup, not the agent's: dismiss Open CAD Studio's donation prompt and open
        // a blank drawing, so the editor does not sit on its start page while the agent reads.
        const r = js(`(async () => { const b = document.getElementById('ocs').contentWindow.wasmBindings;
            const call = async (req) => { const t = b.ocs_control_submit(JSON.stringify({ protocol: 1, client_id: 'harness', request_id: 'h' + Math.random(), ...req }));
                for (let i = 0; i < 200; i++) { const o = b.ocs_control_take(t); if (o) return JSON.parse(o); await new Promise((r) => setTimeout(r, 50)); } };
            let st = await call({ op: 'state' });
            if (st.modal === 'DonationPrompt') await call({ op: 'action', name: 'close_modal', document_id: st.document_id });
            await call({ op: 'new' });
            for (let i = 0; i < 40; i++) { st = await call({ op: 'state' }); if (st.documents?.some((d) => !d.start)) break; await new Promise((r) => setTimeout(r, 150)); }
            return st.documents?.some((d) => !d.start) ?? false })()`);
        console.log(`start-blank: ${r ? "blank drawing open" : "FAILED to open a blank drawing"}`);
    }
    if (PDF) {
        abPdf("set", "viewport", "1600", "1000");
        abPdf("--pin-tab", "open", "about:blank");
        if (!RECORD) abPdf("open", `file://${PDF}`);
        console.log(`pdf: ${PDF} in session ${PDF_SESSION}`);
    }
    let recordingSince = null, pdfRecordingSince = null;
    if (RECORD) {
        ab("record", "start", resolve(OUT, "run-full.mp4"));
        recordingSince = Date.now();
        if (PDF) {
            // Start recording WITH the navigation to the PDF, so there is at least one frame even
            // if the agent never changes the view (a static page yields no screencast frames).
            abPdf("record", "start", resolve(OUT, "pdf-full.mp4"), `file://${PDF}`);
            pdfRecordingSince = Date.now();
        }
    }

    // The stand-in human: answer each confirm dialog, and log exactly what it showed. It talks to
    // the page over its OWN DevTools connection. agent-browser runs one command per session at a
    // time, so through the agent's session it would wait behind the agent's pending
    // `webmcp result` (up to 25 s) before it could even see the dialog.
    const browserWs = ab("get", "cdp-url");
    const targets = await (await fetch(browserWs.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json"))).json();
    const target = targets.find((t) => t.type === "page" && t.url.startsWith(URL));
    if (!target) throw new Error("could not find the editor page over DevTools");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let n = 0;
    const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
    const evaluate = (expression) => new Promise((r) => {
        const id = ++n;
        pending.set(id, (d) => r(d.result?.result?.value));
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    const approver = (async () => {
        while (!stopApprover) {
            const shown = await evaluate(`document.querySelector('[data-ocs-confirm]')?.open === true ? (document.querySelector('[data-ocs-confirm] pre')?.textContent ?? '') : null`);
            if (shown != null) {
                const approve = !(DECLINE && DECLINE.test(shown));
                await sleep(700); // a human reads before deciding
                await evaluate(`document.querySelector(${JSON.stringify(approve ? "[data-ocs-approve]" : "[data-ocs-decline]")})?.click()`);
                approvals.push({ at: new Date().toISOString(), approved: approve, shown });
                console.log(`${approve ? "APPROVED" : "DECLINED"}: ${shown.replace(/\s+/g, " ").slice(0, 160)}`);
                await sleep(400);
            }
            await sleep(250);
        }
        ws.close();
    })();

    const log = createWriteStream(resolve(OUT, "agent.log"));
    const t0 = Date.now();
    agent = spawn(agentCmd[0], agentCmd.slice(1), {
        env: { ...process.env, OCS_PROMPT_FILE: resolve(OUT, "prompt.md"), OCS_SESSION: SESSION, ...(PDF ? { OCS_PDF_SESSION: PDF_SESSION } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
    });
    agent.stdout.pipe(log, { end: false });
    agent.stderr.pipe(log, { end: false });
    const exit = await Promise.race([
        new Promise((r) => agent.on("exit", (code) => r(code))),
        sleep(TIMEOUT_MS).then(() => { agent.kill(); return "timeout"; }),
    ]);
    console.log(`agent exited: ${exit} after ${Math.round((Date.now() - t0) / 1000)} s`);
    stopApprover = true;
    await approver;
    log.end();
    ab("screenshot", resolve(OUT, "final.png"));
    if (recordingSince) {
        ab("record", "stop");
        if (pdfRecordingSince) {
            try { abPdf("record", "stop"); } catch (e) { console.log(`pdf recording failed (${String(e.message).split("\n")[0]}); editor-only video`); pdfRecordingSince = null; }
        }
        const full = resolve(OUT, "run-full.mp4"), cut = resolve(OUT, PDF ? "run-editor.mp4" : "run.mp4");
        // An empty new drawing shows nothing; agents often create one and then read for minutes.
        const firstVisible = approvals.find((a) => !/^ocs_new_drawing\b/.test(a.shown.trim())) ?? approvals[0];
        const first = firstVisible ? Date.parse(firstVisible.at) : null;
        const from = RECORD_FROM === "first-write" && first ? Math.max(0, (first - recordingSince) / 1000 - 2) : 0;
        execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(from), "-i", full, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", cut]);
        console.log(`video: ${cut} (from ${from.toFixed(1)} s of the full recording)`);
        if (pdfRecordingSince) {
            // Side by side, drawing (as the agent sees it) on the left, editor on the right, from
            // the start. Unchanged frames are dropped (at most 15 in a row, so waiting runs up to
            // 16x and activity at normal speed), which keeps the reading without the minutes of idle.
            const both = resolve(OUT, "run.mp4");
            const lag = (pdfRecordingSince - recordingSince) / 1000; // the PDF recording started later
            execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, lag)), "-i", full, "-i", resolve(OUT, "pdf-full.mp4"),
                "-filter_complex",
                "[1:v]scale=-2:720[l];[0:v]scale=-2:720[r];" +
                `[l][r]hstack=inputs=2,mpdecimate=max=15,setpts=N/30/TB,fps=30[v]`,
                "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "22", both]);
            console.log(`video: ${both} (drawing and editor side by side, idle compressed)`);
        }
    }
    writeFileSync(resolve(OUT, "approvals.json"), JSON.stringify(approvals, null, 1));
    console.log(`${approvals.length} approval(s) · ${OUT}`);
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    stopApprover = true;
    agent?.kill();
    cleanup();
}
