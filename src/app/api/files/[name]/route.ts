import { readFile } from "node:fs/promises";
import path from "node:path";
import { auth } from "@/auth";
import { CONTENT_TYPES } from "@/lib/storage";

// Serves dev uploads from ./.uploads. Production serves from object
// storage instead (see saveUpload + saveLogoUpload — both return a
// Supabase URL when SUPABASE_URL is set).
//
// Defence-in-depth over the upload-side validators (validateImageUpload,
// validateInvoiceImage, validateLogoFile). Even if a future PR bypasses
// or weakens those, this route refuses to serve anything outside a
// tight extension allowlist. Same for the SVG-into-CONTENT_TYPES
// regression path — SVG is NOT in the allowlist here, so any .svg that
// somehow lands in .uploads/ 404s at serve time.

const SERVED_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".heic",
    ".mp3",
    ".wav",
    ".webm",
    ".ogg",
    ".m4a",
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"]);

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
    // Session gate (AR 2026-08-21). This route serves dev uploads
    // straight off disk to any caller that knows the (opaque) file
    // name. A URL that leaked into a Slack channel was fetchable by
    // anyone with the link — filenames being random doesn't count
    // as a real access control. Prod uses Supabase's signed URLs
    // and never hits this route; the auth check is dev-only defence
    // and cheap.
    //
    // Not garage-scoped: filename → owning garage requires a join
    // through the parent record (JobStep.photoUrl, Booking.photoUrls,
    // moulkia scan, etc.) and the join isn't cheap. Any signed-in
    // staff at any garage in the dev DB can view every dev file.
    // Filed as a follow-up if we ever want tighter scoping here.
    const session = await auth();
    if (!session?.user?.id) {
        return new Response("Unauthorized", { status: 401 });
    }

    const { name } = await params;
    const safe = path.basename(name); // prevent path traversal
    const ext = path.extname(safe).toLowerCase();

    // Extension allowlist first — 404 on miss. Kills the "one PR adds
    // .svg to CONTENT_TYPES" regression path: even if a future PR
    // widens CONTENT_TYPES, the SVG never gets served.
    if (!SERVED_EXTENSIONS.has(ext)) {
        return new Response("Not found", { status: 404 });
    }

    try {
        const buf = await readFile(path.join(process.cwd(), ".uploads", safe));
        const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
        // Content-Disposition:
        //   - Images stay inline so <img src="/api/files/…"> renders
        //     naturally on the job / booking pages. With `nosniff` +
        //     the extension allowlist above, a real PNG served inline
        //     isn't a script-execution vector.
        //   - Everything else (audio) forces `attachment` so a top-
        //     level navigation cannot execute embedded content the
        //     browser might interpret as HTML.
        // Forcing images to `attachment` would break the daily
        // advisor / tech workflow (viewing job photos inline), so the
        // trade-off is deliberate. See PO discussion 2026-07-29.
        const disposition = IMAGE_EXTENSIONS.has(ext) ? "inline" : "attachment";
        return new Response(new Uint8Array(buf), {
            headers: {
                "Content-Type": type,
                // nosniff prevents browsers from re-classifying an
                // `image/*` response as `text/html` based on byte
                // sniffing. Belt on top of the extension allowlist.
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": `${disposition}; filename="${safe}"`,
                "Cache-Control": "private, max-age=3600",
            },
        });
    } catch {
        return new Response("Not found", { status: 404 });
    }
}
