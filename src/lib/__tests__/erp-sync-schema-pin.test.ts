// Pins the ERPNext-sync Phase 1 schema shape.
//
// The three ErpSync* tables + Garage.erpSyncEnabled column are the
// state spine of a one-way push into ERPNext (see
// ERPNEXT_SYNC_BRIEF.md at repo root). Two constraints are load-
// bearing per §7 of the brief:
//
//   1. Every op is idempotent on (garageId, op, sourceId) — the
//      tailer runs repeatedly and re-scans overlapping cursor
//      windows on retry; without this unique constraint a re-scan
//      would double-enqueue and corrupt ERPNext.
//   2. The entity map is unique on both sides — a duplicate push
//      fails at the database rather than silently creating a second
//      record.
//
// A silent widening or removal of either uniqueness fires this test.
// Same shape as master-owner-boundary.test.ts: source-inspection of
// schema.prisma, brittle by design so a stealth revert fails the
// build with the offending line named.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SCHEMA = readFileSync(
    join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
);

describe("ERPNext sync Phase 1 — schema pin", () => {
    it("Garage carries erpSyncEnabled, default false, non-null", () => {
        expect(SCHEMA).toMatch(
            /erpSyncEnabled\s+Boolean\s+@default\(false\)/,
        );
    });

    it("ErpEntityMap unique on (garageId, garageosDoctype, garageosId)", () => {
        expect(SCHEMA).toMatch(
            /@@unique\(\[garageId,\s*garageosDoctype,\s*garageosId\]\)/,
        );
    });

    it("ErpEntityMap unique on (garageId, erpnextDoctype, erpnextName)", () => {
        expect(SCHEMA).toMatch(
            /@@unique\(\[garageId,\s*erpnextDoctype,\s*erpnextName\]\)/,
        );
    });

    it("ErpSyncJob unique on (garageId, op, sourceId) — the tailer's re-scan safety", () => {
        expect(SCHEMA).toMatch(
            /@@unique\(\[garageId,\s*op,\s*sourceId\]\)/,
        );
    });

    it("ErpSyncOp enum lists exactly the seven ops from the brief", () => {
        // Enum order is deliberate — master-data first, then ledger
        // events. A change to this list means Phase 2's tailer needs
        // a matching change; catching drift here beats catching it in
        // a smoke test that fires when the tailer misses an op.
        const enumBlock = SCHEMA.match(
            /enum ErpSyncOp \{([\s\S]*?)\}/,
        )?.[1];
        expect(enumBlock).toBeDefined();
        const values = (enumBlock ?? "")
            .split("\n")
            .map((l) => l.replace(/\/\/.*$/, "").trim())
            .filter((l) => l.length > 0);
        expect(values).toEqual([
            "PUSH_CUSTOMER",
            "PUSH_ITEM",
            "PUSH_INVOICE",
            "PUSH_PAYMENT",
            "PUSH_ADVANCE",
            "PUSH_VOID",
            "APPLY_DEPOSIT",
        ]);
    });

    it("ErpSyncJobStatus enum has PENDING / RUNNING / SYNCED / FAILED / DEAD_LETTER", () => {
        const enumBlock = SCHEMA.match(
            /enum ErpSyncJobStatus \{([\s\S]*?)\}/,
        )?.[1];
        expect(enumBlock).toBeDefined();
        const values = (enumBlock ?? "")
            .split("\n")
            .map((l) => l.replace(/\/\/.*$/, "").trim())
            .filter((l) => l.length > 0);
        expect(values).toEqual([
            "PENDING",
            "RUNNING",
            "SYNCED",
            "FAILED",
            "DEAD_LETTER",
        ]);
    });

    it("ErpSyncCursor uses compound (lastLedgerCreatedAt, lastLedgerId) — LedgerEntry.id is a cuid, not monotonic", () => {
        const cursorBlock = SCHEMA.match(
            /model ErpSyncCursor \{([\s\S]*?)\n\}/,
        )?.[1];
        expect(cursorBlock).toBeDefined();
        expect(cursorBlock).toMatch(/lastLedgerCreatedAt\s+DateTime/);
        expect(cursorBlock).toMatch(/lastLedgerId\s+String/);
    });
});
