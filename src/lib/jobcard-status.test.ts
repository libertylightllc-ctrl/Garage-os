import { describe, it, expect } from "vitest";
import {
  TIMELINE,
  nextStatus,
  isTerminal,
  isActive,
  availableActions,
  transition,
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

  it("cannot hold or resume from invalid states", () => {
    expect(() => transition(s("ON_HOLD", "REPAIR"), "HOLD")).toThrow();
    expect(() => transition(s("ARRIVED"), "RESUME")).toThrow();
  });
});
