import { test, expect } from "@playwright/test";
import { SMOKE_USERS, storageStatePath } from "../support/roles";

// Same page-load contract as owner.spec.ts. Tech has only one nav
// route today (/technician) — kept as a for-loop so a future config
// change surfaces here automatically.
const tech = SMOKE_USERS.find((u) => u.role === "tech")!;
test.use({ storageState: storageStatePath("tech") });

for (const route of tech.nav) {
    test(`tech: ${route} loads without error`, async ({ page }) => {
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        const response = await page.goto(route);
        expect(response, `${route} produced no response`).not.toBeNull();
        expect(response!.status(), `${route} returned ${response!.status()}`).toBeLessThan(400);

        const bodyText = await page.locator("body").innerText();
        expect(bodyText).not.toContain("Application error: a client-side exception");
        expect(bodyText).not.toContain("Internal Server Error");

        expect(consoleErrors, `console errors on ${route}:\n${consoleErrors.join("\n")}`).toEqual([]);
    });
}
