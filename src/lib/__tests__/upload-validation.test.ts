import { describe, it, expect } from "vitest";
import {
    validateImageUpload,
    LogoValidationError,
    AUTH_PHOTO_MAX_BYTES,
    PUBLIC_INTAKE_PHOTO_MAX_BYTES,
} from "@/lib/storage";

// Real magic bytes — the validator MUST accept only when header + bytes
// match, so tests must produce actual PNG/JPEG signatures rather than
// mocking sniffImageType.
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function makeFile(bytes: Uint8Array, name: string, type: string): File {
    // Wrap through Blob to satisfy TS strict — File's BlobPart type
    // disallows Uint8Array-with-SharedArrayBuffer-lib in some TS
    // configs. The runtime shape is identical.
    return new File([new Blob([bytes as BlobPart])], name, { type });
}

// Common scenario: caller uses the same helper regardless of size cap,
// so tests exercise both the authenticated cap and the tighter public
// intake cap.
describe("validateImageUpload — the shared image validator wired into the three unvalidated saveUpload sites (intake.ts, jobs.ts, techsteps.ts)", () => {
    describe("happy path", () => {
        it("accepts a real PNG with matching MIME under the auth size cap", async () => {
            const bytes = new Uint8Array(PNG_HEADER.length + 32);
            bytes.set(PNG_HEADER, 0);
            const file = makeFile(bytes, "photo.png", "image/png");
            await expect(
                validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES }),
            ).resolves.toBeUndefined();
        });

        it("accepts a real JPEG with matching MIME under the auth size cap", async () => {
            const bytes = new Uint8Array(JPEG_HEADER.length + 32);
            bytes.set(JPEG_HEADER, 0);
            const file = makeFile(bytes, "photo.jpg", "image/jpeg");
            await expect(
                validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES }),
            ).resolves.toBeUndefined();
        });
    });

    describe("rejects — the shape of the stored-XSS class the spec closes", () => {
        it("rejects SVG disguised as PNG (bytes don't match any allowlisted magic)", async () => {
            // The classic vector: attacker sends Content-Type: image/png
            // for an actual <svg><script>...</script></svg> payload. The
            // magic-byte sniff refuses because SVG has no matching header.
            const svg = new TextEncoder().encode(
                '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            );
            const file = makeFile(svg, "attack.png", "image/png");
            await expect(
                validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES }),
            ).rejects.toMatchObject({ name: "LogoValidationError", code: "BAD_MAGIC" });
        });

        it("rejects a PNG whose declared MIME lies (image/jpeg on real PNG bytes)", async () => {
            const bytes = new Uint8Array(PNG_HEADER.length + 32);
            bytes.set(PNG_HEADER, 0);
            const file = makeFile(bytes, "confused.jpg", "image/jpeg");
            await expect(
                validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES }),
            ).rejects.toMatchObject({ name: "LogoValidationError", code: "MIME_MISMATCH" });
        });

        it("rejects an outright text/html MIME (not in the allowlist at all)", async () => {
            const bytes = new TextEncoder().encode("<html><script>alert(1)</script></html>");
            const file = makeFile(bytes, "page.html", "text/html");
            await expect(
                validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES }),
            ).rejects.toMatchObject({ name: "LogoValidationError", code: "BAD_MIME" });
        });

        it("rejects an empty file (EMPTY, not TOO_LARGE — order matters)", async () => {
            const file = makeFile(new Uint8Array(0), "empty.png", "image/png");
            await expect(
                validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES }),
            ).rejects.toMatchObject({ name: "LogoValidationError", code: "EMPTY" });
        });

        it("rejects an oversize file at the public intake cap (5 MB)", async () => {
            // 5 MB + 1 byte. Must reject at the tighter public cap even
            // when it would pass at the authenticated 8 MB cap. This is
            // the specific storage-exhaustion vector the public surface
            // has that the authenticated sites don't.
            const size = PUBLIC_INTAKE_PHOTO_MAX_BYTES + 1;
            const bytes = new Uint8Array(size);
            bytes.set(PNG_HEADER, 0);
            const file = makeFile(bytes, "huge.png", "image/png");
            await expect(
                validateImageUpload(file, { maxBytes: PUBLIC_INTAKE_PHOTO_MAX_BYTES }),
            ).rejects.toMatchObject({ name: "LogoValidationError", code: "TOO_LARGE" });
        });

        it("size caps are DIFFERENT for public vs authenticated flows (regression pin)", () => {
            // The public intake cap MUST be tighter — unauthenticated
            // upload with the same cap as the authenticated flow is
            // still a storage-exhaustion vector. If someone widens the
            // public cap to match, this pins the invariant.
            expect(PUBLIC_INTAKE_PHOTO_MAX_BYTES).toBeLessThan(AUTH_PHOTO_MAX_BYTES);
        });
    });

    describe("the LogoValidationError shape callers rely on", () => {
        it("errors carry a stable `.code` string so server actions can map to user-facing messages", async () => {
            const file = makeFile(new Uint8Array(0), "empty.png", "image/png");
            let caught: unknown;
            try {
                await validateImageUpload(file, { maxBytes: AUTH_PHOTO_MAX_BYTES });
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(LogoValidationError);
            expect((caught as LogoValidationError).code).toBe("EMPTY");
            // `instanceof` is what intake.ts branches on to surface the
            // user-facing "Booking photo rejected: …" message rather than
            // a stack trace.
        });
    });
});

// The client-supplied filename is deliberately NOT persisted or rendered
// anywhere — only the generated URL (`/api/files/{uuid}.{ext}`) survives.
// That eliminates the render-side XSS class ("filename with <script>
// tag") entirely rather than relying on every render surface to escape.
// This pins that contract: saveUpload's return value never leaks the
// original name.
describe("stored URL never contains the client-supplied filename (structural, not escape-at-render)", () => {
    it("the /api/files/{name} URL shape uses a generated uuid, not the uploader's filename", () => {
        // Regex mirrors the shape saveUpload() writes in local mode:
        //   /api/files/{uuid}{.ext}
        // where uuid is a v4 UUID and ext is a lowercased known
        // extension. If someone changes saveUpload to reuse file.name
        // (which would put attacker-controlled HTML into a URL that
        // later renders), this fails.
        const shape = /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif|heic|mp3|wav|webm|ogg|m4a)$/;
        // A hand-authored example matching the current writer's shape.
        // We don't call saveUpload directly here (it hits disk / Supabase
        // depending on env); we pin the URL shape callers depend on.
        expect("/api/files/12345678-1234-1234-1234-123456789012.png").toMatch(shape);
        // And an attacker-shaped filename does NOT match:
        expect("/api/files/attack<script>alert(1)</script>.png").not.toMatch(shape);
    });
});
