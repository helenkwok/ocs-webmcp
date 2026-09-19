// OCS WebMCP — read tools. MIT licensed. See LICENSE.
// None of these mutate the drawing, so the gate lets them through without a confirm.

const WHERE_ITEM = {
    type: "object",
    properties: {
        path: { type: "string", description: "RFC 6901 JSON Pointer relative to the record's properties, e.g. /common/layer" },
        op: { type: "string", enum: ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "starts_with", "ends_with", "in", "exists", "not_exists"], description: "Comparison; default eq." },
        value: { description: "Value to compare against (an array for `in`)." },
    },
    required: ["path"],
};

/** Keep state replies small: the agent needs identity and position, not the whole camera. */
function summariseState(st) {
    return {
        active_document_id: st.document_id,
        revision: st.revision,
        documents: st.documents,
        layout: st.layout,
        camera: { target: st.camera?.target, distance: st.camera?.distance, projection: st.camera?.projection },
        active_command: st.command,
        text_editor_open: st.text_editor === true,   // upstream reports a boolean (text_inline.is_some())
        modal: st.modal,
        selection: { count: st.selection?.length ?? 0, handles: (st.selection ?? []).slice(0, 50) },
        version: st.version,
        protocol: st.protocol,
    };
}

export const READ_TOOLS = [
    {
        name: "ocs_get_state",
        title: "Get editor state",
        description:
            "Open drawings, which one is active, its revision (writes must quote it), the active command, any open dialog, and the current selection. Call this first.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => summariseState(await control.state()),
    },
    {
        name: "ocs_get_capabilities",
        title: "Get capabilities",
        description:
            "What this Open CAD Studio build supports, and every database collection (entities, layers, blocks, text styles, dimension styles, …) with its record count and whether it is editable.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => {
            const c = await control.must({ op: "capabilities" });
            return { api: c.api, version: c.version, editor: c.editor, geometry: c.geometry, transactions: c.transactions, collections: c.records?.collections };
        },
    },
    {
        name: "ocs_count_entities",
        title: "Count entities by type",
        description: "Entity count in the active drawing, broken down by type (Line, Circle, Insert, MText, …). Cheap overview before querying records.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { control }) => control.must({ op: "entities" }),
    },
    {
        name: "ocs_query_records",
        title: "Query drawing records",
        description:
            "Read records from the drawing database. Entities are keyed by hex handle. Filter by type/handle/name and property filters, and project only the property paths you need to keep replies small. Paged by limit/offset; the reply carries next_offset.",
        inputSchema: {
            type: "object",
            properties: {
                collection: { type: "string", description: "Collection name from ocs_get_capabilities, e.g. entities, layers, block_records. Default entities." },
                type: { type: "string", description: "Record type, e.g. Line, Circle, Insert, Layer." },
                handle: { type: "string", description: "One record's hex handle." },
                name: { type: "string", description: "One named record (layers, blocks, styles)." },
                where: { type: "array", items: WHERE_ITEM, description: "Property filters, combined with AND." },
                paths: { type: "array", items: { type: "string" }, description: "JSON Pointer projections, e.g. [\"/center\", \"/radius\", \"/common/layer\"]." },
                limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 50." },
                offset: { type: "integer", minimum: 0 },
            },
        },
        handler: async (input, { control }) => {
            const req = { op: "records", collection: input.collection ?? "entities", limit: input.limit ?? 50 };
            for (const k of ["type", "handle", "name", "where", "paths", "offset"]) if (input[k] !== undefined) req[k] = input[k];
            return control.must(req);
        },
    },
    {
        name: "ocs_get_record_schema",
        title: "Get record schema",
        description:
            "Field names, types, enum variants and write rules for a record type, e.g. collection=entities type=Circle. Use before ocs_set_properties on an unfamiliar type.",
        inputSchema: {
            type: "object",
            properties: {
                collection: { type: "string" },
                type: { type: "string" },
            },
        },
        handler: async (input, { control }) => {
            const req = { op: "record_schema" };
            if (input.collection) req.collection = input.collection;
            if (input.type) req.type = input.type;
            return control.must(req);
        },
    },
    {
        name: "ocs_list_commands",
        title: "List CAD commands",
        description:
            "The editor's command vocabulary (AutoCAD-style: LINE, PLINE, CIRCLE, MOVE, …). With `name`, returns that command's prompts and batch examples, which is how to learn the exact syntax for ocs_run_command.",
        inputSchema: {
            type: "object",
            properties: {
                search: { type: "string", description: "Substring filter, e.g. \"arc\"." },
                name: { type: "string", description: "One command, for its prompts and examples." },
                offset: { type: "integer", minimum: 0 },
            },
        },
        handler: async (input, { control }) => {
            const req = { op: "commands" };
            for (const k of ["search", "name", "offset"]) if (input[k] !== undefined) req[k] = input[k];
            return control.must(req);
        },
    },
    {
        name: "ocs_get_history",
        title: "Get command-line history",
        description: "The editor's command-line log: what ran, prompts, errors. Use it to see why a command did not do what you expected.",
        inputSchema: { type: "object", properties: { last: { type: "integer", minimum: 1, maximum: 200, description: "Most recent N entries; default 30." } } },
        handler: async (input, { control }) => {
            const { document_id } = await control.state();
            const h = await control.must({ op: "history", document_id });
            return { entries: (h.entries ?? []).slice(-(input.last ?? 30)) };
        },
    },
    {
        name: "ocs_measure",
        title: "Measure entities",
        description:
            "Exact geometry for up to 100 entities by handle: bounding box, and for curves their length, whether they are closed, and enclosed area; for solids and meshes, surface area, volume, centroid and mass properties. Use it to check the result of an edit by numbers rather than by eye.",
        inputSchema: {
            type: "object",
            properties: { handles: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, description: "Hex entity handles, e.g. [\"62\", \"1A3\"]." } },
            required: ["handles"],
        },
        handler: async (input, { control }) => control.must({ op: "measure", handles: input.handles }),
    },
    {
        name: "ocs_spatial_query",
        title: "Find entities by position",
        description:
            "Find entities by where they are, which is how to get the handles to pick in ocs_command_steps. Filters combine: `near` sorts by distance from a point (with each entity's closest point), `contains_point` keeps closed entities around a point, `bounds` keeps entities inside a box, plus `type` and `layer`. Or pass `intersections` with two handles for the points where they cross.",
        inputSchema: {
            type: "object",
            properties: {
                near: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3, description: "[x, y] or [x, y, z]; results nearest first." },
                contains_point: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3, description: "[x, y]: closed entities that contain it." },
                bounds: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4, description: "[min_x, min_y, max_x, max_y]." },
                type: { type: "string", description: "Entity type, e.g. Line, Circle, LwPolyline, Insert." },
                layer: { type: "string" },
                intersections: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "Two handles; returns their intersection points. Other filters are ignored." },
                detail: { type: "string", enum: ["summary", "geometry", "full"], description: "Default geometry." },
                limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 20." },
                offset: { type: "integer", minimum: 0 },
            },
        },
        handler: async (input, { control }) => {
            if (input.intersections) return control.must({ op: "query", intersections: input.intersections });
            const req = { op: "query", limit: input.limit ?? 20 };
            for (const k of ["near", "contains_point", "bounds", "type", "layer", "detail", "offset"]) if (input[k] !== undefined) req[k] = input[k];
            return control.must(req);
        },
    },
];
