import { test, expect } from "@playwright/test";
import { SMOKE_USERS, storageStatePath } from "../support/roles";

/**
 * Owner nav sweep — every route in NAV[OWNER] must render 200 with no
 * server error boundary and no red console errors.
 *
 * This spec doesn't interact with anything; it exercises page RENDERING
 * for the role that has the most surfaces (15 routes as of Step 5's
 * Accounts addition). If middleware, guards, or a shared component
 * broke the render, one of these 15 will surface it.
 *
 * A future edit that removes a route from OWNER's nav config must also
 * remove it from support/roles.ts — the sweep is only as complete as
 * that list.
 */

const owner = SMOKE_USERS.find((u) => u.role === "owner")!;
test.use({ storageState: storageStatePath("owner") });

for (const route of owner.nav) {
    test(`owner: ${route} loads without error`, async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        const response = await page.goto(route);
        expect(response, `${route} produced no response`).not.toBeNull();
        expect(response!.status(), `${route} returned ${response!.status()}`).toBeLessThan(400);

        // Next.js renders errored server components via a red error
        // boundary. If our page 500s, that boundary is visible at the
        // DOM level even though the HTML shell may be a 200. Match on
        // Next's default error strings.
        const bodyText = await page.locator("body").innerText();
        expect(bodyText).not.toContain("Application error: a client-side exception");
        expect(bodyText).not.toContain("Internal Server Error");

        // Any console.error is worth stopping on. Real Next apps do
        // sometimes log to the console; if you find one that's noisy
        // but harmless, prefer fixing it over quietly allowing.
        expect(consoleErrors, `console errors on ${route}:\n${consoleErrors.join("\n")}`).toEqual([]);
    });
}
