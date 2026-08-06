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
    // Snapshot columns on PurchaseOrderLine — written once at line creation
    // by buildPoLineVehicleSnapshot(). SOLE source of truth for the
    // resolver as of 2026-08-02: the chain fallback via
    // Part.autoCreatedFromLine was removed after a bug report — the
    // fallback was inventing the vehicle at render time from the
    // matched Part's ORIGIN estimate, which for a manually-added line
    // on a standalone PO/RFQ meant showing the wrong car to a
    // supplier. Snapshot present → use it. Snapshot null → line has no
    // vehicle (correct — the user never picked one).
    vehicleId?: string | null;
    vehicleMake?: string | null;
    vehicleModel?: string | null;
    vehicleYear?: number | null;
    vehiclePlate?: string | null;
    vehicleVin?: string | null;
    vehicleEngineSize?: string | null;
    vehicleFuelType?: string | null;
    vehicleJobNumber?: number | null;
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
        // The line's own snapshot columns are the SOLE source of truth.
        // The old fallback to `Part.autoCreatedFromLine.…` was removed
        // 2026-08-02 after it was found to invent a vehicle at render
        // time for any manually-added line whose matched catalogue Part
        // happened to have been auto-created from a previous estimate.
        // Rule now: snapshot present → resolve. Snapshot null → line
        // has no vehicle, period.
        let ctx: VehicleContext | null = null;
        if (l.vehicleId && l.vehicleMake && l.vehicleModel && l.vehiclePlate && l.vehicleJobNumber != null) {
            ctx = {
                vehicleId: l.vehicleId,
                make: l.vehicleMake,
                model: l.vehicleModel,
                year: l.vehicleYear ?? null,
                plate: l.vehiclePlate,
                vin: l.vehicleVin ?? null,
                engineSize: l.vehicleEngineSize ?? null,
                fuelType: l.vehicleFuelType ?? null,
                jobNumber: l.vehicleJobNumber,
            };
        }
        perLine.set(l.id, ctx);
        if (ctx && !distinctById.has(ctx.vehicleId)) distinctById.set(ctx.vehicleId, ctx);
    }
    const distinct = Array.from(distinctById.values());
    const anyResolved = distinct.length > 0;
    const allResolved = anyResolved && lines.every((l) => perLine.get(l.id) != null);
    return { perLine, distinct, anyResolved, allResolved };
}

/**
 * Snapshot fields written to PurchaseOrderLine at CREATION TIME.
 *
 * Lifecycle rule (schema.prisma PurchaseOrderLine comment): written
 * once, editable only by the advisor through the PO line form, never
 * refreshed from the linked Vehicle after creation. This helper is
 * the write-side counterpart to the migration's backfill UPDATE —
 * same shape, same fields. Any change here must stay in lockstep
 * with the schema and the migration.
 *
 * All fields are optional at the DB level. Callers that can't
 * resolve a vehicle pass an empty object `{}` and the line ships
 * with every snapshot field null — the display surfaces render
 * "(no vehicle linked)" for that shape. NEVER invent placeholder
 * values ("UNKNOWN", "N/A", 0, ""); a null field is meaningful and
 * distinguishable from a real one, a placeholder isn't.
 */
export interface PoLineVehicleSnapshot {
    vehicleId?: string;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleYear?: number;
    vehicleEngineSize?: string;
    vehicleFuelType?: string;
    vehicleVin?: string;
    vehiclePlate?: string;
    vehicleJobNumber?: number;
}

/**
 * Shape a caller must produce for `buildPoLineVehicleSnapshot`. Two
 * paths through the code both funnel through this — see the two
 * usages in src/app/actions/purchasing.ts:
 *   • addPoLineAction — reads the chain via
 *     `Part.autoCreatedFromLine.estimate.jobCard.vehicle` when the
 *     Part was auto-created. Manually-added Parts have no chain.
 *   • createPoFromEstimateAction — reads directly from the
 *     estimate's `jobCard.vehicle` that's already in scope.
 */
export interface SnapshotSource {
    jobNumber: number | null;
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
}

/**
 * Build the snapshot object to spread into a PurchaseOrderLine create.
 * Returns `{}` when no source is available — the caller spreads it
 * either way, so no-vehicle lines just come out with every snapshot
 * field null. `jobNumber == null` also returns `{}` because the JC#
 * is the shop's own reference and a JobCard without a number isn't
 * a citable document (matches the migration backfill's
 * `AND jc.number IS NOT NULL` guard).
 */
export function buildPoLineVehicleSnapshot(
    src: SnapshotSource | null | undefined,
): PoLineVehicleSnapshot {
    if (!src || src.jobNumber == null) return {};
    const v = src.vehicle;
    // Conditionally assign the nullable fields — writing `{ vehicleYear:
    // undefined }` would create an own property with value undefined,
    // which downstream code (and tests) can't distinguish from "the
    // caller meant to set undefined". Absent keys are the honest way
    // to say "the shop didn't record this".
    const snap: PoLineVehicleSnapshot = {
        vehicleId: v.id,
        vehicleMake: v.make,
        vehicleModel: v.model,
        vehiclePlate: v.plate,
        vehicleJobNumber: src.jobNumber,
    };
    if (v.year != null) snap.vehicleYear = v.year;
    if (v.engineSize != null) snap.vehicleEngineSize = v.engineSize;
    if (v.fuelType != null) snap.vehicleFuelType = v.fuelType;
    if (v.vin != null) snap.vehicleVin = v.vin;
    return snap;
}

/**
 * Standalone-PO vehicle snapshot input. Everything optional; the caller
 * has ALREADY parsed the form (plate lookup on garage vehicles + fall-
 * back to free-text). Unlike SnapshotSource / buildPoLineVehicleSnapshot,
 * this does NOT require jobNumber — a standalone quotation / purchase
 * order has no source job.
 */
export interface StandaloneVehicleInput {
    vehicleId?: string | null;
    make?: string | null;
    model?: string | null;
    year?: number | null;
    plate?: string | null;
    vin?: string | null;
    engineSize?: string | null;
    fuelType?: string | null;
}

/**
 * True when at least one meaningful field is present. Used to decide
 * whether to write anything to the doc-level default columns and
 * whether a line inherits from the default at write time.
 */
export function hasAnyVehicleField(v: StandaloneVehicleInput): boolean {
    return Boolean(
        v.vehicleId ||
        (v.make && v.make.trim()) ||
        (v.model && v.model.trim()) ||
        v.year != null ||
        (v.plate && v.plate.trim()) ||
        (v.vin && v.vin.trim()) ||
        (v.engineSize && v.engineSize.trim()) ||
        (v.fuelType && v.fuelType.trim()),
    );
}

/**
 * Build a snapshot object for spreading into a PurchaseOrder default*
 * or PurchaseOrderLine vehicle* create. Omits any field that's null /
 * empty — so an object literal spread never sets `vehicleYear:
 * undefined` (which would create the own property with value
 * undefined and confuse downstream nullability checks). Returns `{}`
 * when the input has no meaningful data (caller should not spread /
 * write in that case).
 */
export function buildStandaloneVehicleSnapshot(
    v: StandaloneVehicleInput,
): PoLineVehicleSnapshot {
    if (!hasAnyVehicleField(v)) return {};
    const snap: PoLineVehicleSnapshot = {};
    if (v.vehicleId) snap.vehicleId = v.vehicleId;
    if (v.make && v.make.trim()) snap.vehicleMake = v.make.trim();
    if (v.model && v.model.trim()) snap.vehicleModel = v.model.trim();
    if (v.year != null && Number.isFinite(v.year)) snap.vehicleYear = v.year;
    if (v.plate && v.plate.trim()) snap.vehiclePlate = v.plate.trim();
    if (v.vin && v.vin.trim()) snap.vehicleVin = v.vin.trim();
    if (v.engineSize && v.engineSize.trim()) snap.vehicleEngineSize = v.engineSize.trim();
    if (v.fuelType && v.fuelType.trim()) snap.vehicleFuelType = v.fuelType.trim();
    return snap;
}

/**
 * Same snapshot shape but for the PO doc-level default columns (they
 * have the `default` prefix). Same suppress-empty rule.
 */
export interface PoDefaultVehicleSnapshot {
    defaultVehicleId?: string;
    defaultVehicleMake?: string;
    defaultVehicleModel?: string;
    defaultVehicleYear?: number;
    defaultVehiclePlate?: string;
    defaultVehicleVin?: string;
    defaultVehicleEngineSize?: string;
    defaultVehicleFuelType?: string;
}

export function buildPoDefaultVehicleSnapshot(
    v: StandaloneVehicleInput,
): PoDefaultVehicleSnapshot {
    if (!hasAnyVehicleField(v)) return {};
    const snap: PoDefaultVehicleSnapshot = {};
    if (v.vehicleId) snap.defaultVehicleId = v.vehicleId;
    if (v.make && v.make.trim()) snap.defaultVehicleMake = v.make.trim();
    if (v.model && v.model.trim()) snap.defaultVehicleModel = v.model.trim();
    if (v.year != null && Number.isFinite(v.year)) snap.defaultVehicleYear = v.year;
    if (v.plate && v.plate.trim()) snap.defaultVehiclePlate = v.plate.trim();
    if (v.vin && v.vin.trim()) snap.defaultVehicleVin = v.vin.trim();
    if (v.engineSize && v.engineSize.trim())
        snap.defaultVehicleEngineSize = v.engineSize.trim();
    if (v.fuelType && v.fuelType.trim()) snap.defaultVehicleFuelType = v.fuelType.trim();
    return snap;
}

/**
 * Reshape a PO row's `default*` columns into a StandaloneVehicleInput
 * so it can be fed to buildStandaloneVehicleSnapshot when a new line
 * inherits from the doc-level default.
 */
export interface PoDefaultVehicleRow {
    defaultVehicleId: string | null;
    defaultVehicleMake: string | null;
    defaultVehicleModel: string | null;
    defaultVehicleYear: number | null;
    defaultVehiclePlate: string | null;
    defaultVehicleVin: string | null;
    defaultVehicleEngineSize: string | null;
    defaultVehicleFuelType: string | null;
}

export function poDefaultToStandalone(
    p: PoDefaultVehicleRow,
): StandaloneVehicleInput {
    return {
        vehicleId: p.defaultVehicleId,
        make: p.defaultVehicleMake,
        model: p.defaultVehicleModel,
        year: p.defaultVehicleYear,
        plate: p.defaultVehiclePlate,
        vin: p.defaultVehicleVin,
        engineSize: p.defaultVehicleEngineSize,
        fuelType: p.defaultVehicleFuelType,
    };
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
