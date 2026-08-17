"use client";

// Inventory 3b — OPTIONAL catalog picker for the estimate add-line form.
// Picking a part prefills description (name + SKU) and unit price from the
// catalog and flips kind to PART — all still editable before submit; the
// server re-validates everything. Leaving it on the placeholder keeps the
// free-text flow byte-identical to before (no partId is submitted).

export interface CatalogPartOption {
  id: string;
  /** Full option label incl. the 3a stock hint, built server-side (i18n). */
  label: string;
  name: string;
  sku: string;
  price: string;
}

export function CatalogPartSelect({
  parts,
  placeholder,
  className,
}: {
  parts: CatalogPartOption[];
  placeholder: string;
  className?: string;
}) {
  return (
    <select
      name="partId"
      defaultValue=""
      className={className}
      onChange={(e) => {
        const form = e.currentTarget.form;
        const picked = parts.find((p) => p.id === e.currentTarget.value);
        if (!form || !picked) return;
        const kind = form.elements.namedItem("kind") as HTMLSelectElement | null;
        if (kind) kind.value = "PART";
        const desc = form.elements.namedItem("description") as HTMLInputElement | null;
        if (desc) desc.value = `${picked.name} (${picked.sku})`;
        const price = form.elements.namedItem("unitPrice") as HTMLInputElement | null;
        // AR 2026-08-17 — don't pre-fill zero. The catalogue Part.price
        // can be 0 (never priced, or seed default), which used to land
        // in the input as "0.00". The input's `required` attribute
        // doesn't fire on "0" — it's non-empty — and the server-side
        // parseMoney accepts explicit 0 as a legitimate courtesy /
        // warranty price. Together that let an advisor pick a catalogue
        // part, hit Add, and save an unpriced line silently. Leaving
        // the field blank when the catalogue has no meaningful price
        // makes `required` block the submit and forces the advisor to
        // type the real number. Explicit "0" is still allowed if they
        // actually type it — the distinction that matters is
        // "advisor typed 0" vs "the picker put 0 there for them".
        if (price) {
          const n = Number(picked.price);
          price.value = Number.isFinite(n) && n > 0 ? picked.price : "";
        }
      }}
    >
      <option value="">{placeholder}</option>
      {parts.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
