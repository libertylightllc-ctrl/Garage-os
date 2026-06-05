// Voice dictation (Web Speech API) — pure helpers so locale mapping and append
// behaviour are testable. The browser API itself lives in <Dictate>.

/**
 * BCP-47 language tag for SpeechRecognition.lang. Defaults to en-US for unknown
 * locales — better to listen in a known language than reject the request.
 */
export function bcp47ForLocale(locale: string | null | undefined): string {
  if (locale === "ar") return "ar-AE"; // Emirati Arabic — pilot is UAE-only
  if (locale === "en") return "en-US";
  return "en-US";
}

/**
 * Append a transcript fragment to existing text. Joins with a single space so
 * dictation NEVER erases what the user already typed. Trims trailing whitespace
 * to keep "hello " + "world" tidy.
 */
export function appendTranscript(prev: string, next: string): string {
  const a = (prev ?? "").replace(/\s+$/u, "");
  const b = (next ?? "").trim();
  if (!b) return a;
  if (!a) return b;
  return `${a} ${b}`;
}
