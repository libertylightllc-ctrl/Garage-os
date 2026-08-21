/**
 * getViewableUrl / getViewableUrls — signed-URL refresh (AR 2026-08-21).
 *
 * Root case: saveUpload historically returned a Supabase signed URL
 * with a 7-day TTL and callers stored it on the row verbatim
 * (Booking.photoUrls, JobStep.photoUrl). After 7 days the URL 404s
 * even though the object itself is fine. The resolver re-signs at
 * render time and passes non-signed URLs through unchanged.
 *
 * Pure unit test — the Supabase client is not mocked because
 * parseSupabaseSignedUrl is the whole story for the pass-through
 * branch, and the actual re-sign path is exercised by the smoke +
 * live app. We're pinning:
 *   1. parseSupabaseSignedUrl correctly extracts bucket + key from
 *      the /storage/v1/object/sign/ URL shape.
 *   2. Non-Supabase URLs (local /api/files, external, blank) return
 *      null from the parser → getViewableUrl passes them through.
 */

import { describe, expect, it } from "vitest";
import { parseSupabaseSignedUrl, getViewableUrl } from "@/lib/storage";

describe("parseSupabaseSignedUrl", () => {
  it("parses a standard signed URL", () => {
    const url = "https://xyz.supabase.co/storage/v1/object/sign/garage-uploads/garages/g_123/photo.jpg?token=abc.def";
    const parsed = parseSupabaseSignedUrl(url);
    expect(parsed).toEqual({ bucket: "garage-uploads", key: "garages/g_123/photo.jpg" });
  });

  it("handles URL-encoded segments in the object key", () => {
    const url = "https://xyz.supabase.co/storage/v1/object/sign/bucket/garages/g%20id/photo%20one.jpg?token=abc";
    const parsed = parseSupabaseSignedUrl(url);
    expect(parsed).toEqual({ bucket: "bucket", key: "garages/g id/photo one.jpg" });
  });

  it("handles the /render/sign/ variant (image transforms)", () => {
    const url = "https://xyz.supabase.co/storage/v1/render/sign/bucket/garages/g_1/logo.png?token=abc&width=200";
    const parsed = parseSupabaseSignedUrl(url);
    expect(parsed).toEqual({ bucket: "bucket", key: "garages/g_1/logo.png" });
  });

  it("returns null on a local /api/files path", () => {
    expect(parseSupabaseSignedUrl("/api/files/abc.jpg")).toBeNull();
  });

  it("returns null on an external URL", () => {
    expect(parseSupabaseSignedUrl("https://example.com/photo.jpg")).toBeNull();
  });

  it("returns null on empty / non-string", () => {
    expect(parseSupabaseSignedUrl("")).toBeNull();
    // @ts-expect-error — deliberate: caller shape drift shouldn't throw.
    expect(parseSupabaseSignedUrl(null)).toBeNull();
    // @ts-expect-error — same discipline.
    expect(parseSupabaseSignedUrl(undefined)).toBeNull();
  });

  it("returns null on a public (unsigned) storage URL", () => {
    // /object/public/ has no signature; nothing to refresh, pass through.
    const url = "https://xyz.supabase.co/storage/v1/object/public/logos/g_1/logo.png";
    expect(parseSupabaseSignedUrl(url)).toBeNull();
  });
});

describe("getViewableUrl — pass-through paths (no Supabase call)", () => {
  it("passes /api/files/... paths through unchanged", async () => {
    const out = await getViewableUrl("/api/files/abcd.jpg");
    expect(out).toBe("/api/files/abcd.jpg");
  });

  it("passes external URLs through unchanged", async () => {
    const out = await getViewableUrl("https://example.com/photo.jpg");
    expect(out).toBe("https://example.com/photo.jpg");
  });

  it("passes empty string through unchanged", async () => {
    const out = await getViewableUrl("");
    expect(out).toBe("");
  });

  it("passes a public storage URL through unchanged", async () => {
    const url = "https://xyz.supabase.co/storage/v1/object/public/logos/g_1/logo.png";
    const out = await getViewableUrl(url);
    expect(out).toBe(url);
  });
});
