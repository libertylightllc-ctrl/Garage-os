import { JobNumberBadge } from "@/components/job-number-badge";

/**
 * Standard stacked-header shape used across every printable / customer-
 * facing document surface. Ensures every job card, estimate, invoice,
 * delivery slip and purchase order reads the same:
 *
 *   [Document type]                            [Garage name]
 *   [Document number]     (INV-… only)         TRN: …
 *   [Job card number]     (JC-… when applicable) [Country]
 *   [Vehicle make/model + year]                (—)
 *   [Plate]                                    (—)
 *
 * For a purchase order (no vehicle, no job link) the identity stack
 * becomes:
 *   Purchase order
 *   [Supplier name]
 *   Supplier ref: [free-text ref]  (only when the supplier gave us one;
 *                                    honestly labelled — it's their
 *                                    quote number, not our PO number)
 *
 * Ordering follows AR's spec (2026-07-24). Estimates skip a distinct
 * document number entirely — they identify by the parent JC-… — because
 * there's no gapless per-garage estimate sequence in the schema and we
 * don't want to invent one.
 *
 * The JC-… line always renders via JobNumberBadge so the format cannot
 * fork across surfaces (Job card: pinned by rule).
 *
 * Deliberately does NOT render a logo. Logo work is a separate slice
 * (see docs / open feature request) — bundling two visual changes across
 * nine documents in one commit is hard to review and harder to revert.
 */
export function DocumentHeader({
    title,
    documentNumber,
    jobCard,
    vehicle,
    supplier,
    garage,
    logoUrl,
    vinLabel,
    centredTitle,
}: {
    /** Localized document type — "Job card", "Estimate", "Invoice", etc. */
    title: string;
    /** Pre-formatted document number, e.g. `INV-2026-0001`. Renders only when set. */
    documentNumber?: string | null;
    /** Job card the doc hangs off. `number: null` → line is skipped. */
    jobCard?: { number: number | null; createdAt: Date } | null;
    /** Vehicle context. Skipped for POs. */
    vehicle?: {
        make: string;
        model: string;
        year: number | null;
        plate: string;
        /** AR 2026-08-25 Batch F1 — VIN prints on estimate + invoice
         *  when the vehicle record holds one. Optional at the type
         *  level so surfaces that don't need to expose VIN (job card
         *  header, PO stack) stay unchanged. */
        vin?: string | null;
    } | null;
    /** VIN column label — pass the localized "VIN" so this
     *  component stays i18n-agnostic. Ignored when the vehicle has
     *  no VIN or is null. */
    vinLabel?: string;
    /** Supplier context — PO only. `refLabel` is the localized "Supplier ref" string. */
    supplier?: {
        name: string;
        reference: string | null;
        refLabel: string;
    } | null;
    /** Garage identity block on the end side. `address` prints below
     *  the country line when non-null (UAE FTA Art. 59 requires it on
     *  every tax invoice; existing shops with no value keep printing
     *  as before). Rendered with `whitespace-pre-line` so multi-line
     *  addresses (P.O. Box / building / area / city) stack naturally. */
    garage: { name: string; trn: string | null; address?: string | null; country: string };
    /**
     * Garage logo shown on the end side above the garage name. Callers
     * decide the fallback:
     *   Internal pages (advisor / cashier / owner) — pass
     *     `garage.logoUrl ?? "/brand/garageos-logo.png"` so the doc
     *     always carries a mark even when the shop hasn't uploaded.
     *   Customer-facing /c/* pages — pass just `garage.logoUrl`. When
     *     null the block falls back to text-only garage name so a
     *     customer never sees the GarageOS mark on THEIR invoice —
     *     that would be our brand on their document.
     * `loading="eager" fetchPriority="high"` because the print dialog
     * can fire before a lazy-loaded image resolves, printing blank.
     */
    logoUrl?: string | null;
    /** AR 2026-08-25 Batch F2 — when true, renders the title as a
     *  centred h1 above the identity/garage flex row instead of on
     *  the left. Estimate preview uses this so the printed doc
     *  reads "Repair Estimate" at the top like a shop's own
     *  template. Existing surfaces default to the left-aligned
     *  layout. */
    centredTitle?: boolean;
}) {
    return (
        <header>
            {centredTitle ? (
                <h1 className="mb-4 text-center text-3xl font-semibold tracking-tight">
                    {title}
                </h1>
            ) : null}
            <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
                {centredTitle ? null : (
                    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                )}
                {documentNumber ? (
                    <div className="text-sm tabular-nums text-zinc-600">
                        {documentNumber}
                    </div>
                ) : null}
                {jobCard && jobCard.number ? (
                    <div className="text-sm text-zinc-600">
                        <JobNumberBadge
                            jobCard={jobCard}
                            className="tabular-nums"
                        />
                    </div>
                ) : null}
                {supplier ? (
                    <div className="text-sm font-medium text-zinc-700">
                        {supplier.name}
                    </div>
                ) : null}
                {vehicle ? (
                    <>
                        <div className="text-sm text-zinc-600">
                            {vehicle.make} {vehicle.model}
                            {vehicle.year ? ` ${vehicle.year}` : ""}
                        </div>
                        <div className="text-sm text-zinc-600">
                            {vehicle.plate}
                        </div>
                        {vehicle.vin && vinLabel ? (
                            <div className="text-sm text-zinc-600 tabular-nums">
                                {vinLabel}: {vehicle.vin}
                            </div>
                        ) : null}
                    </>
                ) : null}
                {supplier && supplier.reference ? (
                    <div className="text-sm text-zinc-600">
                        {supplier.refLabel}:{" "}
                        <span className="tabular-nums">
                            {supplier.reference}
                        </span>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-col items-end gap-1 text-end text-sm">
                {logoUrl ? (
                    <img
                        src={logoUrl}
                        alt=""
                        loading="eager"
                        fetchPriority="high"
                        className="h-10 w-auto max-w-[140px] object-contain"
                    />
                ) : null}
                <div>
                    <div className="font-medium">{garage.name}</div>
                    <div className="text-zinc-600">TRN: {garage.trn ?? "—"}</div>
                    <div className="text-zinc-600">{garage.country}</div>
                    {garage.address ? (
                        <div className="text-zinc-600 whitespace-pre-line">
                            {garage.address}
                        </div>
                    ) : null}
                </div>
            </div>
            </div>
        </header>
    );
}
