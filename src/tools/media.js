// OCS WebMCP — screenshot and screen-recording tools. MIT licensed. See LICENSE.
//
// A screenshot is a read: it shows the agent what the human already sees, so no confirm.
// Starting a recording CONTINUOUSLY captures the human's screen content, so it is confirmed like a
// write (`confirm: true`). It is still annotated read-only, because it never changes the drawing.
// A REC indicator is visible for the whole recording.

import { Recording } from "../capture.js";

const image = (img, caption) => ({
    content: [
        { type: "image", data: img.base64, mimeType: img.mime },
        { type: "text", text: JSON.stringify(caption, null, 1) },
    ],
});

export const MEDIA_TOOLS = [
    {
        name: "ocs_set_view",
        title: "Frame the view",
        description:
            "Change only the camera, never the drawing: zoom_extents fits everything drawn into the viewport (do this before ocs_capture_view, because a new drawing does not zoom to fit); home resets the view.",
        inputSchema: { type: "object", properties: { view: { type: "string", enum: ["zoom_extents", "home"], description: "Default zoom_extents." } } },
        handler: async (input, { control }) => {
            const st = await control.state();
            const cam = (s) => ({ target: s.camera?.target?.map((v) => Math.round(v * 1000) / 1000), distance: Math.round((s.camera?.distance ?? 0) * 1000) / 1000 });
            const before = cam(st);
            await control.must({ op: "action", request_id: control.nextRequestId("view"), document_id: st.document_id, name: input.view === "home" ? "view_home" : "zoom_extents" });
            // Wait until the camera has actually moved (or give up), then let it repaint.
            let after = before;
            for (let i = 0; i < 30; i++) {
                await new Promise((r) => setTimeout(r, 50));
                after = cam(await control.state());
                if (JSON.stringify(after) !== JSON.stringify(before)) break;
            }
            await new Promise((r) => setTimeout(r, 150));
            return {
                view: input.view ?? "zoom_extents",
                camera_before: before,
                camera_after: after,
                moved: JSON.stringify(after) !== JSON.stringify(before),
                note: "Open CAD Studio fits to the whole viewport, including the strip under its floating command-line panel, so geometry at the very bottom edge can be hidden behind that panel.",
            };
        },
    },
    {
        name: "ocs_capture_view",
        title: "Screenshot the editor",
        description:
            "An image of the editor as the user sees it (drawing viewport and ribbon). Use it to check visually what a command did. Set if_changed to skip the image when little has changed since your last capture; that saves tokens.",
        inputSchema: {
            type: "object",
            properties: {
                format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg." },
                quality: { type: "number", minimum: 0.3, maximum: 1, description: "JPEG quality, default 0.8." },
                max_width: { type: "integer", minimum: 320, maximum: 2560, description: "Downscale to at most this width; default 1024." },
                if_changed: { type: "boolean", description: "Return no image if less than `threshold` of the view changed since the previous capture." },
                threshold: { type: "number", minimum: 0, maximum: 1, description: "Changed fraction for if_changed; default 0.01." },
            },
        },
        handler: async (input, { capture }) => {
            const shot = await capture.screenshot({
                format: input.format, quality: input.quality, maxWidth: input.max_width,
                ifChanged: !!input.if_changed, threshold: input.threshold ?? 0.01,
            });
            if (shot.unchanged) return { unchanged: true, changed_ratio: shot.changed_ratio, note: "No image: the view has not changed beyond the threshold since your last capture." };
            return image(shot, { width: shot.width, height: shot.height, format: shot.mime, changed_ratio_since_last: shot.changed_ratio });
        },
    },
    {
        name: "ocs_start_recording",
        title: "Start screen recording",
        confirm: true,
        description:
            "Start recording the editor to a video for the user (MP4, or WebM where MP4 is unavailable). While it records, frames that change noticeably are collected into a contact sheet, which ocs_stop_recording returns to you as one image. Stops by itself after max_seconds.",
        inputSchema: {
            type: "object",
            properties: {
                fps: { type: "integer", minimum: 1, maximum: 60, description: "Video frame rate, default 30." },
                format: { type: "string", enum: ["mp4", "webm"], description: "Video container. Default: mp4 where the browser can record it (has a duration, plays in QuickTime/Keynote), else webm." },
                max_seconds: { type: "integer", minimum: 1, maximum: 600, description: "Auto-stop after this long; default 120." },
                threshold: { type: "number", minimum: 0.001, maximum: 1, description: "Changed fraction for a frame to enter the contact sheet; default 0.05." },
                max_frames: { type: "integer", minimum: 2, maximum: 60, description: "Contact-sheet frames, default 24." },
            },
        },
        handler: async (input, { capture, ui, session }) => {
            if (session.recording) throw new Error("A recording is already running; stop it first (ocs_stop_recording).");
            const rec = new Recording(capture, { format: input.format ?? "auto", fps: input.fps ?? 30, maxSeconds: input.max_seconds ?? 120, threshold: input.threshold ?? 0.05, maxFrames: input.max_frames ?? 24 });
            await rec.start();
            session.recording = rec;
            ui.setRecording(true);
            // ONE finishing path for both endings (ocs_stop_recording or max_seconds): wait for the
            // recording to end, then finish it. Calling stop() here would end it immediately.
            session.finished = rec.done.then((r) => finish(session, ui, r, rec.stopReason ?? "auto-stop (max_seconds)"));
            return { recording: true, mime: rec.mimeType, fps: rec.fps, max_seconds: rec.maxSeconds, note: "Now act; call ocs_stop_recording when done." };
        },
    },
    {
        name: "ocs_stop_recording",
        title: "Stop screen recording",
        description:
            "Stop the recording. The user gets the video as a download in the activity panel. You get a contact sheet: the frames that changed, with timestamps and the changed region outlined in red.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_input, { ui, session }) => {
            const rec = session.recording ?? session.lastRecording?.rec;
            if (!rec) throw new Error("No recording has been started.");
            rec.stopReason ??= "ocs_stop_recording";
            const r = await rec.stop();
            const summary = await session.finished;   // same summary, whichever way it ended
            return r.sheet ? image(r.sheet, summary) : summary;
        },
    },
];

function finish(session, ui, r, how) {
    const ext = r.blob.type.startsWith("video/mp4") ? "mp4" : "webm";
    const name = `ocs-recording-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
    ui.offerDownload(r.blob, name);
    ui.setRecording(false);
    const summary = {
        stopped_by: how, seconds: Math.round(r.seconds * 10) / 10, video_bytes: r.blob.size, video: name,
        video_note: "The video is offered to the user as a download; it is not sent to you.",
        contact_sheet_frames: r.kept, frames_sampled: r.sampled,
    };
    session.lastRecording = { rec: session.recording, summary };
    session.recording = null;
    return summary;
}
