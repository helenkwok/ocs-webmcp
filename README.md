# OCS WebMCP: agentic DWG/DXF editing in the browser

**[Open CAD Studio](https://github.com/HakanSeven12/OpenCADStudio)'s drawing editor, with its
editing verbs registered as [WebMCP](https://github.com/webmachinelearning/webmcp) tools, so an
AI agent in the browser can inspect and edit DWG/DXF drawings. Every change waits for a human.**

Ask for *"draw a 100 × 50 rectangle on layer WALLS"* and the agent calls the editor's own command
engine (`PLINE 0,0 100,0 100,50 0,50 C`). It is the same engine Open CAD Studio's desktop MCP
server drives, running in the browser tab.

## What is ours, and what is not

| | |
|---|---|
| **This repository (MIT)** | The WebMCP layer (`src/`): 14 tools, the registration gate, the human confirm dialog, the activity trail, the control-channel client. The shell (`shell/`). The build and test scripts (`scripts/`). |
| **Not ours (GPL-3.0-only)** | The CAD application itself: Open CAD Studio by Hakan Seven and contributors, including its DWG/DXF engine. **Built unmodified** from a pinned upstream commit; no upstream file is edited. |

The combined deployment is a GPL-3.0 work. See [NOTICE.md](NOTICE.md) for its Corresponding
Source.

## How it works

```
 browser tab (document.modelContext: 14 tools)
 ┌──────────────────────────────────────────────┬──────────────────┐
 │ /  shell  (MIT)                              │ agent activity   │
 │   registers tools → gate → confirm dialog     │  (every call)    │
 │   ┌──────────────────────────────────────┐   │                  │
 │   │ /ocs/  Open CAD Studio (GPL-3,        │   │                  │
 │   │        unmodified, same-origin iframe)│   │                  │
 │   │   window.wasmBindings                 │   │                  │
 │   │     .ocs_control_submit / _take  ◄────┼── src/control.js    │
 │   └──────────────────────────────────────┘   │                  │
 └──────────────────────────────────────────────┴──────────────────┘
```

Open CAD Studio's web build compiles the same semantic control core as its native MCP server,
and exports it to JavaScript as `ocs_control_submit` / `ocs_control_take`. The shell reaches
those exports in a **same-origin iframe**, so nothing upstream needs a plugin hook or a patch.

## Tools

**Read (no confirm):** `ocs_get_state` · `ocs_get_capabilities` · `ocs_count_entities` ·
`ocs_query_records` (filters, JSON-Pointer projections, paging) · `ocs_get_record_schema` ·
`ocs_list_commands` (vocabulary, or one command's exact prompts) · `ocs_get_history`

**Write (each waits for a human):** `ocs_new_drawing` · `ocs_open_drawing` (DXF text or
DWG/DXF base64) · `ocs_run_command` · `ocs_cancel_command` · `ocs_set_properties` ·
`ocs_undo` · `ocs_redo`

## Safety model

- **One gate** (`src/gate.js`): every tool is registered through it, and there is no path
  around it. Writes stop at a confirm dialog **before** anything reaches the editor. A declined
  call returns `REFUSED` and never runs.
- **Confirms are serialised**, so approving one dialog is never consent to a second one.
- **Optimistic concurrency**: writes quote the drawing's revision, and Open CAD Studio itself
  refuses a stale one. Agents may pass the `revision` they last read; `ocs_set_properties`
  supports per-field `expected` values, compared by value.
- **Output is capped**, and truncation is announced, never silent. All tools carry
  `untrustedContentHint`, because drawing content (text, layer names) reaches the agent
  verbatim.
- Only Open CAD Studio's **donation prompt** is dismissed automatically, and only on a path the
  human has already approved. Any other dialog is reported to the agent, not closed.

## Build and run

Requirements: Node ≥ 22, git, [rustup](https://rustup.rs) with
`rustup target add wasm32-unknown-unknown`, [trunk](https://trunkrs.dev), and `wasm-bindgen-cli`
at **exactly** the version in upstream's `Cargo.lock` (0.2.108 at the pinned commit:
`cargo install wasm-bindgen-cli --version 0.2.108 --locked`).

```sh
npm run build      # clone upstream at the pinned commit, build it unmodified, assemble dist/
npm run serve      # http://127.0.0.1:8787/ with the COOP/COEP headers upstream expects
npm run test:e2e   # 20 checks through real WebMCP in headless Chrome
```

WebMCP is behind a flag in Chrome: enable `chrome://flags/#enable-webmcp-testing` (headless:
`--enable-features=WebMCPTesting`).

> **macOS + Homebrew rustup:** the rustup proxies live in `/opt/homebrew/opt/rustup/bin`, which
> is not on PATH by default. Calling a toolchain's `cargo` directly makes `rust-lld` fail to load
> `libLLVM.dylib`. `scripts/vendor.mjs` finds the proxies itself.

### Why this upstream commit

`95bad2a3` is exactly what the official web app at opencadstudio.com/app was built from
(`/site-version.txt`): release `v2026.37` plus one web hotfix. As of 2026-09-18, the bare release
tag and upstream `main` both fail to compile for `wasm32` (desktop-only calls in shared code).

## Upstream internals this depends on

`src/control.js` is the only file that touches them:

1. `window.wasmBindings`, which is the Trunk loader's default, not a documented API;
2. polling `ocs_control_take` for replies;
3. opening a file by writing it into the app's OPFS "recent files" cache, then `open` by name.

These are the subject of an upstream proposal: a documented promise-based entry point, `open`
from bytes, and no donation prompt while automation drives. When they land, only
`src/control.js` changes.

## Licence

MIT for this repository ([LICENSE](LICENSE)). The deployed combination with Open CAD Studio is
GPL-3.0-only ([NOTICE.md](NOTICE.md)).
