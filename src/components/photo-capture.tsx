"use client";

import { useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  defaultAccept,
  defaultCapture,
  fileTooBig,
  fileTypeMatches,
  type CaptureKind,
} from "@/lib/photo-capture";
import { isProbablyBlurry, BLUR_CHECK_TIMEOUT_MS } from "@/lib/blur-detect";

type Mode =
  | "auto-submit" // Moulkia: tap → camera → take photo → form auto-submits, no preview
  | "preview"; //   Everything else: tap → camera → thumbnail → Retake / Continue

export interface FramingTipLabels {
  /** Heading above the three tips, e.g. "For best results:" */
  heading: string;
  fill: string;
  flat: string;
  glare: string;
}

export interface BlurWarningLabels {
  /** e.g. "📷 Photo looks blurry — retake for a better read?" */
  message: string;
  /** Retake the photo (re-opens the camera). */
  retake: string;
  /** Submit anyway (override the warning). */
  useAnyway: string;
  /** Visible during the post-capture blur check — e.g. "Checking photo…" */
  checking: string;
}

interface Props {
  /** Form field name — the underlying <input type="file"> uses this. */
  name: string;
  mode: Mode;
  /** "photo" → camera; "voice" → microphone. Default photo. */
  kind?: CaptureKind;
  required?: boolean;
  /** Idle-state CTA, e.g. "Take photo of Moulkia". */
  buttonLabel: string;
  retakeLabel: string;
  /** Preview-mode submit button, e.g. "Use this photo". Ignored in auto-submit. */
  continueLabel?: string;
  tooBigLabel: string;
  wrongTypeLabel: string;
  /**
   * Optional pre-capture framing tips shown above the Take Photo button.
   * Set on the Moulkia front/back forms; leave off for voice notes and
   * generic technician photos where framing is less critical.
   */
  framingTips?: FramingTipLabels;
  /**
   * Optional post-capture blur check. When provided AND mode === "auto-submit",
   * runs a client-side Laplacian-variance check on the captured photo before
   * auto-submitting. If the photo is judged blurry, the user sees a small
   * "retake / use anyway" panel instead of immediate submit. Lenient by
   * default — see DEFAULT_BLUR_THRESHOLD in blur-detect.ts.
   */
  blurWarning?: BlurWarningLabels;
}

/**
 * One-tap photo / voice capture. Renders a big tappable label that wraps a hidden
 * <input type="file" accept capture> so:
 *   - On iPhone Safari (modern iOS): tap → camera opens directly (no chooser sheet)
 *   - On Android Chrome: tap → "Camera | Files" sheet
 *   - On desktop: tap → file picker (capture is silently ignored)
 *
 * Auto-submit mode is for the Moulkia OCR path: the form fires immediately after
 * the photo is captured so the advisor never has to hunt for a separate "submit"
 * button. Preview mode lets the user retake/confirm before submitting.
 */
export function PhotoCapture({
  name,
  mode,
  kind = "photo",
  required = false,
  buttonLabel,
  retakeLabel,
  continueLabel = "Continue →",
  tooBigLabel,
  wrongTypeLabel,
  framingTips,
  blurWarning,
}: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto-submit + blur-check states. `checking` shows a brief "checking..."
  // hint while we run the variance math (~30-100ms). `blurry` shows the
  // retake / use-anyway panel when the photo failed the sharpness gate.
  const [checking, setChecking] = useState(false);
  const [blurry, setBlurry] = useState(false);
  const icon = kind === "voice" ? "🎤" : "📷";

  const submitForm = () => {
    inputRef.current?.closest("form")?.requestSubmit();
  };

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setBlurry(false);
    const f = e.target.files?.[0];
    if (!f) return;

    if (!fileTypeMatches(f, kind)) {
      setError(wrongTypeLabel);
      e.target.value = "";
      return;
    }
    if (fileTooBig(f.size)) {
      setError(tooBigLabel);
      e.target.value = "";
      return;
    }

    setFilename(f.name);

    if (mode === "auto-submit") {
      // Blur gate — only when the parent opted in (Moulkia front/back).
      // Without it, behave exactly as before: submit immediately.
      if (blurWarning && kind === "photo") {
        setChecking(true);
        // Belt-and-braces timeout: isProbablyBlurry has its own internal
        // timeout, but if the entire await chain ever hangs (e.g. the
        // microtask queue stalls on iOS), this Promise.race guarantees
        // we still submit. The advisor must not be blocked on our heuristic.
        const TIMEOUT_GUARD = BLUR_CHECK_TIMEOUT_MS + 250;
        type Outcome = { kind: "result"; blurry: boolean } | { kind: "timeout" };
        const work: Promise<Outcome> = isProbablyBlurry(f)
          .then((r): Outcome => ({ kind: "result", blurry: r.blurry && !r.timedOut }))
          .catch((): Outcome => ({ kind: "timeout" }));
        const guard: Promise<Outcome> = new Promise((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), TIMEOUT_GUARD);
        });
        const outcome = await Promise.race([work, guard]);
        setChecking(false);
        if (outcome.kind === "result" && outcome.blurry) {
          setBlurry(true);
          return;
        }
        // result-but-sharp, or timeout → fall through and submit.
      }
      submitForm();
      return;
    }
    // preview mode — show a thumbnail for photos, just the filename for voice
    if (kind === "photo") {
      const url = URL.createObjectURL(f);
      setPreview(url);
    }
  };

  const onRetake = () => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setFilename(null);
    setError(null);
    setBlurry(false);
    setChecking(false);
    if (inputRef.current) {
      inputRef.current.value = "";
      // Re-open the camera immediately.
      inputRef.current.click();
    }
  };

  // Advisor overrides the blur warning — submit the captured file as-is.
  const onUseAnyway = () => {
    setBlurry(false);
    submitForm();
  };

  const fileInput = (
    <input
      ref={inputRef}
      id={inputId}
      type="file"
      name={name}
      accept={defaultAccept(kind)}
      capture={defaultCapture(kind)}
      required={required}
      onChange={onChange}
      className="sr-only"
    />
  );

  // Preview state (only reachable in mode="preview")
  if (preview || (filename && mode === "preview")) {
    return (
      <div className="flex flex-col gap-2">
        {fileInput}
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt=""
            className="max-h-64 rounded-lg border border-black/10 dark:border-white/15"
          />
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            {icon} {filename}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRetake}
            className="flex-1 rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            {icon} {retakeLabel}
          </button>
          <button
            type="submit"
            className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {continueLabel}
          </button>
        </div>
      </div>
    );
  }

  // Blurry-warn state — shown only after a failed sharpness check in
  // auto-submit mode. Two equal-weight choices: retake (good for them) or
  // submit anyway (their call — they're closer to the photo than we are).
  if (blurry && blurWarning) {
    return (
      <div className="flex flex-col gap-2">
        {fileInput}
        <div className="rounded-lg border border-amber-400/60 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          {blurWarning.message}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRetake}
            className="flex-1 rounded-lg border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            {icon} {blurWarning.retake}
          </button>
          <button
            type="button"
            onClick={onUseAnyway}
            className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            {blurWarning.useAnyway}
          </button>
        </div>
      </div>
    );
  }

  // Idle state — one big tappable button (+ optional framing tips above it)
  return (
    <div className="flex flex-col gap-3">
      {framingTips ? (
        <div className="rounded-lg border border-black/10 bg-zinc-50 p-3 text-xs text-zinc-700 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-300">
          <p className="font-medium">{framingTips.heading}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            <li>🖼️ {framingTips.fill}</li>
            <li>📐 {framingTips.flat}</li>
            <li>💡 {framingTips.glare}</li>
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label
          htmlFor={inputId}
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-black/15 px-4 py-8 text-center hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {fileInput}
          <span className="text-4xl" aria-hidden>
            {icon}
          </span>
          <span className="text-base font-semibold">{buttonLabel}</span>
        </label>
        {checking ? (
          <p
            className="rounded-md bg-zinc-100 px-3 py-2 text-center text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            aria-live="polite"
          >
            {icon} {blurWarning?.checking ?? "Checking…"}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
