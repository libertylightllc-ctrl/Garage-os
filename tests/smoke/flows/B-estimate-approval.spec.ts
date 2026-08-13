import { test, expect } from "@playwright/test";
import { storageStatePath } from "../support/roles";
import {
    bookManualIntake,
    customerEstimateUrl,
    sendEstimateToCustomer,
    sendJobForEstimate,
} from "../support/flows";

/**
 * Flow B — Estimate reaches APPROVED via the customer approval link.
 *
 * Full customer-facing round-trip:
 *   1. Advisor books a job (bookManualIntake helper).
 *   2. Advisor creates an estimate on the job.
 *   3. Advisor adds one priced line.
 *   4. Advisor clicks the SEND status button → estimate becomes SENT.
 *   5. Test grabs the customer link (contains /c/estimate/<token>) from
 *      the estimate page (WhatsApp draft link or explicit link block).
 *   6. In a fresh browser context (no advisor cookies), test navigates
 *      to the customer URL and clicks Approve.
 *   7. Test asserts the customer page shows the approved-message.
 *   8. Back on the advisor's context, the estimate row now reads APPROVED.
 *
 * File location under tests/smoke/flows/ → the flake reporter emits
 * a commit annotation on retry-to-pass.
 */

test.use({ storageState: storageStatePath("advisor") });

test("Flow B — estimate reaches APPROVED via customer link", async ({ page, browser }) => {
    // Step 1 — intake.
    const { jobCardId } = await bookManualIntake(page, "B");

    // Step 1b — tech claims + submits, so the job status flips to
    // ESTIMATE and the advisor's "Create estimate" button appears.
    // See sendJobForEstimate for why this is a separate context.
    await sendJobForEstimate(browser, jobCardId);

    // Step 2 — advisor creates estimate. The button on the job detail
    // page submits createEstimateAction and redirects to /estimates/<id>.
    await page.goto(`/advisor/jobs/${jobCardId}`);
    await page.click('button:has-text("Create estimate"), button:has-text("Create Estimate")');
    await page.waitForURL(/\/estimates\/[a-z0-9]+$/, { timeout: 15_000 });
    const estimateId = page.url().match(/\/estimates\/([a-z0-9]+)$/)?.[1] ?? "";
    expect(estimateId, "should have extracted estimate id from URL").toMatch(/^[a-z0-9]+$/);

    // Step 3 — add ONE priced line. The line form has select(kind),
    // description, qty (defaults to 1), unitPrice. Kind LABOR is the
    // simplest (no partId lookup, no catalog dependency).
    await page.selectOption('select[name="kind"]', "LABOR");
    await page.fill('input[name="description"], textarea[name="description"]', "Smoke B — labour line");
    await page.fill('input[name="unitPrice"]', "150");
    // Submit the add-line form (the button doesn't have a stable text
    // key, so scope by form action).
    await page.locator('form:has(input[name="estimateId"][value="' + estimateId + '"]):has(input[name="unitPrice"]) button:not([type="button"])').first().click();
    await page.waitForLoadState("networkidle");

    // Step 4 — advisor clicks Send. Send only fires from the preview
    // page now (post-workflow-flip: prevents accidental one-tap sends
    // from the edit view). Helper navigates there + submits.
    await sendEstimateToCustomer(page, estimateId);

    // Step 5 — build the customer /c/estimate/<token> URL directly
    // from the DB. The URL is NOT rendered on the internal preview
    // or estimate pages — it only reaches the customer via the
    // WhatsApp send (sendWhatsApp in billing.ts). The publicToken is
    // populated on the Estimate row at send time; helper reads it.
    const customerHref = await customerEstimateUrl(estimateId);
    expect(customerHref, "customerEstimateUrl should return a /c/estimate/ URL").toMatch(
        /\/c\/estimate\/[A-Za-z0-9_-]+/,
    );

    // Step 6 — customer context: fresh browser, no auth cookies.
    // The customer link is unauthenticated (signed token), so any
    // browser can hit it.
    const customerContext = await browser.newContext();
    try {
        const customerPage = await customerContext.newPage();
        await customerPage.goto(customerHref!);
        // The approve form submits to approveEstimatePublic. Match the
        // form (not the reject one) by its distinctive submit button
        // label — "Approve" is the primary label per the customer i18n.
        await customerPage.click('form:has(input[name="token"]) button:has-text("Approve"), form:has(input[name="token"]) button:has-text("موافق")');
        // Server action redirects back to the same customer page with
        // status=APPROVED — the "approved" banner should render.
        await customerPage.waitForLoadState("networkidle");
        const customerBody = await customerPage.locator("body").innerText();
        expect(customerBody).toMatch(/approved|تمت الموافقة/i);
    } finally {
        await customerContext.close();
    }

    // Step 8 — advisor sees APPROVED on the estimate row.
    await page.goto(`/advisor/jobs/${jobCardId}`);
    await page.waitForLoadState("networkidle");
    const advisorBody = await page.locator("body").innerText();
    expect(advisorBody).toMatch(/APPROVED/);
});
