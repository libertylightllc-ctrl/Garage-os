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

// The 8 owner-only routes MASTER must NOT be able to load. Every one
// must guard with strict requireRole("OWNER").
const OWNER_ONLY: readonly string[] = [
  "src/app/owner/page.tsx",
  "src/app/owner/analytics/page.tsx",
  "src/app/owner/billing/page.tsx",
  "src/app/owner/ledger/page.tsx",
  "src/app/owner/branches/page.tsx",
  "src/app/owner/whatsapp/page.tsx",
  "src/app/owner/staff/page.tsx",
  // Accounting export (CSV downloads of COA/journal/invoices/payments/
  // customers). Ships the entire financial position of the business —
  // financial-reporting bucket per CLAUDE.md, MASTER stays barred.
  "src/app/owner/accounting/page.tsx",
  // ERPNext sync (Phase 5 operator surface, AR 2026-08-27). Flag
  // toggle + dead-letter replay — same finance/admin bucket as
  // billing and ledger, MASTER stays barred.
  "src/app/owner/erp/page.tsx",
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
  { file: "src/app/actions/purchasing.ts", action: "editPoLineAction" },
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
  // Estimate → PO conversion (docs/Estimate-to-PO-Spec.md). MASTER runs
  // the operational floor and owns the from-estimate flow end-to-end.
  { file: "src/app/actions/purchasing.ts", action: "createPoFromEstimateAction" },
  // Pricing defaults on /settings (parts markup %, labour hourly cost).
  // Both feed the profit card on the invoice page, which MASTER sees;
  // AR 2026-08-14 hit the "set labour rate" link as MASTER and found
  // an owner-only /settings page with no field. Widening the page
  // without the actions makes the form a trap — pin it here.
  { file: "src/app/actions/settings.ts", action: "updateDefaultPartsMarkupAction" },
  { file: "src/app/actions/settings.ts", action: "updateDefaultLaborHourlyCostAction" },
  // Garage identity — split into four per-field actions 2026-08-20
  // after AR hit the two-tab overwrite class. Each writes only its
  // own column. All four operational, matching the pricing-defaults
  // precedent.
  { file: "src/app/actions/settings.ts", action: "updateGarageNameAction" },
  { file: "src/app/actions/settings.ts", action: "updateGarageTrnAction" },
  { file: "src/app/actions/settings.ts", action: "updateGarageAddressAction" },
  { file: "src/app/actions/settings.ts", action: "updateGarageDefaultLangAction" },
  // Bays capacity — /owner/bays is on the MASTER-permitted list per
  // AGENTS.md Key Decision #8, but both mutating actions were still
  // requireOwner (fifth instance of the trap pattern, caught in the
  // 2026-08-20 audit). Widened alongside the structural check below.
  { file: "src/app/actions/onboarding.ts", action: "addBayAction" },
  { file: "src/app/actions/onboarding.ts", action: "removeBayAction" },
];

// One action per owner-only file to pin the negative case — MASTER
// must STILL be denied on these. If someone later swaps one of these
// to requireOperational the test fires.
const OWNER_ONLY_ACTIONS: readonly ActionSite[] = [
  { file: "src/app/actions/onboarding.ts", action: "addBranchAction" },
  { file: "src/app/actions/whatsapp-connect.ts", action: "connectWhatsAppAction" },
  // ERPNext sync operator actions (Phase 5, AR 2026-08-27) —
  // finance surface, OWNER-only.
  { file: "src/app/actions/erp-sync.ts", action: "enableErpSyncAction" },
  { file: "src/app/actions/erp-sync.ts", action: "disableErpSyncAction" },
  { file: "src/app/actions/erp-sync.ts", action: "replayErpSyncJobAction" },
  { file: "src/app/actions/erp-sync.ts", action: "resetErpSyncCursorAction" },
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

  // ── Structural: no MASTER-opened page may submit to a requireOwner action ──
  //
  // The narrow-gate trap ("page renders for MASTER, action throws Not
  // authorized on submit") has shipped FIVE times this session — most
  // recently on /owner/bays after Batch B. The per-page-per-action
  // whitelists above catch it once the fix is written, but only if
  // the reviewer remembers to add the new entry. This block catches
  // the CLASS instead: for every OPEN_TO_MASTER page, walk every
  // `<form action={fn}>` reference, resolve `fn` back to its import
  // and file, and fail if that action uses requireOwner() /
  // requireRole("OWNER"). No whitelist needed — new pages and new
  // actions get audited automatically.
  //
  // Deliberately narrow: only `<form action={...}>` (server-action
  // form submissions). Nested `formAction=` attributes on submit
  // buttons are followed too. Client-component handlers and API
  // routes are out of scope — those have their own guards and aren't
  // the trap vector.
  describe("MASTER-opened pages: no reachable action requires OWNER", () => {
    // Import-name → { file, exportedName } table for a given page.
    // Handles both `import { foo } from "@/app/actions/x"` and
    // `import { foo as bar } from "..."`.
    interface ImportedAction { file: string; exported: string }
    function pageActionImports(pageSrc: string): Map<string, ImportedAction> {
      const out = new Map<string, ImportedAction>();
      const re = /import\s*\{([^}]+)\}\s*from\s*["'](@\/app\/actions\/[^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(pageSrc)) !== null) {
        const names = m[1];
        const spec = m[2];
        // Resolve "@/app/actions/foo" → src/app/actions/foo.ts
        const file = spec.replace("@/", "src/") + ".ts";
        for (const raw of names.split(",")) {
          const [exportedRaw, aliasRaw] = raw.split(" as ").map((s) => s.trim());
          const exported = exportedRaw.replace(/^type\s+/, "").trim();
          const local = (aliasRaw ?? exported).trim();
          if (exported && local) out.set(local, { file, exported });
        }
      }
      return out;
    }

    // Every local-name referenced as `action={...}` OR `formAction={...}`
    // inside the page. Only form/button attribute usages — that's the
    // trap vector; other references (a link, a helper) are irrelevant.
    function actionRefs(pageSrc: string): Set<string> {
      const out = new Set<string>();
      const re = /\b(?:action|formAction)=\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(pageSrc)) !== null) out.add(m[1]);
      return out;
    }

    function actionUsesRequireOwner(fileSrc: string, exported: string): boolean {
      const body = extractActionBody(fileSrc, exported);
      // Positive match on requireOwner OR requireRole("OWNER").
      // The latter is used by garage-logo.ts and treated as owner-only.
      return /\brequireOwner\s*\(/.test(body)
        || /\brequireRole\s*\(\s*["']OWNER["']\s*\)/.test(body);
    }

    // Emit one test per (page, referenced-action) pair so the failure
    // message names both. Missing imports (action referenced but not
    // imported from @/app/actions/*) skip silently — client-side
    // handlers and other patterns aren't the trap this catches.
    const cases: Array<{ page: string; local: string; file: string; exported: string }> = [];
    for (const page of OPEN_TO_MASTER) {
      const src = read(page);
      const imports = pageActionImports(src);
      for (const local of actionRefs(src)) {
        const imp = imports.get(local);
        if (!imp) continue;
        cases.push({ page, local, file: imp.file, exported: imp.exported });
      }
    }

    // Guardrail: if this ever returns zero, the regex broke — we'd
    // silently pass instead of catching new traps. Every MASTER page
    // in the repo today has at least one server-action form submit.
    it("scan discovered form actions on MASTER-opened pages", () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases)(
      "$page → $local ($file:$exported) does NOT use requireOwner()",
      ({ page, local, file, exported }) => {
        const fileSrc = read(file);
        const owner = actionUsesRequireOwner(fileSrc, exported);
        // Failure message names the fix path so a reviewer doesn't
        // have to dig: swap requireOwner → requireOperational in the
        // action, and add the action to OPERATIONAL_ACTIONS above.
        expect(owner, `${page} opens for MASTER but submits to ${local} in ${file} which requires OWNER — either widen the action to requireOperational() and add it to OPERATIONAL_ACTIONS, or narrow the page to OWNER-only.`).toBe(false);
      },
    );
  });
});
