/**
 * Language detection from a WhatsApp message body. AR 2026-08-19.
 *
 * The old `resolveLang(customerLang, body)` in receptionist-engine.ts
 * only detected Hindi from Devanagari script. Every other body fell
 * back to `customer.lang` — the CUSTOMER'S SAVED language, which
 * every prod row carried as "ar" (per an audit on 2026-08-19: 22
 * customers, all "ar", every one from the schema default; no code
 * path ever wrote another value). Result: an English message from
 * the customer got an Arabic reply from the AI.
 *
 * This module returns the language actually spoken IN THE BODY,
 * not the language stored on the customer row. Null means "not
 * confident enough" — the caller routes to human approval rather
 * than auto-firing a wrong-language message.
 *
 * Purely lexical detection. No LLM, no dictionary. The scripts
 * used by our supported languages are distinct enough that a
 * character-class scan gives the right answer for real customer
 * messages. Edge cases (an Arabic customer typing English in
 * Latin, an English customer with a stray Arabic word) fall into
 * "ambiguous" → human approval.
 *
 * See business-rules.md rule 4 (WhatsApp hand-off is not delivery) —
 * an auto-fired wrong-language reply on a wa.me channel can't be
 * retracted, so the confidence bar is deliberately high.
 */

import type { Lang } from "./receptionist";

// Unicode block ranges for scripts we can distinguish.
// - Arabic: U+0600–U+06FF (Arabic + Arabic Supplement basics)
//   plus a subset of U+0750–U+077F (Arabic Supplement) for common
//   diacritics that appear in normal Arabic text.
// - Urdu: shares the Arabic script but uses characteristic extra
//   letters (U+0679 ٹ, U+0688 ڈ, U+0691 ڑ, U+06BA ں, U+06BE ھ,
//   U+06C1 ہ, U+06C3 ۃ, U+06CC ی, U+06D2 ے) that don't appear in
//   standard Arabic. We detect Urdu ONLY when at least one of these
//   is present — otherwise Arabic-script → "ar".
// - Devanagari: U+0900–U+097F → "hi".
// - Latin: everything else in the ASCII printable range → "en".
const RE_ARABIC = /[؀-ۿݐ-ݿ]/;
const RE_URDU_SPECIFIC = /[ٹڈڑںھہۃیے]/;
const RE_DEVANAGARI = /[ऀ-ॿ]/;
const RE_LATIN_LETTER = /[A-Za-z]/;

/**
 * Detect the language of a WhatsApp body. Returns null when we can't
 * confidently pick one — caller falls back to `customer.lang` OR
 * routes the reply through human approval, depending on the send
 * path's risk tolerance.
 *
 * Signals (in order):
 *   1. Devanagari script present → "hi".
 *   2. Any Urdu-specific character present → "ur".
 *   3. Arabic-script characters present (and no Urdu marker) → "ar".
 *   4. Latin letters present (and no other script) → "en".
 *   5. Otherwise (empty, digits-only, punctuation-only, unknown
 *      script) → null.
 */
export function detectLangFromBody(body: string): Lang | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;

  if (RE_DEVANAGARI.test(trimmed)) return "hi";
  if (RE_URDU_SPECIFIC.test(trimmed)) return "ur";
  if (RE_ARABIC.test(trimmed)) return "ar";
  // Only claim "en" when there's an actual Latin letter — a message
  // of pure digits + punctuation ("+971 50 111 2222") is
  // ambiguous, not English.
  if (RE_LATIN_LETTER.test(trimmed)) return "en";

  return null;
}
