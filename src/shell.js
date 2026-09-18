// OCS WebMCP — the shell: hosts Open CAD Studio in a same-origin iframe and publishes its tools on
// document.modelContext. MIT licensed. See LICENSE.

import { OcsControl } from "./control.js";
import { registerAll } from "./gate.js";
import { READ_TOOLS } from "./tools/read.js";
import { WRITE_TOOLS } from "./tools/write.js";

const $ = (sel) => document.querySelector(sel);
const frame = $("#ocs");
const statusEl = $("[data-ocs-status]");
const log = $("[data-ocs-activity]");
const dialog = $("[data-ocs-confirm]");

function setStatus(msg, ok = true) {
    statusEl.textContent = msg;
    statusEl.dataset.ok = String(ok);
}

// ── activity trail: every call, visible to the human ────────────────────────────────────────
function onEvent(ev) {
    const li = document.createElement("li");
    li.dataset.phase = ev.phase;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    const detail =
        ev.phase === "called" ? (Object.keys(ev.args ?? {}).length ? ` ${JSON.stringify(ev.args).slice(0, 160)}` : "")
        : ev.detail ? ` ${ev.detail.slice(0, 200)}` : "";
    li.textContent = `${time} ${ev.tool} · ${ev.phase}${ev.write && ev.phase === "called" ? " (write)" : ""}${detail}`;
    log.prepend(li);
    while (log.children.length > 200) log.lastChild.remove();
}

// ── the confirm seam: every write waits here for a human ───────────────────────────────────
function confirm(summary) {
    $("[data-ocs-confirm-title]").textContent = summary.title;
    $("[data-ocs-confirm-tool]").textContent = summary.tool;
    $("[data-ocs-confirm-args]").textContent = summary.args;
    return new Promise((resolve) => {
        const done = (answer) => {
            dialog.close();
            $("[data-ocs-approve]").onclick = $("[data-ocs-decline]").onclick = null;
            dialog.oncancel = null;
            resolve(answer);
        };
        $("[data-ocs-approve]").onclick = () => done(true);
        $("[data-ocs-decline]").onclick = () => done(false);
        dialog.oncancel = (e) => { e.preventDefault(); done(false); }; // Escape = decline
        dialog.showModal();
        $("[data-ocs-decline]").focus(); // the safe default has focus
    });
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────
const control = new OcsControl(frame);
const tools = [...READ_TOOLS, ...WRITE_TOOLS];
const mc = document.modelContext;

setStatus("Loading Open CAD Studio…");
control
    .ready()
    .then(async () => {
        const st = await control.state();
        if (!mc?.registerTool) {
            setStatus(`Open CAD Studio ${st.version} ready, but WebMCP is unavailable in this browser (enable chrome://flags/#enable-webmcp-testing)`, false);
            return;
        }
        registerAll(mc, tools, { control }, confirm, onEvent);
        setStatus(`WebMCP ready: ${tools.length} tools (${READ_TOOLS.length} read, ${WRITE_TOOLS.length} write, confirmed) · Open CAD Studio ${st.version}`);
        document.documentElement.dataset.ocsWebmcpReady = String(tools.length);
    })
    .catch((err) => setStatus(String(err.message ?? err), false));
