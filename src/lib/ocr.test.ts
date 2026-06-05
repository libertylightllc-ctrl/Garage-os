import { describe, it, expect } from "vitest";
import { mockMoulkia, parseMoulkiaJson, ocrCostUsd, extractMoulkia } from "./ocr";

describe("Moulkia OCR", () => {
  it("mock returns a complete UAE-style record", () => {
    const m = mockMoulkia();
    expect(m.ownerName.length).toBeGreaterThan(0);
    expect(m.plate.length).toBeGreaterThan(0);
    expect(m.make).toBe("Nissan");
    expect(m.year).toBe(2022);
  });

  it("parses a clean JSON reply", () => {
    const f = parseMoulkiaJson(
      '{"ownerName":"Ali Hassan","vin":"WDB1234567","plate":"A 55555","make":"Toyota","model":"Camry","year":2019}',
    );
    expect(f.ownerName).toBe("Ali Hassan");
    expect(f.plate).toBe("A 55555");
    expect(f.year).toBe(2019);
  });

  it("tolerates prose around the JSON", () => {
    const f = parseMoulkiaJson('Here you go:\n{"make":"Honda","model":"Accord","year":2020} — done');
    expect(f.make).toBe("Honda");
    expect(f.year).toBe(2020);
    expect(f.ownerName).toBe(""); // missing → empty
  });

  it("rejects an implausible year", () => {
    expect(parseMoulkiaJson('{"year":123}').year).toBeNull();
    expect(parseMoulkiaJson('{"year":0}').year).toBeNull();
    expect(parseMoulkiaJson("not json").year).toBeNull();
  });

  it("mock OCR is free; real model is metered", () => {
    expect(ocrCostUsd("mock-ocr", 0, 0)).toBe(0);
    expect(ocrCostUsd("claude-haiku-4-5", 1000, 1000)).toBeGreaterThan(0);
  });

  it("no API key → mock prefill, NOT marked failed (demo mode)", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.model).toBe("mock-ocr");
      expect(r.failed).toBeUndefined();
      expect(r.fields.make).toBe("Nissan");
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("API key set but the call fails → blank fields with failed=true (no fake data)", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevFetch = globalThis.fetch;
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = (async () => {
      throw new Error("network");
    }) as typeof fetch;
    try {
      const r = await extractMoulkia("xxx", "image/jpeg");
      expect(r.failed).toBe(true);
      expect(r.model).toBe("ocr-failed");
      expect(r.fields.make).toBe(""); // critically: NOT mock data
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
