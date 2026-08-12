import { test, expect } from "@playwright/test";
import { SMOKE_USERS, storageStatePath } from "../support/roles";

const cashier = SMOKE_USERS.find((u) => u.role === "cashier")!;
test.use({ storageState: storageStatePath("cashier") });

for (const route of cashier.nav) {
    test(`cashier: ${route} loads without error`, async ({ page }) => {
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
