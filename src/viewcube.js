// OCS WebMCP — preset 3D views by clicking Open CAD Studio's ViewCube. MIT licensed. See LICENSE.
//
// The web build has no command or control action for a preset view: `VIEW` only manages named
// views, there is no VPOINT / -VIEW, the `view_home` action goes to plan (top), and writing the
// active VPORT's view_direction does not move the live camera. The ViewCube does it, so we click
// it, the way a user would, with synthetic pointer events on the same-origin canvas.
//
// Geometry from upstream src/scene/pipeline/viewcube.rs (95bad2a3):
//   half = VIEWCUBE_PX(84) * VIEWCUBE_SCALE(0.36) = 30.24 px; the cube centre sits
//   inset + pad = 2*half + 12 = 72.48 px in from the viewport's top-right corner.
//   Corner regions are at (±m, ±m, m) with m = (F + E) / 2 = 0.9 cube units. From the plan view (camera looking straight down), those project to
//   the offsets below. So every preset starts from `view_home`, whose cube pose is known.
// The viewport's position depends on the layout (ribbon, docked panels), so the cube centre is
// found in a captured frame by its face colour (SURFACE_RGB 0.62, 0.76, 0.84), and the camera is
// checked afterwards. A click that did not produce the expected view is reported, not assumed.

const HALF = 84 * 0.36;
const CORNER = 0.9 * HALF;

/** Offset from the cube centre in the plan view (screen y grows downwards), and the camera pitch to expect. */
export const PRESETS = {
    top: { dx: 0, dy: 0, pitch: Math.PI / 2 },
    iso_se: { dx: CORNER, dy: CORNER, pitch: Math.atan(1 / Math.SQRT2) },
    iso_sw: { dx: -CORNER, dy: CORNER, pitch: Math.atan(1 / Math.SQRT2) },
    iso_ne: { dx: CORNER, dy: -CORNER, pitch: Math.atan(1 / Math.SQRT2) },
    iso_nw: { dx: -CORNER, dy: -CORNER, pitch: Math.atan(1 / Math.SQRT2) },
    // Elevations: the compass letters do not respond to a synthetic click, so these go via an
    // isometric view where the face is visible, then click the face's projected centre.
    front: { via: "iso_se", face: [0, -1, 0], pitch: 0 },
    right: { via: "iso_se", face: [1, 0, 0], pitch: 0 },
    back: { via: "iso_nw", face: [0, 1, 0], pitch: 0 },
    left: { via: "iso_nw", face: [-1, 0, 0], pitch: 0 },
};

/** Rotate v by quaternion q = [x, y, z, w]; with inverse, by its conjugate. */
function rotate([qx, qy, qz, qw], [vx, vy, vz], inverse = false) {
    if (inverse) [qx, qy, qz] = [-qx, -qy, -qz];
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)];
}

/**
 * Screen offset of a cube face's centre from the cube centre, for the camera rotation reported
 * in state (upstream does not document which way that rotation maps, so both are offered and the
 * caller verifies the result).
 */
export function faceOffsets(rotation, face) {
    return [false, true]
        .map((inverse) => rotate(rotation, face, inverse))
        .filter(([, , z]) => z > 0.05)
        .map(([x, y]) => ({ dx: x * HALF * 0.7, dy: -y * HALF * 0.7 }));
}

/** Visual styles, by VSCURRENT keyword. */
export const STYLES = {
    wireframe_2d: "WIREFRAME2D",
    wireframe_3d: "WIREFRAME3D",
    hidden_line: "HIDDENLINE",
    shaded: "GOURAUDSHADED",
    shaded_with_edges: "GOURAUDSHADEDWITHEDGES",
    flat_shaded: "FLATSHADED",
    flat_shaded_with_edges: "FLATSHADEDWITHEDGES",
};

/**
 * Where the ViewCube's centre is, in canvas CSS pixels, found by its face colour in the top-right
 * region of a captured frame.
 */
export async function findCubeCentre(capture) {
    const frame = await capture.frame(4096);
    const canvas = capture.canvas();
    const scale = canvas.getBoundingClientRect().width / frame.width;
    const w = frame.width, h = frame.height;
    const x0 = Math.max(0, w - Math.round(150 / scale)); // cube + compass ring, clear of ribbon icons
    const y1 = Math.min(h, Math.round(520 / scale));
    const px = frame.getContext("2d").getImageData(x0, 0, w - x0, y1).data;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (let y = 0; y < y1; y++) {
        for (let x = 0; x < w - x0; x++) {
            const i = (y * (w - x0) + x) * 4;
            const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
            // The face is shaded, so match its hue family rather than the exact value.
            if (b > 150 && g > 130 && r > 100 && b > r + 25 && g > r + 10 && Math.abs(b - g) < 45) {
                n++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (n < 200) throw new Error("Could not find the ViewCube on screen (it hides when the viewport is too narrow).");
    return { x: ((minX + maxX) / 2 + x0) * scale, y: ((minY + maxY) / 2) * scale, size: (maxX - minX) * scale };
}

/** A mouse click at canvas CSS pixel (x, y), delivered the way winit on the web listens for it. */
export async function clickCanvas(canvas, x, y) {
    const r = canvas.getBoundingClientRect();
    const o = { clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 };
    const win = canvas.ownerDocument.defaultView;
    const pause = (ms) => new Promise((res) => win.setTimeout(res, ms));
    canvas.dispatchEvent(new win.PointerEvent("pointermove", { ...o, buttons: 0 }));
    await pause(60);
    canvas.dispatchEvent(new win.PointerEvent("pointerdown", { ...o, buttons: 1 }));
    canvas.dispatchEvent(new win.MouseEvent("mousedown", { ...o, buttons: 1 }));
    await pause(60);
    canvas.dispatchEvent(new win.PointerEvent("pointerup", { ...o, buttons: 0 }));
    canvas.dispatchEvent(new win.MouseEvent("mouseup", { ...o, buttons: 0 }));
    canvas.dispatchEvent(new win.MouseEvent("click", { ...o, buttons: 0 }));
    // Leave the canvas, so neither the cube's hover highlight nor a crosshair is left in the next capture.
    await pause(60);
    for (const type of ["pointerout", "pointerleave"]) canvas.dispatchEvent(new win.PointerEvent(type, { ...o, buttons: 0 }));
    for (const type of ["mouseout", "mouseleave"]) canvas.dispatchEvent(new win.MouseEvent(type, { ...o, buttons: 0 }));
}
