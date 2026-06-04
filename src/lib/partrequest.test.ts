import { describe, it, expect } from "vitest";
import {
  isOpen,
  inStock,
  shouldPauseForRequest,
  canTransition,
  consumesStock,
  restocks,
  stockDelta,
  canResumeFromParts,
  type PartRequestStatus,
} from "./partrequest";

describe("part-request lifecycle", () => {
  it("open states block the job; closed states release it", () => {
    expect(isOpen("REQUESTED")).toBe(true);
    expect(isOpen("ORDERED")).toBe(true);
    expect(isOpen("ARRIVED")).toBe(true);
    expect(isOpen("FULFILLED")).toBe(false);
    expect(isOpen("CANCELLED")).toBe(false);
  });

  it("in-stock needs enough quantity on hand", () => {
    expect(inStock(5, 1)).toBe(true);
    expect(inStock(1, 1)).toBe(true);
    expect(inStock(0, 1)).toBe(false);
    expect(inStock(2, 3)).toBe(false);
    expect(inStock(null, 1)).toBe(false); // free-text / unknown part
    expect(inStock(undefined, 1)).toBe(false);
    expect(inStock(5, 0)).toBe(false); // non-positive qty
  });

  it("pauses the job only when the part isn't available", () => {
    expect(shouldPauseForRequest(false)).toBe(true);
    expect(shouldPauseForRequest(true)).toBe(false);
  });

  it("allows the real transitions and rejects the rest", () => {
    expect(canTransition("REQUESTED", "ORDERED")).toBe(true);
    expect(canTransition("REQUESTED", "FULFILLED")).toBe(true); // in stock
    expect(canTransition("ORDERED", "ARRIVED")).toBe(true);
    expect(canTransition("ARRIVED", "FULFILLED")).toBe(true);
    expect(canTransition("REQUESTED", "ARRIVED")).toBe(false);
    expect(canTransition("ORDERED", "FULFILLED")).toBe(false); // must arrive first
    expect(canTransition("FULFILLED", "REQUESTED")).toBe(false);
    expect(canTransition("CANCELLED", "ORDERED")).toBe(false);
  });

  it("allows an arrived (wrong/late) part to be re-ordered", () => {
    expect(canTransition("ARRIVED", "ORDERED")).toBe(true);
  });

  it("stockDelta: receive adds, fulfil consumes, wrong-part return reverses", () => {
    expect(stockDelta("ORDERED", "ARRIVED", 3)).toBe(3);
    expect(stockDelta("ARRIVED", "FULFILLED", 3)).toBe(-3);
    expect(stockDelta("REQUESTED", "FULFILLED", 2)).toBe(-2);
    expect(stockDelta("ARRIVED", "ORDERED", 3)).toBe(-3); // wrong/late returned
    expect(stockDelta("REQUESTED", "ORDERED", 3)).toBe(0);
    expect(stockDelta("ARRIVED", "CANCELLED", 3)).toBe(0);
  });

  it("knows which transitions move stock", () => {
    expect(consumesStock("FULFILLED")).toBe(true);
    expect(consumesStock("ARRIVED")).toBe(false);
    expect(restocks("ARRIVED")).toBe(true);
    expect(restocks("FULFILLED")).toBe(false);
  });

  it("auto-resumes only when held for parts and nothing is open", () => {
    expect(canResumeFromParts("AWAITING_PART", 0)).toBe(true);
    expect(canResumeFromParts("AWAITING_PART", 1)).toBe(false);
    // never override a quote-approval hold
    expect(canResumeFromParts("AWAITING_APPROVAL", 0)).toBe(false);
    expect(canResumeFromParts(null, 0)).toBe(false);
    expect(canResumeFromParts(undefined, 0)).toBe(false);
  });

  it("a full ordered-part journey transitions cleanly", () => {
    const path: PartRequestStatus[] = ["REQUESTED", "ORDERED", "ARRIVED", "FULFILLED"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });
});
