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

// The 15 server actions behind the MASTER-opened pages. Opening a page
// to MASTER without also swapping its action guards makes the page a
// trap — form loads, submit throws "Not authorized". Every action name
// here must sit under `requireOperational()` in the file listed.
//
// Owner-only action files (onboarding, whatsapp-connect) must NOT
// route through requireOperational — they touch finance / onboarding
// and stay OWNER-only.
interface ActionSite {
  file: string;
  action: string;
}
const OPERATIONAL_ACTIONS: readonly ActionSite[] = [
  { file: "src/app/actions/purchasing.ts", action: "createPurchaseOrderAction" },
  { file: "src/app/actions/purchasing.ts", action: "addPoLineAction" },
  { file: "src/app/actions/purchasing.ts", action: "removePoLineAction" },
  { file: "src/app/actions/purchasing.ts", action: "setPoStatusAction" },
  { file: "src/app/actions/purchasing.ts", action: "receivePurchaseOrderAction" },
  { file: "src/app/actions/purchasing.ts", action: "returnPurchaseOrderAction" },
  { file: "src/app/actions/suppliers.ts", action: "createSupplierAction" },
  { file: "src/app/actions/suppliers.ts", action: "updateSupplierAction" },
  { file: "src/app/actions/suppliers.ts", action: "setSupplierActiveAction" },
  { file: "src/app/actions/inventory.ts", action: "createPartAction" },
  { file: "src/app/actions/inventory.ts", action: "updatePartAction" },
  { file: "src/app/actions/inventory.ts", action: "adjustStockAction" },
  { file: "src/app/actions/parts-import.ts", action: "startPartsImportAction" },
  { file: "src/app/actions/parts-import.ts", action: "confirmPartsImportAction" },
  { file: "src/app/actions/parts-import.ts", action: "discardPartsImportAction" },
];

// One action per owner-only file to pin the negative case — MASTER
// must STILL be denied on these. If someone later swaps one of these
// to requireOperational the test fires.
const OWNER_ONLY_ACTIONS: readonly ActionSite[] = [
  { file: "src/app/actions/onboarding.ts", action: "addBranchAction" },
  { file: "src/app/actions/whatsapp-connect.ts", action: "connectWhatsAppAction" },
];

// Extract the source of a single top-level exported action function.
// Returns everything from `export async function <name>` up to the
// next `export ` (or EOF), so we can pattern-match its guard call in
// isolation. If the name isn't found we return the whole file — the
// name assertion below will fail loudly and tell the reader which
// action drifted.
function extractActionBody(src: string, action: string): string {
  const start = src.indexOf(`export async function ${action}`);
  if (start === -1) return src;
  const rest = src.slice(start + 1);
  const nextExport = rest.indexOf("\nexport ");
  return nextExport === -1
    ? src.slice(start)
    : src.slice(start, start + 1 + nextExport);
}

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

  // ── Actions ────────────────────────────────────────────────────
  //
  // Page guard and action guard must match, or the page becomes a
  // trap. This block is the test that would have caught the 15-action
  // gap shipped in commit f86c97c (this session).
  describe("MASTER allowed — actions", () => {
    it.each(OPERATIONAL_ACTIONS)(
      "$file → $action guards with requireOperational()",
      ({ file, action }) => {
        const body = extractActionBody(read(file), action);
        // The action must exist by that exact name.
        expect(body).toMatch(new RegExp(`export async function ${action}\\b`));
        // The guard call must be requireOperational — NOT requireOwner
        // (the previous shape) and NOT an inline requireAnyRole that
        // could accidentally leave MASTER out.
        expect(body).toMatch(/\brequireOperational\s*\(\s*\)/);
        expect(body).not.toMatch(/\brequireOwner\s*\(/);
      },
    );
  });

  describe("MASTER denied — actions", () => {
    it.each(OWNER_ONLY_ACTIONS)(
      "$file → $action stays behind requireOwner()",
      ({ file, action }) => {
        const body = extractActionBody(read(file), action);
        expect(body).toMatch(new RegExp(`export async function ${action}\\b`));
        expect(body).toMatch(/\brequireOwner\s*\(\s*\)/);
        // Guarding an owner-only action with requireOperational would
        // silently widen finance / onboarding to MASTER — pin it out.
        expect(body).not.toMatch(/\brequireOperational\s*\(/);
      },
    );
  });
});
