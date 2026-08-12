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

    it.each(CUSTOMER_PAGES)(
        "%s never passes the whole invoice / estimate row to a Client Component",
        (file) => {
            const src = fs.readFileSync(path.resolve(file), "utf8");
            // Whole-object prop leak surface (AR 2026-08-12): the
            // `select:` allowlist at the DB layer keeps the raw
            // Prisma row narrow, but a future Client Component prop
            // like `<SomeClient inv={inv} />` or `<X est={est} />`
            // would serialise the WHOLE prop object into the RSC
            // payload delivered to the customer's browser. The
            // customer would then be able to open DevTools and read
            // every field on the row — including cost, if it were
            // there. Since we don't include cost in the select
            // allowlist today the immediate risk is low, but a slip
            // by any future edit would silently open the door. We
            // block the pattern by name to close it forever.
            //
            // Substrings intentionally match ONLY the exact "pass
            // the raw row" shape. `line=` inside a `map` callback
            // (`lines.map((l) => <Row line={l} />)` — passing a
            // per-line object) is fine because the row still
            // reflects the narrow select. `inv={...}` passing a
            // narrowed object is technically flagged too — accept
            // that as false-positive noise; if a legit whole-object
            // prop lands here, we'll rename the variable or narrow
            // it first.
            // Regex explanation: match a real JSX opener — `<` then a
            // capital letter and identifier chars — then any chars on
            // that line, then the exact `inv={inv}` / `est={est}` prop.
            // Comments (like the illustrative one in Step 5's block
            // header at the top of the customer invoice page) don't
            // start with `<[A-Z]` so they never trip the pin.
            expect(src, "whole invoice row passed as prop → cost leak surface").not.toMatch(/<[A-Z]\w*[^>]*\binv=\{inv\}/);
            expect(src, "whole estimate row passed as prop → cost leak surface").not.toMatch(/<[A-Z]\w*[^>]*\best=\{est\}/);
        },
    );
});
