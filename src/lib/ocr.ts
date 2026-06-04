// Moulkia (UAE vehicle registration card) OCR. Uses Claude vision when
// ANTHROPIC_API_KEY is set; otherwise a deterministic mock so new-customer intake
// is fully demoable. Every caller meters the call to AiEvent (kind = OCR).
//
// Privacy: the image is processed in-memory and NEVER persisted — we store only
// the extracted fields, and only after the advisor confirms (consent at intake).

import { estimateCostUsd } from "@/lib/ai";

export interface MoulkiaFields {
  ownerName: string;
  vin: string;
  plate: string;
  make: string;
  model: string;
  year: number | null;
}

export interface OcrResult {
  fields: MoulkiaFields;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export function ocrEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Vision-capable model; OCR volume is low, but keep it the cheap tier by default.
const OCR_MODEL = process.env.ANTHROPIC_OCR_MODEL ?? "claude-haiku-4-5";

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

async function callClaudeVision(base64: string, mediaType: string): Promise<OcrResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OCR_MODEL,
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
  };
  if (!res.ok) throw new Error(`Anthropic vision error ${res.status}`);
  return {
    fields: parseMoulkiaJson(j.content?.[0]?.text ?? "{}"),
    model: OCR_MODEL,
    tokensIn: j.usage?.input_tokens ?? 0,
    tokensOut: j.usage?.output_tokens ?? 0,
  };
}

/** Extract Moulkia fields from an image. Falls back to the mock on any failure. */
export async function extractMoulkia(base64: string, mediaType: string): Promise<OcrResult> {
  if (ocrEnabled()) {
    try {
      return await callClaudeVision(base64, mediaType);
    } catch {
      // graceful fallback — intake must never hard-fail
    }
  }
  return { fields: mockMoulkia(), model: "mock-ocr", tokensIn: 0, tokensOut: 0 };
}

/** Convenience for callers writing the AiEvent meter row. */
export function ocrCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  return model === "mock-ocr" ? 0 : estimateCostUsd(model, tokensIn, tokensOut);
}
