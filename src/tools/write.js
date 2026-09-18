// OCS WebMCP — write tools. MIT licensed. See LICENSE.
// Every tool here has `write: true`, so the gate asks the human BEFORE the handler runs, and a
// declined call never reaches Open CAD Studio.
//
// Each write quotes the active drawing's `document_id` and `revision`. Open CAD Studio rejects a
// stale revision ("stale_state"), so an agent cannot edit a drawing it has not seen the latest
// version of.

import { ControlError, sleep } from "../control.js";

/** Re-read state until the editor has applied a queued change (its reply is `accepted`, not done). */
async function settle(control, predicate, timeoutMs = 5000) {
    const t0 = performance.now();
    let st = await control.state();
    while (!predicate(st) && performance.now() - t0 < timeoutMs) {
        await sleep(150);
        st = await control.state();
    }
    return st;
}

async function entityTotal(control) {
    const e = await control.request({ op: "entities" });
    return e?.ok === false ? null : e.total;
}

/**
 * The donation prompt blocks new tabs until it is closed (spike 224). Close ONLY that dialog, and
 * only on a path the human already approved. Any other dialog (e.g. Recovery) is reported, not
 * dismissed. Upstream proposal: do not show it while automation is driving.
 */
async function clearDonationPrompt(control) {
    const st = await control.state();
    if (st.modal === "DonationPrompt") {
        await control.must({ op: "action", request_id: control.nextRequestId("modal"), document_id: st.document_id, name: "close_modal" });
        return true;
    }
    if (st.modal) throw new ControlError({ code: "modal_open", error: `A "${st.modal}" dialog is open in the editor; ask the user to deal with it first.` });
    return false;
}

/** Structural equality where numbers compare by value (10 === 10.0), as JSON numbers should. */
function sameValue(a, b) {
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export const WRITE_TOOLS = [
    {
        name: "ocs_new_drawing",
        title: "Create a new drawing",
        write: true,
        description: "Open a new, empty drawing tab and make it active.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => {
            const before = (await control.state()).documents?.length ?? 0;
            const closedPrompt = await clearDonationPrompt(control);
            await control.must({ op: "new", request_id: control.nextRequestId("new") });
            const st = await settle(control, (s) => (s.documents?.length ?? 0) > before);
            const doc = st.documents.find((d) => d.id === st.document_id);
            if (!doc || doc.start) throw new Error("The editor accepted `new` but no drawing tab appeared.");
            return { created: doc, revision: st.revision, closed_donation_prompt: closedPrompt };
        },
    },
    {
        name: "ocs_open_drawing",
        title: "Open a drawing from content",
        write: true,
        description:
            "Open a DWG or DXF in a new tab. Pass exactly one of: `url` (preferred for real drawings: the page fetches it, subject to the browser's normal cross-origin rules), `base64` (file content; fine for small files, but tool-argument limits apply, e.g. agent-browser caps arguments at 1 MB), or `text` (ASCII DXF). `name` must end in .dwg or .dxf; it becomes the tab title.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "File name, e.g. plan.dwg" },
                text: { type: "string", description: "ASCII DXF content." },
                base64: { type: "string", description: "File content, base64 (DWG or binary DXF). Small files only." },
                url: { type: "string", description: "Where to fetch the file from, e.g. /samples/plan.dwg or an https URL that allows cross-origin reads." },
            },
            required: ["name"],
        },
        handler: async (input, { control }) => {
            if (!/\.(dwg|dxf)$/i.test(input.name)) throw new Error("name must end in .dwg or .dxf");
            const given = ["text", "base64", "url"].filter((k) => input[k] != null);
            if (given.length !== 1) throw new Error("pass exactly one of url, base64 or text");
            let bytes;
            if (input.url != null) {
                const res = await fetch(new URL(input.url, location.href), { credentials: "omit" });
                if (!res.ok) throw new Error(`fetching ${input.url} failed: HTTP ${res.status}`);
                bytes = new Uint8Array(await res.arrayBuffer());
            } else {
                bytes = input.text != null ? new TextEncoder().encode(input.text) : b64ToBytes(input.base64);
            }
            if (bytes.length > 200_000_000) throw new Error(`file is ${bytes.length} bytes; refusing to open more than 200 MB in the browser`);
            const before = (await control.state()).documents?.length ?? 0;
            await clearDonationPrompt(control);
            const reply = await control.openBytes(input.name, bytes);
            if (reply?.ok === false) throw new ControlError(reply);
            const st = await settle(control, (s) => (s.documents?.length ?? 0) > before || !!s.modal, 8000);
            if (st.modal) throw new ControlError({ code: "open_failed", error: `The editor opened a "${st.modal}" dialog instead of the drawing. The file may be unreadable.` });
            const doc = st.documents.find((d) => d.id === st.document_id);
            return { opened: doc, bytes: bytes.length, entities: await entityTotal(control) };
        },
    },
    {
        name: "ocs_run_command",
        title: "Run a CAD command",
        write: true,
        description:
            "Run one complete command line in the active drawing, AutoCAD-style: prompt answers separated by spaces, points as x,y or x,y,z, options by their token. E.g. \"LINE 0,0 100,0 100,50 C\", \"CIRCLE 50,25 10\". Use ocs_list_commands with `name` for a command's exact prompts. A command still waiting for input after the line is reported as waiting; finish it with ocs_cancel_command.",
        inputSchema: {
            type: "object",
            properties: { cmd: { type: "string", description: "The full command line." }, revision: { type: "integer", description: "Optional: the drawing revision you last read (from ocs_get_state or ocs_query_records). If the drawing has changed since, the edit is refused instead of applied to a version you have not seen." }, },
            required: ["cmd"],
        },
        handler: async (input, { control }) => {
            const { document_id, revision } = await control.activeDrawing();
            if (input.revision != null && input.revision !== revision) {
                throw new ControlError({ code: "stale_state", error: `The drawing changed since you read it (your revision ${input.revision}, now ${revision}). Re-read before editing.` });
            }
            const before = await entityTotal(control);
            const reply = await control.must({ op: "run", request_id: control.nextRequestId("run"), document_id, revision, cmd: input.cmd });
            const st = await settle(control, (s) => s.revision !== revision || s.command == null, 3000);
            const after = await entityTotal(control);
            return {
                status: reply.status,
                still_waiting_for_input: st.command ?? null,
                entities_before: before,
                entities_after: after,
                added: before != null && after != null ? after - before : null,
                revision: st.revision,
            };
        },
    },
    {
        name: "ocs_add_text",
        title: "Add a text note",
        write: true,
        description:
            "Place a single-line text note: insertion point, height and rotation in drawing units, and the text itself (spaces are fine). Open CAD Studio takes the words through an in-canvas editor, which a plain ocs_run_command cannot fill, so use this rather than TEXT.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number" }, y: { type: "number" },
                height: { type: "number", exclusiveMinimum: 0, description: "Text height in drawing units (e.g. mm)." },
                rotation: { type: "number", description: "Degrees, default 0." },
                text: { type: "string", minLength: 1 },
                revision: { type: "integer", description: "Optional: the revision you last read; the edit is refused if the drawing changed since." },
            },
            required: ["x", "y", "height", "text"],
        },
        handler: async (input, { control }) => {
            const { document_id, revision } = await control.activeDrawing();
            if (input.revision != null && input.revision !== revision) {
                throw new ControlError({ code: "stale_state", error: `The drawing changed since you read it (your revision ${input.revision}, now ${revision}). Re-read before editing.` });
            }
            const before = await entityTotal(control);
            await control.must({ op: "run", request_id: control.nextRequestId("text"), document_id, revision, cmd: `TEXT ${input.x},${input.y} ${input.height} ${input.rotation ?? 0}` });
            await sleep(200);
            await control.must({ op: "action", request_id: control.nextRequestId("text-in"), document_id, name: "text_input", value: input.text });
            await control.must({ op: "action", request_id: control.nextRequestId("text-ok"), document_id, name: "text_commit" });
            // TEXT, like AutoCAD's, moves on to a NEXT line after each commit and leaves an empty
            // in-canvas box open. Escape (`cancel` -> CommandEscape -> text_inline_cancel) closes it
            // without touching the committed note. (An empty text_input is rejected upstream:
            // "Missing value".)
            await sleep(200);
            const now = await control.state();
            if (now.command || now.text_editor) {
                await control.must({ op: "cancel", request_id: control.nextRequestId("text-end"), document_id });
                await settle(control, (s) => !s.command && !s.text_editor, 2000);
            }
            const st = await settle(control, (s) => s.command == null, 3000);
            const after = await entityTotal(control);
            return { added: after - before, text: input.text, at: [input.x, input.y], height: input.height, revision: st.revision };
        },
    },
    {
        name: "ocs_cancel_command",
        title: "Cancel the active command",
        write: true,
        description: "Cancel whatever command is waiting for input (like pressing Escape). Geometry already committed by that command stays.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => {
            const st = await control.state();
            await control.must({ op: "cancel", request_id: control.nextRequestId("cancel"), document_id: st.document_id });
            const after = await settle(control, (s) => s.command == null, 2000);
            return { cancelled: st.command ?? null, active_command: after.command };
        },
    },
    {
        name: "ocs_set_properties",
        title: "Edit record properties",
        write: true,
        description:
            "Atomically change fields of one record (one undo step). Paths are JSON Pointers into the record's properties, as returned by ocs_query_records; pass `expected` to make an update conditional on the current value. Handles and ownership are read-only.",
        inputSchema: {
            type: "object",
            properties: {
                collection: { type: "string", description: "Default entities." },
                revision: { type: "integer", description: "Optional: the drawing revision you last read (from ocs_get_state or ocs_query_records). If the drawing has changed since, the edit is refused instead of applied to a version you have not seen." },
                handle: { type: "string", description: "Hex handle (entities/objects)." },
                name: { type: "string", description: "Record name (layers, styles, blocks)." },
                updates: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: { path: { type: "string" }, value: {}, expected: {} },
                        required: ["path", "value"],
                    },
                },
            },
            required: ["updates"],
        },
        handler: async (input, { control }) => {
            const { document_id, revision } = await control.activeDrawing();
            if (input.revision != null && input.revision !== revision) {
                throw new ControlError({ code: "stale_state", error: `The drawing changed since you read it (your revision ${input.revision}, now ${revision}). Re-read before editing.` });
            }
            const collection = input.collection ?? "entities";
            const target = input.handle ? { handle: input.handle } : input.name ? { name: input.name } : null;
            if (!target) throw new Error("pass handle (entities/objects) or name (named records)");

            // `expected` is checked HERE, not upstream: upstream compares raw JSON values, so a
            // stored float 10.0 never equals an expected 10 (all JSON numbers from JavaScript are
            // written without ".0"). We read the current values, compare numbers by value, then
            // send the update pinned to the revision we read. If anything changes in between,
            // Open CAD Studio rejects it as stale_state, so the guard stays atomic.
            const guarded = input.updates.filter((u) => "expected" in u);
            let pinned = revision;
            if (guarded.length) {
                const cur = await control.must({ op: "records", collection, ...target, paths: guarded.map((u) => u.path), limit: 1 });
                const rec = cur.records?.[0];
                if (!rec) throw new ControlError({ code: "not_found", error: `No ${collection} record ${JSON.stringify(target)}` });
                for (const u of guarded) {
                    const actual = rec.values?.[u.path];
                    if (!sameValue(actual, u.expected)) {
                        throw new ControlError({ code: "expected_mismatch", error: `${u.path} is ${JSON.stringify(actual)}, not the expected ${JSON.stringify(u.expected)}. Nothing was changed.` });
                    }
                }
                pinned = cur.revision ?? revision;
            }
            const updates = input.updates.map(({ path, value }) => ({ path, value }));
            return control.must({ op: "set_properties", request_id: control.nextRequestId("set"), document_id, revision: pinned, collection, ...target, updates });
        },
    },
    {
        name: "ocs_undo",
        title: "Undo",
        write: true,
        description: "Undo the last change in the active drawing.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => {
            const { document_id, revision } = await control.activeDrawing();
            await control.must({ op: "undo", request_id: control.nextRequestId("undo"), document_id });
            const st = await settle(control, (s) => s.revision !== revision, 2000);
            return { revision_before: revision, revision_after: st.revision, entities: await entityTotal(control) };
        },
    },
    {
        name: "ocs_redo",
        title: "Redo",
        write: true,
        description: "Redo the last undone change in the active drawing.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => {
            const { document_id, revision } = await control.activeDrawing();
            await control.must({ op: "redo", request_id: control.nextRequestId("redo"), document_id });
            const st = await settle(control, (s) => s.revision !== revision, 2000);
            return { revision_before: revision, revision_after: st.revision, entities: await entityTotal(control) };
        },
    },
];
