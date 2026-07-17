// Pins the MASTER vs OWNER access boundary on /owner/* routes.
//
// Rule (matches AGENTS.md): MASTER runs the operational floor — bays,
// suppliers, purchasing, inventory, hours, and their child routes are
// open to MASTER. Owner-only surfaces are the dashboard (/owner),
// analytics, billing, ledger, plus the admin surfaces (branches, staff
// index, whatsapp).
//
// Why source-inspection: the guards live at page module top-level as
// `await requireRole(...)` / `await requireAnyRole([...])`. There is no
// route manifest today, and importing each page module in tests would
// pull in Prisma + auth + server-only glue. Reading the source file is
// brittle but deliberate: if someone widens or narrows a guard silently
// this test fires without needing a whole harness rewrite. When we
// introduce a first-class route manifest (e.g. `src/config/route-guards.ts`)
// this file can be flattened to a manifest-vs-expected diff.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = process.cwd();

// The 9 operational routes MASTER is permitted on. Every one must guard
// with requireAnyRole containing both OWNER and MASTER.
const OPEN_TO_MASTER: readonly string[] = [
  "src/app/owner/purchasing/page.tsx",
  "src/app/owner/purchasing/[id]/page.tsx",
  "src/app/owner/purchasing/new/page.tsx",
  "src/app/owner/suppliers/page.tsx",
  "src/app/owner/suppliers/[id]/page.tsx",
  "src/app/owner/inventory/page.tsx",
  "src/app/owner/inventory/[id]/page.tsx",
  "src/app/owner/inventory/import/[id]/page.tsx",
  "src/app/owner/bays/page.tsx",
];

// The 7 owner-only routes MASTER must NOT be able to load. Every one
// must guard with strict requireRole("OWNER").
const OWNER_ONLY: readonly string[] = [
  "src/app/owner/page.tsx",
  "src/app/owner/analytics/page.tsx",
  "src/app/owner/billing/page.tsx",
  "src/app/owner/ledger/page.tsx",
  "src/app/owner/branches/page.tsx",
  "src/app/owner/whatsapp/page.tsx",
  "src/app/owner/staff/page.tsx",
];

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

// Match `requireAnyRole([...])` and check both OWNER and MASTER are in
// the array. Tolerates whitespace and either ordering.
function permitsBothOwnerAndMaster(src: string): boolean {
  const m = src.match(/requireAnyRole\s*\(\s*\[([^\]]+)\]/);
  if (!m) return false;
  const inside = m[1];
  return /["']OWNER["']/.test(inside) && /["']MASTER["']/.test(inside);
}

// Match strict `requireRole("OWNER")` and confirm no requireAnyRole
// escape hatch also exists in the file.
function ownerOnlyStrict(src: string): boolean {
  const strict = /requireRole\s*\(\s*["']OWNER["']\s*\)/.test(src);
  const anyRole = /requireAnyRole/.test(src);
  return strict && !anyRole;
}

describe("MASTER vs OWNER boundary on /owner/*", () => {
  describe("MASTER allowed", () => {
    it.each(OPEN_TO_MASTER)("%s permits MASTER via requireAnyRole", (path) => {
      const src = read(path);
      expect(permitsBothOwnerAndMaster(src)).toBe(true);
    });
  });

  describe("MASTER denied", () => {
    it.each(OWNER_ONLY)(
      "%s stays OWNER-only via strict requireRole('OWNER')",
      (path) => {
        const src = read(path);
        expect(ownerOnlyStrict(src)).toBe(true);
      },
    );
  });

  it("the two lists are disjoint", () => {
    const inter = OPEN_TO_MASTER.filter((p) => OWNER_ONLY.includes(p));
    expect(inter).toEqual([]);
  });
});
