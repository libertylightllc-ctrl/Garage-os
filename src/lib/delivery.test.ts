import { describe, it, expect } from "vitest";
import {
  canRecordDelivery,
  deliveryStatus,
  cleanMileage,
  validateDeliveryInput,
} from "./delivery";

describe("delivery stage", () => {
  it("delivery can only be recorded from INVOICED", () => {
    expect(canRecordDelivery("INVOICED")).toBe(true);
    expect(canRecordDelivery("REPAIR")).toBe(false);
    expect(canRecordDelivery("DELIVERED")).toBe(false);
    expect(canRecordDelivery("CANCELLED")).toBe(false);
    expect(canRecordDelivery("ARRIVED")).toBe(false);
  });

  it("display status reflects the timestamps", () => {
    expect(deliveryStatus(null, null)).toBe("PENDING");
    expect(deliveryStatus(undefined, undefined)).toBe("PENDING");
    expect(deliveryStatus(new Date(), null)).toBe("DELIVERED");
    expect(deliveryStatus(new Date(), new Date())).toBe("CONFIRMED");
    // confirmed trumps an absent delivered-at (defensive — shouldn't occur in practice)
    expect(deliveryStatus(null, new Date())).toBe("CONFIRMED");
  });

  it("cleans mileage to a non-negative integer or null", () => {
    expect(cleanMileage(0)).toBe(0);
    expect(cleanMileage(84500)).toBe(84500);
    expect(cleanMileage(84500.7)).toBe(84500);
    expect(cleanMileage(-1)).toBeNull();
    expect(cleanMileage(NaN)).toBeNull();
  });
});

describe("validateDeliveryInput — reminder gate", () => {
  const good = {
    types: ["OIL_5000"],
    serviceDate: "2026-07-16",
    mileageOut: 84500,
  };

  it("accepts a valid payload", () => {
    const r = validateDeliveryInput(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.types).toEqual(["OIL_5000"]);
      expect(r.serviceDate).toBeInstanceOf(Date);
      expect(r.mileageOut).toBe(84500);
    }
  });

  it("rejects when no reminder type is ticked", () => {
    const r = validateDeliveryInput({ ...good, types: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/reminder/i);
  });

  it("drops unknown reminder types silently", () => {
    // Client could POST garbage; only known types survive. If everything
    // is garbage, that's treated as zero — rejected.
    const r = validateDeliveryInput({ ...good, types: ["NOT_A_REAL_TYPE"] });
    expect(r.ok).toBe(false);
  });

  it("keeps only known types when mixed with garbage", () => {
    const r = validateDeliveryInput({
      ...good,
      types: ["OIL_5000", "NOPE", "BATTERY"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.types).toEqual(["OIL_5000", "BATTERY"]);
  });

  it("rejects when serviceDate is missing", () => {
    const r = validateDeliveryInput({ ...good, serviceDate: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/date/i);
  });

  it("rejects when serviceDate is not a valid date", () => {
    const r = validateDeliveryInput({ ...good, serviceDate: "not-a-date" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/date/i);
  });

  it("rejects when mileageOut is negative", () => {
    const r = validateDeliveryInput({ ...good, mileageOut: -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mileage/i);
  });

  it("rejects when mileageOut is NaN", () => {
    const r = validateDeliveryInput({ ...good, mileageOut: NaN });
    expect(r.ok).toBe(false);
  });
});
