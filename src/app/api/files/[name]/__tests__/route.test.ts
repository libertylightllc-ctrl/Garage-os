import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

// Mock `@/auth` BEFORE importing the route — the real module boots
// next-auth v5 which pulls `next/server` in a shape vitest can't
// resolve ("Cannot find module 'next/server'"). Same pattern used by
// intake-phone-normalization.test.ts. `authReturns` is mutable so a
// single test can flip it to null to exercise the 401 branch.
let authReturns: { user: { id: string } } | null = { user: { id: "test-user" } };
vi.mock("@/auth", () => ({ auth: async () => authReturns }));

const { GET } = await import("../route");

// Serve-route hardening (defence-in-depth over upload-side validation):
//   1. Session gate first → 401 when unauthenticated. Filenames are
//      opaque but not a real access control; a link that leaks (Slack,
//      email) shouldn't hand any anonymous caller the file.
//   2. Extension allowlist → 404 on miss. Kills the "one PR adds
//      .svg to CONTENT_TYPES" regression: the route refuses to serve
//      any extension it doesn't recognise, regardless of what
//      CONTENT_TYPES says.
//   3. X-Content-Type-Options: nosniff on every response. Prevents
//      browsers from re-classifying an `image/*` response as text/html
//      based on byte-sniffing.
//   4. Content-Disposition switch — inline for images (advisor / tech
//      workflows depend on <img src="/api/files/…"> rendering), attachment
//      for audio (top-level navigation would download rather than render).

const UPLOAD_DIR = path.join(process.cwd(), ".uploads");

async function callGET(filename: string): Promise<Response> {
    return await GET(new Request("http://localhost/api/files/" + filename), {
        params: Promise.resolve({ name: filename }),
    });
}

describe("/api/files/[name] — serve-route hardening", () => {
    // Test fixtures — real PNG bytes so the route reads a plausible
    // file, and an MP3 stub for the audio branch. Fixtures live under
    // .uploads/ because that's where the route reads from; test names
    // are prefixed so a real dev upload isn't touched.
    const pngName = "test-upload-validation-fixture.png";
    const svgName = "test-upload-validation-fixture.svg";
    const mp3Name = "test-upload-validation-fixture.mp3";
    const noExtName = "test-upload-validation-fixture-noext";
    const htmlName = "test-upload-validation-fixture.html";

    beforeAll(async () => {
        await mkdir(UPLOAD_DIR, { recursive: true });
        // Real PNG header + padding — enough for readFile to succeed.
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        await writeFile(path.join(UPLOAD_DIR, pngName), png);
        // SVG payload as if an attacker got one past the upload
        // validator — the route STILL must refuse. This is the
        // regression-in-depth test.
        await writeFile(
            path.join(UPLOAD_DIR, svgName),
            new TextEncoder().encode('<svg><script>alert(1)</script></svg>'),
        );
        await writeFile(path.join(UPLOAD_DIR, mp3Name), new Uint8Array([0x49, 0x44, 0x33, 0x03, 0]));
        await writeFile(path.join(UPLOAD_DIR, noExtName), new Uint8Array([0x00]));
        await writeFile(path.join(UPLOAD_DIR, htmlName), new TextEncoder().encode("<html></html>"));
    });

    afterAll(async () => {
        for (const n of [pngName, svgName, mp3Name, noExtName, htmlName]) {
            await rm(path.join(UPLOAD_DIR, n), { force: true });
        }
    });

    describe("extension allowlist", () => {
        it("SVG → 404 even when the file exists on disk (bypasses CONTENT_TYPES entirely)", async () => {
            const res = await callGET(svgName);
            expect(res.status).toBe(404);
        });

        it("HTML → 404 even when the file exists on disk", async () => {
            const res = await callGET(htmlName);
            expect(res.status).toBe(404);
        });

        it("no-extension → 404", async () => {
            const res = await callGET(noExtName);
            expect(res.status).toBe(404);
        });

        it("PNG → 200", async () => {
            const res = await callGET(pngName);
            expect(res.status).toBe(200);
        });

        it("MP3 → 200", async () => {
            const res = await callGET(mp3Name);
            expect(res.status).toBe(200);
        });
    });

    describe("response headers", () => {
        it("PNG gets Content-Disposition: inline (advisor / tech workflows depend on <img src> rendering)", async () => {
            const res = await callGET(pngName);
            expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
            expect(res.headers.get("Content-Type")).toBe("image/png");
        });

        it("MP3 gets Content-Disposition: attachment (top-level nav should download, not attempt to render)", async () => {
            const res = await callGET(mp3Name);
            expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
            expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
        });

        it("every served response carries X-Content-Type-Options: nosniff (blocks MIME re-sniffing)", async () => {
            const png = await callGET(pngName);
            const mp3 = await callGET(mp3Name);
            expect(png.headers.get("X-Content-Type-Options")).toBe("nosniff");
            expect(mp3.headers.get("X-Content-Type-Options")).toBe("nosniff");
        });
    });

    describe("path traversal (existing protection, pinned)", () => {
        it("basename strips a directory prefix so ../../etc/passwd style names cannot escape .uploads/", async () => {
            const res = await callGET("../../../etc/passwd");
            // Even if the basename ends up as "passwd" (no ext), the
            // allowlist check rejects it. If the basename had an
            // allowlisted ext, the read would fail because the file
            // doesn't exist. Either way: not 200.
            expect(res.status).toBe(404);
        });
    });

    describe("session gate (AR 2026-08-21 — leaked-link defence)", () => {
        // Flip the mock to unauthenticated for this block; restore
        // after so the hardening tests above keep working if
        // reordered. See also src/app/api/files/[name]/route.ts:47.
        it("returns 401 when auth() resolves to null (leaked link, no session)", async () => {
            const prior = authReturns;
            authReturns = null;
            try {
                const res = await callGET(pngName);
                expect(res.status).toBe(401);
            } finally {
                authReturns = prior;
            }
        });

        it("returns 401 when session has no user.id (malformed session shape)", async () => {
            const prior = authReturns;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            authReturns = { user: {} as any };
            try {
                const res = await callGET(pngName);
                expect(res.status).toBe(401);
            } finally {
                authReturns = prior;
            }
        });
    });
});
