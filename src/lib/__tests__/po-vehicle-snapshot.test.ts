import { describe, it, expect } from "vitest";
import { buildPoLineVehicleSnapshot, resolvePoVehicles } from "@/lib/po-vehicle";

describe("buildPoLineVehicleSnapshot", () => {
    const fullVehicle = {
        id: "veh_1",
        make: "Nissan",
        model: "Patrol",
        year: 2022,
        plate: "D 12345",
        vin: "JN1TANT32U0123456",
        engineSize: "5",
        fuelType: "PETROL",
    };

    it("no source (walk-in, manual add, catalog buy) → empty snapshot", () => {
        expect(buildPoLineVehicleSnapshot(null)).toEqual({});
        expect(buildPoLineVehicleSnapshot(undefined)).toEqual({});
    });

    it("source with null jobNumber → empty snapshot (matches migration backfill guard)", () => {
        // Migration's backfill UPDATE has `AND jc.number IS NOT NULL`
        // in its WHERE. Write path must match: a JobCard without a
        // number is not a citable reference, so we skip it here too.
        // Prevents a race where a not-yet-numbered JobCard slips a
        // half-populated snapshot into the line.
        expect(
            buildPoLineVehicleSnapshot({ jobNumber: null, vehicle: fullVehicle }),
        ).toEqual({});
    });

    it("fully-populated source → every column set", () => {
        expect(
            buildPoLineVehicleSnapshot({ jobNumber: 42, vehicle: fullVehicle }),
        ).toEqual({
            vehicleId: "veh_1",
            vehicleMake: "Nissan",
            vehicleModel: "Patrol",
            vehicleYear: 2022,
            vehicleEngineSize: "5",
            vehicleFuelType: "PETROL",
            vehicleVin: "JN1TANT32U0123456",
            vehiclePlate: "D 12345",
            vehicleJobNumber: 42,
        });
    });

    it("partial vehicle (older intake / walk-in without VIN or engine) → nulls stay null", () => {
        // Don't invent placeholder values ("UNKNOWN", "N/A", 0, "").
        // A null column is meaningful — the reader can tell the shop
        // didn't record it — a placeholder is a fabrication.
        const snap = buildPoLineVehicleSnapshot({
            jobNumber: 7,
            vehicle: {
                id: "veh_2",
                make: "Toyota",
                model: "Land Cruiser",
                year: null,
                plate: "A 12345",
                vin: null,
                engineSize: null,
                fuelType: null,
            },
        });
        expect(snap).toEqual({
            vehicleId: "veh_2",
            vehicleMake: "Toyota",
            vehicleModel: "Land Cruiser",
            vehiclePlate: "A 12345",
            vehicleJobNumber: 7,
            // year/engineSize/fuelType/vin: undefined, so the spread
            // into Prisma's create data leaves the DB columns null.
            // Presence keys are absent — verified next.
        });
        expect(Object.hasOwn(snap, "vehicleYear")).toBe(false);
        expect(Object.hasOwn(snap, "vehicleVin")).toBe(false);
        expect(Object.hasOwn(snap, "vehicleEngineSize")).toBe(false);
        expect(Object.hasOwn(snap, "vehicleFuelType")).toBe(false);
    });

    it("returned shape spreads cleanly into a Prisma create — no unexpected keys", () => {
        // Regression contract: only PurchaseOrderLine snapshot columns
        // may appear as keys. A stray key would break Prisma's
        // `Object literal may only specify known properties` check
        // AND desync from the schema comment (which enumerates the
        // fields).
        const ALLOWED = new Set([
            "vehicleId",
            "vehicleMake",
            "vehicleModel",
            "vehicleYear",
            "vehicleEngineSize",
            "vehicleFuelType",
            "vehicleVin",
            "vehiclePlate",
            "vehicleJobNumber",
        ]);
        const snap = buildPoLineVehicleSnapshot({
            jobNumber: 1,
            vehicle: fullVehicle,
        });
        for (const k of Object.keys(snap)) {
            expect(ALLOWED.has(k)).toBe(true);
        }
    });
});

describe("resolvePoVehicles — snapshot-preferred read path", () => {
    const chainVehicle = {
        id: "veh_chain",
        make: "Honda",
        model: "Civic",
        year: 2020,
        plate: "B 111",
        vin: null,
        engineSize: null,
        fuelType: null,
    };
    const chainLine = {
        estimate: { jobCard: { number: 99, vehicle: chainVehicle } },
    };

    it("prefers the line's own snapshot over the chain", () => {
        // The chain still resolves (Honda Civic), but the snapshot on the
        // line is the source of truth for what the supplier already saw.
        // The line's snapshot must win — that's the whole freeze-at-send
        // contract.
        const line = {
            id: "L1",
            vehicleId: "veh_snap",
            vehicleMake: "Toyota",
            vehicleModel: "Land Cruiser",
            vehicleYear: 2021,
            vehiclePlate: "A 123",
            vehicleVin: "JT111",
            vehicleEngineSize: "4.0L",
            vehicleFuelType: "PETROL",
            vehicleJobNumber: 42,
            part: { autoCreatedFromLine: chainLine },
        };
        const r = resolvePoVehicles([line]);
        const ctx = r.perLine.get("L1")!;
        expect(ctx.make).toBe("Toyota");
        expect(ctx.model).toBe("Land Cruiser");
        expect(ctx.jobNumber).toBe(42);
        expect(ctx.vehicleId).toBe("veh_snap");
        expect(r.distinct).toHaveLength(1);
        expect(r.distinct[0].vehicleId).toBe("veh_snap");
    });

    it("falls back to the chain when snapshot is empty (pre-migration rows)", () => {
        // Backfill couldn't reach seed parts (autoCreatedFromLineId is null
        // for those). Existing rows show the chain if it resolves; new rows
        // will have snapshot columns written directly.
        const line = {
            id: "L2",
            vehicleId: null,
            vehicleMake: null,
            vehicleModel: null,
            vehiclePlate: null,
            vehicleJobNumber: null,
            part: { autoCreatedFromLine: chainLine },
        };
        const r = resolvePoVehicles([line]);
        const ctx = r.perLine.get("L2")!;
        expect(ctx.make).toBe("Honda");
        expect(ctx.jobNumber).toBe(99);
        expect(ctx.vehicleId).toBe("veh_chain");
    });

    it("returns null when both snapshot AND chain are missing", () => {
        // Manually-added parts on a walk-in: no snapshot, no chain.
        // Display surfaces show "(no vehicle linked)".
        const line = {
            id: "L3",
            vehicleId: null,
            vehicleMake: null,
            vehicleModel: null,
            vehiclePlate: null,
            vehicleJobNumber: null,
            part: { autoCreatedFromLine: null },
        };
        const r = resolvePoVehicles([line]);
        expect(r.perLine.get("L3")).toBeNull();
        expect(r.anyResolved).toBe(false);
    });
});
