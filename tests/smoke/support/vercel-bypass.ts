/**
 * Vercel Deployment Protection bypass header (AR 2026-08-14).
 *
 * Vercel's Deployment Protection puts an SSO interstitial in front
 * of every preview deployment. Playwright would fill the SSO email
 * field and time out on a password field that doesn't exist.
 *
 * The workaround is a per-request header carrying the project's
 * bypass secret (Vercel dashboard → Deployment Protection → Runtime
 * verification → VERCEL_AUTOMATION_BYPASS_SECRET). Playwright's
 * config-level `use.extraHTTPHeaders` reaches the fixture-created
 * page but NOT contexts we build ourselves via
 * `browser.newContext()` — those need the header wired in
 * explicitly. This helper is the one place that reads the env var
 * and shapes the object so every call site can do:
 *
 *   const ctx = await browser.newContext({
 *       extraHTTPHeaders: bypassHeaders(),
 *   });
 *
 * Returns an empty object when the env var is unset (local dev
 * against localhost — Deployment Protection isn't in the loop
 * there, so sending a bogus header no one asked for is worse than
 * nothing).
 */
export function bypassHeaders(): Record<string, string> {
    const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return secret ? { "x-vercel-protection-bypass": secret } : {};
}
