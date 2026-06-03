import { describe, it, expect } from "vitest";
import { signId, verifyToken } from "./tokens";

describe("signed capability tokens", () => {
  it("round-trips a valid token", () => {
    const t = signId("estimate", "abc123");
    expect(verifyToken("estimate", t)).toBe("abc123");
  });

  it("rejects a tampered id", () => {
    const t = signId("estimate", "abc123");
    const tampered = t.replace("abc123", "abc124");
    expect(verifyToken("estimate", tampered)).toBeNull();
  });

  it("rejects cross-kind replay", () => {
    const t = signId("estimate", "abc123");
    expect(verifyToken("invoice", t)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifyToken("estimate", "nope")).toBeNull();
    expect(verifyToken("estimate", "")).toBeNull();
  });
});
