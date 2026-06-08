// Client-side photo resize — used before submitting a captured photo to
// the Moulkia OCR pipeline. Saves 1-3 seconds per scan by:
//   - Cutting upload time (3-5 MB iPhone JPEG → 300-700 KB)
//   - Letting us send pixels Claude actually uses (vision API caps at
//     1568x1568 anyway — everything bigger gets downsampled remotely)
//   - Shrinking the base64 buffer the Server Action has to parse
//
// Lessons from the blur-check incident, applied here:
//   1. Internal timeout — if createImageBitmap hangs on a HEIC photo,
//      we fail open and return the original File (caller submits as-is).
//   2. NEVER throws. Returns the original File on any error path.
//   3. No DOM dependencies on import — safe to import in SSR contexts.
//
// All capped sizes / quality are constants so they're easy to tune.

/**
 * Longest-edge target after resize. 1568px matches Anthropic's internal
 * vision-API downsample cap — anything bigger gets shrunk there anyway,
 * and anything smaller loses text legibility on a card the size of a
 * credit card. After real-iPhone testing showed too-small images caused
 * OCR misreads, we moved up from 1024px → 1568px.
 */
export const RESIZE_MAX_EDGE = 1568;
/**
 * JPEG quality — 0.92 preserves the fine print on small Moulkia text far
 * better than the 0.85 we shipped first. Files stay well under 1 MB at
 * this size which is fine for our 4 MB server-action limit.
 */
export const RESIZE_JPEG_QUALITY = 0.92;
/**
 * Hard cap on time spent resizing. Past this we give up and submit the
 * original file — same fail-open philosophy as isProbablyBlurry.
 */
export const RESIZE_TIMEOUT_MS = 1500;
/**
 * Skip the resize entirely for files already this small or smaller —
 * not worth the CPU + thermal cost on iPhone.
 */
export const RESIZE_SKIP_BYTES = 600 * 1024; // 600 KB

export interface ResizeResult {
  file: File;
  /** True when the original was returned unchanged (skip / fail-open / timeout). */
  unchanged: boolean;
  /** Bytes saved (0 when unchanged). */
  savedBytes: number;
}

export async function resizeForOcr(input: File): Promise<ResizeResult> {
  // Tiny file → no point resizing.
  if (input.size <= RESIZE_SKIP_BYTES) {
    return { file: input, unchanged: true, savedBytes: 0 };
  }

  const failOpen: ResizeResult = { file: input, unchanged: true, savedBytes: 0 };

  const work = (async (): Promise<ResizeResult> => {
    try {
      const blob = await downscaleToJpeg(input, RESIZE_MAX_EDGE, RESIZE_JPEG_QUALITY);
      if (!blob || blob.size >= input.size) {
        // Resize didn't help (e.g. already-small JPEG, or canvas re-encoded
        // larger than the source). Keep the original.
        return failOpen;
      }
      const resized = new File([blob], input.name.replace(/\.[^.]+$/, "") + ".jpg", {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
      return { file: resized, unchanged: false, savedBytes: input.size - resized.size };
    } catch {
      return failOpen;
    }
  })();

  return withTimeout(work, RESIZE_TIMEOUT_MS, failOpen);
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(onTimeout), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      () => {
        clearTimeout(id);
        resolve(onTimeout);
      },
    );
  });
}

async function downscaleToJpeg(
  file: File,
  maxEdge: number,
  quality: number,
): Promise<Blob | null> {
  const bitmap = await loadBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);

  type AnyCtx = {
    drawImage: (
      img: CanvasImageSource,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => void;
  };

  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => {
      getContext: (k: string) => AnyCtx | null;
      convertToBlob: (opts: { type: string; quality: number }) => Promise<Blob>;
    };
    document?: { createElement: (tag: string) => HTMLCanvasElement };
  };

  // Path 1 — OffscreenCanvas (faster, off-DOM)
  if (typeof g.OffscreenCanvas !== "undefined") {
    const off = new g.OffscreenCanvas(width, height);
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return off.convertToBlob({ type: "image/jpeg", quality });
  }

  // Path 2 — regular canvas + toBlob (broad compatibility)
  if (!g.document) return null;
  const canvas = g.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (b) => resolve(b),
      "image/jpeg",
      quality,
    );
  });
}

type LoadedFrame = (ImageBitmap | HTMLImageElement) & { width: number; height: number };

async function loadBitmap(file: File): Promise<LoadedFrame> {
  const g = globalThis as unknown as {
    createImageBitmap?: (f: Blob) => Promise<ImageBitmap>;
    Image?: new () => HTMLImageElement;
    URL?: typeof URL;
  };
  if (g.createImageBitmap) return (await g.createImageBitmap(file)) as LoadedFrame;

  if (!g.Image || !g.URL) throw new Error("No image loader available");
  const url = g.URL.createObjectURL(file);
  try {
    return await new Promise<LoadedFrame>((resolve, reject) => {
      const img = new g.Image!();
      img.onload = () => resolve(img as LoadedFrame);
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = url;
    });
  } catch (e) {
    g.URL.revokeObjectURL(url);
    throw e;
  }
  // NOTE: object URL is intentionally not revoked on success — caller may
  // draw from it. Revoking here causes Safari to draw a blank canvas
  // (same bug we fixed in blur-detect's fallback path).
}

function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h };
  const scale = w >= h ? maxEdge / w : maxEdge / h;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
