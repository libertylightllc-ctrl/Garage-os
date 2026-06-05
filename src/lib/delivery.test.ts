import { describe, it, expect } from "vitest";
import { canRecordDelivery, deliveryStatus, cleanMileage } from "./delivery";

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
