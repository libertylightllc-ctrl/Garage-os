import { describe, it, expect } from "vitest";
import { PurchaseOrderStatus } from "@/generated/prisma/client";
import {
  purchaseOrderSection,
  purchaseOrderStatusLabelKey,
  PURCHASE_ORDER_TABS,
  statusToUrlParam,
  urlParamToStatus,
} from "./purchase-order-section";

describe("purchaseOrderSection — exhaustiveness", () => {
  it("every PurchaseOrderStatus value lands in EXACTLY one section", () => {
    const values = Object.values(PurchaseOrderStatus);
    // Sanity: the enum is non-empty; if this drops to 0 the test below is
    // vacuously true and the safety net is gone.
    expect(values.length).toBeGreaterThan(0);

    // Every value maps to OPEN or CLOSED. `never` in the helper's
    // default arm makes an unmapped value a compile error, but this
    // runtime check catches the case where someone bypasses the helper
    // and calls it with a string cast at runtime (or when running a
    // JS-only build).
    for (const status of values) {
      const section = purchaseOrderSection(status);
      expect(["OPEN", "CLOSED"]).toContain(section);
    }
  });

  it("known status routings — the specific bug this fixes", () => {
    // PARTIALLY_RECEIVED was silently dropped by the old bucket filter
    // (kept only DRAFT+ORDERED in Open and RECEIVED+CANCELLED in Closed).
    // This assertion locks in the fix.
    expect(purchaseOrderSection("PARTIALLY_RECEIVED")).toBe("OPEN");

    // The other four keep their expected homes.
    expect(purchaseOrderSection("DRAFT")).toBe("OPEN");
    expect(purchaseOrderSection("ORDERED")).toBe("OPEN");
    expect(purchaseOrderSection("RECEIVED")).toBe("CLOSED");
    expect(purchaseOrderSection("CANCELLED")).toBe("CLOSED");
  });

  it("union of both sections covers the full enum with no overlap", () => {
    const values = Object.values(PurchaseOrderStatus);
    const open = values.filter((s) => purchaseOrderSection(s) === "OPEN");
    const closed = values.filter((s) => purchaseOrderSection(s) === "CLOSED");
    // Partition property: open ∪ closed = full set, open ∩ closed = ∅.
    expect(open.length + closed.length).toBe(values.length);
    for (const s of open) expect(closed).not.toContain(s);
  });
});

describe("purchaseOrderStatusLabelKey — every status has a translation key", () => {
  it("returns a label key for every enum value", () => {
    for (const status of Object.values(PurchaseOrderStatus)) {
      const key = purchaseOrderStatusLabelKey(status);
      expect(key).toMatch(/^poStatus_/);
    }
  });
});

describe("PURCHASE_ORDER_TABS — derived tab list", () => {
  it("covers every enum value exactly once", () => {
    const values = Object.values(PurchaseOrderStatus);
    expect(PURCHASE_ORDER_TABS.length).toBe(values.length);
    for (const s of values) {
      expect(PURCHASE_ORDER_TABS).toContain(s);
    }
  });

  it("matches the schema declaration order — DRAFT → CANCELLED", () => {
    expect([...PURCHASE_ORDER_TABS]).toEqual([
      "DRAFT",
      "ORDERED",
      "PARTIALLY_RECEIVED",
      "RECEIVED",
      "CANCELLED",
    ]);
  });
});

describe("urlParamToStatus / statusToUrlParam — round-trip + safety", () => {
  it("round-trips every enum value via lowercase URL param", () => {
    for (const status of Object.values(PurchaseOrderStatus)) {
      const url = statusToUrlParam(status);
      expect(url).toBe(status.toLowerCase());
      expect(urlParamToStatus(url)).toBe(status);
    }
  });

  it("mixed-case survives", () => {
    expect(urlParamToStatus("Draft")).toBe("DRAFT");
    expect(urlParamToStatus("PARTIALLY_RECEIVED")).toBe("PARTIALLY_RECEIVED");
  });

  it("junk / unknown returns null so the caller can fall back to default", () => {
    expect(urlParamToStatus("")).toBeNull();
    expect(urlParamToStatus("garbage")).toBeNull();
    expect(urlParamToStatus(undefined)).toBeNull();
    expect(urlParamToStatus(42)).toBeNull();
    expect(urlParamToStatus("cancelled_x")).toBeNull();
  });
});
