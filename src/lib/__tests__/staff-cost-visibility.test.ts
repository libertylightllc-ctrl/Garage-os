import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Staff cost/markup visibility pin (AR 2026-08-14).
 *
 * `/estimates/[id]` accepts CASHIER + ADVISOR + OWNER + MASTER as page
 * viewers (cashier needs to open approved estimates to generate the
 * invoice). But cost, markup, and margin are advisor / owner / master
 * only — cashier + tech must not see any of them.
 *
 * The fix pattern is a server-side `canShowCost = canSeeMargin(role)`
 * gate that nulls `unitCost` and `markupPct` in the RSC prop map BEFORE
 * they cross to the client component. This test source-inspects the
 * page file to confirm that gate is in place, so a future edit that
 * regressed to passing raw `l.unitCost` fails the pin in the same PR
 * (rather than silently leaking on staging).
 *
 * String-grep on the source file — same shape as the customer-side
 * pin at `customer-invoice-line-fields.test.ts`, not the most surgical
 * check but the one that lands in bright red next to the change that
 * broke it.
 */

const STAFF_ESTIMATE_PAGE = "src/app/estimates/[id]/page.tsx";

describe("staff estimate page — cost/markup gated on canSeeMargin", () => {
    const src = fs.readFileSync(path.resolve(STAFF_ESTIMATE_PAGE), "utf8");

    it("imports canSeeMargin from the permissions helper", () => {
        // A future edit that removed the import would fail every
        // downstream assertion too, but pin it explicitly so the
        // failure message is unambiguous.
        expect(src, "canSeeMargin must be imported from @/lib/permissions").toMatch(
            /import\s+{[^}]*\bcanSeeMargin\b[^}]*}\s+from\s+["']@\/lib\/permissions["']/,
        );
    });

    it("computes a canShowCost flag from the session role", () => {
        // The whole gate hinges on this local. If it disappears, both
        // the desktop-row and mobile-card call sites lose the prop and
        // TypeScript will fail — but a rename would compile fine while
        // regressing behaviour. Pin the exact identifier.
        expect(
            src,
            "canShowCost = canSeeMargin(role) is the shared gate name",
        ).toMatch(/canShowCost\s*=\s*canSeeMargin\s*\(\s*role\s*\)/);
    });

    it("nulls unitCost when !canShowCost in the line prop mapping", () => {
        // The critical rule: unitCost passed to the client component
        // must be ternary-gated on canShowCost, not passed through raw.
        // A cashier session must not carry any Number(l.unitCost) into
        // the RSC payload.
        //
        // Match: `unitCost: canShowCost && l.unitCost ... : null`.
        // The regex accepts either `!= null` or `!== null`.
        expect(
            src,
            "unitCost prop must be gated: `unitCost: canShowCost && l.unitCost != null ? Number(l.unitCost) : null`",
        ).toMatch(
            /unitCost:\s*canShowCost\s*&&\s*l\.unitCost\s*!==?\s*null\s*\?\s*Number\(l\.unitCost\)\s*:\s*null/,
        );
    });

    it("nulls markupPct when !canShowCost in the line prop mapping", () => {
        // Same rule as unitCost — markupPct must be ternary-gated so
        // it never crosses to a cashier's RSC payload.
        expect(
            src,
            "markupPct prop must be gated: `markupPct: canShowCost && l.markupPct != null ? Number(l.markupPct) : null`",
        ).toMatch(
            /markupPct:\s*canShowCost\s*&&\s*l\.markupPct\s*!==?\s*null\s*\?\s*Number\(l\.markupPct\)\s*:\s*null/,
        );
    });

    it("passes canShowCost through to both line-component callsites", () => {
        // Belt-and-braces: even if a future edit passed raw unitCost,
        // the client component's `isPart && canShowCost` gate would
        // still hide the tri-input. Both call sites (mobile card + desktop
        // row) must forward the flag so that belt-and-braces stays true.
        const callSites = src.match(/canShowCost=\{canShowCost\}/g) ?? [];
        expect(
            callSites.length,
            "canShowCost={canShowCost} must appear at least twice (mobile card + desktop row)",
        ).toBeGreaterThanOrEqual(2);
    });
});
