// Moulkia (UAE vehicle registration card) OCR — TWO-SIDED.
//   Front side  → owner name + plate number
//   Back side   → VIN + make + model + year
// Splitting by side gives Claude a focused prompt per call and avoids cross-side
// confusion; each side has its own AI metering row so cost + reliability per
// model + per side is visible.
//
// Each side uses the same primary→fallback chain (Haiku 4.5 → Sonnet 4.6).
//
// Privacy: images are processed in-memory and NEVER persisted — we store only
// the extracted fields, and only after the advisor confirms.

import { estimateCostUsd } from "@/lib/ai";

export interface MoulkiaFront {
  ownerName: string;
  plate: string;
  // The FRONT also shows vehicle make / model / year / VIN on most UAE
  // Moulkias. We extract them here so a single front photo can prefill
  // every spec — the back step still runs and overrides on overlap.
  vin: string;
  make: string;
  model: string;
  year: number | null;
}

export interface MoulkiaBack {
  vin: string;
  make: string;
  model: string;
  year: number | null;
}

/** The full set carried into the confirm form (after merging front + back). */
export interface MoulkiaFields extends MoulkiaFront, MoulkiaBack {}

/** One OCR attempt's metering record — the caller writes one AiEvent per row. */
export interface OcrAttempt {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  error?: string; // present when this attempt failed
}

export interface OcrResult<T> {
  fields: T;
  attempts: OcrAttempt[];
  failed?: boolean;
}

export function ocrEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Verified against https://platform.claude.com/docs (Models overview) on 2026-06-05:
//   Sonnet 4.6: $3/$15 per Mtok, stronger OCR, vision-capable     ← PRIMARY
//   Haiku  4.5: $1/$5  per Mtok, fastest, vision-capable          ← FALLBACK
// Order was swapped (was Haiku-first) after real iPhone testing showed
// Haiku misread UAE Moulkias often enough that the advisor had to retype
// fields. Sonnet is ~2× slower per call but accuracy >> raw speed for the
// reception flow — a correct first scan beats two fast wrong ones.
export const OCR_PRIMARY = process.env.ANTHROPIC_OCR_MODEL ?? "claude-sonnet-4-6";
export const OCR_FALLBACK = process.env.ANTHROPIC_OCR_FALLBACK_MODEL ?? "claude-haiku-4-5";

export const EMPTY_FRONT: MoulkiaFront = {
  ownerName: "",
  plate: "",
  vin: "",
  make: "",
  model: "",
  year: null,
};
export const EMPTY_BACK: MoulkiaBack = {
  vin: "",
  make: "",
  model: "",
  year: null,
};
export const EMPTY_FIELDS: MoulkiaFields = { ...EMPTY_FRONT, ...EMPTY_BACK };

/** Demo sample (no API key) so reception intake stays demoable. */
export function mockMoulkiaFront(): MoulkiaFront {
  return {
    ownerName: "Mohammed Al Maktoum",
    plate: "D 12345",
    vin: "JN1TANT32U0123456",
    make: "Nissan",
    model: "Patrol",
    year: 2022,
  };
}
export function mockMoulkiaBack(): MoulkiaBack {
  return {
    vin: "JN1TANT32U0123456",
    make: "Nissan",
    model: "Patrol",
    year: 2022,
  };
}

function toYear(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 1950 && n <= 2100 ? n : null;
}

function pickStr(obj: Record<string, unknown>, key: string): string {
  return String(obj[key] ?? "").trim();
}

function parseJsonLoose(raw: string): Record<string, unknown> {
  try {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    return a >= 0 && b > a ? (JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseMoulkiaFrontJson(raw: string): MoulkiaFront {
  const o = parseJsonLoose(raw);
  return {
    ownerName: pickStr(o, "ownerName"),
    plate: pickStr(o, "plate"),
    vin: pickStr(o, "vin"),
    make: pickStr(o, "make"),
    model: pickStr(o, "model"),
    year: toYear(o["year"]),
  };
}

export function parseMoulkiaBackJson(raw: string): MoulkiaBack {
  const o = parseJsonLoose(raw);
  return {
    vin: pickStr(o, "vin"),
    make: pickStr(o, "make"),
    model: pickStr(o, "model"),
    year: toYear(o["year"]),
  };
}

export function isEmptyFront(f: MoulkiaFront): boolean {
  // Soft-fail when NONE of the front fields came back — owner + plate are
  // the must-haves, but if vehicle specs are also blank that's a stronger
  // signal the photo was unreadable. We still flag empty on any identity
  // miss so the fallback model gets a chance, even when specs survived.
  return !f.ownerName && !f.plate;
}

export function isEmptyBack(b: MoulkiaBack): boolean {
  return !b.vin && !b.make && !b.model && (b.year == null || b.year === 0);
}

/**
 * Merge front + back into one field set.
 *
 * Identity (owner / plate): front only — never on the back.
 * Vehicle specs (VIN / make / model / year): now appear on BOTH sides.
 *   - BACK wins on overlap — it's the spec card, more authoritative.
 *   - When BACK is empty / missing, fall through to the FRONT value so a
 *     skipped or unreadable back still keeps the data the front captured.
 * Empty strings / null never overwrite a populated value.
 */
export function mergeMoulkiaFields(
  front: Partial<MoulkiaFront>,
  back: Partial<MoulkiaBack>,
): MoulkiaFields {
  const backFirst = (b: string | undefined, f: string | undefined) =>
    b?.trim() || f?.trim() || "";
  return {
    ownerName: front.ownerName?.trim() || "",
    plate: front.plate?.trim() || "",
    vin: backFirst(back.vin, front.vin),
    make: backFirst(back.make, front.make),
    model: backFirst(back.model, front.model),
    // back wins on year, but if back didn't capture it, take what the front got
    year: back.year ?? front.year ?? null,
  };
}

// ---------------------------------------------------------------------------
// Claude vision call (shared between front and back; prompt is the variable)
// ---------------------------------------------------------------------------

// Sharper prompts after real iPhone testing showed Haiku misreading fields.
// We name the on-card labels we actually see on UAE Moulkias so the model
// knows exactly where each value lives, and we explicitly say "prefer the
// Latin/English transliteration" because the cards are bilingual and the
// Arabic side is rendered with diacritics that often OCR poorly.
const FRONT_SYSTEM_PROMPT =
  "You read the FRONT side of a UAE Moulkia (vehicle registration card) image and reply with ONLY a JSON object: " +
  '{"ownerName": string, "plate": string, "make": string, "model": string, "year": number, "vin": string}. ' +
  "Extract the owner name from the middle section of the front of the Moulkia card. " +
  "Also extract vehicle make, model, year, and VIN. Return all four fields. " +
  "Layout cues — the card has these labelled rows: 'Owner' (middle, bilingual — pick the Latin/English line, full name), " +
  "'Plate No' / 'T.C No' (top, alphanumeric with emirate code like 'A 12345' or 'DXB A 12345'), " +
  "'Veh. Type' / 'Make' (lower-middle), 'Model' (next to or below Make), " +
  "'Model Year' (the four-digit year), and 'Chassis No' / 'VIN' (bottom row, 17 alphanumeric chars). " +
  "Read the Latin/English transcription, never the Arabic. " +
  "If a field is unreadable use an empty string (or 0 for year). No prose, no markdown, no code fences — just the JSON object.";

const BACK_SYSTEM_PROMPT =
  "You read the BACK side of a UAE Moulkia (vehicle registration card) image and reply with ONLY a JSON object: " +
  '{"vin": string, "make": string, "model": string, "year": number}. ' +
  "Layout cues — 'Chassis No' / 'VIN' (17 alphanumeric chars), 'Make' (manufacturer), 'Model' (variant), " +
  "'Model Year' (four-digit year). Read the Latin/English transcription, never the Arabic. " +
  "If a field is unreadable use an empty string (or 0 for year). No prose, no markdown, no code fences — just the JSON object.";

interface ClaudeRaw {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

async function callClaudeVision(
  model: string,
  systemPrompt: string,
  userText: string,
  base64: string,
  mediaType: string,
): Promise<ClaudeRaw> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: userText },
          ],
        },
      ],
    }),
  });
  const j = (await res.json()) as {
    content?: { text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`Anthropic vision error ${res.status}: ${j.error?.message ?? "(no message)"}`);
  }
  return {
    text: j.content?.[0]?.text ?? "{}",
    tokensIn: j.usage?.input_tokens ?? 0,
    tokensOut: j.usage?.output_tokens ?? 0,
  };
}

async function tryAttempt<T>(
  model: string,
  systemPrompt: string,
  userText: string,
  parser: (raw: string) => T,
  isEmpty: (t: T) => boolean,
  base64: string,
  mediaType: string,
): Promise<{ attempt: OcrAttempt; fields: T | null }> {
  const start = Date.now();
  try {
    const r = await callClaudeVision(model, systemPrompt, userText, base64, mediaType);
    const latencyMs = Date.now() - start;
    const fields = parser(r.text);
    if (isEmpty(fields)) {
      return {
        attempt: {
          model,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
          latencyMs,
          error: "empty-extraction",
        },
        fields: null,
      };
    }
    return {
      attempt: { model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs },
      fields,
    };
  } catch (e) {
    return {
      attempt: {
        model,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      },
      fields: null,
    };
  }
}

async function extractWithFallback<T>(
  systemPrompt: string,
  userText: string,
  parser: (raw: string) => T,
  isEmpty: (t: T) => boolean,
  emptyValue: T,
  mockValue: T,
  base64: string,
  mediaType: string,
): Promise<OcrResult<T>> {
  if (!ocrEnabled()) {
    return { fields: mockValue, attempts: [{ model: "mock-ocr", tokensIn: 0, tokensOut: 0, latencyMs: 0 }] };
  }
  const attempts: OcrAttempt[] = [];

  const primary = await tryAttempt(OCR_PRIMARY, systemPrompt, userText, parser, isEmpty, base64, mediaType);
  attempts.push(primary.attempt);
  if (primary.fields) return { fields: primary.fields, attempts };

  const fallback = await tryAttempt(OCR_FALLBACK, systemPrompt, userText, parser, isEmpty, base64, mediaType);
  attempts.push(fallback.attempt);
  if (fallback.fields) return { fields: fallback.fields, attempts };

  return { fields: emptyValue, attempts, failed: true };
}

/** OCR the FRONT side (owner name + plate). */
export function extractMoulkiaFront(base64: string, mediaType: string): Promise<OcrResult<MoulkiaFront>> {
  return extractWithFallback(
    FRONT_SYSTEM_PROMPT,
    "Extract owner name, plate, make, model, year and VIN from the FRONT of this Moulkia as JSON.",
    parseMoulkiaFrontJson,
    isEmptyFront,
    EMPTY_FRONT,
    mockMoulkiaFront(),
    base64,
    mediaType,
  );
}

/** OCR the BACK side (VIN + make + model + year). */
export function extractMoulkiaBack(base64: string, mediaType: string): Promise<OcrResult<MoulkiaBack>> {
  return extractWithFallback(
    BACK_SYSTEM_PROMPT,
    "Extract VIN, make, model, year from the BACK of this Moulkia as JSON.",
    parseMoulkiaBackJson,
    isEmptyBack,
    EMPTY_BACK,
    mockMoulkiaBack(),
    base64,
    mediaType,
  );
}

/** Cost in USD for one OCR attempt. Mock mode is free. */
export function ocrCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  return model === "mock-ocr" ? 0 : estimateCostUsd(model, tokensIn, tokensOut);
}
