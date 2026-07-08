// Inventory 3a — read-only stock display for catalog part pickers.
// Pure + dependency-free so the level rules are testable. Display ONLY:
// nothing here moves stock (3d owns the movement guards).

export type StockLevel = "OUT" | "LOW" | "OK";

/** OUT at zero or below; LOW at or under the reorder level; else OK. */
export function stockLevel(qtyOnHand: number, reorderLevel: number): StockLevel {
  if (qtyOnHand <= 0) return "OUT";
  if (qtyOnHand <= reorderLevel) return "LOW";
  return "OK";
}

/**
 * Suffix for a <select><option> label. Options can't be styled per-row, so
 * the low/out flag is textual: "✕ out of stock" / "⚠ 3 in stock (Low)" /
 * "12 in stock". Strings come in from the caller's i18n dictionary.
 */
export function stockOptionSuffix(
  qtyOnHand: number,
  reorderLevel: number,
  labels: { inStock: string; low: string; out: string },
): string {
  const level = stockLevel(qtyOnHand, reorderLevel);
  if (level === "OUT") return `✕ ${labels.out}`;
  if (level === "LOW") return `⚠ ${qtyOnHand} ${labels.inStock} (${labels.low})`;
  return `${qtyOnHand} ${labels.inStock}`;
}
