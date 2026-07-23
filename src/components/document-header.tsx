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
    } | null;
    /** Supplier context — PO only. `refLabel` is the localized "Supplier ref" string. */
    supplier?: {
        name: string;
        reference: string | null;
        refLabel: string;
    } | null;
    /** Garage identity block on the end side. */
    garage: { name: string; trn: string | null; country: string };
}) {
    return (
        <header className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
                <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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
            <div className="text-end text-sm">
                <div className="font-medium">{garage.name}</div>
                <div className="text-zinc-600">TRN: {garage.trn ?? "—"}</div>
                <div className="text-zinc-600">{garage.country}</div>
            </div>
        </header>
    );
}
