// OCS WebMCP — screenshots, change detection and recording of the Open CAD Studio canvas.
// MIT licensed. See LICENSE.
//
// ⚠️ Why a MediaStream and not canvas.toDataURL(): Open CAD Studio renders through WebGL
// (wgpu), whose drawing buffer is not preserved between frames. Read from outside the render
// loop, toDataURL() returns an all-black image. Measured 2026-09-18: mean 0, spread 0. Frames
// taken from canvas.captureStream() are the composited output: mean 32, spread 22 on the same
// drawing. The web build's own `capture` op answers "gui_required".
//
// Change detection and the contact sheet follow vercel-labs/agent-browser's recording design
// (Apache-2.0): keep a frame only when enough of it changed since the last kept frame, measured
// on small tiles, and lay the kept frames out with timestamps and the changed region outlined.
// This is a smaller, in-page reimplementation, not a copy of its code.

// CAD views are thin lines on a flat background. A tile's MEAN change dilutes a 1-px line to
// nothing (measured: a new r=30 circle scored 0% with mean-per-tile at 240 px). So count changed
// PIXELS per tile at a higher resolution, like agent-browser's min-pixels-per-tile rule.
const DIFF_WIDTH = 480;       // frames are compared at this width
const TILE = 8;               // px tiles at DIFF_WIDTH
const PIXEL_DELTA = 24;       // |Δ luminance| (0-255) for a pixel to count as changed
const TILE_MIN_PIXELS = 2;    // changed pixels for a tile to count as changed

export class CanvasCapture {
    /** @param {() => HTMLCanvasElement | null} getCanvas */
    constructor(getCanvas) {
        this.getCanvas = getCanvas;
        this.stream = null;
        this.video = null;
        this.last = null;         // luminance grid of the last capture, for if_changed
    }

    canvas() {
        const c = this.getCanvas();
        if (!c) throw new Error("The Open CAD Studio canvas is not available yet.");
        return c;
    }

    /** A live video of the canvas; frames come from the compositor, so they are never black. */
    async source() {
        const c = this.canvas();
        if (this.stream && this.streamCanvas === c && this.stream.getVideoTracks()[0]?.readyState === "live") return this.video;
        this.stop();
        this.stream = c.captureStream(15);
        this.streamCanvas = c;
        this.video = document.createElement("video");
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.srcObject = this.stream;
        await this.video.play();
        const t0 = performance.now();
        while ((this.video.readyState < 2 || !this.video.videoWidth) && performance.now() - t0 < 3000) await sleep(30);
        if (!this.video.videoWidth) throw new Error("The canvas stream produced no frame.");
        return this.video;
    }

    /** The current frame as a canvas, scaled to at most maxWidth. */
    async frame(maxWidth = 1280) {
        const v = await this.source();
        await nextFrame(v);
        const scale = Math.min(1, maxWidth / v.videoWidth);
        const out = document.createElement("canvas");
        out.width = Math.round(v.videoWidth * scale);
        out.height = Math.round(v.videoHeight * scale);
        out.getContext("2d").drawImage(v, 0, 0, out.width, out.height);
        return out;
    }

    /**
     * Screenshot. With `ifChanged`, returns { unchanged: true } (no image) when less than
     * `threshold` of the view changed since the previous capture.
     */
    async screenshot({ format = "jpeg", quality = 0.8, maxWidth = 1024, ifChanged = false, threshold = 0.01 } = {}) {
        const img = await this.frame(maxWidth);
        const grid = lumaGrid(img);
        const change = this.last ? compare(this.last, grid) : { ratio: 1, box: null };
        if (ifChanged && this.last && change.ratio < threshold) return { unchanged: true, changed_ratio: round(change.ratio) };
        this.last = grid;
        const mime = format === "png" ? "image/png" : "image/jpeg";
        const dataUrl = img.toDataURL(mime, quality);
        return { mime, base64: dataUrl.slice(dataUrl.indexOf(",") + 1), width: img.width, height: img.height, changed_ratio: round(change.ratio) };
    }

    stop() {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.video = null;
    }
}

/**
 * Records the canvas to WebM (for the human) and, alongside, builds a contact sheet of the frames
 * that changed (for the agent, which cannot watch a video).
 */
export class Recording {
    constructor(capture, { fps = 30, maxSeconds = 120, threshold = 0.05, maxFrames = 24, sampleMs = 250, format = "auto" } = {}) {
        Object.assign(this, { capture, fps, maxSeconds, threshold, maxFrames, sampleMs, format });
        this.kept = [];           // { t, img, box, ratio }
        // Resolves when the recording has stopped, by ocs_stop_recording OR by max_seconds.
        this.done = new Promise((r) => { this.resolveDone = r; });
        this.chunks = [];
        this.sampled = 0;
    }

    async start() {
        const canvas = this.capture.canvas();
        this.stream = canvas.captureStream(this.fps);
        // MP4 first: Chrome's MP4 carries a real duration (measured 2.03 s on a 2 s take) and plays
        // in QuickTime/Keynote. Its WebM has NO duration header (ffprobe: N/A), so scrubbing breaks
        // in some players. WebM stays as the fallback for browsers without MP4 recording.
        const MP4 = ["video/mp4;codecs=avc1", "video/mp4"], WEBM = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
        const prefs = this.format === "webm" ? WEBM : this.format === "mp4" ? MP4 : [...MP4, ...WEBM];
        const mimeType = prefs.find((t) => MediaRecorder.isTypeSupported(t));
        if (!mimeType) throw new Error(`This browser cannot record the canvas as ${this.format} (no supported MediaRecorder type).`);
        this.mimeType = mimeType;
        this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 8_000_000 });
        this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
        this.t0 = performance.now();
        this.recorder.start(500);
        this.lastGrid = null;
        await this.sample(true);
        this.timer = setInterval(() => this.sample(false).catch(() => {}), this.sampleMs);
        this.limit = setTimeout(() => this.stop().catch(() => {}), this.maxSeconds * 1000);
    }

    async sample(force) {
        if (this.sampling) return;
        this.sampling = true;
        try {
            const img = await this.capture.frame(320);
            const grid = lumaGrid(img);
            this.sampled++;
            const change = this.lastGrid ? compare(this.lastGrid, grid) : { ratio: 1, box: null };
            if (force || change.ratio >= this.threshold) {
                this.lastGrid = grid;
                this.kept.push({ t: (performance.now() - this.t0) / 1000, img, box: change.box, ratio: change.ratio });
                // Bound memory: keep the first frame, then thin the middle evenly.
                if (this.kept.length > this.maxFrames) this.kept.splice(1 + Math.floor((this.kept.length - 1) / 2), 1);
            }
        } finally {
            this.sampling = false;
        }
    }

    /** Stops once; later calls return the same result. */
    stop() {
        this.stopping ??= (async () => {
            clearInterval(this.timer);
            clearTimeout(this.limit);
            await this.sample(false).catch(() => {});
            await new Promise((r) => { this.recorder.onstop = r; this.recorder.stop(); });
            this.stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(this.chunks, { type: this.mimeType });
            const result = { blob, seconds: (performance.now() - this.t0) / 1000, sheet: contactSheet(this.kept), kept: this.kept.length, sampled: this.sampled };
            this.resolveDone(result);
            return result;
        })();
        return this.stopping;
    }
}

// ── image helpers ───────────────────────────────────────────────────────────────────────────

/** Luminance grid of an image at DIFF_WIDTH. */
function lumaGrid(img) {
    const w = DIFF_WIDTH, h = Math.max(1, Math.round((img.height / img.width) * DIFF_WIDTH));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const y = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) y[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return { w, h, y };
}

/** Fraction of TILE×TILE tiles with ≥ TILE_MIN_PIXELS changed pixels, plus their bounding box (0-1 coords). */
function compare(a, b) {
    if (a.w !== b.w || a.h !== b.h) return { ratio: 1, box: null };
    const tx = Math.ceil(a.w / TILE), ty = Math.ceil(a.h / TILE);
    let changed = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
        let hits = 0;
        for (let y = j * TILE; y < Math.min(a.h, (j + 1) * TILE); y++) for (let x = i * TILE; x < Math.min(a.w, (i + 1) * TILE); x++) {
            if (Math.abs(a.y[y * a.w + x] - b.y[y * a.w + x]) > PIXEL_DELTA) hits++;
        }
        if (hits >= TILE_MIN_PIXELS) { changed++; x0 = Math.min(x0, i); y0 = Math.min(y0, j); x1 = Math.max(x1, i); y1 = Math.max(y1, j); }
    }
    const box = changed ? { x: x0 / tx, y: y0 / ty, w: (x1 - x0 + 1) / tx, h: (y1 - y0 + 1) / ty } : null;
    return { ratio: changed / (tx * ty), box };
}

/** Grid of kept frames: 4 columns, timestamp + change label, changed region outlined. */
function contactSheet(kept) {
    if (!kept.length) return null;
    const cols = Math.min(4, kept.length), cellW = 320, cellH = Math.round(cellW * (kept[0].img.height / kept[0].img.width)), label = 18, gap = 6;
    const rows = Math.ceil(kept.length / cols);
    const c = document.createElement("canvas");
    c.width = cols * cellW + (cols + 1) * gap;
    c.height = rows * (cellH + label) + (rows + 1) * gap;
    const g = c.getContext("2d");
    g.fillStyle = "#101216"; g.fillRect(0, 0, c.width, c.height);
    g.font = "12px ui-monospace, Menlo, monospace"; g.textBaseline = "middle";
    kept.forEach((k, i) => {
        const x = gap + (i % cols) * (cellW + gap), y = gap + Math.floor(i / cols) * (cellH + label + gap);
        g.fillStyle = "#c9d1d9";
        g.fillText(`#${i + 1}  t=${k.t.toFixed(1)}s${i ? `  Δ${Math.round(k.ratio * 100)}%` : "  start"}`, x + 2, y + label / 2);
        g.drawImage(k.img, x, y + label, cellW, cellH);
        if (k.box) {
            g.strokeStyle = "#ff5a5a"; g.lineWidth = 2;
            g.strokeRect(x + k.box.x * cellW, y + label + k.box.y * cellH, k.box.w * cellW, k.box.h * cellH);
        }
    });
    const url = c.toDataURL("image/jpeg", 0.8);
    return { mime: "image/jpeg", base64: url.slice(url.indexOf(",") + 1), width: c.width, height: c.height };
}

/**
 * Prefer a fresh frame, but never wait for one: captureStream only emits when the canvas repaints,
 * so on a still drawing the current frame IS the latest one.
 */
function nextFrame(video) {
    return new Promise((r) => {
        const t = setTimeout(r, 150);
        video.requestVideoFrameCallback?.(() => { clearTimeout(t); r(); });
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => Math.round(x * 10000) / 10000;
