import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resizeForOcr,
  RESIZE_SKIP_BYTES,
  RESIZE_TIMEOUT_MS,
  RESIZE_MAX_EDGE,
  RESIZE_JPEG_QUALITY,
} from "./resize-photo";

function makeFile(bytes: number, type = "image/jpeg", name = "photo.jpg"): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("resizeForOcr — fail-open + skip rules", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns original file untouched when input is at or below the skip threshold", async () => {
    const small = makeFile(RESIZE_SKIP_BYTES);
    const r = await resizeForOcr(small);
    expect(r.unchanged).toBe(true);
    expect(r.savedBytes).toBe(0);
    expect(r.file).toBe(small);
  });

  it("returns original file when createImageBitmap HANGS forever", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(() => {})));
    const big = makeFile(2_000_000);
    const p = resizeForOcr(big);
    await vi.advanceTimersByTimeAsync(RESIZE_TIMEOUT_MS + 50);
    const r = await p;
    expect(r.unchanged).toBe(true);
    expect(r.file).toBe(big);
  });

  it("returns original file when createImageBitmap THROWS sync", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => {
        throw new Error("Format not supported");
      }),
    );
    const big = makeFile(2_000_000);
    const p = resizeForOcr(big);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.unchanged).toBe(true);
    expect(r.file).toBe(big);
  });

  it("returns original file when createImageBitmap REJECTS async", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => Promise.reject(new Error("Decode error"))),
    );
    const big = makeFile(2_000_000);
    const p = resizeForOcr(big);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.unchanged).toBe(true);
    expect(r.file).toBe(big);
  });

  it("returns original when canvas isn't available either", async () => {
    // Stub a successful createImageBitmap but kill the canvas paths.
    const fakeBitmap = { width: 4032, height: 3024 };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => fakeBitmap));
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);
    const big = makeFile(2_000_000);
    const p = resizeForOcr(big);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.unchanged).toBe(true);
    expect(r.file).toBe(big);
  });

  it("NEVER throws and NEVER returns a forever-pending promise", async () => {
    // Most hostile env possible — every API missing.
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("Image", undefined);
    vi.stubGlobal("URL", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);
    const big = makeFile(2_000_000);
    const p = resizeForOcr(big);
    await vi.advanceTimersByTimeAsync(RESIZE_TIMEOUT_MS + 100);
    const r = await p;
    expect(r.unchanged).toBe(true);
    expect(r.file).toBe(big);
  });
});

describe("constants are in sane ranges (catch accidental drift)", () => {
  it("RESIZE_MAX_EDGE between 512 and 2048", () => {
    expect(RESIZE_MAX_EDGE).toBeGreaterThanOrEqual(512);
    expect(RESIZE_MAX_EDGE).toBeLessThanOrEqual(2048);
  });
  it("RESIZE_JPEG_QUALITY between 0.7 and 0.95", () => {
    expect(RESIZE_JPEG_QUALITY).toBeGreaterThanOrEqual(0.7);
    expect(RESIZE_JPEG_QUALITY).toBeLessThanOrEqual(0.95);
  });
  it("RESIZE_TIMEOUT_MS between 500 and 3000", () => {
    expect(RESIZE_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
    expect(RESIZE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
  it("RESIZE_SKIP_BYTES under 1 MB (no point resizing already-small files)", () => {
    expect(RESIZE_SKIP_BYTES).toBeLessThan(1024 * 1024);
  });
});
