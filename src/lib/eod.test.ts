import { describe, it, expect } from "vitest";
import { eodBucket } from "./eod";

describe("end-of-day bucketing", () => {
  it("invoiced (not delivered) is ready for collection", () => {
    expect(eodBucket("INVOICED", null)).toBe("READY");
  });

  it("on hold for a part is waiting on parts", () => {
    expect(eodBucket("ON_HOLD", "AWAITING_PART")).toBe("WAITING_PARTS");
  });

  it("on hold for the customer or approval is waiting on the customer", () => {
    expect(eodBucket("ON_HOLD", "AWAITING_CUSTOMER")).toBe("WAITING_CUSTOMER");
    expect(eodBucket("ON_HOLD", "AWAITING_APPROVAL")).toBe("WAITING_CUSTOMER");
  });

  it("on hold for another reason is OTHER", () => {
    expect(eodBucket("ON_HOLD", "OTHER")).toBe("OTHER");
    expect(eodBucket("ON_HOLD", null)).toBe("OTHER");
  });

  it("active stages are in progress", () => {
    for (const s of ["ARRIVED", "INSPECTION", "ESTIMATE", "APPROVED", "REPAIR"]) {
      expect(eodBucket(s, null)).toBe("IN_PROGRESS");
    }
  });
});
