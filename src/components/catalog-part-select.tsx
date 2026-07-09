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
        if (price) price.value = picked.price;
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
