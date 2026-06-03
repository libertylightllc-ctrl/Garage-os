// UAE VAT helper (Phase 1). Real persisted money is Prisma Decimal; this works in
// minor-unit-safe rounding for display/derivation. KSA strategies plug in later (§3 VatService).
export const UAE_VAT_RATE = 0.05;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface VatBreakdown {
  subtotal: number;
  vatAmount: number;
  total: number;
}

/** Given a VAT-exclusive subtotal, return {subtotal, vatAmount, total} rounded to 2dp. */
export function computeVat(subtotal: number, rate: number = UAE_VAT_RATE): VatBreakdown {
  const sub = round2(subtotal);
  const vatAmount = round2(sub * rate);
  return { subtotal: sub, vatAmount, total: round2(sub + vatAmount) };
}
