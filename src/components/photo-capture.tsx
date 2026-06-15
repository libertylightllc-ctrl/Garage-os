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
import { resizeForOcr } from "@/lib/resize-photo";

type Mode =
    | "auto-submit" // Moulkia: tap → camera → take photo → form auto-submits, no preview
    | "preview"; //   Everything else: tap → camera → thumbnail → Retake / Continue

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
      * If true, the captured file is downscaled to ~1024px JPEG before the form
      * submits. Saves 1-3s per OCR call by skipping Anthropic's remote
      * downsample step. Opt-in (Moulkia only) because we replace the user's
      * file in the input via DataTransfer — a small DOM trick that's safe but
      * unnecessary for non-OCR use cases. Fails open: if resize hangs / errors,
      * we submit the original file. Label shown during work.
      */
    optimizeForOcr?: boolean;
    /** Visible during the brief resize window, e.g. "Optimising photo…" */
    optimizingLabel?: string;
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
    optimizeForOcr = false,
    optimizingLabel,
}: Props) {
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [filename, setFilename] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [optimizing, setOptimizing] = useState(false);
    const icon = kind === "voice" ? "🎤" : "📷";

    /**
      * Replace the file currently in the input with a smaller one. Uses
      * DataTransfer — supported on iPhone Safari 14.5+ and all modern
      * Android browsers. If unsupported, silently keeps the original file.
      */
    function replaceInputFile(newFile: File) {
        const input = inputRef.current;
        if (!input) return;
        try {
            const dt = new DataTransfer();
            dt.items.add(newFile);
            input.files = dt.files;
        } catch {
            // Older Safari / non-standard env — leave the original file alone.
        }
    }

    const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
        setError(null);
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
            // Optional resize: shrink ~3-5 MB iPhone photos to ~300-700 KB before
            // the form auto-submits. resizeForOcr has its own internal timeout +
            // fail-open, so the worst case is "we submit the original file".
            if (optimizeForOcr && kind === "photo") {
                setOptimizing(true);
                try {
                    const r = await resizeForOcr(f);
                    if (!r.unchanged) replaceInputFile(r.file);
                } catch {
                    // fail-open — leave the original file in place
                } finally {
                    setOptimizing(false);
                }
            }
            inputRef.current?.closest("form")?.requestSubmit();
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
        if (inputRef.current) {
            inputRef.current.value = "";
            // Re-open the camera immediately.
            inputRef.current.click();
        }
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

    // ONE root wrapper for every state so the hidden <input> stays in the same
    // tree position. React reconciles it as the same DOM node across idle →
    // preview transitions, so the user's captured File is preserved instead
    // of being wiped when the input is unmounted into a different parent.
    // (That was the "Please select a file" bug on the check-in photo screen:
    // the photo preview was visible but Safari's form-level required check
    // saw an empty input because the DOM element had just been recreated.)
    const inPreview = preview || (filename && mode === "preview");

    return (
        <div className="flex flex-col gap-2">
            {fileInput}

            {inPreview ? (
                <>
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
                </>
            ) : (
                // Idle state — one big tappable label. htmlFor delegates clicks to
                // the input above, so we don't need to nest the input inside.
                <>
                    <label
                        htmlFor={inputId}
                        className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-black/15 px-4 py-8 text-center hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
                    >
                        <span className="text-4xl" aria-hidden>
                            {icon}
                        </span>
                        <span className="text-base font-semibold">{buttonLabel}</span>
                    </label>
                    {optimizing && optimizingLabel ? (
                        <p
                            className="rounded-md bg-zinc-100 px-3 py-2 text-center text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                            aria-live="polite"
                        >
                            ⚙️ {optimizingLabel}
                        </p>
                    ) : null}
                    {error ? (
                        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                            {error}
                        </p>
                    ) : null}
                </>
            )}
        </div>
    );
}
