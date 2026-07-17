// Guards the exhaustiveness discipline of part-request-open.ts. If a new
// PartRequestStatus lands in the schema without being explicitly routed
// to OPEN or TERMINAL, tsc will fail the whole build before these run;
// the tests below just pin the current shape so silent regressions
// (someone stuffing a new value into a default arm) show up here too.

import { describe, it, expect } from "vitest";
import { PartRequestStatus } from "@/generated/prisma/client";
import {
  partRequestSection,
  PART_REQUEST_OPEN_STATUSES,
} from "./part-request-open";

describe("partRequestSection", () => {
  it("routes REQUESTED, ORDERED, ARRIVED to OPEN", () => {
    expect(partRequestSection("REQUESTED")).toBe("OPEN");
    expect(partRequestSection("ORDERED")).toBe("OPEN");
    expect(partRequestSection("ARRIVED")).toBe("OPEN");
  });

  it("routes FULFILLED and CANCELLED to TERMINAL (explicit, not a default)", () => {
    expect(partRequestSection("FULFILLED")).toBe("TERMINAL");
    expect(partRequestSection("CANCELLED")).toBe("TERMINAL");
  });

  it("routes every enum value — no status silently drops out", () => {
    for (const s of Object.values(PartRequestStatus)) {
      const section = partRequestSection(s);
      expect(["OPEN", "TERMINAL"]).toContain(section);
    }
  });
});

describe("PART_REQUEST_OPEN_STATUSES", () => {
  it("is exactly the OPEN statuses derived from the enum", () => {
    // The current shape — kept as a concrete assertion so a silent change
    // in ordering or membership is caught, not just a typecheck.
    expect([...PART_REQUEST_OPEN_STATUSES]).toEqual([
      "REQUESTED",
      "ORDERED",
      "ARRIVED",
    ]);
  });

  it("excludes every TERMINAL status", () => {
    for (const s of Object.values(PartRequestStatus)) {
      if (partRequestSection(s) === "TERMINAL") {
        expect(PART_REQUEST_OPEN_STATUSES).not.toContain(s);
      }
    }
  });

  it("includes every OPEN status", () => {
    for (const s of Object.values(PartRequestStatus)) {
      if (partRequestSection(s) === "OPEN") {
        expect(PART_REQUEST_OPEN_STATUSES).toContain(s);
      }
    }
  });
});
