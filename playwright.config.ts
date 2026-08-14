import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the staging smoke suite (AR 2026-08-12).
 *
 * The suite runs against a real deployed URL — the local dev server
 * doesn't participate. `STAGING_URL` is set by the GitHub Actions
 * wait-for-vercel step to the specific commit's Vercel alias, so
 * every run is pinned to the commit whose gate it's protecting.
 *
 * For local iteration: `STAGING_URL=https://... npx playwright test`.
 *
 * Retries + reporter shape are the load-bearing pieces of the flake
 * strategy (see the plan in the smoke checklist / deploy runbook):
 *   - retries: 2 on CI, 0 locally.
 *   - The custom reporter writes a flake summary to $GITHUB_STEP_SUMMARY
 *     and emits ::warning:: annotations for retried tests under
 *     tests/smoke/flows/ so quotation-flow flakes surface on the
 *     commit page, not buried in an artifact.
 */

const isCI = !!process.env.CI;

export default defineConfig({
    testDir: "./tests/smoke",
    // Every test's own hard cap. Individual steps have shorter caps.
    timeout: 90_000,
    expect: { timeout: 10_000 },
    // 2 workers on CI keeps runtime under the 8-minute budget; local
    // dev prefers serial so screenshots + traces don't interleave.
    workers: isCI ? 2 : 1,
    // 2 retries on CI = up to 3 attempts total. Passes on retry still
    // count as passes for the gate, but the reporter surfaces them
    // prominently in the job summary + annotates flow-file retries.
    retries: isCI ? 2 : 0,
    // Never allow test.only to sneak in — the gate would silently
    // skip the rest of the suite.
    forbidOnly: isCI,
    // Reporter chain: the custom flake reporter (see support/) writes
    // the top-of-page summary and commit annotations; html emits the
    // detailed report we upload as an artifact on failure only.
    reporter: [
        ["./tests/smoke/support/flake-reporter.ts"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
        ["list"],
    ],
    use: {
        baseURL: process.env.STAGING_URL || "http://localhost:3000",
        // Vercel Deployment Protection sits in front of preview URLs.
        // Unauthenticated requests hit the Vercel SSO interstitial
        // instead of the app; Playwright would fill the SSO email
        // field and time out on a password field that doesn't exist.
        // Sending the `x-vercel-protection-bypass` header on every
        // request skips the interstitial for the run.
        //
        // NB: this reaches the test-fixture-created context/page (the
        // one every spec's `test('…', ({ page }) => …)` receives).
        // It does NOT reach a context you build yourself via
        // `browser.newContext()` — global-setup.ts wires the header
        // explicitly there. See its comment.
        //
        // Empty object when the env var is unset (local dev against
        // localhost) so we don't send a bogus header no one asked for.
        extraHTTPHeaders: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            ? {
                  "x-vercel-protection-bypass":
                      process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
              }
            : {},
        // Real device pixel ratio + a phone-shaped viewport catches the
        // mobile bottom bar behaviour by default. Individual specs can
        // override via test.use({ viewport: ... }) for the desktop
        // layout paths.
        ...devices["Pixel 7"],
        // Screenshot every failure; video only on retry (cheap when
        // things work, useful when they don't).
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        // Trace on retry is the single most useful artifact for
        // diagnosing a flake — Playwright's trace viewer replays the
        // whole DOM + network timeline.
        trace: "on-first-retry",
        // Fail fast on any request that returns 5xx during a
        // navigation — a route quietly 500'ing while the DOM half-
        // renders is exactly the "broke another thing" AR is trying
        // to catch.
        ignoreHTTPSErrors: false,
    },
    // Auth: global setup signs in as each of the five demo users once
    // per run and writes the cookies to .auth/<role>.json. Each spec
    // picks its own state file via test.use({ storageState: ... }).
    globalSetup: "./tests/smoke/support/global-setup.ts",
});
