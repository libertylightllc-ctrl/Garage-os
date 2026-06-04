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
} as const;

/** Issuing an invoice: DR AR (total) / CR Sales (subtotal) + CR VAT Payable (vat). */
export function invoiceLedger(subtotal: number, vatAmount: number, total: number): LedgerLine[] {
  return [
    { account: ACCOUNTS.AR, debit: round2(total), credit: 0 },
    { account: ACCOUNTS.SALES, debit: 0, credit: round2(subtotal) },
    { account: ACCOUNTS.VAT_PAYABLE, debit: 0, credit: round2(vatAmount) },
  ];
}

/** Receiving a payment: DR Cash/Bank / CR AR. */
export function paymentLedger(amount: number): LedgerLine[] {
  return [
    { account: ACCOUNTS.CASH, debit: round2(amount), credit: 0 },
    { account: ACCOUNTS.AR, debit: 0, credit: round2(amount) },
  ];
}

export function isBalanced(rows: LedgerLine[]): boolean {
  const d = round2(rows.reduce((s, r) => s + r.debit, 0));
  const c = round2(rows.reduce((s, r) => s + r.credit, 0));
  return d === c;
}

// ---------- Accounts receivable status (🟢🟡🔴) ----------
export type ArState = "PAID" | "DUE" | "OVERDUE";

export const AR_EMOJI: Record<ArState, string> = { PAID: "🟢", DUE: "🟡", OVERDUE: "🔴" };

export function arState(total: number, paid: number, dueDate: Date, now: Date): ArState {
  if (round2(paid) >= round2(total)) return "PAID";
  return now.getTime() > dueDate.getTime() ? "OVERDUE" : "DUE";
}

// ---------- Payment methods ----------
// We RECORD payments only — money is handled by the garage's own POS / cash drawer.
// Cash and Card (POS) record immediately; Online Link is a stub (wired with the PSP later).
export type PaymentMethod = "CASH" | "CARD_POS" | "ONLINE_LINK";
export const PAYMENT_METHODS: PaymentMethod[] = ["CASH", "CARD_POS", "ONLINE_LINK"];

export function isRecordableMethod(method: string): method is "CASH" | "CARD_POS" {
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
