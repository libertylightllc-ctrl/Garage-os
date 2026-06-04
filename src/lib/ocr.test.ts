import { describe, it, expect } from "vitest";
import { mockMoulkia, parseMoulkiaJson, ocrCostUsd } from "./ocr";

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
});
