import type { Browser, Page } from "@playwright/test";
import { smokeCustomerName, smokePhone, smokePlate } from "./unique-id";
import { storageStatePath } from "./roles";
import { bypassHeaders } from "./vercel-bypass";
import pg from "pg";

/**
 * Prod-DB guard (AR 2026-08-14, sibling to the STAGING_URL guard in
 * global-setup.ts).
 *
 * The raw-pg helpers below (customerEstimateUrl, getJobNumber,
 * markJobTechComplete) mutate whatever DB the connection string points
 * at. Belt-and-braces against INV-2026-0039 class of failure — someone
 * exports PROD_DATABASE_URL's value into DATABASE_URL by accident, then
 * runs smoke locally. STAGING_URL still points at localhost so its
 * guard doesn't fire, and the app never runs — but our raw pg queries
 * would still land on prod.
 *
 * Preference order (mirrors the CI workflow's cleanup job):
 *   STAGING_DATABASE_URL > DATABASE_URL > local-dev default.
 * Then, refuse if the resolved URL byte-matches PROD_DATABASE_URL
 * (which sits in .env on operator machines per AGENTS.md's Prod-DB
 * isolation section). Byte-match instead of hostname-match because
 * staging is likely on the same hosted-Postgres provider as prod —
 * a hostname check would either be too broad (blocks staging) or
 * useless (matches nothing). The URL-value match is exact.
 */
const LOCAL_DEV_DEFAULT =
    "postgres://postgres:postgres@localhost:51214/template1?sslmode=disable";

function resolveSmokeDbUrl(): string {
    const url =
        process.env.STAGING_DATABASE_URL ||
        process.env.DATABASE_URL ||
        LOCAL_DEV_DEFAULT;
    if (process.env.FORCE_SMOKE_AGAINST_PROD === "1") {
        console.warn(
            `[smoke] FORCE_SMOKE_AGAINST_PROD=1 — bypassing prod-DB guard. Break-glass only.`,
        );
        return url;
    }
    const prod = process.env.PROD_DATABASE_URL;
    if (prod && url === prod) {
        throw new Error(
            `[smoke] REFUSING to open a DB connection: resolved URL byte-matches PROD_DATABASE_URL.\n` +
                `See AGENTS.md § Prod-DB isolation. Set STAGING_DATABASE_URL (CI) or ` +
                `unset DATABASE_URL (local, defaults to prisma-dev on localhost:51214), or ` +
                `set FORCE_SMOKE_AGAINST_PROD=1 as a break-glass.`,
        );
    }
    return url;
}

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
    letter: "A" | "B" | "C" | "D" | "E",
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
        extraHTTPHeaders: bypassHeaders(),
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
        //
        // First attempt (AR 2026-08-15) tried waitForURL matching
        // /technician — but the URL is ALREADY /technician when the
        // click fires, so Playwright's waitForURL returned instantly
        // and the ?taken=1 check ran against pre-action state, giving
        // false negatives for the entire suite (same 4-spec failure
        // pattern as before). waitForURL only fires on a new
        // navigation; a Next.js server action's redirect back to the
        // same URL is a soft revalidation, not a hard navigation.
        //
        // Second attempt: race two post-action signals with
        // Promise.any — success = the claim form for this jobId is
        // detached (job moved out of the unclaimed list); fail = the
        // URL gained ?taken=1. Whichever fires first ends the wait;
        // if BOTH time out, Promise.any rejects with AggregateError
        // and the test fails loud rather than hanging. Predicates
        // that only match POST-action DOM/URL state, so no race with
        // pre-action state.
        await Promise.any([
            page
                .locator(
                    `form:has(input[name="jobId"][value="${jobCardId}"])`,
                )
                .first()
                .waitFor({ state: "detached", timeout: 15_000 }),
            page.waitForURL(
                (url) => url.searchParams.get("taken") === "1",
                { timeout: 15_000 },
            ),
        ]);
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
        // Wait for the added-part description to appear in the DOM as
        // rendered TEXT (not the input value we typed — getByText
        // matches text nodes, not <input value>). Deterministic signal
        // that the server action re-rendered with the new part in the
        // list. `.first()` because the tech page renders each part
        // twice (card view + table view) and strict-mode locators
        // reject 2-element matches. Was `page.waitForLoadState
        // ("networkidle")` — hung indefinitely on Vercel preview
        // (AR 2026-08-15).
        await page
            .getByText("Smoke test — brake pads")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 });

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
 * requires going through the customer-facing preview page.
 *
 * AR 2026-08-16 estimate-send fix: the preview form now submits to
 * sendEstimateToCustomerAction, which mirrors the invoice send —
 * builds a wa.me URL and redirects the browser to it. The old form
 * carried a `status=SENT` hidden input; the new one only carries
 * `estimateId`. Match by form action attribute (Next.js server-
 * action forms render an opaque `/estimates/[id]/preview`-ish action;
 * safest is to match on the button label since that's the only
 * Send button on the preview page).
 *
 * On successful redirect the browser navigates to wa.me/... — we
 * intercept that so smoke tests don't leave the app. When the URL
 * changes to a wa.me destination, we know the action ran; we then
 * navigate back to the preview page so the caller can continue.
 */
export async function sendEstimateToCustomer(
    page: Page,
    estimateId: string,
): Promise<void> {
    await page.goto(`/estimates/${estimateId}/preview`);
    // Poll the DB for Estimate.sentAt AFTER click — deterministic
    // signal that the server action committed. Previous attempts:
    //   • page.route + page.unroute: unroute hung past test timeout
    //     on retries.
    //   • page.waitForURL(/wa.me/): never fired — Next.js server-
    //     action cross-origin redirects apparently don't surface as
    //     main-frame nav events to Playwright's URL observer.
    // Raw pg poll bypasses both — we know the exact DB write we're
    // waiting on (Estimate.sentAt IS NOT NULL) and can bound the
    // wait ourselves.
    await page
        .getByRole("button", { name: /Send Estimate to Customer/i })
        .first()
        .click({ timeout: 10_000 });
    const client = new pg.Client({ connectionString: resolveSmokeDbUrl() });
    await client.connect();
    try {
        const deadline = Date.now() + 15_000;
        // Poll every 250ms for the sentAt stamp. Fires in ~1 round-
        // trip on the happy path; times out with a specific message
        // if the server action never committed.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const r = await client.query<{ sentAt: Date | null; status: string }>(
                `SELECT "sentAt", status FROM "Estimate" WHERE id = $1`,
                [estimateId],
            );
            const row = r.rows[0];
            if (row?.sentAt && row.status === "SENT") return;
            if (Date.now() > deadline) {
                throw new Error(
                    `sendEstimateToCustomer: estimate ${estimateId} did not reach status=SENT + sentAt within 15s. Row: ${JSON.stringify(row ?? null)}`,
                );
            }
            await new Promise((res) => setTimeout(res, 250));
        }
    } finally {
        await client.end();
        // Reload the preview page so the caller sees fresh RSC state.
        // The wa.me redirect fired on the browser side but nothing
        // waited for it; goto cancels any pending nav and pulls a
        // clean render.
        await page.goto(`/estimates/${estimateId}/preview`);
    }
}

/**
 * Build the customer-facing /c/estimate/<token> URL directly from
 * the DB — the URL is NOT rendered anywhere on the internal estimate
 * or preview pages (only sent to the customer's WhatsApp via
 * sendWhatsApp in billing.ts:475). The publicToken is on the
 * Estimate row, populated either at row create time or by
 * ensurePublicToken during the send action; a just-sent estimate is
 * guaranteed to have one. See src/lib/document-tokens.ts for the
 * token resolution scheme (raw publicToken in Phase 2; HMAC in
 * Phase 1 fallback — we always get the Phase-2 shape from fresh
 * estimates).
 *
 * baseUrl mirrors playwright.config.ts's `baseURL` fallback so
 * local dev runs work out of the box.
 */
/**
 * Advance a job from ESTIMATE (with an APPROVED estimate on it) to
 * TECH_COMPLETE via a direct DB update, bypassing the
 * markCompleteAction UI. Necessary because that action's UI gate
 * requires `hasWorkProof` — a photo upload or a mid-repair findings
 * edit — which is impractical to fake in a smoke test.
 *
 * The gate exists to prevent techs from claiming completion without
 * evidence; it's a UX / audit invariant, not a data invariant. Every
 * downstream cashier / invoice check reads `jobCard.status` and the
 * estimate.status pair — both of which we set correctly here.
 *
 * `workCompletedAt` is set so the cashier's "Awaiting final invoice"
 * timing display doesn't render "—" and every downstream assertion
 * against the invoice UI sees a real production-shaped row.
 */
export async function markJobTechComplete(
    jobCardId: string,
): Promise<void> {
    const client = new pg.Client({ connectionString: resolveSmokeDbUrl() });
    await client.connect();
    try {
        const res = await client.query(
            `UPDATE "JobCard" SET status = 'TECH_COMPLETE', "workCompletedAt" = NOW() WHERE id = $1 RETURNING id`,
            [jobCardId],
        );
        if (res.rowCount !== 1) {
            throw new Error(
                `markJobTechComplete: expected to update 1 job, updated ${res.rowCount} (jobId=${jobCardId})`,
            );
        }
    } finally {
        await client.end();
    }
}

/**
 * Force a known unitCost onto every PART line of an estimate via
 * direct DB write. The screen add-line form (addEstimateLineAction)
 * only accepts qty + unitPrice — cost is prefilled from a catalog
 * Part.cost, or left null for free-text lines. The edit-mode
 * CostPricedInputs form does accept a typed cost, but driving that
 * UX in Playwright adds an inner mode-switch step for zero test
 * value. The print-leak test just needs a KNOWN cost value on the
 * eventually-generated InvoiceLine so the profit-card render has
 * something concrete to leak — bypassing the UI is fine.
 *
 * Data-invariant preserving: the same column the UI writes.
 */
export async function setEstimateLineCosts(
    estimateId: string,
    unitCost: string,
): Promise<number> {
    const client = new pg.Client({ connectionString: resolveSmokeDbUrl() });
    await client.connect();
    try {
        const res = await client.query(
            `UPDATE "EstimateLine" SET "unitCost" = $2, "markupPct" = 0 WHERE "estimateId" = $1 AND kind = 'PART'`,
            [estimateId, unitCost],
        );
        return res.rowCount ?? 0;
    } finally {
        await client.end();
    }
}

/**
 * Look up a job's per-garage sequential number. Needed because
 * /owner/purchasing/from-estimate requires `?jobNumber=<N>` in the
 * URL to find the job — passing jobCardId alone isn't enough. Same
 * raw-pg pattern as customerEstimateUrl for the same reason.
 */
export async function getJobNumber(jobCardId: string): Promise<number> {
    const client = new pg.Client({ connectionString: resolveSmokeDbUrl() });
    await client.connect();
    try {
        const res = await client.query<{ number: number | null }>(
            `SELECT number FROM "JobCard" WHERE id = $1`,
            [jobCardId],
        );
        const n = res.rows[0]?.number ?? null;
        if (n == null) {
            throw new Error(`getJobNumber: no JobCard row for id ${jobCardId}`);
        }
        return n;
    } finally {
        await client.end();
    }
}

export async function customerEstimateUrl(
    estimateId: string,
): Promise<string> {
    // Using raw pg instead of @/lib/prisma: the Prisma 7 driverless
    // client generator uses `import.meta` internally, which trips
    // Playwright's CommonJS transpiler at import time. pg is already
    // transitively installed via @prisma/adapter-pg. One-shot
    // connection — cheap, self-cleaning.
    const client = new pg.Client({ connectionString: resolveSmokeDbUrl() });
    await client.connect();
    try {
        const res = await client.query<{ publicToken: string | null }>(
            `SELECT "publicToken" FROM "Estimate" WHERE id = $1`,
            [estimateId],
        );
        const token = res.rows[0]?.publicToken ?? null;
        if (!token) {
            throw new Error(
                `customerEstimateUrl: estimate ${estimateId} has no publicToken — was sendEstimateToCustomer called first?`,
            );
        }
        const baseUrl = process.env.STAGING_URL || "http://localhost:3000";
        return `${baseUrl}/c/estimate/${token}`;
    } finally {
        await client.end();
    }
}
