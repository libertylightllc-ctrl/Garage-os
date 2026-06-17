"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appendTranscript, bcp47ForLocale } from "@/lib/dictate";

// Same minimal Web Speech API typing as src/components/dictate.tsx — kept
// local rather than shared because the dictation hook there is tightly
// coupled to attaching to an existing input element. This component is
// the standalone "tap → speak → save a note" variant.
interface MinimalRecognition {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start(): void;
    stop(): void;
    onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((e: { error?: string }) => void) | null;
    onend: (() => void) | null;
}

interface RecognitionCtor {
    new (): MinimalRecognition;
}

function getRecognitionCtor(): RecognitionCtor | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as {
        SpeechRecognition?: RecognitionCtor;
        webkitSpeechRecognition?: RecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceNoteLabels {
    /** Idle CTA — "Voice Note". */
    tap: string;
    /** Live indicator under the listening button — "Listening… tap to stop". */
    listening: string;
    /** Listening button itself — "Tap to stop". */
    stop: string;
    /** "Save note". */
    save: string;
    /** Cancel/discard — clears the current transcript without saving. */
    cancel: string;
    /** Placeholder shown in the textarea when speech-to-text isn't
     *  available — "Type the note here". */
    typePlaceholder: string;
    /** Friendly fallback message when SpeechRecognition is missing
     *  (older Safari, Firefox, etc.) — keeps the workflow usable. */
    unsupported: string;
    /** Recognition error caption (mic permission denied, network, etc.) */
    error: string;
}

interface Props {
    /** The job this note attaches to — flows through as a hidden
     *  jobId form field on submit. */
    jobId: string;
    /** Locale → BCP-47 used by Web Speech ("ar" → ar-AE, "en" → en-US). */
    locale: string;
    labels: VoiceNoteLabels;
    /** Big-button CSS that matches the surrounding workshop tiles. */
    bigBtnClass: string;
    /** Server action — same addStepAction used by Photo / Voice / Finish.
     *  Submitted with hidden type="VOICE" and a transcript field. */
    action: (formData: FormData) => void | Promise<void>;
}

/**
 * "Voice Note" workshop tile — speech-to-text edition.
 *
 * Three states:
 *   1. idle      — big "Voice Note" tile. Tap → start recognition.
 *   2. capture   — live "Listening… tap to stop" indicator + an editable
 *                  textarea showing the running transcript. The mic and
 *                  the textarea share state, so the tech can dictate then
 *                  hand-edit before saving.
 *   3. unsupported — older browsers without Web Speech still get a usable
 *                    textarea + Save flow. Never falls through to the
 *                    file picker that the legacy PhotoCapture flow showed.
 *
 * On Save: form submits to the server action with type=VOICE and the
 * transcript text. addStepAction stores it on JobStep.transcript so it
 * renders in the Activity feed alongside the other steps.
 *
 * NOTE: this component intentionally does NOT touch the user's mic for
 * recording an audio file. Speech-to-text is the entire mechanism —
 * matches the dictation UX the technician already uses on findings.
 */
export function VoiceNoteDictation({ jobId, locale, labels, bigBtnClass, action }: Props) {
    const [active, setActive] = useState(false);
    const [listening, setListening] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [supported, setSupported] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const recRef = useRef<MinimalRecognition | null>(null);

    useEffect(() => {
        // Detect Web Speech support post-hydration so SSR markup matches
        // (same hydration-mismatch trick as dictate.tsx).
        // eslint-disable-next-line react-hooks/set-state-in-effect -- browser API detection
        setSupported(getRecognitionCtor() !== null);
        return () => {
            try {
                recRef.current?.stop();
            } catch {
                /* noop */
            }
        };
    }, []);

    const stop = useCallback(() => {
        try {
            recRef.current?.stop();
        } catch {
            /* noop */
        }
        setListening(false);
    }, []);

    const start = useCallback(() => {
        const Ctor = getRecognitionCtor();
        if (!Ctor) return;
        setError(null);

        const rec = new Ctor();
        rec.lang = bcp47ForLocale(locale);
        // Keep listening across pauses so a tech can think mid-sentence
        // without the recognizer cutting them off. They explicitly stop
        // via the "tap to stop" button.
        rec.continuous = true;
        rec.interimResults = false;

        rec.onresult = (e) => {
            let fresh = "";
            for (let i = 0; i < e.results.length; i++) {
                const alt = e.results[i]?.[0];
                if (alt) fresh += " " + alt.transcript;
            }
            // Append to whatever the tech may have already typed/dictated
            // — never erase prior input. Same helper used by the findings
            // mic so behavior matches everywhere.
            setTranscript((prev) => appendTranscript(prev, fresh));
        };
        rec.onerror = (e) => {
            if (e.error !== "aborted") setError(labels.error);
        };
        rec.onend = () => setListening(false);

        recRef.current = rec;
        try {
            rec.start();
            setListening(true);
        } catch {
            setError(labels.error);
        }
    }, [locale, labels.error]);

    // ── Idle state — the "Voice Note" tile in the workshop grid. ──
    if (!active) {
        return (
            <button
                type="button"
                onClick={() => {
                    setActive(true);
                    // Start recognition immediately if supported; the
                    // unsupported branch just opens the editor.
                    if (getRecognitionCtor()) start();
                }}
                className={bigBtnClass}
            >
                <span className="text-3xl">🎤</span>
                {labels.tap}
            </button>
        );
    }

    // ── Active state — listening + editable transcript ──
    return (
        <form
            action={action}
            className="col-span-2 flex flex-col gap-3 rounded-2xl border border-border p-4"
        >
            <input type="hidden" name="jobId" value={jobId} />
            <input type="hidden" name="type" value="VOICE" />

            {!supported ? (
                <p className="rounded-lg border border-warning-500/40 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                    ⚠️ {labels.unsupported}
                </p>
            ) : null}

            <textarea
                name="transcript"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                rows={4}
                placeholder={labels.typePlaceholder}
                required
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            />

            {supported ? (
                <button
                    type="button"
                    onClick={listening ? stop : start}
                    className={
                        listening
                            ? "inline-flex h-10 items-center justify-center rounded-lg bg-danger-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors animate-pulse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                            : "inline-flex h-10 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    }
                >
                    {listening ? `⏺ ${labels.stop}` : `🎤 ${labels.tap}`}
                </button>
            ) : null}

            {listening ? (
                <p className="text-xs text-danger-700 dark:text-danger-500">{labels.listening}</p>
            ) : null}
            {error ? (
                <p className="text-xs text-danger-700 dark:text-danger-500">{error}</p>
            ) : null}

            <div className="flex gap-2">
                <button
                    type="submit"
                    className="inline-flex h-10 flex-1 items-center justify-center rounded-lg bg-brand-900 px-4 text-sm font-semibold text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                >
                    {labels.save}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        stop();
                        setTranscript("");
                        setError(null);
                        setActive(false);
                    }}
                    className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-border bg-transparent px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                >
                    {labels.cancel}
                </button>
            </div>
        </form>
    );
}
