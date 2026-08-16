import { describe, it, expect } from "vitest";
import { PurchaseOrderStatus } from "@/generated/prisma/client";
import {
  purchaseOrderSection,
  purchaseOrderStatusLabelKey,
  purchaseOrderTabLabelKey,
  tabHasImplicitSentFilter,
  tabWherePredicate,
  PURCHASE_ORDER_TABS,
  DEFAULT_PURCHASE_ORDER_TAB,
  tabToUrlParam,
  urlParamToTab,
  type PurchaseOrderTab,
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
  // Still used by surfaces that render the raw schema status (detail
  // page banner, print doc footer, admin logs). Kept in lock-step with
  // the enum so a new status can't ship without a key.
  it("returns a poStatus_* key for every enum value", () => {
    for (const status of Object.values(PurchaseOrderStatus)) {
      const key = purchaseOrderStatusLabelKey(status);
      expect(key).toMatch(/^poStatus_/);
    }
  });
});

describe("PURCHASE_ORDER_TABS — the display tab list (AR 2026-08-17)", () => {
  // Tabs are a DISPLAY split, not a schema mirror. DRAFT is split into
  // UNSENT_DRAFT + AWAITING_SUPPLIER; everything else 1-for-1.

  it("declares the tabs in action-oriented order", () => {
    // What needs the owner's action first, then what's in flight,
    // then closed.
    expect([...PURCHASE_ORDER_TABS]).toEqual([
      "UNSENT_DRAFT",
      "AWAITING_SUPPLIER",
      "ORDERED",
      "PARTIALLY_RECEIVED",
      "RECEIVED",
      "CANCELLED",
    ]);
  });

  it("has one more tab than the schema has statuses (the DRAFT split)", () => {
    expect(PURCHASE_ORDER_TABS.length).toBe(
      Object.values(PurchaseOrderStatus).length + 1,
    );
  });

  it("default tab is ORDERED — 'real work in flight'", () => {
    expect(DEFAULT_PURCHASE_ORDER_TAB).toBe("ORDERED");
  });
});

describe("purchaseOrderTabLabelKey — every tab has a translation key", () => {
  it("returns a MessageKey for every tab (build breaks if a new tab is added without a case)", () => {
    for (const tab of PURCHASE_ORDER_TABS) {
      const key = purchaseOrderTabLabelKey(tab);
      // The two draft tabs get poTab_* keys; the rest reuse poStatus_*
      // because their tab and status names are the same.
      expect(key).toMatch(/^(poTab_|poStatus_)/);
    }
  });

  it("draft tabs get the new poTab_* keys, others reuse poStatus_*", () => {
    expect(purchaseOrderTabLabelKey("UNSENT_DRAFT")).toBe("poTab_UNSENT_DRAFT");
    expect(purchaseOrderTabLabelKey("AWAITING_SUPPLIER")).toBe(
      "poTab_AWAITING_SUPPLIER",
    );
    expect(purchaseOrderTabLabelKey("ORDERED")).toBe("poStatus_ORDERED");
    expect(purchaseOrderTabLabelKey("PARTIALLY_RECEIVED")).toBe(
      "poStatus_PARTIALLY_RECEIVED",
    );
    expect(purchaseOrderTabLabelKey("RECEIVED")).toBe("poStatus_RECEIVED");
    expect(purchaseOrderTabLabelKey("CANCELLED")).toBe("poStatus_CANCELLED");
  });
});

describe("tabWherePredicate — DRAFT split maps to sends-any-none clauses", () => {
  it("UNSENT_DRAFT → status DRAFT + sends is empty", () => {
    expect(tabWherePredicate("UNSENT_DRAFT")).toEqual({
      status: "DRAFT",
      sends: { none: {} },
    });
  });

  it("AWAITING_SUPPLIER → status DRAFT + sends is non-empty", () => {
    expect(tabWherePredicate("AWAITING_SUPPLIER")).toEqual({
      status: "DRAFT",
      sends: { some: {} },
    });
  });

  it("post-DRAFT tabs pass status straight through with no send predicate", () => {
    // Anywhere else the sent axis is a legit user-controlled filter
    // (the Sent / Not sent pill); the tab shouldn't force it either
    // way.
    for (const tab of [
      "ORDERED",
      "PARTIALLY_RECEIVED",
      "RECEIVED",
      "CANCELLED",
    ] as const) {
      const pred = tabWherePredicate(tab);
      expect(pred).toEqual({ status: tab });
      expect(pred).not.toHaveProperty("sends");
    }
  });
});

describe("tabHasImplicitSentFilter — the pill-visibility rule", () => {
  it("true for the two DRAFT-split tabs (pill would be redundant/contradictory)", () => {
    expect(tabHasImplicitSentFilter("UNSENT_DRAFT")).toBe(true);
    expect(tabHasImplicitSentFilter("AWAITING_SUPPLIER")).toBe(true);
  });

  it("false everywhere else — the pill stays useful", () => {
    for (const tab of [
      "ORDERED",
      "PARTIALLY_RECEIVED",
      "RECEIVED",
      "CANCELLED",
    ] as const satisfies readonly PurchaseOrderTab[]) {
      expect(tabHasImplicitSentFilter(tab)).toBe(false);
    }
  });
});

describe("urlParamToTab / tabToUrlParam — round-trip + legacy compat", () => {
  it("round-trips every tab via kebab-case URL param", () => {
    for (const tab of PURCHASE_ORDER_TABS) {
      const url = tabToUrlParam(tab);
      expect(url).toBe(tab.toLowerCase().replace(/_/g, "-"));
      expect(urlParamToTab(url)).toBe(tab);
    }
  });

  it("mixed-case survives", () => {
    expect(urlParamToTab("Unsent-Draft")).toBe("UNSENT_DRAFT");
    expect(urlParamToTab("PARTIALLY-RECEIVED")).toBe("PARTIALLY_RECEIVED");
  });

  it("legacy ?status=draft (pre-split URL) lands on UNSENT_DRAFT", () => {
    // Bookmarked pre-split URLs used ?status=draft. Route them to
    // the "what needs my action" bucket rather than 404 to default —
    // that's what the operator most likely wanted.
    expect(urlParamToTab("draft")).toBe("UNSENT_DRAFT");
    expect(urlParamToTab("DRAFT")).toBe("UNSENT_DRAFT");
  });

  it("junk / unknown returns null so the caller can fall back to default", () => {
    expect(urlParamToTab("")).toBeNull();
    expect(urlParamToTab("garbage")).toBeNull();
    expect(urlParamToTab(undefined)).toBeNull();
    expect(urlParamToTab(42)).toBeNull();
    expect(urlParamToTab("cancelled_x")).toBeNull();
  });
});
