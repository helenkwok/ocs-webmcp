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


function refuseStale(given, revision) {
    if (given != null && given !== revision) {
        throw new ControlError({ code: "stale_state", error: `The drawing changed since you read it (your revision ${given}, now ${revision}). Re-read before editing.` });
    }
}

/**
 * Fold per-reply `changes` ({handle, kind}) into what the whole call did. An entity added and
 * removed again within the call (a transient) is dropped.
 */
function changeTracker() {
    const seen = new Map(); // handle -> { first, last }
    return {
        add(reply) {
            for (const c of reply?.changes ?? []) {
                const kind = String(c.kind).toLowerCase();
                const prev = seen.get(c.handle);
                seen.set(c.handle, { first: prev?.first ?? kind, last: kind });
            }
        },
        summary() {
            const out = { added: [], removed: [], modified: [] };
            for (const [handle, { first, last }] of seen) {
                if (first.startsWith("add") && last.startsWith("remov")) continue;
                if (first.startsWith("add")) out.added.push(handle);
                else if (last.startsWith("remov")) out.removed.push(handle);
                else out.modified.push(handle);
            }
            for (const k of Object.keys(out)) if (out[k].length > 200) out[k] = [...out[k].slice(0, 200), `…${out[k].length - 200} more`];
            return out;
        },
    };
}

/** What the command is asking for right now, in the words an agent needs to answer it. */
function promptOf(command) {
    if (!command) return null;
    return {
        prompt: command.prompt,
        accepts: command.accepts,
        options: (command.options ?? []).map((o) => o.keyword || o.label).filter(Boolean),
    };
}

const STEP_SCHEMA = {
    type: "object",
    properties: {
        kind: { type: "string", enum: ["point", "entity", "structure", "token", "text", "enter", "selection"], description: "Must be one of the prompt's `accepts`." },
        point: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3, description: "point: the point. entity/structure: WHERE on the entity you pick it. That decides the side kept by FILLET, TRIM, EXTEND, OFFSET, BREAK." },
        space: { type: "string", enum: ["wcs", "ucs", "relative"], description: "point only; default wcs. relative = offset from the last point." },
        handle: { type: "string", description: "entity/structure: the hex handle picked." },
        text: { type: "string", description: "token: what you would type at the prompt, an option keyword (R for Radius) or a value (5). text: free text, only where the prompt accepts text (e.g. a name)." },
    },
    required: ["kind"],
};

function stepPayload(step) {
    const p = { kind: step.kind };
    if (step.kind === "point" || step.kind === "entity" || step.kind === "structure") {
        if (!Array.isArray(step.point)) throw new Error(`a ${step.kind} step needs point`);
        p.point = step.point.length === 2 ? [...step.point, 0] : step.point; // upstream wants x,y,z
        if (step.kind === "point" && step.space) p.space = step.space;
        if (step.kind !== "point") {
            if (!step.handle) throw new Error(`a ${step.kind} step needs handle`);
            p.handle = step.handle;
        }
    }
    if (step.kind === "token" || step.kind === "text") p.text = step.text ?? "";
    return p;
}

async function runCommandSteps(control, input) {
    const { document_id, revision } = await control.activeDrawing();
    refuseStale(input.revision, revision);
    const busy = (await control.state()).command;
    if (busy) throw new ControlError({ code: "command_busy", error: `Another command is waiting for input (${busy.prompt}). Cancel it with ocs_cancel_command first.` });

    const changes = changeTracker();
    const done = [];
    const fail = async (error, extra = {}) => {
        const st = await control.state();
        if (st.command) await control.settled({ op: "cancel", request_id: control.nextRequestId("steps-abort"), document_id });
        throw new ControlError({ code: "step_failed", error: `${error} Steps sent: ${JSON.stringify(done)}. The command was cancelled; geometry it had already committed stays (ocs_undo reverses it). Changes so far: ${JSON.stringify(changes.summary())}`, ...extra });
    };

    if (input.select?.length) {
        const sel = await control.settled({ op: "select", request_id: control.nextRequestId("steps-sel"), document_id, handles: input.select });
        if (sel?.ok === false) throw new ControlError(sel);
    }
    const now = await control.state();
    let reply = await control.settled({ op: "start", request_id: control.nextRequestId("steps-start"), document_id, revision: now.revision, cmd: input.cmd });
    if (reply?.ok === false) throw new ControlError(reply);
    changes.add(reply);

    for (const [i, step] of (input.steps ?? []).entries()) {
        const asked = promptOf(reply.state?.command);
        if (!asked) await fail(`${input.cmd} finished before step ${i + 1}; the remaining ${input.steps.length - i} step(s) were not sent.`);
        // Upstream lists ONE input kind per prompt. A point step that also takes keyword letters
        // (MOVE/COPY base point with [Displacement] on builds after v2026.37) is reported as
        // accepting only "token", though it takes points too. So a point is let through wherever a
        // token is, and the step log says so.
        const pointViaToken = step.kind === "point" && !asked.accepts?.includes("point") && asked.accepts?.includes("token");
        if (!asked.accepts?.includes(step.kind) && !pointViaToken) await fail(`Step ${i + 1} is a ${step.kind}, but the prompt "${asked.prompt}" accepts ${JSON.stringify(asked.accepts)}${asked.options.length ? ` (options: ${asked.options.join(", ")})` : ""}.`);
        let payload;
        try { payload = stepPayload(step); } catch (e) { await fail(`Step ${i + 1}: ${e.message}.`); }
        reply = await control.settled({ op: "input", request_id: control.nextRequestId("steps-in"), document_id, ...payload });
        changes.add(reply);
        done.push({ step: i + 1, prompt: asked.prompt, sent: payload, status: reply?.status, ...(pointViaToken ? { note: "prompt listed token, not point; sent the point anyway" } : {}) });
        if (reply?.ok === false) await fail(`Step ${i + 1} failed: ${reply.error ?? reply.code}.`);
    }

    // Many commands (FILLET, LINE, OFFSET, …) start over or wait for more after the last answer,
    // as in AutoCAD. Leaving one waiting would block the next edit, so finish it unless asked not to.
    let waiting = promptOf(reply.state?.command);
    let autoCancelled = null;
    if (waiting && input.finish !== "leave") {
        const c = await control.settled({ op: "cancel", request_id: control.nextRequestId("steps-end"), document_id });
        changes.add(c);
        autoCancelled = waiting.prompt;
        waiting = null;
    }
    const st = await control.state();
    return {
        command: input.cmd,
        steps: done,
        still_waiting: waiting,
        auto_cancelled_at: autoCancelled,
        changes: changes.summary(),
        entities: await entityTotal(control),
        revision: st.revision,
    };
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
            return { opened: doc, bytes: bytes.length, entities: await entityTotal(control), open_method: control.openMethod };
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
    {
        name: "ocs_command_steps",
        title: "Run a command step by step",
        write: true,
        description:
            "Run a command that needs picks or several answers, one prompt at a time: FILLET, TRIM, EXTEND, OFFSET, BREAK, MOVE/COPY/ROTATE on a selection, and (on newer builds) geometric constraints. Optionally select entities first; then give one step per prompt, each of a kind the prompt accepts (ocs_list_commands with `name` shows the flow). Get handles and pick points from ocs_spatial_query. The reply lists each prompt, and the handles added, removed and modified: edits like FILLET and TRIM REPLACE entities, so re-read handles afterwards. A command still waiting after the last step is cancelled (committed geometry stays) unless finish is \"leave\". Stops at the first step the prompt does not accept.",
        inputSchema: {
            type: "object",
            properties: {
                cmd: { type: "string", description: "The command name, e.g. FILLET." },
                select: { type: "array", items: { type: "string" }, description: "Handles to select before starting (for commands that act on a selection, like MOVE)." },
                steps: { type: "array", items: STEP_SCHEMA, description: "Answers, in prompt order." },
                finish: { type: "string", enum: ["cancel", "leave"], description: "Default cancel." },
                revision: { type: "integer", description: "Optional: the revision you last read; refused if the drawing changed since." },
            },
            required: ["cmd"],
        },
        handler: async (input, { control }) => runCommandSteps(control, input),
    },
    {
        name: "ocs_set_layer",
        title: "Set a layer's state",
        write: true,
        description:
            "Show or hide, freeze or thaw, lock or unlock a layer, and/or make it the current layer (new objects go on it). Sets the state you ask for, so repeating a call changes nothing. The layer must exist: this build has no way to create layers through automation.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Layer name, as in ocs_query_records collection=layers." },
                visible: { type: "boolean" },
                frozen: { type: "boolean" },
                locked: { type: "boolean" },
                current: { type: "boolean", description: "true makes it the current layer." },
                revision: { type: "integer", description: "Optional: the revision you last read; refused if the drawing changed since." },
            },
            required: ["name"],
        },
        handler: async (input, { control }) => {
            const { document_id, revision } = await control.activeDrawing();
            refuseStale(input.revision, revision);
            if (input.current === false) throw new Error("current=false is not a state you can set; make another layer current instead");
            const flagsOf = async () => (await control.must({ op: "records", collection: "layers", name: input.name, paths: ["/flags"], limit: 1 })).records?.[0]?.values?.["/flags"];
            const currentLayer = async () => (await control.must({ op: "records", collection: "header", paths: ["/current_layer_name"], limit: 1 })).records?.[0]?.values?.["/current_layer_name"];
            const flags = await flagsOf();
            if (!flags) throw new ControlError({ code: "unknown_layer", error: `No layer named ${JSON.stringify(input.name)}. List them with ocs_query_records collection=layers.` });
            const want = { off: input.visible == null ? undefined : !input.visible, frozen: input.frozen, locked: input.locked };
            const updates = Object.entries(want)
                .filter(([k, v]) => v !== undefined && flags[k] !== v)
                .map(([k, v]) => ({ path: `/flags/${k}`, value: v }));
            const changed = [];
            if (updates.length) {
                // One set_properties = one undo step for all the flags.
                const r = await control.settled({ op: "set_properties", request_id: control.nextRequestId("layer"), document_id, revision, collection: "layers", name: input.name, updates });
                if (r?.ok === false) throw new ControlError(r);
                changed.push(...updates.map((u) => u.path.slice("/flags/".length)));
            }
            if (input.current && (await currentLayer()) !== input.name) {
                // CLAYER checks the layer exists; a raw header write would not.
                const st = await control.state();
                const r = await control.settled({ op: "run", request_id: control.nextRequestId("clayer"), document_id, revision: st.revision, cmd: `CLAYER ${input.name}` });
                if (r?.ok === false) throw new ControlError(r);
                changed.push("current");
            }
            const after = await flagsOf();
            const current = await currentLayer();
            if (input.current && current !== input.name) throw new ControlError({ code: "not_applied", error: `The current layer is still ${JSON.stringify(current)}.` });
            return { layer: input.name, changed, visible: !after.off, frozen: !!after.frozen, locked: !!after.locked, current: current === input.name, revision: (await control.state()).revision };
        },
    },
    {
        name: "ocs_batch",
        title: "Run several edits",
        write: true,
        describe: (input) => {
            const lines = (input.steps ?? []).map((s, i) => `${i + 1}. ${s.tool} ${JSON.stringify(s.input ?? {})}`);
            if (input.revision != null) lines.push(`(only if the drawing is still at revision ${input.revision})`);
            return lines.join("\n") || "(no steps)";
        },
        description:
            "Run several edits in order under ONE approval, so the user reviews the whole plan at once instead of approving each call. Each step is {tool, input} for one of: ocs_run_command, ocs_command_steps, ocs_add_text, ocs_set_properties, ocs_set_layer. Stops at the first failure and reports what already ran. Not atomic: each step is its own undo step. A `revision` inside a step is ignored (the batch's own steps change it); pass `revision` on the batch instead.",
        inputSchema: {
            type: "object",
            properties: {
                steps: {
                    type: "array",
                    minItems: 1,
                    maxItems: 50,
                    items: {
                        type: "object",
                        properties: {
                            tool: { type: "string", enum: ["ocs_run_command", "ocs_command_steps", "ocs_add_text", "ocs_set_properties", "ocs_set_layer"] },
                            input: { type: "object", description: "That tool's arguments." },
                        },
                        required: ["tool", "input"],
                    },
                },
                revision: { type: "integer", description: "Optional: the revision you last read; the whole batch is refused if the drawing changed since." },
            },
            required: ["steps"],
        },
        handler: async (input, ctx) => {
            const { revision } = await ctx.control.activeDrawing();
            refuseStale(input.revision, revision);
            const results = [];
            for (const [i, step] of input.steps.entries()) {
                const def = BATCHABLE.has(step.tool) && WRITE_TOOLS.find((t) => t.name === step.tool);
                if (!def) throw new Error(`step ${i + 1}: ${step.tool} cannot be batched`);
                const { revision: _ignored, ...args } = step.input ?? {};
                try {
                    results.push({ step: i + 1, tool: step.tool, result: await def.handler(args, ctx) });
                } catch (e) {
                    const ran = results.length ? `Steps 1-${i} ran and stay applied.` : "No step ran.";
                    throw new ControlError({ code: "batch_stopped", error: `Step ${i + 1} (${step.tool}) failed: ${e.message} ${ran} Steps ${i + 2}-${input.steps.length} were not run.` });
                }
            }
            return { ran: results.length, results, revision: (await ctx.control.state()).revision };
        },
    },
];

/** Write tools ocs_batch may run. Not drawing lifecycle (new/open), undo/redo, or itself. */
const BATCHABLE = new Set(["ocs_run_command", "ocs_command_steps", "ocs_add_text", "ocs_set_properties", "ocs_set_layer"]);
