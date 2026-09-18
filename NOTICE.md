# Licences and Corresponding Source

The MIT licence in [LICENSE](LICENSE) covers **only the code in this repository**: the WebMCP
layer in `src/`, the shell in `shell/`, and the build scripts in `scripts/`.

## Open CAD Studio: GPL-3.0-only

This project runs alongside [**Open CAD Studio**](https://github.com/HakanSeven12/OpenCADStudio)
by Hakan Seven and contributors, licensed **GPL-3.0-only**. No file of Open CAD Studio is
modified. `scripts/vendor.mjs` checks out a pinned upstream commit and builds it with upstream's
own web build command. It is served from `/ocs/` and reached from the shell through a same-origin
iframe.

**A deployment that serves this layer together with Open CAD Studio is a combined work governed
by GPL-3.0-only.** Its Corresponding Source is:

1. this repository, and
2. unmodified upstream Open CAD Studio at commit
   [`95bad2a3b2e2779ede14b79a2a1a0e32c6b8d93d`](https://github.com/HakanSeven12/OpenCADStudio/tree/95bad2a3b2e2779ede14b79a2a1a0e32c6b8d93d)
   (the commit the official web app at opencadstudio.com/app was built from on 2026-09-18),
   built by `scripts/vendor.mjs`. The deployment also publishes it at `/ocs-source.json`.

Open CAD Studio's own third-party notices (fonts, the `acadrust` DWG/DXF library under MPL-2.0,
and others) ship with its build under `/ocs/` and are in its repository.

## Trademarks

"Open CAD Studio" names the upstream project. This repository is independent and is not
affiliated with or endorsed by it. AutoCAD and DWG are trademarks of Autodesk, Inc.; they are
used here only to describe file compatibility.
