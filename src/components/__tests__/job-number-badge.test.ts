import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Pins two invariants about how job card numbers appear anywhere in the app:
 *
 *   1. The <JobNumberBadge> component is the single source of truth: it
 *      imports formatJobNo, delegates to it, and returns null when the
 *      formatted output is null (a job that hasn't been numbered yet).
 *
 *   2. NO page renders the raw `#{...number}` bareword. Before this
 *      component landed the same job displayed as `JC-2026-0042` on some
 *      pages and `#42` on others. If someone later reverts a page to
 *      raw `#{jobCard.number}` this test fires.
 *
 * Search-token strings (used inside the client-side filter on /cashier)
 * are template literals — `#${number ?? ""}` — and are NOT caught by the
 * ban regex below because they use `${` (template-literal syntax), not
 * `{` (JSX rendering). That's deliberate: search tokens aren't user-
 * visible, so they don't need the badge treatment.
 */

const REPO_ROOT = process.cwd();

function read(rel: string): string {
    return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function walkTsx(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        // Skip node_modules, .next, __tests__ (test files reference the
        // banned pattern in their own assertions), hidden dirs.
        if (
            name === "node_modules" ||
            name === ".next" ||
            name === "__tests__" ||
            name.startsWith(".")
        )
            continue;
        const p = join(dir, name);
        const s = statSync(p);
        if (s.isDirectory()) walkTsx(p, out);
        else if (p.endsWith(".tsx")) out.push(p);
    }
    return out;
}

describe("JobNumberBadge — invariants", () => {
    it("badge imports formatJobNo (single formatter)", () => {
        const src = read("src/components/job-number-badge.tsx");
        expect(src).toMatch(
            /import\s+\{\s*formatJobNo\s*\}\s+from\s+["']@\/lib\/jobcard-fields["']/,
        );
        expect(src).toMatch(/formatJobNo\s*\(/);
    });

    it("badge returns null when the formatted label is null", () => {
        const src = read("src/components/job-number-badge.tsx");
        // Enforce the null-guard textually — a tiny file, easy to keep.
        expect(src).toMatch(/if\s*\(\s*!label\s*\)\s*return\s+null/);
    });

    it("no page under src/app renders `#{...number}` bareword", () => {
        const appDir = join(REPO_ROOT, "src/app");
        const files = walkTsx(appDir);
        const offenders: string[] = [];

        // Match JSX-position `#{ ... .number ... }`. Template-literal
        // interpolation `${...}` is naturally excluded — the pattern
        // requires `#` immediately followed by `{`, which template
        // literals never write (they use `${`).
        //
        // Anchor with a preceding non-word / non-punct char so we don't
        // catch e.g. `foo#{bar}` inside a string — the JSX case has
        // `>#{` or `\n#{` or space before it. The regex `[^\w$]#\{`
        // requires the char before `#` to not be a word char or a `$`
        // (the latter is template-literal territory).
        const banned = /[^\w$]#\{[^}]*\.number[^}]*\}/;

        for (const f of files) {
            const content = readFileSync(f, "utf8");
            if (banned.test(content)) {
                offenders.push(relative(REPO_ROOT, f).replace(/\\/g, "/"));
            }
        }
        expect(offenders).toEqual([]);
    });

    it("regex correctly EXCLUDES template-literal search tokens", () => {
        // Self-check: if this fails, the ban above is over-eager and
        // would kill legitimate search-token code inside `${...}`.
        const banned = /[^\w$]#\{[^}]*\.number[^}]*\}/;
        expect(banned.test("`#${inv.jobCard.number ?? \"\"}`")).toBe(false);
        expect(banned.test('const s = "#" + n;')).toBe(false);
    });

    it("regex DOES match the JSX rendering it bans", () => {
        // Self-check: prove the ban catches the actual bug shape.
        const banned = /[^\w$]#\{[^}]*\.number[^}]*\}/;
        expect(banned.test('<span>#{j.number}</span>')).toBe(true);
        expect(
            banned.test('<dd className="…">#{inv.jobCard.number ?? "—"}</dd>'),
        ).toBe(true);
    });
});
