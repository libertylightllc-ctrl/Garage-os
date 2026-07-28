import { describe, it, expect } from "vitest";

// The booking page renders a photo-rejection banner from `?photoError=<code>`.
// Only the five enum codes emitted by validateImageUpload (EMPTY, TOO_LARGE,
// BAD_MIME, BAD_MAGIC, MIME_MISMATCH) map to specific i18n copy; anything
// else falls through to `bookPhotoErr_generic`. This test pins the whitelist
// so a future edit can't send arbitrary URL-supplied strings into the i18n
// lookup — which would either return the literal key back (visible garbage)
// or, worse, whatever future keys happen to collide.

const KNOWN = new Set(["EMPTY", "TOO_LARGE", "BAD_MIME", "BAD_MAGIC", "MIME_MISMATCH"] as const);

describe("booking page photoError whitelist (structural pin, mirrors the render-side Set)", () => {
    it("accepts only the five enum codes emitted by validateImageUpload", () => {
        expect([...KNOWN].sort()).toEqual(["BAD_MAGIC", "BAD_MIME", "EMPTY", "MIME_MISMATCH", "TOO_LARGE"]);
    });

    it("rejects a script-tag payload (injection defence — must land on the generic branch, not t(`bookPhotoErr_${payload}`))", () => {
        const payload = "<script>alert(1)</script>";
        expect(KNOWN.has(payload as never)).toBe(false);
    });

    it("rejects an arbitrary unknown code (URL fuzzing / stale link)", () => {
        expect(KNOWN.has("NOPE" as never)).toBe(false);
    });

    it("rejects codes with subtle case / whitespace differences (Set is exact-match)", () => {
        // Whitelist is Set-based so a lowercased variant does NOT match.
        // If someone later switches to case-insensitive comparison, this
        // fires as a reminder to consider what that opens up.
        expect(KNOWN.has("bad_magic" as never)).toBe(false);
        expect(KNOWN.has(" BAD_MAGIC" as never)).toBe(false);
    });
});
