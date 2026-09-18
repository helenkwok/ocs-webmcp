// OCS WebMCP — the client for Open CAD Studio's in-page control channel. MIT licensed. See LICENSE.
//
// Open CAD Studio's web build compiles the same semantic control core as its native MCP server
// ("Semantic control shared by the GUI, headless client and web adapter", src/app/control/mod.rs)
// and exports two wasm-bindgen functions:
//
//   ocs_control_submit(json) -> ticket          queue a request (queue depth 64)
//   ocs_control_take(ticket) -> json | undefined take the reply once the app has handled it
//
// The Trunk loader publishes those exports on `window.wasmBindings`. We reach them in a SAME-ORIGIN
// iframe, so no upstream file is modified.
//
// ⚠️ THIS FILE IS THE ONLY PLACE THAT DEPENDS ON UPSTREAM INTERNALS. Three of them, none documented:
//   1. `window.wasmBindings`: a Trunk loader default, not an Open CAD Studio API;
//   2. polling `ocs_control_take` for replies;
//   3. the OPFS cache layout used to open files (`openBytes` below; src/io/web_recent.rs).
// Upstream proposal: a documented `request(json) -> Promise`, `open` from bytes, and no donation
// modal while automation drives. When those land, this file changes and nothing else does.

const POLL_START_MS = 10;
const POLL_MAX_MS = 120;

export class ControlError extends Error {
    constructor(reply) {
        super(`${reply?.code ?? "error"}: ${reply?.error ?? JSON.stringify(reply)}`);
        this.reply = reply;
        this.code = reply?.code;
    }
}

export class OcsControl {
    /** @param {HTMLIFrameElement} frame  the same-origin iframe hosting the Open CAD Studio build */
    constructor(frame) {
        this.frame = frame;
        this.bindings = null;
        this.serial = 0;
    }

    /** Resolve once the app's wasm has booted and the control exports exist. */
    async ready(timeoutMs = 180_000) {
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
            const b = this.frame.contentWindow?.wasmBindings;
            if (typeof b?.ocs_control_submit === "function" && typeof b?.ocs_control_take === "function") {
                this.bindings = b;
                return this;
            }
            await sleep(250);
        }
        throw new Error("Open CAD Studio did not expose its control channel (window.wasmBindings.ocs_control_*) in time");
    }

    /**
     * Send one request and wait for its reply. Resolves with the parsed reply, INCLUDING
     * `{ok:false,…}` replies. Callers decide what a failure means. Rejects only on a transport
     * problem (not ready, timeout).
     */
    async request(req, { timeoutMs = 20_000 } = {}) {
        if (!this.bindings) await this.ready();
        const ticket = this.bindings.ocs_control_submit(JSON.stringify(req));
        const t0 = performance.now();
        let wait = POLL_START_MS;
        while (performance.now() - t0 < timeoutMs) {
            // The app answers on its next update tick; results live in a 64-slot ring, so take
            // promptly rather than batching.
            const out = this.bindings.ocs_control_take(ticket);
            if (out != null) return JSON.parse(out);
            await sleep(wait);
            wait = Math.min(POLL_MAX_MS, wait * 2);
        }
        throw new Error(`Open CAD Studio did not answer "${req.op}" within ${timeoutMs} ms (ticket ${ticket})`);
    }

    /** Like request(), but throws a ControlError on `{ok:false}`. */
    async must(req, opts) {
        const reply = await this.request(req, opts);
        if (reply?.ok === false) throw new ControlError(reply);
        return reply;
    }

    nextRequestId(prefix) {
        this.serial += 1;
        return `${prefix}-${Date.now().toString(36)}-${this.serial}`;
    }

    state() {
        return this.must({ op: "state" });
    }

    /**
     * The active drawing's id and revision, which every write must quote (optimistic concurrency).
     * Throws a readable error when the Start page is active: nothing to edit yet.
     */
    async activeDrawing() {
        const st = await this.state();
        const doc = st.documents?.find((d) => d.id === st.document_id);
        if (!doc || doc.start) {
            throw new ControlError({ code: "no_document", error: "No drawing is open. Create one (ocs_new_drawing) or open one (ocs_open_drawing) first." });
        }
        return { st, doc, document_id: st.document_id, revision: st.revision };
    }

    /**
     * Open a drawing from bytes. The web build's `open` op resolves a NAME against its OPFS
     * "recent files" cache (`opencadstudio-recent/<fnv1a64(name)>.cad`, raw bytes), so we put the
     * bytes there first, then open by name. Verified 2026-09-18 against 2026.37 (spike 224).
     */
    async openBytes(name, bytes) {
        const win = this.frame.contentWindow;
        const key = fnv1a64(name) + ".cad";
        const root = await win.navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle("opencadstudio-recent", { create: true });
        const writable = await (await dir.getFileHandle(key, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
        return this.request({ op: "open", request_id: this.nextRequestId("open"), path: name });
    }
}

/** FNV-1a 64-bit over UTF-8, as 16 lowercase hex digits. Mirrors web_recent.rs `name_hash`. */
export function fnv1a64(name) {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode(name)) {
        h ^= BigInt(b);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
