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

/**
 * Thrown when OCR is invoked in PRODUCTION but ANTHROPIC_API_KEY is unset.
 * Mock OCR data is a dev/demo convenience only — silently handing a real
 * user fake invoice/registration reads (with no error) is far worse than
 * failing loudly, so production refuses to mock. Callers can catch this to
 * show a clean "scanning unavailable" message.
 */
export class OcrDisabledError extends Error {
  constructor() {
    super("OCR unavailable: ANTHROPIC_API_KEY is not configured.");
    this.name = "OcrDisabledError";
  }
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
  maxTokens = 400,
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
      // Moulkia (~6 fields) fits in 400; a multi-line invoice needs more.
      max_tokens: maxTokens,
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
  maxTokens = 400,
): Promise<{ attempt: OcrAttempt; fields: T | null }> {
  const start = Date.now();
  try {
    const r = await callClaudeVision(model, systemPrompt, userText, base64, mediaType, maxTokens);
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
  maxTokens = 400,
): Promise<OcrResult<T>> {
  if (!ocrEnabled()) {
    // Mock is a DEV/demo convenience ONLY. In production a missing key must
    // fail LOUDLY — never silently return fabricated OCR data to a real user.
    if (process.env.NODE_ENV === "production") {
      throw new OcrDisabledError();
    }
    return { fields: mockValue, attempts: [{ model: "mock-ocr", tokensIn: 0, tokensOut: 0, latencyMs: 0 }] };
  }
  const attempts: OcrAttempt[] = [];

  const primary = await tryAttempt(OCR_PRIMARY, systemPrompt, userText, parser, isEmpty, base64, mediaType, maxTokens);
  attempts.push(primary.attempt);
  if (primary.fields) return { fields: primary.fields, attempts };

  const fallback = await tryAttempt(OCR_FALLBACK, systemPrompt, userText, parser, isEmpty, base64, mediaType, maxTokens);
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

// ---------------------------------------------------------------------------
// Supplier parts-invoice OCR (Inventory import). Multi-line, so max_tokens is
// raised. The critical rule: the model must LEAVE A VALUE BLANK and mark the
// line not-confident rather than guess — a wrong price/name that looks right
// is worse than an obvious gap the owner fills in. `flagged` drives the
// review UI's highlight; nothing is saved to the catalog until the owner
// confirms.
// ---------------------------------------------------------------------------

export interface InvoiceLine {
  name: string;
  sku: string;
  qty: number;
  unitCost: number;
  flagged: boolean; // OCR not confident, or a required value was blank
}

export interface InvoiceExtract {
  supplierName: string;
  lines: InvoiceLine[];
}

export const EMPTY_INVOICE: InvoiceExtract = { supplierName: "", lines: [] };

/** Demo sample (no API key) so the import flow stays demoable. */
export function mockInvoiceExtract(): InvoiceExtract {
  return {
    supplierName: "Gulf Auto Parts LLC",
    lines: [
      { name: "Oil Filter", sku: "OF-1042", qty: 12, unitCost: 8.5, flagged: false },
      { name: "Brake Pad Set (Front)", sku: "", qty: 4, unitCost: 95, flagged: false },
      { name: "", sku: "WPR-22", qty: 6, unitCost: 0, flagged: true }, // unreadable → flagged for the owner
    ],
  };
}

const INVOICE_SYSTEM_PROMPT =
  "You read a photographed SUPPLIER PARTS INVOICE (a GCC auto-parts shop invoice, often bilingual Arabic/English, " +
  "sometimes thermal-printed or handwritten) and reply with ONLY a JSON object: " +
  '{"supplierName": string, "lines": [{"name": string, "sku": string, "qty": number, "unitCost": number, "confident": boolean}]}. ' +
  "Each element of lines is ONE product row from the invoice's item table. " +
  "name = the part description; sku = the part/item code if the row shows one (else empty string); " +
  "qty = quantity ordered (a whole number); unitCost = price PER UNIT (not the line total). " +
  "Read the Latin/English text; if a cell is only in Arabic, transliterate the part name but never invent digits. " +
  "CRITICAL: if you are not sure of a value, leave it blank (empty string, or 0 for a number) and set \"confident\": false " +
  "for that line. NEVER guess or invent a part name, code, quantity, or price. It is far better to flag a line for the " +
  "human to fix than to fill in a plausible-looking wrong value. Set \"confident\": true only when the whole row is clearly legible. " +
  "Skip header/subtotal/VAT/total rows — only real product lines. No prose, no markdown, no code fences — just the JSON object.";

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function toQty(v: unknown): number {
  const n = typeof v === "number" ? Math.round(v) : parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function parseInvoiceJson(raw: string): InvoiceExtract {
  let obj: Record<string, unknown> = {};
  try {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a >= 0 && b > a) obj = JSON.parse(raw.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    obj = {};
  }
  const rawLines = Array.isArray(obj["lines"]) ? (obj["lines"] as unknown[]) : [];
  const lines: InvoiceLine[] = rawLines.map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const name = String(o["name"] ?? "").trim();
    const sku = String(o["sku"] ?? "").trim();
    const qty = toQty(o["qty"]);
    const unitCost = toNum(o["unitCost"]);
    // Flag when the model was unsure OR a must-have value is missing, so the
    // owner's review highlights exactly the rows that need a human eye.
    const modelConfident = o["confident"] !== false;
    const flagged = !modelConfident || name === "" || qty === 0 || unitCost === 0;
    return { name, sku, qty: qty || 1, unitCost, flagged };
  });
  return { supplierName: String(obj["supplierName"] ?? "").trim(), lines };
}

export function isEmptyInvoice(e: InvoiceExtract): boolean {
  return e.lines.length === 0;
}

/** OCR a supplier parts invoice into draft lines (multi-line → higher token budget). */
export function extractPartsInvoice(base64: string, mediaType: string): Promise<OcrResult<InvoiceExtract>> {
  return extractWithFallback(
    INVOICE_SYSTEM_PROMPT,
    "Extract the supplier name and every product line (name, sku, qty, unit cost) from this invoice as JSON.",
    parseInvoiceJson,
    isEmptyInvoice,
    EMPTY_INVOICE,
    mockInvoiceExtract(),
    base64,
    mediaType,
    1600, // room for ~25 line items
  );
}

/** Cost in USD for one OCR attempt. Mock mode is free. */
export function ocrCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  return model === "mock-ocr" ? 0 : estimateCostUsd(model, tokensIn, tokensOut);
}
