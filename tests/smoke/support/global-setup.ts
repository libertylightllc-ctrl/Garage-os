import { chromium, FullConfig } from "@playwright/test";
import { SMOKE_USERS, storageStatePath } from "./roles";
import fs from "node:fs";
import path from "node:path";

/**
 * Global setup — sign in as each demo user once, save cookies.
 *
 * Per-spec sign-in would multiply the run time by 5. Instead we run
 * five sign-in flows sequentially here, save `.auth/<role>.json` for
 * each, and every downstream spec picks up its own state file via
 * `test.use({ storageState })`.
 *
 * The staging DB is seeded with these five users at every deploy
 * (see prisma/seed.ts). If sign-in fails here, downstream specs all
 * fail with the same misleading "logged out" symptom — the summary
 * from the flake reporter surfaces "auth setup failed" specifically
 * so it's clear the DB seed didn't land, not that the app broke.
 */
export default async function globalSetup(config: FullConfig) {
    const baseURL = config.projects[0]?.use.baseURL;
    if (!baseURL) throw new Error("[smoke] no baseURL configured");

    // Fresh browser per setup — auth cookies from a previous run must
    // not leak in.
    const browser = await chromium.launch();
    const authDir = path.resolve(".auth");
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    try {
        for (const user of SMOKE_USERS) {
            const context = await browser.newContext();
            const page = await context.newPage();

            await page.goto(`${baseURL}/login`);
            await page.fill('input[name="email"]', user.email);
            await page.fill('input[name="password"]', user.password);
            await page.click('button[type="submit"]');

            // NextAuth redirects to the role's home on success. We
            // wait for URL to change from /login, don't pin to a
            // specific destination (that varies by role and is a
            // separate assertion downstream).
            await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
                timeout: 15_000,
            });

            await context.storageState({ path: storageStatePath(user.role) });
            await context.close();
        }
    } finally {
        await browser.close();
    }
}
