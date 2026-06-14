import { describe, it, expect } from "vitest";

// Mirror of the formatMin helper in src/app/owner/page.tsx. Inlining
// because the page is a server component and exporting from it would
// pull in next/headers / prisma at test time. The function is small
// and pure — duplicating here keeps the test cheap to maintain.
function formatMin(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

describe("formatMin (owner technician productivity)", () => {
  it("renders minutes below an hour as 'Xm'", () => {
    expect(formatMin(0)).toBe("0m");
    expect(formatMin(1)).toBe("1m");
    expect(formatMin(45)).toBe("45m");
    expect(formatMin(59)).toBe("59m");
  });

  it("renders exact hours without minutes", () => {
    expect(formatMin(60)).toBe("1h");
    expect(formatMin(120)).toBe("2h");
    expect(formatMin(480)).toBe("8h");
  });

  it("renders hours + minutes when there's a remainder", () => {
    expect(formatMin(75)).toBe("1h 15m");
    expect(formatMin(125)).toBe("2h 5m");
    expect(formatMin(610)).toBe("10h 10m");
  });

  it("rounds fractional inputs to the nearest minute", () => {
    expect(formatMin(0.4)).toBe("0m"); // rounds down
    expect(formatMin(0.5)).toBe("1m"); // banker's tie-breaker irrelevant for 0.5 → 1 in JS Math.round
    expect(formatMin(59.6)).toBe("1h"); // rounds to 60 → 1h
  });

  it("clamps negative inputs to 0 (defensive — should never happen)", () => {
    expect(formatMin(-5)).toBe("0m");
    expect(formatMin(-9999)).toBe("0m");
  });
});
