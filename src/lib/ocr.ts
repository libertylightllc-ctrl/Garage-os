// Moulkia (UAE vehicle registration card) OCR. Uses Claude vision when
// ANTHROPIC_API_KEY is set; otherwise a deterministic mock so new-customer intake
// is fully demoable. Every caller meters each attempt to AiEvent (kind = OCR).
//
// Privacy: the image is processed in-memory and NEVER persisted — we store only
// the extracted fields, and only after the advisor confirms (consent at intake).
//
// Fallback chain: PRIMARY (cheap/fast Haiku) → FALLBACK (Sonnet, stronger OCR).
// If both fail, the result is marked failed=true and the caller routes to manual entry.

import { estimateCostUsd } from "@/lib/ai";

export interface MoulkiaFields {
  ownerName: string;
  vin: string;
  plate: string;
  make: string;
  model: string;
  year: number | null;
}

/**
 * One OCR attempt's metering record — the caller writes one AiEvent row per
 * attempt so cost + reliability per model is visible.
 */
export interface OcrAttempt {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  error?: string; // present when this attempt failed
}

export interface OcrResult {
  fields: MoulkiaFields;
  /** One entry per HTTP attempt (1 on success / 2 if fallback ran / 1 if mock mode). */
  attempts: OcrAttempt[];
  /** True when every real attempt failed → caller routes to manual entry. */
  failed?: boolean;
}

export function ocrEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Verified against https://platform.claude.com/docs (Models overview) on 2026-06-05:
//   - Haiku 4.5: $1/$5 per Mtok, fastest, vision-capable
//   - Sonnet 4.6: $3/$15 per Mtok, stronger OCR, vision-capable
// Aliases used here are convenience pointers; both resolve to pinned snapshots.
export const OCR_PRIMARY = process.env.ANTHROPIC_OCR_MODEL ?? "claude-haiku-4-5";
export const OCR_FALLBACK = process.env.ANTHROPIC_OCR_FALLBACK_MODEL ?? "claude-sonnet-4-6";

const EMPTY_FIELDS: MoulkiaFields = {
  ownerName: "",
  vin: "",
  plate: "",
  make: "",
  model: "",
  year: null,
};

/** Deterministic sample used when no API key is configured (demo / tests). */
export function mockMoulkia(): MoulkiaFields {
  return {
    ownerName: "Mohammed Al Maktoum",
    vin: "JN1TANT32U0123456",
    plate: "D 12345",
    make: "Nissan",
    model: "Patrol",
    year: 2022,
  };
}

function toYear(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 1950 && n <= 2100 ? n : null;
}

/** Parse the model's JSON reply into clean fields (tolerant of extra prose). */
export function parseMoulkiaJson(raw: string): MoulkiaFields {
  let obj: Record<string, unknown> = {};
  try {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    obj = a >= 0 && b > a ? (JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>) : {};
  } catch {
    obj = {};
  }
  const str = (k: string) => String(obj[k] ?? "").trim();
  return {
    ownerName: str("ownerName"),
    vin: str("vin"),
    plate: str("plate"),
    make: str("make"),
    model: str("model"),
    year: toYear(obj["year"]),
  };
}

/** All fields empty means the model couldn't read anything useful — treat as a failure. */
export function isEmptyExtraction(f: MoulkiaFields): boolean {
  return (
    !f.ownerName && !f.vin && !f.plate && !f.make && !f.model && (f.year == null || f.year === 0)
  );
}

interface ClaudeAttempt {
  fields: MoulkiaFields;
  tokensIn: number;
  tokensOut: number;
}

async function callClaudeVision(
  model: string,
  base64: string,
  mediaType: string,
): Promise<ClaudeAttempt> {
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
      system:
        "You read a UAE Moulkia (vehicle registration card) image and reply with ONLY a JSON object: " +
        '{"ownerName": string, "vin": string, "plate": string, "make": string, "model": string, "year": number}. ' +
        "Use the Latin/English text. If a field is unreadable use an empty string (or 0 for year). No prose.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: "Extract the registration fields as JSON." },
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
    fields: parseMoulkiaJson(j.content?.[0]?.text ?? "{}"),
    tokensIn: j.usage?.input_tokens ?? 0,
    tokensOut: j.usage?.output_tokens ?? 0,
  };
}

async function tryAttempt(
  model: string,
  base64: string,
  mediaType: string,
): Promise<{ attempt: OcrAttempt; fields: MoulkiaFields | null }> {
  const start = Date.now();
  try {
    const r = await callClaudeVision(model, base64, mediaType);
    const latencyMs = Date.now() - start;
    // Soft failure: HTTP 200 but the model returned nothing usable — same outcome as a
    // hard failure from the user's perspective, so let the fallback take a shot.
    if (isEmptyExtraction(r.fields)) {
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
      fields: r.fields,
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

/**
 * Extract Moulkia fields from an image with a primary→fallback model chain.
 * Mock mode (no API key) returns the deterministic sample with one mock attempt
 * row so AiEvent metering remains consistent.
 */
export async function extractMoulkia(base64: string, mediaType: string): Promise<OcrResult> {
  if (!ocrEnabled()) {
    return {
      fields: mockMoulkia(),
      attempts: [{ model: "mock-ocr", tokensIn: 0, tokensOut: 0, latencyMs: 0 }],
    };
  }

  const attempts: OcrAttempt[] = [];
  const primary = await tryAttempt(OCR_PRIMARY, base64, mediaType);
  attempts.push(primary.attempt);
  if (primary.fields) return { fields: primary.fields, attempts };

  // Primary failed → escalate to the stronger model.
  const fallback = await tryAttempt(OCR_FALLBACK, base64, mediaType);
  attempts.push(fallback.attempt);
  if (fallback.fields) return { fields: fallback.fields, attempts };

  // Both failed → caller routes to manual entry; the empty fields prevent stale data.
  return { fields: EMPTY_FIELDS, attempts, failed: true };
}

/** Cost in USD for one OCR attempt. Mock mode is free. */
export function ocrCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  return model === "mock-ocr" ? 0 : estimateCostUsd(model, tokensIn, tokensOut);
}
