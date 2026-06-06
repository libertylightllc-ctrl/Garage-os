// Client-side blur detection — used after a Moulkia photo is captured to
// flag obviously-bad shots BEFORE we burn a Claude OCR call on them.
//
// Why: native-camera capture (the <input capture> flow) gives no live
// preview to coach the framing, so the user happily ships a blurry photo
// and only finds out it failed 4 seconds later when OCR returns nothing.
// A fast post-capture variance check catches the worst ~20% of those.
//
// Algorithm: Laplacian variance. Convolve the grayscale frame with the
// 3×3 Laplacian kernel ([[0,1,0],[1,-4,1],[0,1,0]]) and take the variance
// of the result. Sharp photos have strong edges → high variance. Out-of-
// focus photos lose high-frequency detail → low variance.
//
// This is a coarse, well-known heuristic. It catches obvious out-of-focus
// shots; it will NOT catch motion blur, low light, or wrong-subject.
// Tune DEFAULT_BLUR_THRESHOLD once we have real garage captures.

/**
 * Convolve `gray` with the 3×3 Laplacian kernel and return the variance
 * of the response. Pure pixel math — no DOM, no canvas. Easy to unit-test.
 *
 *   Kernel:        0  1  0
 *                  1 -4  1
 *                  0  1  0
 *
 * Border pixels (1px frame) are skipped — they have no full 3×3 neighbourhood.
 * Returns 0 for images smaller than 3×3 (cannot compute).
 */
export function laplacianVariance(
  gray: ArrayLike<number>,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;

  const responses: number[] = [];
  let sum = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const r =
        gray[i - width] + // up
        gray[i - 1] + // left
        gray[i + 1] + // right
        gray[i + width] + // down
        -4 * gray[i];
      responses.push(r);
      sum += r;
    }
  }

  const n = responses.length;
  if (n === 0) return 0;
  const mean = sum / n;
  let sq = 0;
  for (const r of responses) {
    const d = r - mean;
    sq += d * d;
  }
  return sq / n;
}

/**
 * Lenient default — only flag photos that are clearly bad. Better to let a
 * borderline shot through and have Claude handle it than to badger advisors
 * with false "blurry?" prompts on shots that would have OCR'd fine.
 *
 * Re-tune once we have a week of real captures + AiEvent OCR-failure rate.
 */
export const DEFAULT_BLUR_THRESHOLD = 15;

/**
 * Cap the downscale longest-edge at this many pixels. Laplacian variance is
 * scale-sensitive — comparing the same photo at 2000px vs 256px gives very
 * different numbers. Downscaling to a fixed size normalises this AND keeps
 * the math fast on phones (~30ms on an iPhone 12 at 256px).
 */
export const BLUR_SAMPLE_MAX_EDGE = 256;

/**
 * Hard cap on how long the blur check is allowed to take. iOS Safari's
 * `createImageBitmap` has been observed to hang on certain captured photos
 * (HEIC, awkward EXIF orientation, very large files). Past this budget we
 * give up, fail-open, and let the photo submit — never block the advisor
 * on our heuristic.
 */
export const BLUR_CHECK_TIMEOUT_MS = 1500;

export interface BlurResult {
  blurry: boolean;
  variance: number;
  threshold: number;
  /** True when the timeout fired before we could decide — caller should fail-open. */
  timedOut?: boolean;
}

/**
 * Race a promise against a timeout. On timeout, resolves with `onTimeout`
 * value; the underlying work is NOT cancelled (we can't cancel
 * createImageBitmap) but its eventual result is ignored.
 */
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

/**
 * Run the blur check on a captured image file. Resolves with the variance
 * + the blurry verdict. Designed to be called from onChange in the
 * PhotoCapture component, BEFORE the form auto-submits.
 *
 * Internal timeout (BLUR_CHECK_TIMEOUT_MS) guards against iOS Safari
 * `createImageBitmap` hangs — past the budget we return `timedOut: true`
 * with a non-blurry verdict so the caller submits the photo anyway. The
 * caller MAY also impose its own timeout (PhotoCapture does); both are
 * belt-and-braces.
 */
export async function isProbablyBlurry(
  file: File,
  threshold = DEFAULT_BLUR_THRESHOLD,
): Promise<BlurResult> {
  const failOpen: BlurResult = { blurry: false, variance: 0, threshold };
  const timedOut: BlurResult = { ...failOpen, timedOut: true };

  const work = (async (): Promise<BlurResult> => {
    try {
      const { gray, width, height } = await fileToDownscaledGrayscale(
        file,
        BLUR_SAMPLE_MAX_EDGE,
      );
      if (width < 3 || height < 3) return failOpen;
      const variance = laplacianVariance(gray, width, height);
      return { blurry: variance < threshold, variance, threshold };
    } catch {
      // createImageBitmap unsupported, canvas missing, file corrupt — let
      // the OCR fallback chain handle the photo. Failing-open is the call.
      return failOpen;
    }
  })();

  return withTimeout(work, BLUR_CHECK_TIMEOUT_MS, timedOut);
}

interface DownscaledFrame {
  gray: Uint8ClampedArray;
  width: number;
  height: number;
}

async function fileToDownscaledGrayscale(
  file: File,
  maxEdge: number,
): Promise<DownscaledFrame> {
  const { bitmap, revoke } = await loadBitmap(file);
  try {
    return await drawAndExtract(bitmap, maxEdge);
  } finally {
    // Revoke the object URL ONLY after drawImage has consumed it (Safari
    // requires the source URL still resolve when drawImage runs).
    revoke?.();
  }
}

async function drawAndExtract(bitmap: LoadedFrame, maxEdge: number): Promise<DownscaledFrame> {
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);

  // Prefer OffscreenCanvas — avoids touching the DOM, runs slightly faster
  // and is safe inside web-workers (future-proofs us if we ever move this
  // off the main thread).
  type AnyCtx = {
    drawImage: (
      img: CanvasImageSource,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => void;
    getImageData: (sx: number, sy: number, sw: number, sh: number) => ImageData;
  };

  let ctx: AnyCtx | null = null;
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => {
      getContext: (k: string) => AnyCtx | null;
    };
    document?: { createElement: (tag: string) => HTMLCanvasElement };
  };
  if (typeof g.OffscreenCanvas !== "undefined") {
    const off = new g.OffscreenCanvas(width, height);
    ctx = off.getContext("2d");
  } else if (g.document) {
    const canvas = g.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext("2d") as unknown as AnyCtx | null;
  }
  if (!ctx) throw new Error("No canvas available");

  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  // RGBA → 8-bit grayscale (Rec. 709 luma — same weights Safari uses for
  // canvas-implicit grayscale, so results match between browsers).
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) | 0;
  }
  return { gray, width, height };
}

// Narrowed loader return — both ImageBitmap and HTMLImageElement expose
// width/height directly. (CanvasImageSource is a wider union that also
// includes VideoFrame, which doesn't — hence this dedicated type.)
type LoadedFrame = (ImageBitmap | HTMLImageElement) & { width: number; height: number };

interface LoadedBitmap {
  bitmap: LoadedFrame;
  /** Caller MUST invoke this once it's done drawing — releases the object URL. */
  revoke?: () => void;
}

async function loadBitmap(file: File): Promise<LoadedBitmap> {
  const g = globalThis as unknown as {
    createImageBitmap?: (f: Blob) => Promise<ImageBitmap>;
    Image?: new () => HTMLImageElement;
    URL?: typeof URL;
  };
  if (g.createImageBitmap) {
    const bitmap = (await g.createImageBitmap(file)) as LoadedFrame;
    return { bitmap };
  }

  // Safari < 14.0 fallback — load via <img> + object URL.
  if (!g.Image || !g.URL) throw new Error("No image loader available");
  const url = g.URL.createObjectURL(file);
  try {
    const bitmap = await new Promise<LoadedFrame>((resolve, reject) => {
      const img = new g.Image!();
      img.onload = () => resolve(img as LoadedFrame);
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = url;
    });
    return { bitmap, revoke: () => g.URL!.revokeObjectURL(url) };
  } catch (e) {
    // Decode failed → release the URL now; nothing to draw.
    g.URL.revokeObjectURL(url);
    throw e;
  }
}

function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h };
  const scale = w >= h ? maxEdge / w : maxEdge / h;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
