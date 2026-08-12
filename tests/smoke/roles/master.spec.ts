import { test, expect } from "@playwright/test";
import { SMOKE_USERS, storageStatePath } from "../support/roles";

// Same page-load contract. MASTER has 16 routes — the widest sweep,
// since they wear the advisor + tech + cashier hats + the operational
// slice of /owner/*. If middleware or a shared component broke, this
// role is where the most surfaces would fail.
const master = SMOKE_USERS.find((u) => u.role === "master")!;
test.use({ storageState: storageStatePath("master") });

for (const route of master.nav) {
    test(`master: ${route} loads without error`, async ({ page }) => {
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
