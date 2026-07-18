import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The shell reservation padding (220px inline-start on md+, bottom-bar
 * clearance on mobile) lives in src/app/globals.css keyed on two DOM
 * markers set by the shell's own components:
 *
 *   - <aside data-app-shell="1">        in DesktopSideNav.tsx
 *   - <nav   data-mobile-tab-bar="1">   in BottomTabBar.tsx
 *
 * Public + login + customer (/c/*) pages don't render either component,
 * so they don't trigger the padding and stay centred. If any of these
 * markers goes missing, every non-shell page sits off-centre again — the
 * same visible bug we already shipped once. This test pins:
 *
 *   1. The two data attributes are still present on the shell components.
 *   2. globals.css still keys the padding rules on those attributes.
 *   3. src/app/layout.tsx has NOT re-added the padding to <body>
 *      unconditionally (the original bug shape).
 */
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function read(rel: string): string {
    return readFileSync(join(REPO_ROOT, rel), "utf8");
}

describe("shell padding markers", () => {
    it("DesktopSideNav aside carries data-app-shell", () => {
        const src = read("src/components/nav-shell/DesktopSideNav.tsx");
        expect(src).toMatch(/data-app-shell\s*=\s*["']1["']/);
    });

    it("BottomTabBar nav carries data-mobile-tab-bar", () => {
        const src = read("src/components/nav-shell/BottomTabBar.tsx");
        expect(src).toMatch(/data-mobile-tab-bar\s*=\s*["']1["']/);
    });

    it("globals.css keys inline-start padding on data-app-shell", () => {
        const src = read("src/app/globals.css");
        expect(src).toMatch(
            /body:has\(\[data-app-shell\]\)\s*\{\s*padding-inline-start:\s*220px/,
        );
    });

    it("globals.css keys bottom padding on data-mobile-tab-bar", () => {
        const src = read("src/app/globals.css");
        expect(src).toMatch(
            /body:has\(\[data-mobile-tab-bar\]\)\s*\{\s*padding-bottom:/,
        );
    });

    it("root layout does NOT re-add the shell padding to <body>", () => {
        const src = read("src/app/layout.tsx");
        // The original bug shape — `md:ps-[220px]` on <body> — leaks the
        // side-nav reservation to public/login/customer pages. If it
        // reappears here, the CSS marker rules become dead weight and
        // the centring bug returns.
        expect(src).not.toMatch(/md:ps-\[220px\]/);
        // Bottom-bar clearance likewise — must NOT be unconditional on
        // body; the :has([data-mobile-tab-bar]) rule handles it.
        expect(src).not.toMatch(/pb-\[calc\(4rem\+env\(safe-area-inset-bottom\)\)\]/);
    });
});
