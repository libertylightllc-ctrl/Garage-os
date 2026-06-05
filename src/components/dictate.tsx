"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { appendTranscript, bcp47ForLocale } from "@/lib/dictate";

// Privacy note: some browsers (notably Chrome) send the captured audio to a
// remote service (Google) for transcription. Acceptable for the pilot — no PII
// beyond the customer complaint/diagnosis/etc. — but document if a customer asks.

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

interface DictateLabels {
  start: string;
  stop: string;
  listening: string;
  error: string;
}

interface CommonProps {
  locale: string;
  labels: DictateLabels;
}

function useDictation<T extends HTMLInputElement | HTMLTextAreaElement>(
  locale: string,
  labels: DictateLabels,
) {
  const ref = useRef<T | null>(null);
  const recRef = useRef<MinimalRecognition | null>(null);
  // MUST start false so SSR markup matches the client's first hydration render
  // (the lazy initializer ran on the server and saw no `window`, producing no
  // button; if we initialised true on the client we'd hit a hydration mismatch).
  // Flip to true in an effect after mount — the mic then appears post-hydration.
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-API detection
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
    const el = ref.current;
    if (!Ctor || !el) return;
    setError(null);

    const rec = new Ctor();
    rec.lang = bcp47ForLocale(locale);
    rec.continuous = false;
    rec.interimResults = false;

    rec.onresult = (e) => {
      // Concatenate all final results (we requested interimResults=false).
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) {
        const alt = e.results[i]?.[0];
        if (alt) transcript += " " + alt.transcript;
      }
      const next = appendTranscript(el.value, transcript);
      el.value = next;
      // Dispatch input so any listeners / styles depending on value update.
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    rec.onerror = (e) => {
      // "no-speech" / "aborted" / "audio-capture" / "not-allowed" / "network"
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

  return { ref, supported, listening, error, start, stop };
}

const MIC_BTN_BASE =
  "inline-flex shrink-0 items-center justify-center rounded-md border text-base leading-none";
const MIC_BTN_IDLE =
  "border-black/15 bg-transparent text-zinc-500 hover:bg-black/5 dark:border-white/20 dark:text-zinc-300 dark:hover:bg-white/10";
const MIC_BTN_LISTENING =
  "border-red-500 bg-red-500 text-white animate-pulse";

function MicButton({
  supported,
  listening,
  start,
  stop,
  labels,
  className,
}: {
  supported: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
  labels: DictateLabels;
  className?: string;
}) {
  if (!supported) return null;
  return (
    <button
      type="button"
      aria-label={listening ? labels.stop : labels.start}
      title={listening ? labels.stop : labels.start}
      onClick={listening ? stop : start}
      className={`${MIC_BTN_BASE} ${listening ? MIC_BTN_LISTENING : MIC_BTN_IDLE} h-8 w-8 ${className ?? ""}`}
    >
      🎤
    </button>
  );
}

// ---- Public components ----------------------------------------------------

type DictateInputProps = ComponentProps<"input"> & CommonProps;

export function DictateInput({ locale, labels, className, ...rest }: DictateInputProps) {
  const labelsMemo = useMemo(() => labels, [labels.start, labels.stop, labels.listening, labels.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const { ref, supported, listening, error, start, stop } = useDictation<HTMLInputElement>(
    locale,
    labelsMemo,
  );
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <input ref={ref} {...rest} className={className} />
        <MicButton supported={supported} listening={listening} start={start} stop={stop} labels={labelsMemo} />
      </span>
      {listening ? (
        <span className="text-xs text-red-600 dark:text-red-400">{labelsMemo.listening}</span>
      ) : null}
      {error ? (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : null}
    </span>
  );
}

type DictateTextareaProps = ComponentProps<"textarea"> & CommonProps;

export function DictateTextarea({
  locale,
  labels,
  className,
  ...rest
}: DictateTextareaProps) {
  const labelsMemo = useMemo(() => labels, [labels.start, labels.stop, labels.listening, labels.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const { ref, supported, listening, error, start, stop } = useDictation<HTMLTextAreaElement>(
    locale,
    labelsMemo,
  );
  return (
    <span className="relative flex flex-col gap-1">
      <textarea ref={ref} {...rest} className={className} />
      <MicButton
        supported={supported}
        listening={listening}
        start={start}
        stop={stop}
        labels={labelsMemo}
        className="absolute end-1 top-1"
      />
      {listening ? (
        <span className="text-xs text-red-600 dark:text-red-400">{labelsMemo.listening}</span>
      ) : null}
      {error ? (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : null}
    </span>
  );
}
