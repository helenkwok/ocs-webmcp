// OCS WebMCP — builds upstream Open CAD Studio's web app UNMODIFIED at a pinned commit, then
// assembles the deployable bundle: shell at /, Open CAD Studio at /ocs/. MIT licensed. See LICENSE.
//
// No upstream file is edited. The build command is upstream's own (.github/workflows/pages.yml),
// with only the URL prefix and output folder changed by command-line flags.

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const VENDOR = resolve(ROOT, ".vendor/opencadstudio");
const BUILT = resolve(ROOT, ".vendor/dist-ocs");
const DIST = resolve(ROOT, "dist");

const UPSTREAM = "https://github.com/HakanSeven12/OpenCADStudio.git";
/**
 * The exact commit the live https://www.opencadstudio.com/app/ was built from
 * (its /site-version.txt, 2026-09-18): release tag v2026.37 PLUS one web hotfix, "Fix web folder
 * paths and allow main-only web hotfix deployment". Why not the others:
 *   - v2026.37 (a43fb253) itself does NOT compile for wasm32 (config_dir / plot_styles_dir are
 *     desktop-only);
 *   - main as of 2026-09-17 (472bb988) does NOT compile for wasm32 either: `crate::network` in
 *     src/io/font_repo.rs (from 28efbffd) and `open::that_detached` in src/app/update/mod.rs (from
 *     1c8e3ff3) are desktop-only.
 * Pinned, so the combined deployment's GPL-3 Corresponding Source is exact.
 */
const PINNED_COMMIT = "95bad2a3b2e2779ede14b79a2a1a0e32c6b8d93d";

const run = (cmd, cwd, env) => execSync(cmd, { cwd, stdio: "inherit", env: env ?? process.env });

// ── toolchain ────────────────────────────────────────────────────────────────────────────────
// Build through rustup's PROXIES. Calling a toolchain's rustc/cargo directly leaves rust-lld
// unable to find libLLVM.dylib (the proxies put the toolchain's lib/ on the loader path). With
// Homebrew's rustup the proxies live in the keg, which is NOT on PATH by default.
const proxyDirs = ["/opt/homebrew/opt/rustup/bin", "/usr/local/opt/rustup/bin", resolve(homedir(), ".cargo/bin")];
const proxies = proxyDirs.find((d) => existsSync(resolve(d, "cargo")) && existsSync(resolve(d, "rustc")));
if (!proxies) throw new Error("rustup proxies not found; install rustup and `rustup target add wasm32-unknown-unknown`");
const env = { ...process.env, PATH: [proxies, resolve(homedir(), ".cargo/bin"), process.env.PATH].join(":") };

// ── source ───────────────────────────────────────────────────────────────────────────────────
if (!existsSync(VENDOR)) {
    mkdirSync(resolve(ROOT, ".vendor"), { recursive: true });
    run(`git clone ${UPSTREAM} ${VENDOR}`, ROOT);
}
run(`git fetch --tags origin`, VENDOR);
run(`git checkout --quiet ${PINNED_COMMIT}`, VENDOR);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: VENDOR, encoding: "utf8" }).trim();
if (dirty) throw new Error(`upstream checkout is modified; refusing to build a modified copy:\n${dirty}`);

// wasm-bindgen-cli must equal the wasm-bindgen crate in upstream's Cargo.lock exactly.
const lock = readFileSync(resolve(VENDOR, "Cargo.lock"), "utf8");
const want = lock.match(/name = "wasm-bindgen"\nversion = "([^"]+)"/)?.[1];
const have = execFileSync("wasm-bindgen", ["--version"], { env, encoding: "utf8" }).trim().split(" ")[1];
if (want !== have) throw new Error(`wasm-bindgen-cli ${have} != Cargo.lock ${want}: cargo install wasm-bindgen-cli --version ${want} --locked`);

// ── build (upstream's own command) ──────────────────────────────────────────────────────────
// `--layer-only` reuses an existing upstream build and only re-assembles our files.
const layerOnly = process.argv.includes("--layer-only") && existsSync(resolve(BUILT, "index.html"));
if (!layerOnly) rmSync(BUILT, { recursive: true, force: true });
if (!layerOnly) run(`trunk build --locked --release --public-url /ocs/ --dist ${BUILT} --html-output index.html web-app.html`, VENDOR, env);

// ── assemble ────────────────────────────────────────────────────────────────────────────────
//   /            the shell: WebMCP registration, activity panel, confirm dialog   (MIT)
//   /src/        the layer                                                          (MIT)
//   /ocs/        upstream Open CAD Studio, built unmodified at PINNED_COMMIT       (GPL-3.0-only)
rmSync(DIST, { recursive: true, force: true });
cpSync(BUILT, resolve(DIST, "ocs"), { recursive: true });
cpSync(resolve(ROOT, "shell/index.html"), resolve(DIST, "index.html"));
cpSync(resolve(ROOT, "src"), resolve(DIST, "src"), { recursive: true });
for (const f of ["NOTICE.md", "LICENSE"]) cpSync(resolve(ROOT, f), resolve(DIST, f));
writeFileSync(resolve(DIST, "ocs-source.json"), JSON.stringify({ upstream: UPSTREAM, commit: PINNED_COMMIT, license: "GPL-3.0-only", modified: false }, null, 2) + "\n");

console.log(`\n✓ dist/ ready: shell + unmodified Open CAD Studio @ ${PINNED_COMMIT.slice(0, 10)}. Serve with: npm run serve`);
