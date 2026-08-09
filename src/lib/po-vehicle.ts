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
    /**
     * Vehicle.id when the row was picked from the garage's catalogue;
     * null for a free-text-typed vehicle (owner typed make + model for
     * a car we haven't seen). Both are legitimate write shapes as of
     * 2026-08-02.
     */
    vehicleId: string | null;
    make: string | null;
    model: string | null;
    year: number | null;
    plate: string | null;
    vin: string | null;
    engineSize: string | null;
    fuelType: string | null;
    /**
     * JobCard.number — the shop's own reference. Set only when the
     * vehicle was pulled from a source job (the from-estimate flow).
     * Null on standalone / free-text vehicles.
     */
    jobNumber: number | null;
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

/**
 * Doc-level default vehicle that a line falls back to at render time
 * when the line's own snapshot is empty. Same shape as a line's own
 * snapshot columns but sourced from `PurchaseOrder.default*` (fix #3,
 * 2026-08-02).
 *
 * Snapshot semantics unchanged — the doc default is written ONCE at
 * PO creation and never mutated; falling back to it at render is not
 * a "live reference" in the sense the schema comment warns against,
 * it's still snapshot data, just held at doc scope. This existed
 * before as a write-time copy INTO the line's own columns, but the
 * copy was invisible because the old strict predicate below
 * (`vehicleJobNumber != null`) refused to render standalone / free-
 * text writes. Doc-level fallback at render is the belt-and-braces
 * that catches the same shape whether the copy landed or not, and
 * covers pre-fix rows retroactively.
 */
export interface ResolverPoDefault {
    defaultVehicleId?: string | null;
    defaultVehicleMake?: string | null;
    defaultVehicleModel?: string | null;
    defaultVehicleYear?: number | null;
    defaultVehiclePlate?: string | null;
    defaultVehicleVin?: string | null;
    defaultVehicleEngineSize?: string | null;
    defaultVehicleFuelType?: string | null;
    defaultVehicleJobNumber?: number | null;
}

/** Any identifying field means "this snapshot represents a real vehicle". */
function anySnapshotField(
    id: string | null | undefined,
    plate: string | null | undefined,
    make: string | null | undefined,
    model: string | null | undefined,
    vin: string | null | undefined,
): boolean {
    return Boolean(id || plate || make || model || vin);
}

export function resolvePoVehicles(
    lines: readonly ResolverPoLine[],
    docDefault: ResolverPoDefault | null = null,
): ResolvedPoVehicles {
    const perLine = new Map<string, VehicleContext | null>();
    const distinctById = new Map<string, VehicleContext>();

    // Build the doc-level fallback once. `null` when the doc has no
    // meaningful default set (all default* columns empty).
    let docCtx: VehicleContext | null = null;
    if (
        docDefault &&
        anySnapshotField(
            docDefault.defaultVehicleId,
            docDefault.defaultVehiclePlate,
            docDefault.defaultVehicleMake,
            docDefault.defaultVehicleModel,
            docDefault.defaultVehicleVin,
        )
    ) {
        docCtx = {
            vehicleId: docDefault.defaultVehicleId ?? null,
            make: docDefault.defaultVehicleMake ?? null,
            model: docDefault.defaultVehicleModel ?? null,
            year: docDefault.defaultVehicleYear ?? null,
            plate: docDefault.defaultVehiclePlate ?? null,
            vin: docDefault.defaultVehicleVin ?? null,
            engineSize: docDefault.defaultVehicleEngineSize ?? null,
            fuelType: docDefault.defaultVehicleFuelType ?? null,
            jobNumber: docDefault.defaultVehicleJobNumber ?? null,
        };
    }

    for (const l of lines) {
        // Line's own snapshot wins when it has ANY identifying field —
        // vehicleId, plate, make, model, or VIN. The old strict
        // predicate required ALL of vehicleId + make + model + plate +
        // jobNumber and silently dropped standalone / free-text lines
        // (fix #3, 2026-08-02 followup). Doc-level fallback catches
        // lines with no per-line snapshot AND covers pre-fix rows
        // retroactively.
        let ctx: VehicleContext | null = null;
        if (
            anySnapshotField(
                l.vehicleId,
                l.vehiclePlate,
                l.vehicleMake,
                l.vehicleModel,
                l.vehicleVin,
            )
        ) {
            ctx = {
                vehicleId: l.vehicleId ?? null,
                make: l.vehicleMake ?? null,
                model: l.vehicleModel ?? null,
                year: l.vehicleYear ?? null,
                plate: l.vehiclePlate ?? null,
                vin: l.vehicleVin ?? null,
                engineSize: l.vehicleEngineSize ?? null,
                fuelType: l.vehicleFuelType ?? null,
                jobNumber: l.vehicleJobNumber ?? null,
            };
        } else if (docCtx) {
            ctx = docCtx;
        }
        perLine.set(l.id, ctx);
        if (ctx) {
            // Dedup: prefer vehicleId when set; otherwise the snapshot
            // hash (plate is usually enough, but stringify the whole
            // shape so a partial free-text ctx doesn't collapse with a
            // different partial ctx that happens to share a plate).
            const key = ctx.vehicleId ?? JSON.stringify(ctx);
            if (!distinctById.has(key)) distinctById.set(key, ctx);
        }
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
    // Job card number — captured when the operator identified the car
    // by JC# in the vehicle picker instead of by plate. Snapshot on
    // the line / doc-default, purely informational for the supplier
    // ("this is for the job you know as JC-2026-0007"). Never used as
    // a live join key.
    jobNumber?: number | null;
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
        (v.fuelType && v.fuelType.trim()) ||
        v.jobNumber != null,
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
    if (v.jobNumber != null && Number.isFinite(v.jobNumber)) snap.vehicleJobNumber = v.jobNumber;
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
    defaultVehicleJobNumber?: number;
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
    if (v.jobNumber != null && Number.isFinite(v.jobNumber))
        snap.defaultVehicleJobNumber = v.jobNumber;
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
    defaultVehicleJobNumber: number | null;
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
        jobNumber: p.defaultVehicleJobNumber,
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
    // All fields nullable as of 2026-08-02 — a standalone / free-text
    // vehicle may have only make + model, or only a plate.
    const parts: string[] = [];
    const mmy = [v.make, v.model, v.year != null ? String(v.year) : ""]
        .filter((s): s is string => Boolean(s))
        .join(" ");
    if (mmy) parts.push(mmy);
    if (v.plate) parts.push(v.plate);
    const engineBits = [v.engineSize, v.fuelType]
        .filter((s): s is string => Boolean(s))
        .join(" ");
    if (engineBits) parts.push(engineBits);
    return parts.join(" · ");
}
