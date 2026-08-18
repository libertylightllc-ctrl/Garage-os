import { computeVat, UAE_VAT_RATE } from "./vat";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------- Line items ----------
export type LineKind = "LABOR" | "PART" | "FEE";

export interface DraftLine {
  kind: LineKind;
  description: string;
  qty: number;
  unitPrice: number;
}

export function lineTotal(qty: number, unitPrice: number): number {
  return round2(qty * unitPrice);
}

/**
 * Discriminated money parse — AR 2026-08-17. Same shape mandated on
 * the Layer 0 branch for parsing supplier costs, brought over to the
 * customer-facing side after the estimate-line blank-price incident.
 *
 * `Number("")` collapses silently to 0, which is exactly what we want
 * to STOP happening on money fields: a blank price is not a real
 * zero, it's the operator forgetting to type. This helper never
 * returns 0 for a blank — blanks are rejected outright — and rejects
 * non-numeric text, negatives (unless `allowNegative`), and NaN /
 * Infinity. The caller pattern is
 *
 *     const parsed = parseMoney(formData.get("unitPrice"));
 *     if (!parsed.ok) throw new Error(parsed.error);
 *     const price = parsed.value;
 *
 * `allowNegative: true` is for the DISCOUNT convention (FEE with
 * negative unitPrice); default false rejects negatives on LABOR/PART/
 * regular FEE lines. Once accepted the sign is preserved verbatim —
 * callers that need |value| take Math.abs themselves.
 */
export type MoneyParseResult =
  | { ok: true; value: number }
  | { ok: false; error: "required" | "not-a-number" | "negative" };

/**
 * Decide whether a technician-requested part can be one-click
 * itemised into a priced estimate line. AR 2026-08-17.
 *
 * Historical shape (`jp.part ? Number(jp.part.price) : 0`) silently
 * wrote unitPrice: 0 when the part was uncatalogued OR the catalogue
 * price was null/zero. That's how JC-2026-0098's lines ended up
 * unpriced. EstimateLine.unitPrice is NOT NULL in the schema so we
 * can't express "unpriced" — the choice is accept-at-0 (the bug) or
 * refuse-with-message (this helper). Kept as a pure function so the
 * decision table is testable without a DB fixture.
 *
 * Two accept shapes:
 *   { ok: true, price }
 * where price is > 0 and finite. Three refuse shapes:
 *   { ok: false, reason: "no-catalogue-part" }  — jp.part is null
 *   { ok: false, reason: "no-catalogue-price" } — Part.price null/0
 *   { ok: false, reason: "bad-catalogue-price" } — NaN / Infinity
 * The caller surfaces the appropriate operator-facing error string.
 */
export type OneClickItemisePart = { price: number | string | { toString(): string } } | null;

export type OneClickItemiseResolution =
  | { ok: true; price: number }
  | { ok: false; reason: "no-catalogue-part" | "no-catalogue-price" | "bad-catalogue-price" };

export function resolveOneClickItemisePrice(
  part: OneClickItemisePart,
): OneClickItemiseResolution {
  if (part == null) return { ok: false, reason: "no-catalogue-part" };
  // Prisma Decimals arrive as strings via the driver adapter; Number()
  // handles both Decimal.toString() and the direct-number path used by
  // tests. NaN / Infinity are the "shouldn't-happen" catch-all — the
  // schema declares Part.price as non-null Decimal, so this branch
  // fires only if a driver bug or bad seed slips through.
  const n = Number(part.price);
  if (!Number.isFinite(n)) return { ok: false, reason: "bad-catalogue-price" };
  // 0 (and negative) means "never priced" — a courtesy/warranty line
  // is created by pricing the estimate line at 0 explicitly, NOT by
  // storing a 0 catalogue price. Treat the same as null.
  if (n <= 0) return { ok: false, reason: "no-catalogue-price" };
  return { ok: true, price: n };
}

// ── Estimate / invoice line-form error codes (AR 2026-08-18) ──────
//
// Server actions that validate estimate/invoice add-line + edit-line
// forms used to `throw new Error(msg)` on refusal — Next then rendered
// its generic "Something went wrong / ref: <digest>" page, and the
// operator-facing text never reached the advisor (INC ref 4073247469,
// the "Price this part" click on a free-typed jobPart). The
// replacement pattern:
//
//   * Actions REDIRECT back to their source page (`/estimates/${id}`
//     or `/invoices/${id}`) with `?formError=<code>` in the query.
//   * The source page whitelists the code against LINE_FORM_ERROR_CODES
//     below, then renders the localized message from
//     t(`lineFormErr_${code}`). Whitelist prevents URL fuzzing —
//     never send an untrusted string into i18n lookup.
//
// Codes are kebab-cased. Every code has both an en and ar i18n key
// under the `lineFormErr_` prefix. Adding a new code: extend the
// union type + the Set + both i18n dictionaries in the same commit,
// otherwise the whitelist will drop it into the generic fallback.
export type LineFormErrorCode =
  | "price-required"
  | "price-negative"
  | "price-not-numeric"
  | "desc-required"
  | "qty-invalid"
  | "kind-unknown"
  | "part-not-in-catalogue"
  | "part-no-price-in-catalogue";

export const LINE_FORM_ERROR_CODES: ReadonlySet<LineFormErrorCode> = new Set<LineFormErrorCode>([
  "price-required",
  "price-negative",
  "price-not-numeric",
  "desc-required",
  "qty-invalid",
  "kind-unknown",
  "part-not-in-catalogue",
  "part-no-price-in-catalogue",
]);

/** Map parseMoney's result-error to a LineFormErrorCode. Keeps the
 *  action-layer callers from re-deriving the mapping site-by-site. */
export function priceErrorCode(
  err: "required" | "not-a-number" | "negative",
): LineFormErrorCode {
  switch (err) {
    case "required": return "price-required";
    case "not-a-number": return "price-not-numeric";
    case "negative": return "price-negative";
  }
}

/** Map parseLineEditInput's result-error to a LineFormErrorCode. */
export function lineEditErrorCode(err: LineEditError): LineFormErrorCode {
  switch (err) {
    case "missing-description": return "desc-required";
    case "bad-qty": return "qty-invalid";
    case "bad-price": return "price-required";  // parseLineEditInput's bad-price already covers blank via parseMoney
    case "unknown-kind": return "kind-unknown";
  }
}

export function parseMoney(
  raw: unknown,
  opts: { allowNegative?: boolean } = {},
): MoneyParseResult {
  // Accept the two legitimate shapes callers pass:
  //   - string (FormData.get on a number input) — the actual hazard;
  //     the blank-collapses-to-zero bug this helper exists to close.
  //   - number (a caller that already has the parsed value in hand,
  //     e.g. parseLineEditInput's unit tests, or a JSON body).
  // Everything else (null / undefined / File / boolean / object) is
  // either a missing key or a caller-side type bug — reject as
  // "required", same as an empty string.
  let n: number;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: false, error: "required" };
    n = Number(trimmed);
  } else if (typeof raw === "number") {
    n = raw;
  } else {
    return { ok: false, error: "required" };
  }
  if (!Number.isFinite(n)) return { ok: false, error: "not-a-number" };
  if (!opts.allowNegative && n < 0) return { ok: false, error: "negative" };
  return { ok: true, value: n };
}

/**
 * Validate + normalise the raw inputs from an estimate-line edit form.
 * Pulled out as a pure helper so the server action stays thin and the
 * validation rules are unit-testable. DISCOUNT is sugar for a FEE line
 * with a negative amount — same convention as addEstimateLineAction.
 *
 * Returns { ok: true, ... } on success or { ok: false, error: <key> }
 * with a short error code the caller can throw / surface in the UI.
 */
export type LineEditError =
  | "missing-description"
  | "bad-qty"
  | "bad-price"
  | "unknown-kind";

export type LineEditResult =
  | {
      ok: true;
      kind: LineKind;
      description: string;
      qty: number;
      unitPrice: number;
      // Cost-based pricing (AR 2026-08-12) — both nullable; only PART
      // lines meaningfully set them. Persisted as-typed; the client's
      // two-way binding is what keeps them consistent with unitPrice,
      // so the server doesn't re-derive.
      unitCost: number | null;
      markupPct: number | null;
    }
  | { ok: false; error: LineEditError };

export function parseLineEditInput(input: {
  kind: unknown;
  description: unknown;
  qty: unknown;
  unitPrice: unknown;
  unitCost?: unknown;
  markupPct?: unknown;
}): LineEditResult {
  const rawKind = String(input.kind ?? "").toUpperCase();
  if (!["LABOR", "PART", "FEE", "DISCOUNT"].includes(rawKind)) {
    return { ok: false, error: "unknown-kind" };
  }
  const isDiscount = rawKind === "DISCOUNT";
  const kind: LineKind = isDiscount ? "FEE" : (rawKind as LineKind);

  const description = String(input.description ?? "").trim();
  if (!description) return { ok: false, error: "missing-description" };

  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "bad-qty" };

  // AR 2026-08-17 — no more silent Number("") → 0. A blank price is
  // "advisor forgot to type", not a real zero, and letting it write
  // 0 through to the invoice + ledger silently understated VAT on
  // filed returns. parseMoney rejects blanks and non-numeric input;
  // DISCOUNT parses with `allowNegative: true` because the sign
  // itself is the signal, then we re-sign below to canonical
  // negative regardless of what the operator typed.
  const parsedPrice = parseMoney(input.unitPrice, { allowNegative: isDiscount });
  if (!parsedPrice.ok) return { ok: false, error: "bad-price" };
  const priceAbs = Math.abs(parsedPrice.value);
  const unitPrice = isDiscount ? -priceAbs : priceAbs;

  // Cost + markup (PART lines only; ignored + nulled on other kinds).
  // Blank input → null (advisor deliberately cleared the field, which
  // means "no cost data" not "zero cost"). Non-numeric input → null.
  let unitCost: number | null = null;
  let markupPct: number | null = null;
  if (kind === "PART") {
    const rawCost = String(input.unitCost ?? "").trim();
    if (rawCost !== "") {
      const c = Number(rawCost);
      if (Number.isFinite(c) && c >= 0) unitCost = c;
    }
    const rawMarkup = String(input.markupPct ?? "").trim();
    if (rawMarkup !== "") {
      const m = Number(rawMarkup);
      // Range mirrors Garage.defaultPartsMarkupPct in schema (5,2).
      // Negative markup (selling at a loss) is allowed — advisor may
      // still want to record it. Cap high end for sanity.
      if (Number.isFinite(m) && m >= -100 && m <= 999.99) markupPct = m;
    }
  }

  return { ok: true, kind, description, qty, unitPrice, unitCost, markupPct };
}

/** Sum lines (VAT-exclusive) → {subtotal, vatAmount, total} at the given country's rate. */
export function totalsFor(lines: DraftLine[], rate: number = UAE_VAT_RATE) {
  const subtotal = round2(lines.reduce((s, l) => s + lineTotal(l.qty, l.unitPrice), 0));
  return computeVat(subtotal, rate);
}

// ---------- Country-pluggable VAT strategy (§3 VatService) ----------
export interface VatStrategy {
  country: string;
  rate: number;
  clearanceStatus: "NA" | "PENDING" | "CLEARED"; // KSA flips this to PENDING later
}

export const UAEStrategy: VatStrategy = { country: "UAE", rate: UAE_VAT_RATE, clearanceStatus: "NA" };

export function vatStrategyFor(country: string): VatStrategy {
  // Phase 1 ships UAE only; KSAFatooraStrategy plugs in here in Phase 2.
  switch (country) {
    case "UAE":
    default:
      return UAEStrategy;
  }
}

// ---------- Zero-entry double-entry ledger ----------
export interface LedgerLine {
  account: string;
  debit: number;
  credit: number;
}

export const ACCOUNTS = {
  AR: "Accounts Receivable",
  SALES: "Sales Revenue",
  VAT_PAYABLE: "VAT Payable",
  CASH: "Cash/Bank",
  // Customer Deposits — liability account holding advances received
  // BEFORE an invoice exists. Reclassified to AR (at the advance amount)
  // when the invoice is generated. See advanceLedger() /
  // advanceMigrationLedger() below — slice 6b.
  DEPOSITS: "Customer Deposits",
} as const;

/** Issuing an invoice: DR AR (total) / CR Sales (subtotal) + CR VAT Payable (vat). */
export function invoiceLedger(subtotal: number, vatAmount: number, total: number): LedgerLine[] {
  return [
    { account: ACCOUNTS.AR, debit: round2(total), credit: 0 },
    { account: ACCOUNTS.SALES, debit: 0, credit: round2(subtotal) },
    { account: ACCOUNTS.VAT_PAYABLE, debit: 0, credit: round2(vatAmount) },
  ];
}

/**
 * Voiding a delivered invoice: exact mirror of `invoiceLedger`.
 * CR AR (total) / DR Sales (subtotal) + DR VAT Payable (vat). Summed
 * with the original issuance entries this nets to zero on every
 * account — the accounting effect of the sale is undone. Written by
 * voidInvoiceAction with sourceType='INVOICE_VOID'. AR 2026-08-17.
 */
export function voidReversalLedger(
  subtotal: number,
  vatAmount: number,
  total: number,
): LedgerLine[] {
  return [
    { account: ACCOUNTS.AR, debit: 0, credit: round2(total) },
    { account: ACCOUNTS.SALES, debit: round2(subtotal), credit: 0 },
    { account: ACCOUNTS.VAT_PAYABLE, debit: round2(vatAmount), credit: 0 },
  ];
}

/** Receiving a payment: DR Cash/Bank / CR AR. */
export function paymentLedger(amount: number): LedgerLine[] {
  return [
    { account: ACCOUNTS.CASH, debit: round2(amount), credit: 0 },
    { account: ACCOUNTS.AR, debit: 0, credit: round2(amount) },
  ];
}

/**
 * Receiving an advance BEFORE the invoice exists: DR Cash / CR Customer
 * Deposits. The cash hits the books now; the matching credit sits as a
 * liability (we owe the customer the work, not the cash) until the
 * invoice is generated and the deposit is reclassified to AR via
 * advanceMigrationLedger(). Slice 6b.
 */
export function advanceLedger(amount: number): LedgerLine[] {
  return [
    { account: ACCOUNTS.CASH, debit: round2(amount), credit: 0 },
    { account: ACCOUNTS.DEPOSITS, debit: 0, credit: round2(amount) },
  ];
}

/**
 * Migrating an advance onto a new invoice: DR Customer Deposits / CR AR.
 * Cash is NOT touched (it was recognized at advance time). This is a
 * balance-sheet reclassification: the deposit liability disappears, the
 * AR balance the new invoice just opened up shrinks by the same amount.
 * Net effect across the two events:
 *   Cash:       DR (one-time)
 *   AR:         DR (invoice)  + CR (migration)  = total − sum(advances)
 *   Sales/VAT:  CR (invoice)
 *   Deposits:   CR (advance)  + DR (migration)  = 0
 * Slice 6b.
 */
export function advanceMigrationLedger(amount: number): LedgerLine[] {
  return [
    { account: ACCOUNTS.DEPOSITS, debit: round2(amount), credit: 0 },
    { account: ACCOUNTS.AR, debit: 0, credit: round2(amount) },
  ];
}

export function isBalanced(rows: LedgerLine[]): boolean {
  const d = round2(rows.reduce((s, r) => s + r.debit, 0));
  const c = round2(rows.reduce((s, r) => s + r.credit, 0));
  return d === c;
}

// ---------- Accounts receivable status (🟢🟠🟡🔴) ----------
// PAID    — paid >= total (fully settled)
// OVERDUE — paid < total AND now > dueDate (the more urgent date
//           signal wins over partial when both apply)
// PARTIAL — 0 < paid < total AND now <= dueDate (advance / partial)
// DUE     — paid === 0 AND now <= dueDate (nothing paid yet)
//
// Precedence chosen so OVERDUE captures any underpaid invoice past
// its due date — that's the case the cashier needs to chase. PARTIAL
// is the at-a-glance signal for non-overdue advance-paid invoices.
export type ArState = "PAID" | "PARTIAL" | "DUE" | "OVERDUE";

export const AR_EMOJI: Record<ArState, string> = {
  PAID: "🟢",
  PARTIAL: "🟠",
  DUE: "🟡",
  OVERDUE: "🔴",
};

export function arState(total: number, paid: number, dueDate: Date, now: Date): ArState {
  const paidR = round2(paid);
  const totalR = round2(total);
  if (paidR >= totalR) return "PAID";
  // Underpaid + past due → OVERDUE wins (whether 0 or partial-paid).
  if (now.getTime() > dueDate.getTime()) return "OVERDUE";
  // Underpaid + on/before due. Any non-zero payment → PARTIAL; nothing → DUE.
  return paidR > 0 ? "PARTIAL" : "DUE";
}

// Pure 'is the invoice partially paid' check — independent of due date.
// Used by the dashboard 'Partially Paid' counter, which wants to count
// both PARTIAL (not yet due) AND partially-paid-but-OVERDUE invoices.
export function isPartiallyPaid(total: number, paid: number): boolean {
  const paidR = round2(paid);
  const totalR = round2(total);
  return paidR > 0 && paidR < totalR;
}

// Balance-due math used everywhere. Keeps the invariant
//   round2(paid) + balanceDue(total, paid) == round2(total)
// true regardless of floating-point noise in the inputs. Always >= 0;
// overpayment is blocked at the action layer so callers never need to
// guard for negative balance here.
export function balanceDue(total: number, paid: number): number {
  return Math.max(0, round2(round2(total) - round2(paid)));
}

// ---------- Payment methods ----------
// We RECORD payments only — the app never processes money. The garage takes payment on
// its own cash drawer / POS, then staff record it here as Cash or Card.
export type PaymentMethod = "CASH" | "CARD_POS";
export const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD_POS"];

export function isRecordableMethod(method: string): method is PaymentMethod {
  return method === "CASH" || method === "CARD_POS";
}

// Extra-work guard: a revised quote that exceeds an already-approved total must be
// re-approved by the customer before work continues. (First quote isn't an "increase".)
export function isQuoteIncrease(newTotal: number, lastApprovedTotal: number): boolean {
  return lastApprovedTotal > 0 && newTotal > lastApprovedTotal;
}

// ---------- Invoice helpers ----------
export function formatInvoiceNo(seq: number, year: number): string {
  return `INV-${year}-${String(seq).padStart(4, "0")}`;
}

/** Build an estimate-line description from a technician part (part No + name). */
export function jobPartLineDescription(
  partNo: string | null | undefined,
  description: string,
): string {
  const no = (partNo ?? "").trim();
  const desc = description.trim();
  return no ? `${no} — ${desc}` : desc;
}

/** Placeholder QR content (UAE). KSA Phase 2 replaces with a signed ZATCA TLV/QR. */
export function qrPlaceholder(opts: {
  seller: string;
  trn: string | null;
  total: number;
  vat: number;
  isoDate: string;
}): string {
  const payload = `GARAGEOS|${opts.seller}|TRN:${opts.trn ?? "-"}|${opts.isoDate}|TOTAL:${opts.total}|VAT:${opts.vat}`;
  return Buffer.from(payload, "utf8").toString("base64");
}
