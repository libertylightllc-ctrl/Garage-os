import { describe, it, expect } from "vitest";
import {
  TIMELINE,
  nextStatus,
  isTerminal,
  isActive,
  availableActions,
  transition,
  skippableTargets,
  skipTo,
  friendlyStatus,
  FRIENDLY_STATUS_TONE,
  type JobState,
} from "./jobcard-status";

const s = (status: JobState["status"], heldFrom: JobState["heldFrom"] = null): JobState => ({
  status,
  heldFrom,
});

describe("jobcard state machine", () => {
  it("advances one tap at a time through the whole timeline", () => {
    let state = s("ARRIVED");
    const path = [state.status];
    while (nextStatus(state.status)) {
      state = transition(state, "ADVANCE");
      path.push(state.status);
    }
    expect(path).toEqual(TIMELINE);
    expect(state.status).toBe("DELIVERED");
  });

  it("cannot advance past DELIVERED", () => {
    expect(() => transition(s("DELIVERED"), "ADVANCE")).toThrow();
    expect(isTerminal("DELIVERED")).toBe(true);
  });

  it("holds and resumes back to the same stage", () => {
    const held = transition(s("REPAIR"), "HOLD");
    expect(held).toEqual({ status: "ON_HOLD", heldFrom: "REPAIR" });
    const resumed = transition(held, "RESUME");
    expect(resumed).toEqual({ status: "REPAIR", heldFrom: null });
  });

  it("cancels from an active stage and then blocks further actions", () => {
    const cancelled = transition(s("INSPECTION"), "CANCEL");
    expect(cancelled.status).toBe("CANCELLED");
    expect(isActive("CANCELLED")).toBe(false);
    expect(availableActions(cancelled)).toEqual([]);
    expect(() => transition(cancelled, "ADVANCE")).toThrow();
  });

  it("reworks APPROVED/REPAIR back to ESTIMATE but not earlier stages", () => {
    expect(transition(s("APPROVED"), "REWORK").status).toBe("ESTIMATE");
    expect(transition(s("REPAIR"), "REWORK").status).toBe("ESTIMATE");
    expect(() => transition(s("ARRIVED"), "REWORK")).toThrow();
  });

  it("offers <= 3 primary-ish actions and the right ones per state", () => {
    expect(availableActions(s("ARRIVED"))).toEqual(["ADVANCE", "HOLD", "CANCEL"]);
    expect(availableActions(s("APPROVED"))).toEqual(["ADVANCE", "REWORK", "HOLD", "CANCEL"]);
    expect(availableActions(s("ON_HOLD", "REPAIR"))).toEqual(["RESUME", "CANCEL"]);
    expect(availableActions(s("DELIVERED"))).toEqual([]);
  });

  it("skip-to offers forward stages but never INVOICED/DELIVERED", () => {
    expect(skippableTargets("ARRIVED")).toEqual(["INSPECTION", "ESTIMATE", "APPROVED", "REPAIR"]);
    expect(skippableTargets("REPAIR")).toEqual([]);
    expect(skipTo(s("ARRIVED"), "REPAIR").status).toBe("REPAIR");
    expect(() => skipTo(s("ARRIVED"), "INVOICED")).toThrow();
    expect(() => skipTo(s("ESTIMATE"), "ARRIVED")).toThrow(); // no backward skip
  });

  it("cannot hold or resume from invalid states", () => {
    expect(() => transition(s("ON_HOLD", "REPAIR"), "HOLD")).toThrow();
    expect(() => transition(s("ARRIVED"), "RESUME")).toThrow();
  });
});

describe("friendlyStatus — internal → customer-facing label", () => {
  it("ARRIVED unclaimed → 'Waiting for technician'", () => {
    expect(friendlyStatus({ status: "ARRIVED", claimedById: null })).toBe(
      "WAITING_FOR_TECH",
    );
  });

  it("ARRIVED but already claimed → 'Technician diagnosing' (caught the gap before status flips)", () => {
    expect(friendlyStatus({ status: "ARRIVED", claimedById: "tech-1" })).toBe(
      "TECH_DIAGNOSING",
    );
  });

  it("INSPECTION → 'Technician diagnosing'", () => {
    expect(friendlyStatus({ status: "INSPECTION", claimedById: "tech-1" })).toBe(
      "TECH_DIAGNOSING",
    );
  });

  it("ESTIMATE with no SENT yet → 'Estimate under process' (cashier working on it)", () => {
    expect(
      friendlyStatus({
        status: "ESTIMATE",
        claimedById: "tech-1",
        latestEstimateStatus: "DRAFT",
      }),
    ).toBe("ESTIMATE_UNDER_PROCESS");
    expect(
      friendlyStatus({ status: "ESTIMATE", claimedById: "tech-1", latestEstimateStatus: null }),
    ).toBe("ESTIMATE_UNDER_PROCESS");
  });

  it("ESTIMATE with latest=SENT → 'Awaiting customer approval'", () => {
    expect(
      friendlyStatus({
        status: "ESTIMATE",
        claimedById: "tech-1",
        latestEstimateStatus: "SENT",
      }),
    ).toBe("AWAITING_CUSTOMER_APPROVAL");
  });

  it("ESTIMATE with latest=REJECTED → back to 'Estimate under process' (cashier reworking)", () => {
    expect(
      friendlyStatus({
        status: "ESTIMATE",
        claimedById: "tech-1",
        latestEstimateStatus: "REJECTED",
      }),
    ).toBe("ESTIMATE_UNDER_PROCESS");
  });

  it("APPROVED / REPAIR → 'Approved work in progress'", () => {
    for (const s of ["APPROVED", "REPAIR"] as const) {
      expect(friendlyStatus({ status: s, claimedById: "tech-1" })).toBe(
        "APPROVED_IN_PROGRESS",
      );
    }
  });

  it("TECH_COMPLETE → 'Complete — awaiting invoice' (Stage 8)", () => {
    expect(friendlyStatus({ status: "TECH_COMPLETE", claimedById: "tech-1" })).toBe(
      "COMPLETE_AWAITING_INVOICE",
    );
  });

  it("INVOICED not yet paid → 'Awaiting payment' (Stage 9)", () => {
    expect(friendlyStatus({ status: "INVOICED", claimedById: "tech-1" })).toBe(
      "AWAITING_PAYMENT",
    );
    expect(
      friendlyStatus({ status: "INVOICED", claimedById: "tech-1", invoicePaidInFull: false }),
    ).toBe("AWAITING_PAYMENT");
  });

  it("INVOICED + paid in full → 'Ready for pickup' (Stage 10)", () => {
    expect(
      friendlyStatus({ status: "INVOICED", claimedById: "tech-1", invoicePaidInFull: true }),
    ).toBe("READY_FOR_PICKUP");
  });

  it("DELIVERED → 'Collected' (Stage 11)", () => {
    expect(friendlyStatus({ status: "DELIVERED", claimedById: "tech-1" })).toBe("COMPLETE");
  });

  it("ON_HOLD and CANCELLED stay as their own labels (don't lie to the user)", () => {
    expect(friendlyStatus({ status: "ON_HOLD", claimedById: null })).toBe("ON_HOLD");
    expect(friendlyStatus({ status: "CANCELLED", claimedById: null })).toBe("CANCELLED");
  });

  it("every friendly status has a Tailwind tone (so the badge never renders unstyled)", () => {
    const allFriendly = [
      "WAITING_FOR_TECH",
      "TECH_DIAGNOSING",
      "ESTIMATE_UNDER_PROCESS",
      "AWAITING_CUSTOMER_APPROVAL",
      "APPROVED_IN_PROGRESS",
      "COMPLETE_AWAITING_INVOICE",
      "AWAITING_PAYMENT",
      "READY_FOR_PICKUP",
      "COMPLETE",
      "ON_HOLD",
      "CANCELLED",
    ] as const;
    for (const k of allFriendly) {
      expect(FRIENDLY_STATUS_TONE[k]).toMatch(/bg-\w+/);
    }
  });
});
