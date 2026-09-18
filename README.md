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
| **This repository (MIT)** | The WebMCP layer (`src/`): 18 tools, the registration gate, the human confirm dialog, the activity trail, the control-channel client. The shell (`shell/`). The build and test scripts (`scripts/`). |
| **Not ours (GPL-3.0-only)** | The CAD application itself: Open CAD Studio by Hakan Seven and contributors, including its DWG/DXF engine. **Built unmodified** from a pinned upstream commit; no upstream file is edited. |

The combined deployment is a GPL-3.0 work. See [NOTICE.md](NOTICE.md) for its Corresponding
Source.

## How it works

```
 browser tab (document.modelContext: 18 tools)
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

**See (no confirm):** `ocs_capture_view` (screenshot: JPEG/PNG, `max_width`, `if_changed` +
`threshold` to skip unchanged views and save tokens) · `ocs_set_view` (`zoom_extents` / `home`;
the camera only, never the drawing)

**Record (starting it waits for a human):** `ocs_start_recording` → `ocs_stop_recording`. The
human gets the video (**MP4**, or WebM where MP4 can't be recorded) as a download in the activity
panel. The agent gets a **contact sheet**: one image of the frames that changed, with timestamps
and the changed region outlined. An agent can't watch a video, but it can read a contact sheet.

**Write (each waits for a human):** `ocs_new_drawing` · `ocs_open_drawing` (DXF text or
DWG/DXF base64) · `ocs_run_command` · `ocs_cancel_command` · `ocs_set_properties` ·
`ocs_undo` · `ocs_redo`

### Screenshots and recording: how

- **Frames come from `canvas.captureStream()`, never `toDataURL()`.** The editor renders
  through WebGL without a preserved drawing buffer, so `toDataURL()` from outside the render loop
  is **all black** (measured: mean 0, spread 0). Stream frames are the composited output. The web
  build's own `capture` op answers `gui_required`.
- **Change detection counts changed pixels per tile** at 480 px, not mean change. CAD is thin
  lines on a flat background, and averaging dilutes a 1-px line to nothing (a new circle measured
  0% that way).
- **MP4 by default:** Chrome's MP4 has a real duration (2.03 s measured on a 2 s take) and plays
  in QuickTime/Keynote. Its WebM has no duration header (`ffprobe`: N/A).
- The contact-sheet and `if_changed` design follows
  [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)'s recording and
  screenshot options (Apache-2.0), reimplemented in-page. No code copied.

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
- **Recording needs consent.** It changes nothing in the drawing, but it continuously captures
  the user's screen content, so starting it is confirmed like a write, and a red **REC**
  indicator stays visible until it stops. A `max_seconds` limit (default 120) always ends it.
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
npm run test:e2e   # 30 checks through real WebMCP in headless Chrome
```

### Driving it from an agent: agent-browser

[agent-browser](https://github.com/vercel-labs/agent-browser) enables WebMCP in the Chrome it
manages, so it works as the agent-side client with no flags. Verified 2026-09-18 with
agent-browser 0.37.1:

```sh
npm run serve &
agent-browser open http://127.0.0.1:8787/
agent-browser webmcp list                                   # all 18 tools
agent-browser webmcp invoke ocs_get_state
agent-browser webmcp invoke ocs_capture_view --params '{"max_width":900}'   # returns image/jpeg
# a write blocks on the human's dialog, so detach it and collect the result after approval:
agent-browser webmcp invoke ocs_run_command --params '{"cmd":"PLINE 0,0 100,0 100,50 0,50 C"}' --detach
agent-browser webmcp result <invocation-id>                 # "pending" until approved
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
