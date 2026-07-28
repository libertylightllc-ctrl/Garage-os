/**
 * Purchase-order vehicle resolution — traverses the only link the
 * schema gives us (Part.autoCreatedFromLineId → EstimateLine →
 * Estimate → JobCard → Vehicle) and returns per-line context plus a
 * deduped list of distinct vehicles across the PO.
 *
 * A single POLine can either resolve to exactly one vehicle (its
 * Part was auto-created via the from-estimate flow) or not at all
 * (Part was pre-existing catalog — seed, manually added, OCR-
 * imported). We surface both cases explicitly. Callers render `—` /
 * "no vehicle linked" for unresolved lines rather than blank — the
 * supplier needs to know when the shop CAN'T tell them what car
 * the part is for, not have it hidden.
 *
 * Kept purely presentational: no DB access here. Callers pass the
 * already-loaded PO with the nested `part.autoCreatedFromLine`
 * chain, and this maps the raw rows into what the UI + message
 * builder consume. See src/app/owner/purchasing/[id]/page.tsx for
 * the include shape.
 */

export interface VehicleContext {
    /** Vehicle.id — used for dedup across lines in the same PO. */
    vehicleId: string;
    make: string;
    model: string;
    year: number | null;
    plate: string;
    vin: string | null;
    engineSize: string | null;
    fuelType: string | null;
    /** JobCard.number — the shop's own reference for the job. */
    jobNumber: number;
}

/** Shape a caller must provide per PO line for the resolver. */
export interface ResolverPoLine {
    id: string;
    part: {
        autoCreatedFromLine: {
            estimate: {
                jobCard: {
                    number: number | null;
                    vehicle: {
                        id: string;
                        make: string;
                        model: string;
                        year: number | null;
                        plate: string;
                        vin: string | null;
                        engineSize: string | null;
                        fuelType: string | null;
                    };
                };
            };
        } | null;
    };
}

export interface ResolvedPoVehicles {
    /** Line id → context (or `null` when the chain terminates). */
    perLine: Map<string, VehicleContext | null>;
    /** Deduped vehicles across the PO. Order-preserving on first appearance. */
    distinct: VehicleContext[];
    /** True when every line resolved (used to decide the "one vehicle at the top" message shape). */
    allResolved: boolean;
    /** True when at least one line resolved (used to decide whether to show a header at all). */
    anyResolved: boolean;
}

export function resolvePoVehicles(lines: readonly ResolverPoLine[]): ResolvedPoVehicles {
    const perLine = new Map<string, VehicleContext | null>();
    const distinctById = new Map<string, VehicleContext>();
    for (const l of lines) {
        const jc = l.part.autoCreatedFromLine?.estimate.jobCard;
        if (!jc || jc.number == null) {
            // Missing chain OR job with no assigned number yet — either
            // way we can't cite it as the shop's own reference, so mark
            // the line unresolved.
            perLine.set(l.id, null);
            continue;
        }
        const v = jc.vehicle;
        const ctx: VehicleContext = {
            vehicleId: v.id,
            make: v.make,
            model: v.model,
            year: v.year,
            plate: v.plate,
            vin: v.vin,
            engineSize: v.engineSize,
            fuelType: v.fuelType,
            jobNumber: jc.number,
        };
        perLine.set(l.id, ctx);
        if (!distinctById.has(v.id)) distinctById.set(v.id, ctx);
    }
    const distinct = Array.from(distinctById.values());
    const anyResolved = distinct.length > 0;
    const allResolved = anyResolved && lines.every((l) => perLine.get(l.id) != null);
    return { perLine, distinct, anyResolved, allResolved };
}

/**
 * Compact single-line label for a vehicle in list contexts (the
 * WhatsApp/email header, the multi-vehicle inline suffix). Order:
 * make model year, then plate, then engine variant if we have
 * details worth showing. VIN is intentionally omitted here — it's
 * long and only useful on the print/document surface where a
 * multi-line block reads cleanly. Callers who want the VIN render
 * the field themselves.
 */
export function formatVehicleShort(v: VehicleContext): string {
    const parts: string[] = [];
    parts.push([v.make, v.model, v.year != null ? String(v.year) : ""].filter(Boolean).join(" "));
    parts.push(v.plate);
    const engineBits = [v.engineSize, v.fuelType].filter(Boolean).join(" ");
    if (engineBits) parts.push(engineBits);
    return parts.filter(Boolean).join(" · ");
}
