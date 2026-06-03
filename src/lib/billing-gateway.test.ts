import { describe, it, expect } from "vitest";
import { mapStripeStatus, shouldCharge } from "./billing-gateway";

describe("mapStripeStatus", () => {
  it("maps Stripe statuses to our enum", () => {
    expect(mapStripeStatus("trialing")).toBe("TRIALING");
    expect(mapStripeStatus("active")).toBe("ACTIVE");
    expect(mapStripeStatus("past_due")).toBe("PAST_DUE");
    expect(mapStripeStatus("unpaid")).toBe("PAST_DUE");
    expect(mapStripeStatus("canceled")).toBe("CANCELED");
  });
});

describe("shouldCharge (pilots never billed)", () => {
  it("never charges a pilot", () => {
    expect(shouldCharge({ isPilot: true })).toBe(false);
  });
  it("charges a non-pilot", () => {
    expect(shouldCharge({ isPilot: false })).toBe(true);
  });
});
