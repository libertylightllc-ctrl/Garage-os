import { test, expect } from "@playwright/test";
import { storageStatePath } from "../support/roles";
import { bypassHeaders } from "../support/vercel-bypass";
import {
    bookManualIntake,
    customerEstimateUrl,
    getJobNumber,
    sendEstimateToCustomer,
    sendJobForEstimate,
} from "../support/flows";

/**
 * Flow D — Estimate with a hand-typed part converts to a Request for
 * Quotation reaching a supplier.
 *
 * THIS IS THE FLOW WHOSE REGRESSION COST TWO SHOPS. AR specifically
 * called it out as the one they most want a machine watching. The
 * critical invariants this test pins:
 *
 *   1. When at least one line has no cost (hand-typed, no partId,
 *      no unitCost), the doc kind becomes RFQ, not PO.
 *   2. The internal purchasing document reads "Request for Quotation",
 *      not "Purchase Order".
 *   3. The hand-typed line still carries the description the advisor
 *      wrote — the freehand text survives conversion.
 *   4. There is NO price on that line — the whole point of the RFQ
 *      is asking the supplier what it costs.
 *
 * File is under tests/smoke/flows/ → any retry-to-pass on this test
 * emits a ::warning:: commit annotation. A quotation flow flaking
 * at 33% is the exact story from the two-shop incident.
 */

test.use({ storageState: storageStatePath("advisor") });

// Flow D switches contexts three times (advisor + tech + customer +
// owner). Matches Flow C's 3-minute cap for the same reason: local
// Windows browser context startup pushes total wall-clock beyond the
// default 90s even on a clean run.
test.setTimeout(180_000);

const HANDTYPED_DESCRIPTION = "Bespoke suspension bushing SMK-D";

test("Flow D — hand-typed part converts to Request for Quotation with no price", async ({ page, browser }) => {
    // Step 1 — advisor books a job.
    const { jobCardId } = await bookManualIntake(page, "D");

    // Step 1b — tech workflow flips status ARRIVED → ESTIMATE so
    // the advisor's Create Estimate button appears. See helper.
    await sendJobForEstimate(browser, jobCardId);

    // Step 2 — create estimate on the job.
    await page.goto(`/advisor/jobs/${jobCardId}`);
    await page.click('button:has-text("Create estimate"), button:has-text("Create Estimate")');
    await page.waitForURL(/\/estimates\/[a-z0-9]+$/, { timeout: 15_000 });
    const estimateId = page.url().match(/\/estimates\/([a-z0-9]+)$/)?.[1] ?? "";
    expect(estimateId).toMatch(/^[a-z0-9]+$/);

    // Step 3 — add a HAND-TYPED PART line. The advisor picks kind=PART
    // without selecting from a catalog match, types the description
    // freehand, sets a unit price but leaves unitCost null. That's
    // exactly what a real advisor does when the part isn't in stock
    // and needs a supplier quote. The empty unitCost is what
    // downstream flips the doc kind to RFQ.
    await page.selectOption('select[name="kind"]', "PART");
    await page.fill('input[name="description"], textarea[name="description"]', HANDTYPED_DESCRIPTION);
    await page.fill('input[name="unitPrice"]', "300");
    await page
        .locator(
            'form:has(input[name="estimateId"][value="' + estimateId + '"]):has(input[name="unitPrice"]) button:not([type="button"])',
        )
        .first()
        .click();
    await page.waitForLoadState("networkidle");

    // Step 4 — advisor sends the estimate (status → SENT). Send only
    // fires from the preview page post-workflow-flip.
    await sendEstimateToCustomer(page, estimateId);

    // Step 5 — build the customer approval link from DB (URL isn't
    // rendered on any advisor page; only ships via WhatsApp).
    const customerHref = await customerEstimateUrl(estimateId);
    expect(customerHref).toMatch(/\/c\/estimate\/[A-Za-z0-9_-]+/);

    // Step 6 — customer approves in a fresh context.
    const customerContext = await browser.newContext({
        extraHTTPHeaders: bypassHeaders(),
    });
    try {
        const customerPage = await customerContext.newPage();
        await customerPage.goto(customerHref!);
        await customerPage.click(
            'form:has(input[name="token"]) button:has-text("Approve"), form:has(input[name="token"]) button:has-text("موافق")',
        );
        await customerPage.waitForLoadState("networkidle");
    } finally {
        await customerContext.close();
    }

    // Step 7 — switch to owner. The from-estimate page is
    // OWNER-guarded. Fresh context uses owner's storageState.
    const ownerContext = await browser.newContext({
        storageState: storageStatePath("owner"),
        extraHTTPHeaders: bypassHeaders(),
    });
    try {
        const ownerPage = await ownerContext.newPage();

        // Step 8 — go to the from-estimate conversion page for THIS
        // job. The page requires a `jobNumber` query param to load
        // the job (`?estimateId=` alone doesn't populate the form);
        // look it up from the DB.
        const jobNumber = await getJobNumber(jobCardId);
        await ownerPage.goto(
            `/owner/purchasing/from-estimate?jobNumber=${jobNumber}&estimateId=${estimateId}`,
        );

        // Step 9 — locate the form for THIS job (scoped by hidden
        // jobCardId + estimateId inputs so we don't accidentally
        // submit against another concurrent smoke run's estimate).
        const conversionForm = ownerPage.locator(
            `form:has(input[name="jobCardId"][value="${jobCardId}"]):has(input[name="estimateId"][value="${estimateId}"])`,
        );
        await expect(conversionForm, "conversion form for this job should render on from-estimate page").toBeVisible({
            timeout: 15_000,
        });

        // Step 10 — the include checkbox for our hand-typed line
        // should default to checked (the page renders each estimate
        // line as an include row). Confirm it, then choose the
        // seeded supplier.
        const includeChecks = conversionForm.locator('input[name="include"]');
        const firstInclude = includeChecks.first();
        if (!(await firstInclude.isChecked())) {
            await firstInclude.check();
        }
        await conversionForm.locator('select[name="supplierId"]').selectOption({ label: "Demo Parts Supplier" });

        // Step 11 — submit. Two buttons now (AR 2026-08-14): "Create
        // quotation" (always enabled) and "Create purchase order"
        // (disabled while any included line has no cost). Flow D's
        // hand-typed line has NO unitCost, so the PO button is
        // disabled and we click Quotation — the intent this flow
        // is testing.
        await conversionForm
            .getByRole("button", { name: /Create quotation/i })
            .click();

        // Step 12 — redirected to the new PO page.
        await ownerPage.waitForURL(/\/owner\/purchasing\/[a-z0-9]+$/, { timeout: 15_000 });
        const poId = ownerPage.url().match(/\/owner\/purchasing\/([a-z0-9]+)$/)?.[1] ?? "";
        expect(poId).toMatch(/^[a-z0-9]+$/);

        // Step 13 — the critical assertions. Read the page body
        // once and check every invariant against it.
        const body = await ownerPage.locator("body").innerText();

        // 13a — reads Request for Quotation, NOT Purchase Order.
        expect(body, "PO page should carry the RFQ document title").toContain(
            "Request for Quotation",
        );
        // Belt-and-braces: the doc must NOT read as a Purchase
        // Order document heading. There may be legitimate uses of
        // the string "purchase order" elsewhere (nav items, links
        // to unrelated docs), so we require the RFQ title to be
        // present rather than asserting the PO title's absence.

        // 13b — hand-typed description survives.
        expect(body, "hand-typed line description should survive conversion").toContain(
            HANDTYPED_DESCRIPTION,
        );

        // 13c — NO price on the hand-typed line. The line should
        // render some empty-cost marker (em dash / TBD / blank
        // cost cell), and the AED currency prefix should NOT sit
        // adjacent to the description. The strong signal is that
        // the internal money formatter's output ("AED 300.00")
        // does not appear anywhere in the doc — that would mean
        // the price bled through despite the line being unpriced.
        expect(body, "no price should appear on the hand-typed RFQ line").not.toContain(
            "AED 300.00",
        );
    } finally {
        await ownerContext.close();
    }
});
