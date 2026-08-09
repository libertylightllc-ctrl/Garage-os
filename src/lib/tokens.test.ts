import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("signId — dev-secret + hosted-DB guard (2026-08-10)", () => {
  // The bug this guards against: a local `npm run dev` inheriting the
  // repo-root `.env` (DATABASE_URL points at the Supabase pooler for
  // operator scripts) but with no AUTH_SECRET, so signId uses the dev
  // fallback secret and emits a wa.me link that will never verify on
  // the real Vercel Prod deploy. INV-2026-0039 diagnosis.
  const originalSecret = process.env.AUTH_SECRET;
  const originalDbUrl = process.env.DATABASE_URL;

  afterEach(() => {
    process.env.AUTH_SECRET = originalSecret;
    process.env.DATABASE_URL = originalDbUrl;
  });

  it("throws when secret is the dev fallback and DATABASE_URL points at supabase.com", () => {
    delete process.env.AUTH_SECRET;
    process.env.DATABASE_URL =
      "postgres://postgres.xyz:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres";
    expect(() => signId("invoice", "abc123")).toThrow(/dev fallback secret/);
  });

  it("throws when secret is the dev fallback and DATABASE_URL points at supabase.co", () => {
    delete process.env.AUTH_SECRET;
    process.env.DATABASE_URL = "postgres://postgres:pw@db.example.supabase.co:5432/postgres";
    expect(() => signId("invoice", "abc123")).toThrow(/dev fallback secret/);
  });

  it("does NOT throw when secret is the dev fallback but DATABASE_URL is local", () => {
    delete process.env.AUTH_SECRET;
    process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:51214/postgres";
    expect(() => signId("invoice", "abc123")).not.toThrow();
  });

  it("does NOT throw when a real secret is set, even against a supabase DB", () => {
    process.env.AUTH_SECRET = "a-real-32-byte-secret-not-the-fallback";
    process.env.DATABASE_URL =
      "postgres://postgres:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres";
    expect(() => signId("invoice", "abc123")).not.toThrow();
  });

  it("does NOT throw when DATABASE_URL is unset (dev with no DB configured)", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.DATABASE_URL;
    expect(() => signId("invoice", "abc123")).not.toThrow();
  });
});
