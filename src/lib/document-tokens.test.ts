import { describe, it, expect } from "vitest";
import { newPublicToken } from "./document-tokens";

describe("newPublicToken", () => {
  it("produces 32 URL-safe base64 chars", () => {
    for (let i = 0; i < 32; i++) {
      const t = newPublicToken();
      // 24 raw bytes → base64url of 32 chars.
      expect(t).toHaveLength(32);
      // base64url alphabet: A-Z, a-z, 0-9, "-", "_". No padding, no "/", no "+".
      expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  it("NEVER contains '~' (contract with resolveDocumentToken dispatch)", () => {
    // The resolver dispatches on token.includes("~") — HMAC path if
    // present, DB-lookup path if not. If a publicToken ever contained
    // "~", a raw token would be misrouted to the HMAC verifier and
    // fail. base64url excludes "~" per RFC 4648 §5, so this holds by
    // spec — the assertion is defensive against a future refactor
    // switching to a different encoding (base64 std, hex etc.).
    for (let i = 0; i < 1000; i++) {
      expect(newPublicToken()).not.toContain("~");
    }
  });

  it("produces distinct tokens across many calls (collision sanity)", () => {
    // With 192 bits of entropy, the birthday bound on collision at
    // N tokens is ~sqrt(2^192) — practically infinite. This just
    // catches "randomBytes broke and returned a constant".
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(newPublicToken());
    expect(seen.size).toBe(10_000);
  });
});
