import { describe, expect, it } from "vitest";
import { stockLevel, stockOptionSuffix } from "@/lib/stock-label";

const L = { inStock: "in stock", low: "Low", out: "out of stock" };

describe("stockLevel", () => {
  it("OUT at zero and below", () => {
    expect(stockLevel(0, 5)).toBe("OUT");
    expect(stockLevel(-2, 5)).toBe("OUT"); // legacy negative rows still read OUT
  });
  it("LOW at or under the reorder level", () => {
    expect(stockLevel(5, 5)).toBe("LOW");
    expect(stockLevel(1, 5)).toBe("LOW");
  });
  it("OK above the reorder level", () => {
    expect(stockLevel(6, 5)).toBe("OK");
    expect(stockLevel(100, 5)).toBe("OK");
  });
  it("reorder level 0: anything positive is OK, zero is OUT", () => {
    expect(stockLevel(1, 0)).toBe("OK");
    expect(stockLevel(0, 0)).toBe("OUT");
  });
});

describe("stockOptionSuffix", () => {
  it("plain count when OK", () => {
    expect(stockOptionSuffix(12, 5, L)).toBe("12 in stock");
  });
  it("warning flag when low", () => {
    expect(stockOptionSuffix(3, 5, L)).toBe("⚠ 3 in stock (Low)");
  });
  it("out-of-stock flag at zero", () => {
    expect(stockOptionSuffix(0, 5, L)).toBe("✕ out of stock");
  });
});
