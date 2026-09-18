// OCS WebMCP — THE REGISTRATION BOUNDARY. MIT licensed. See LICENSE.
// Design carried over from chisel-webmcp's gate.ts.
//
// WebMCP has no registration-time authorisation hook: you hand registerTool a function and the
// browser calls it. `readOnlyHint` is advisory, and an agent may ignore it. So every safety
// property lives HERE, in the one wrapper every registration goes through. There is deliberately
// no exported way to register a tool without it.

/** Max characters of tool output handed back to the agent. */
export const OUTPUT_CAP = 4000;

const SENTINEL = "[TRUNCATED by ocs-webmcp:";

/**
 * Cap tool output and ANNOUNCE the truncation. This bounds volume; it is not a prompt-injection
 * defence. Drawing content (layer names, text entities) still reaches the agent verbatim, which is
 * why every tool is annotated `untrustedContentHint`, and why the sentinel is neutralised so a
 * drawing cannot forge a truncation notice.
 */
export function cap(s, limit = OUTPUT_CAP) {
    const clean = s.split(SENTINEL).join("[truncated-by-ocs-webmcp:");
    if (clean.length <= limit) return clean;
    const notice = (dropped) =>
        `\n\n${SENTINEL} ${dropped} of ${clean.length} characters were withheld. This result is INCOMPLETE. Narrow the query (a type, a where-filter, paths, or a smaller limit) rather than reasoning from this partial view.]`;
    const room = Math.max(0, limit - notice(clean.length).length);
    return clean.slice(0, room) + notice(clean.length - room);
}

const text = (s, isError = false) => ({ content: [{ type: "text", text: s }], isError });
const render = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));

/**
 * Confirms run one at a time, in order. Two writes arriving together must not stack two dialogs,
 * because approving the one on top is not consent for the one underneath.
 */
let chain = Promise.resolve();
export function serialised(confirm) {
    return (summary) => {
        const next = chain.then(() => confirm(summary));
        chain = next.catch(() => false);
        return next;
    };
}

/** What the human sees in the confirm dialog: the tool, and every argument, verbatim. */
export function describeIntent(def, input) {
    const args = Object.entries(input ?? {})
        .map(([k, v]) => `${k} = ${typeof v === "string" && v.length > 300 ? `${JSON.stringify(v.slice(0, 300))}… (${v.length} chars)` : JSON.stringify(v)}`)
        .join("\n");
    return { title: def.title, tool: def.name, args: args || "(no arguments)" };
}

/**
 * Wrap a tool definition's handler with the gate. This is the ONLY way a handler becomes an
 * `execute` function.
 *
 * @param def      { name, title, description, inputSchema, write?, handler(input, ctx) }
 * @param ctx      passed through to the handler (the OcsControl, etc.)
 * @param confirm  (summary) => Promise<boolean>; called for every write, before the handler runs
 * @param onEvent  (event) => void; the activity trail ({tool, phase, detail})
 */
export function makeGatedExecute(def, ctx, confirm, onEvent = () => {}) {
    return async (input) => {
        const args = input ?? {};
        onEvent({ tool: def.name, phase: "called", write: !!def.write, args });
        try {
            if (def.write) {
                const approved = await confirm(describeIntent(def, args));
                if (!approved) {
                    onEvent({ tool: def.name, phase: "declined" });
                    // The handler NEVER runs. Not "runs and rolls back": never runs.
                    return text(`REFUSED: the human declined "${def.name}". The drawing was not modified. Do not retry this call without new instruction from the user.`, true);
                }
                onEvent({ tool: def.name, phase: "approved" });
            }
            const result = await def.handler(args, ctx);
            onEvent({ tool: def.name, phase: "ok" });
            return text(cap(render(result)));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            onEvent({ tool: def.name, phase: "error", detail: msg });
            return text(`ERROR in ${def.name}: ${cap(msg, 600)}`, true);
        }
    };
}

/**
 * Register every tool through the gate. Returns the AbortController whose abort() unregisters
 * them all (WebMCP has no unregisterTool; you abort the signal passed to registerTool).
 */
export function registerAll(modelContext, defs, ctx, confirm, onEvent) {
    const controller = new AbortController();
    const gatedConfirm = serialised(confirm);
    const execs = new Map();
    for (const def of defs) {
        const execute = makeGatedExecute(def, ctx, gatedConfirm, onEvent);
        execs.set(def.name, execute);
        modelContext?.registerTool(
            {
                name: def.name,
                title: def.title,
                description: def.description,
                inputSchema: def.inputSchema,
                annotations: {
                    // Honest, and advisory. The gate does not rely on them.
                    readOnlyHint: !def.write,
                    destructiveHint: !!def.write,
                    untrustedContentHint: true,
                },
                execute,
            },
            { signal: controller.signal },
        );
    }
    return { controller, execs };
}
