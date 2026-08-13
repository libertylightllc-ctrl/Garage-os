import type { Browser, Page } from "@playwright/test";
import { smokeCustomerName, smokePhone, smokePlate } from "./unique-id";
import { storageStatePath } from "./roles";

/**
 * Shared helpers for the four flow specs. Each helper does ONE step
 * of the customer journey — flows compose them.
 *
 * Every helper is idempotent-ish: if the spec retries, the plate stays
 * the same for a given (runId, letter), so a partial run's job may
 * still exist. That's OK — the cleanup step will find them all by
 * prefix at end of run.
 */

/**
 * Book a manual-intake job. Fills the required fields with unique-
 * per-run values, submits, and returns the resulting jobCardId and
 * plate. Caller must already be signed in as an advisor / master.
 */
export async function bookManualIntake(
    page: Page,
    letter: "A" | "B" | "C" | "D",
): Promise<{ jobCardId: string; plate: string }> {
    const plate = smokePlate(letter);
    const customer = smokeCustomerName();
    const phone = smokePhone(letter);

    await page.goto("/advisor/jobs/new/confirm?via=manual");
    await page.fill('input[name="ownerName"]', customer);
    await page.fill('input[name="phone"]', phone);
    await page.fill('input[name="plate"]', plate);
    await page.fill('input[name="make"]', "Toyota");
    await page.fill('input[name="model"]', "Corolla");
    await page.fill('input[name="mileageIn"]', "42000");
    await page.fill('textarea[name="complaint"]', `Smoke ${letter} — ${plate}`);
    // NB: the Moulkia consent checkbox only renders when via === "moulkia".
    // The manual-intake path (used here) never shows it, and the server
    // action's `consentOk = via !== "moulkia" || consent` short-circuits
    // to true anyway. Attempting to `page.check('input[name="consent"]')`
    // here just hangs on a selector that never resolves.
    // `button[type="submit"]` alone matches two elements on this page —
    // the intake form's "Send to Technician" AND a nav-menu submit
    // button that's hidden inside an offcanvas / bottom sheet. Playwright
    // picks the first (hidden) one and hangs on visibility. Scope by
    // role + accessible name so we always click the correct submit.
    await page
        .getByRole("button", { name: /send to technician/i })
        .click();

    // Server action redirects to /advisor/jobs/new/done?jobId=<id> —
    // an explicit "you handed this to a tech" confirmation page. The
    // jobCardId lives in the query string; the actual job page is
    // /advisor/jobs/<id> and is one click away, but downstream flows
    // typically already know where they want to go with the id.
    await page.waitForURL(/\/advisor\/jobs\/new\/done\?.*jobId=[a-z0-9]+/, {
        timeout: 15_000,
    });
    const url = page.url();
    const jobCardId = new URL(url).searchParams.get("jobId") ?? "";
    if (!jobCardId) throw new Error(`Could not extract jobCardId from ${url}`);
    return { jobCardId, plate };
}

/**
 * Advance a freshly-intake'd job (status ARRIVED) to status ESTIMATE so
 * the advisor's "Create estimate" button appears. This is the exact
 * production workflow — the advisor cannot skip it; only a technician
 * can flip ARRIVED → ESTIMATE, and only after adding at least one
 * REQUIRED job part.
 *
 * The helper spins up a fresh browser context using the tech's stored
 * auth (from global-setup), runs the three-step tech workflow
 * (claim → add required part → submit to cashier), then closes.
 *
 *   1. `/technician` — claim the job by targeting its jobId hidden
 *      input inside the claim form.
 *   2. `/technician/jobs/{id}` — submit the addRequiredPartAction
 *      form with a description ("Smoke — brake pads"). Doesn't need
 *      a catalog partId; free-text is valid REQUIRED. This is what
 *      makes the "Send to Cashier for Estimate" button appear per
 *      `technician/jobs/[id]/page.tsx` (requiredParts.length > 0
 *      gate at line 532).
 *   3. Click "Send to Cashier for Estimate", wait for the sent-to-
 *      advisor confirmation redirect.
 *
 * Split out so B/C/D flows share exactly one implementation of the
 * intermediate tech steps — a change to how a tech submits a job
 * updates all three specs at once.
 */
export async function sendJobForEstimate(
    browser: Browser,
    jobCardId: string,
): Promise<void> {
    const ctx = await browser.newContext({
        storageState: storageStatePath("tech"),
    });
    try {
        const page = await ctx.newPage();

        // 1. Claim from the /technician dashboard. Multiple claim forms
        //    render (one per unclaimed job); scope by the hidden jobId
        //    to hit the one we care about. .first() is defensive against
        //    the same job appearing in multiple visual sections.
        await page.goto("/technician");
        // Assert we landed on /technician (not bounced to /login) —
        // gives a clean failure message if the tech storageState is stale.
        if (!page.url().includes("/technician")) {
            throw new Error(
                `sendJobForEstimate: expected /technician, got ${page.url()} — tech storageState may be stale`,
            );
        }
        await page
            .locator(
                `form:has(input[name="jobId"][value="${jobCardId}"]) button:not([type="button"])`,
            )
            .first()
            .click({ timeout: 10_000 });
        // TECH stays on /technician after a successful claim — only
        // MASTER auto-redirects to /technician/jobs/{id} (see
        // claimJobAction in src/app/actions/jobs.ts). Wait for the
        // page to settle after the server action, then navigate
        // ourselves. `?taken=1` means the claim didn't land; surface
        // that explicitly rather than hanging on the next locator.
        await page.waitForLoadState("networkidle");
        if (page.url().includes("?taken=1")) {
            throw new Error(
                `sendJobForEstimate: claim didn't land — /technician?taken=1 (job ${jobCardId} already taken or ineligible)`,
            );
        }
        await page.goto(`/technician/jobs/${jobCardId}`);

        // 2. Add a REQUIRED job part — free-text description is enough
        //    (partId select is optional). Scope the description input by
        //    ANDing the jobId hidden with the description input, so we
        //    hit the addRequiredPart form and not the RFQ form on the
        //    same page.
        await page
            .locator(
                `form:has(input[name="jobId"][value="${jobCardId}"]):has(input[name="description"]) input[name="description"]`,
            )
            .first()
            .fill("Smoke test — brake pads", { timeout: 10_000 });
        await page
            .locator(
                `form:has(input[name="jobId"][value="${jobCardId}"]):has(input[name="description"]) button:not([type="button"])`,
            )
            .first()
            .click({ timeout: 10_000 });
        await page.waitForLoadState("networkidle");

        // 3. "Send to Cashier for Estimate" (button label i18n key
        //    submitToCashier — "Send to Cashier for Estimate →"). Use
        //    role+name for stability. Fires sendForEstimateAction which
        //    flips status ARRIVED → ESTIMATE and redirects to
        //    /technician/jobs/{id}/sent-to-advisor.
        await page
            .getByRole("button", { name: /Send to Cashier for Estimate/i })
            .click({ timeout: 10_000 });
        await page.waitForURL(/\/sent-to-advisor/, { timeout: 15_000 });
    } finally {
        await ctx.close();
    }
}

/**
 * Send a DRAFT estimate to the customer.
 *
 * Post-workflow-flip (see the /estimates/[id]/page.tsx comment: "The
 * send action itself now only fires from /estimates/[id]/preview, so
 * a typo noticed mid-edit can't slip into a one-tap send"), sending
 * requires going through the customer-facing preview page. Direct
 * navigate + click the Send form there.
 *
 * The preview page's Send form has:
 *   <form action={setEstimateStatusAction}>
 *     <input name="estimateId" value=... />
 *     <input name="status" value="SENT" />
 *     <button>...</button>
 *   </form>
 *
 * Scope by status=SENT + estimateId to distinguish from the reject
 * form (also on preview).
 */
export async function sendEstimateToCustomer(
    page: Page,
    estimateId: string,
): Promise<void> {
    await page.goto(`/estimates/${estimateId}/preview`);
    await page
        .locator(
            `form:has(input[name="estimateId"][value="${estimateId}"]):has(input[name="status"][value="SENT"]) button:not([type="button"])`,
        )
        .first()
        .click({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");
}
