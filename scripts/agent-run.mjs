// OCS WebMCP — run ANY agent against the tools, with a stand-in human. MIT licensed. See LICENSE.
//
// Usage:
//   npm run build   # once
//   node scripts/agent-run.mjs <task.md> [--out dir] [--record] [--decline <regex>] [--timeout <min>] -- <agent command...>
//
// The agent command is run with these environment variables:
//   OCS_PROMPT_FILE  the full prompt: how to reach the tools, then your task
//   OCS_SESSION      the agent-browser session that has Open CAD Studio open
// e.g.  -- sh -c 'claude -p "$(cat "$OCS_PROMPT_FILE")" --allowedTools "Bash(agent-browser:*)" Read'
//
// The agent reaches the tools only through agent-browser's WebMCP client (`webmcp list / invoke /
// result`), the path any shell-capable agent can use. Every write opens the confirm dialog; the
// stand-in human here approves it (or declines it, if it matches --decline) and logs exactly what
// was shown. Nothing else in the page is touched by the harness.
//
// Writes to <out>: prompt.md, agent.log, approvals.json, final.png, and run.mp4 with --record.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
if (dash < 1) {
    console.error("usage: node scripts/agent-run.mjs <task.md> [--out dir] [--record] [--decline <regex>] [--timeout <min>] -- <agent command...>");
    process.exit(2);
}
const opts = argv.slice(0, dash), agentCmd = argv.slice(dash + 1);
const flag = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
const taskFile = opts[0];
const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(flag("--out") ?? resolve(ROOT, "e2e-out", `agent-run-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const RECORD = opts.includes("--record");
const DECLINE = flag("--decline") ? new RegExp(flag("--decline"), "i") : null;
const TIMEOUT_MS = Number(flag("--timeout") ?? 45) * 60_000;
const PORT = Number(process.env.PORT ?? 8795);
const SESSION = `ocs-agent-${process.pid}`;
const URL = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab = (...args) => execFileSync("agent-browser", ["--session", SESSION, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const js = (expr) => { try { return JSON.parse(ab("eval", expr)); } catch { return null; } };

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

# Your task

`;
writeFileSync(resolve(OUT, "prompt.md"), guide + readFileSync(taskFile, "utf8"));

const server = spawn(process.execPath, [resolve(ROOT, "scripts/serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
const approvals = [];
let agent = null, stopApprover = false;
const cleanup = () => { try { ab("close"); } catch {} server.kill(); };

try {
    await sleep(500);
    ab("set", "viewport", "1600", "1000");
    ab("open", URL);
    let ready = "";
    for (let i = 0; i < 120 && !ready; i++) { ready = js(`document.documentElement.dataset.ocsWebmcpReady ?? ''`) ?? ""; if (!ready) await sleep(1000); }
    if (!ready) throw new Error("the WebMCP shell did not become ready");
    console.log(`ready: ${ready} tools · session ${SESSION} · out ${OUT}`);
    if (RECORD) ab("record", "start", resolve(OUT, "run.mp4"));

    // The stand-in human: answer each confirm dialog, and log exactly what it showed.
    const approver = (async () => {
        while (!stopApprover) {
            if (js(`document.querySelector('[data-ocs-confirm]')?.open === true`)) {
                const shown = js(`document.querySelector('[data-ocs-confirm] pre')?.textContent ?? ''`) ?? "";
                const approve = !(DECLINE && DECLINE.test(shown));
                await sleep(700); // a human reads before deciding
                try { ab("click", approve ? "[data-ocs-approve]" : "[data-ocs-decline]"); } catch {}
                approvals.push({ at: new Date().toISOString(), approved: approve, shown });
                console.log(`${approve ? "APPROVED" : "DECLINED"}: ${shown.replace(/\s+/g, " ").slice(0, 160)}`);
                await sleep(400);
            }
            await sleep(300);
        }
    })();

    const log = createWriteStream(resolve(OUT, "agent.log"));
    const t0 = Date.now();
    agent = spawn(agentCmd[0], agentCmd.slice(1), {
        env: { ...process.env, OCS_PROMPT_FILE: resolve(OUT, "prompt.md"), OCS_SESSION: SESSION },
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
    if (RECORD) ab("record", "stop");
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
