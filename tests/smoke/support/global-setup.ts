import { chromium, FullConfig } from "@playwright/test";
import { SMOKE_USERS, storageStatePath } from "./roles";
import { bypassHeaders } from "./vercel-bypass";
import fs from "node:fs";
import path from "node:path";

/**
 * Production-domain guard (AR 2026-08-14).
 *
 * The smoke suite creates jobs, estimates, invoices, payments and
 * writes them all to whatever DB the target app is connected to. If
 * STAGING_URL ever accidentally pointed at the production alias
 * (garageos.shop / www.garageos.shop), we'd write real customer-
 * facing records under fake plates + fake customers — indistinguishable
 * from a real intake in the shop's dashboard, and impossible to
 * fully unwind (invoice numbers are gapless per garage).
 *
 * Same class of check as next.config.ts's dev-server-vs-prod-DB
 * guard added after INV-2026-0039. Refuse loudly at the earliest
 * point in the test run (globalSetup runs BEFORE any sign-in).
 *
 * Set FORCE_SMOKE_AGAINST_PROD=1 as a break-glass — kept out of any
 * default CI workflow, needs manual export to reach.
 */
const BLOCKED_HOSTS = new Set([
    "garageos.shop",
    "www.garageos.shop",
]);
function assertNotProduction(baseURL: string): void {
    if (process.env.FORCE_SMOKE_AGAINST_PROD === "1") {
        console.warn(
            `[smoke] FORCE_SMOKE_AGAINST_PROD=1 — bypassing production-domain guard. This is a break-glass. Do not use in CI.`,
        );
        return;
    }
    let host: string;
    try {
        host = new URL(baseURL).hostname.toLowerCase();
    } catch {
        throw new Error(`[smoke] baseURL isn't a valid URL: ${baseURL}`);
    }
    if (BLOCKED_HOSTS.has(host)) {
        throw new Error(
            `[smoke] REFUSING TO RUN against production host "${host}" (baseURL=${baseURL}).\n` +
                `The smoke suite creates jobs, invoices and payments. Running it against ` +
                `production would write real records under fake plates that can't fully be undone ` +
                `(gapless per-garage invoice numbers). Point STAGING_URL at a staging alias, or ` +
                `set FORCE_SMOKE_AGAINST_PROD=1 to bypass (break-glass only).`,
        );
    }
}

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
    // Guard #1 — refuse if the Playwright baseURL is a production host.
    // Runs before any browser context or DB helper touches anything.
    assertNotProduction(baseURL);

    // Fresh browser per setup — auth cookies from a previous run must
    // not leak in.
    const browser = await chromium.launch();
    const authDir = path.resolve(".auth");
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    // Vercel Deployment Protection bypass header (AR 2026-08-14).
    //
    // playwright.config.ts sets `use.extraHTTPHeaders` with this
    // header, but that only reaches the fixture-created page in
    // `test('…', ({ page }) => …)`. This global setup builds its OWN
    // context via `browser.newContext()`, which does NOT inherit
    // `use.extraHTTPHeaders` — it's a config-driven fixture, not a
    // browser-level default. Without the explicit wire-in here, the
    // sign-in flow hits Vercel's SSO interstitial and times out
    // waiting for a password field on Vercel's login page. Same
    // pattern in every spec that opens a second/third context via
    // `browser.newContext()` — see the helper module for the shared
    // list of call sites.
    const bypass = bypassHeaders();

    try {
        for (const user of SMOKE_USERS) {
            const context = await browser.newContext({
                extraHTTPHeaders: bypass,
            });
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
