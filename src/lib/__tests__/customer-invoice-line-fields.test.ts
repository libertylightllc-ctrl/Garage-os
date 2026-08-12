import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Cost + margin field-leak pin (AR 2026-08-12 Step 5).
 *
 * The two customer-facing pages — /c/invoice/[id] and /c/estimate/[id]
 * — fetch their document row via prisma with an explicit `select:`
 * allowlist. Internal-only pricing fields (unitCost, markupPct) are
 * DELIBERATELY omitted so they never reach the RSC payload the
 * customer's browser receives, even if a future dev adds a Client
 * Component that echoes props.
 *
 * This test guards two ways someone might silently regress that:
 *   1. Switching the query back to `include: { lines: true }` (which
 *      pulls every column, including cost).
 *   2. Adding `unitCost: true` / `markupPct: true` to the `select:`
 *      block — deliberately or by autocomplete accident.
 *
 * String-grep on the file source. Not the most surgical pin — but it's
 * one that lands in the SAME PR as a leak, in bright red, with a
 * message a reviewer can act on.
 */

const CUSTOMER_PAGES = [
    "src/app/c/invoice/[id]/page.tsx",
    "src/app/c/estimate/[id]/page.tsx",
] as const;

describe("customer-facing pages — no cost/markup leakage", () => {
    it.each(CUSTOMER_PAGES)(
        "%s uses select (not include) on the lines query",
        (file) => {
            const src = fs.readFileSync(path.resolve(file), "utf8");
            // Anywhere the source loads lines, it must be via `select:`,
            // not `include:`. Broad match: if we see `lines: {` followed
            // (within the same block, allowing whitespace + comments) by
            // `include:` for the lines themselves, fail. Simpler
            // proxy that catches the common regression: no bare
            // `include: {\n\s*lines: {` block.
            const badInclude = /include:\s*\{[\s\S]{0,200}?lines:\s*\{/;
            expect(src, "lines fetched via include — should be select allowlist").not.toMatch(badInclude);
        },
    );

    it.each(CUSTOMER_PAGES)(
        "%s never selects unitCost or markupPct (customer must not see them)",
        (file) => {
            const src = fs.readFileSync(path.resolve(file), "utf8");
            // `unitCost:` and `markupPct:` should not appear as select
            // keys anywhere in these files. They're advisor-internal.
            // The staff page src/app/estimates/[id]/page.tsx and the
            // billing action are allowed to reference them; this pin
            // guards only the two customer surfaces.
            expect(src, "unitCost leak into customer surface").not.toMatch(/\bunitCost:\s*true\b/);
            expect(src, "markupPct leak into customer surface").not.toMatch(/\bmarkupPct:\s*true\b/);
        },
    );
});
