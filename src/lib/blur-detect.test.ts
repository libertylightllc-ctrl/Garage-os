import { describe, it, expect } from "vitest";
import { laplacianVariance, DEFAULT_BLUR_THRESHOLD } from "./blur-detect";

// Helper: build a width×height grayscale frame from a pixel function.
function frame(width: number, height: number, fn: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = fn(x, y);
    }
  }
  return out;
}

describe("laplacianVariance — pure math", () => {
  it("returns 0 for frames smaller than 3×3 (no interior pixels)", () => {
    expect(laplacianVariance(new Uint8ClampedArray(4), 2, 2)).toBe(0);
    expect(laplacianVariance(new Uint8ClampedArray(1), 1, 1)).toBe(0);
  });

  it("returns 0 for a uniform frame (no edges at all)", () => {
    const flat = frame(32, 32, () => 128);
    expect(laplacianVariance(flat, 32, 32)).toBe(0);
  });

  it("is very low for a smooth gradient (low high-frequency content)", () => {
    // Linear gradient — Laplacian of a linear function is 0 everywhere.
    const gradient = frame(32, 32, (x) => (x * 8) & 0xff);
    expect(laplacianVariance(gradient, 32, 32)).toBeLessThan(1);
  });

  it("is HIGH for a sharp checkerboard (every pixel a hard edge)", () => {
    // Single-pixel checkerboard — max possible Laplacian response per pixel.
    const checker = frame(32, 32, (x, y) => ((x + y) & 1) * 255);
    const v = laplacianVariance(checker, 32, 32);
    expect(v).toBeGreaterThan(10_000);
  });

  it("ranks sharp > soft-blurred > flat (the ordering is what matters)", () => {
    const sharp = laplacianVariance(
      frame(64, 64, (x, y) => ((x + y) & 1) * 255),
      64,
      64,
    );
    // 4-pixel blocks instead of 1-pixel — same pattern, much lower edge density.
    const soft = laplacianVariance(
      frame(64, 64, (x, y) => ((((x / 4) | 0) + ((y / 4) | 0)) & 1) * 255),
      64,
      64,
    );
    const flat = laplacianVariance(
      frame(64, 64, () => 128),
      64,
      64,
    );
    expect(sharp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(flat);
  });

  it("a flat frame is below the lenient threshold (would be flagged as blurry)", () => {
    const flat = frame(64, 64, () => 200);
    expect(laplacianVariance(flat, 64, 64)).toBeLessThan(DEFAULT_BLUR_THRESHOLD);
  });

  it("a sharp frame is comfortably above the lenient threshold (would NOT be flagged)", () => {
    const sharp = frame(64, 64, (x, y) => ((x + y) & 1) * 255);
    expect(laplacianVariance(sharp, 64, 64)).toBeGreaterThan(DEFAULT_BLUR_THRESHOLD * 100);
  });

  it("supports a plain number[] (not just Uint8ClampedArray) — useful for ad-hoc tests", () => {
    // 5×5 with a bright central pixel — the 3×3 interior has 9 Laplacian
    // responses (mostly 0, one strongly negative) so variance is non-zero.
    // (A 3×3 input has only ONE interior pixel — variance of a single sample
    // is zero by definition, which is correct behaviour, not what we're
    // testing here.)
    const arr: number[] = new Array(25).fill(0);
    arr[12] = 255; // centre of the 5×5
    expect(laplacianVariance(arr, 5, 5)).toBeGreaterThan(0);
  });
});

describe("DEFAULT_BLUR_THRESHOLD — sanity-check the constant we ship with", () => {
  it("is in the 'lenient' band — only obviously bad photos get flagged", () => {
    // We chose lenient at launch (see plan). If someone bumps this without
    // thinking, the test surfaces it — review the change before shipping.
    expect(DEFAULT_BLUR_THRESHOLD).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_BLUR_THRESHOLD).toBeLessThanOrEqual(40);
  });
});
