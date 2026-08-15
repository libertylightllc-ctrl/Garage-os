import { test, expect } from "@playwright/test";
import { storageStatePath } from "../support/roles";
import { bypassHeaders } from "../support/vercel-bypass";
import {
    bookManualIntake,
    customerEstimateUrl,
    markJobTechComplete,
    sendEstimateToCustomer,
    sendJobForEstimate,
} from "../support/flows";

/**
 * Flow C — Cashier generates + records payment on an invoice.
 *
 * Extends Flow B's shape: intake → estimate → line → SENT → customer
 * APPROVES → cashier generates invoice → cashier records cash payment.
 * Different plate (letter "C") so runs don't collide with Flow B.
 *
 * Uses two contexts:
 *   - advisor (default storageState) for the intake + estimate steps.
 *   - cashier (switch mid-test via context.newContext with the
 *     cashier storageState) for the invoice + payment.
 *
 * File location under tests/smoke/flows/ → the flake reporter emits
 * a commit annotation on retry-to-pass.
 */

test.use({ storageState: storageStatePath("advisor") });

// Flow C has the most context switches of any flow (advisor + tech +
// customer + cashier). Local dev browsers spin up in ~2-3s each on
// Windows, so total wall-clock can push past the default 90s cap even
// on a clean run. 3-minute cap gives headroom without hiding real
// regressions.
test.setTimeout(180_000);

test("Flow C — cashier generates invoice + records payment", async ({ page, browser }) => {

    // Step 1 — intake as advisor.
    const { jobCardId } = await bookManualIntake(page, "C");

    // Step 1b — tech workflow flips status ARRIVED → ESTIMATE so
    // the advisor's Create Estimate button appears. See helper.
    await sendJobForEstimate(browser, jobCardId);

    // Step 2 — create estimate.
    await page.goto(`/advisor/jobs/${jobCardId}`);
    await page.click('button:has-text("Create estimate"), button:has-text("Create Estimate")');
    await page.waitForURL(/\/estimates\/[a-z0-9]+$/, { timeout: 15_000 });
    const estimateId = page.url().match(/\/estimates\/([a-z0-9]+)$/)?.[1] ?? "";

    // Step 3 — one labour line, priced.
    await page.selectOption('select[name="kind"]', "LABOR");
    await page.fill('input[name="description"], textarea[name="description"]', "Smoke C — labour line");
    await page.fill('input[name="unitPrice"]', "200");
    await page.locator('form:has(input[name="estimateId"][value="' + estimateId + '"]):has(input[name="unitPrice"]) button:not([type="button"])').first().click();
    // Deterministic wait for the added line's rendered text — was
    // networkidle (unreliable on Vercel preview). AR 2026-08-15.
    await page.getByText("Smoke C — labour line").waitFor({ state: "visible", timeout: 10_000 });

    // Step 4 — SEND (only from the preview page post-workflow-flip).
    await sendEstimateToCustomer(page, estimateId);

    // Step 5 — build customer link from DB (URL isn't on any advisor
    // page; it only ships via WhatsApp to the customer's phone).
    const customerHref = await customerEstimateUrl(estimateId);
    expect(customerHref).toMatch(/\/c\/estimate\/[A-Za-z0-9_-]+/);

    // Step 6 — customer approves.
    const customerContext = await browser.newContext({
        extraHTTPHeaders: bypassHeaders(),
    });
    try {
        const customerPage = await customerContext.newPage();
        await customerPage.goto(customerHref!);
        await customerPage.click('form:has(input[name="token"]) button:has-text("Approve"), form:has(input[name="token"]) button:has-text("موافق")');
        // Wait for the approved banner — matches Flow B's pattern.
        // AR 2026-08-15.
        await expect(
            customerPage.getByText(/approved|تمت الموافقة/i).first(),
        ).toBeVisible({ timeout: 15_000 });
    } finally {
        await customerContext.close();
    }

    // Step 6b — the cashier's "Generate Invoice" button gates on
    // jobCard.status === "TECH_COMPLETE" (per estimates/[id]/page.tsx
    // line ~638). Estimate APPROVED alone isn't enough; the tech has
    // to Mark Complete. Bypass the UI (proof-of-work photo requirement
    // impractical to fake in smoke) via direct DB update — see the
    // helper for why this shortcut is safe.
    await markJobTechComplete(jobCardId);

    // Step 7 — switch to cashier. Fresh context with cashier's
    // storageState — mid-test role switch is standard Playwright.
    const cashierContext = await browser.newContext({
        storageState: storageStatePath("cashier"),
        extraHTTPHeaders: bypassHeaders(),
    });
    try {
        const cashierPage = await cashierContext.newPage();

        // Cashier lands on /estimates/<id> and finds the approved
        // estimate; clicking Generate Invoice fires generateInvoiceAction
        // and redirects to /invoices/<id>. Text-based selector (i18n
        // key `generateInvoice` = "Generate invoice") is more robust
        // than form:has(estimateId) because MANY forms on the page
        // carry the same hidden estimateId input.
        await cashierPage.goto(`/estimates/${estimateId}`);
        await cashierPage
            .getByRole("button", { name: /Generate invoice/i })
            .click({ timeout: 15_000 });
        await cashierPage.waitForURL(/\/invoices\/[a-z0-9]+/, { timeout: 15_000 });
        const invoiceUrl = cashierPage.url();
        const invoiceId = invoiceUrl.match(/\/invoices\/([a-z0-9]+)/)?.[1] ?? "";
        expect(invoiceId).toMatch(/^[a-z0-9]+$/);

        // Step 8 — payment recording lives on the /cashier Receivables
        // row, INSIDE the Invoices tab (not the default Estimates
        // tab). Navigate with ?tab=invoices explicitly or the row's
        // form never renders in the DOM and the fill() call below
        // hangs waiting for an element that will never appear.
        // Scope by invoiceId to distinguish from every other unpaid
        // invoice on the page (a real prod dashboard has many).
        await cashierPage.goto("/cashier?tab=invoices");
        // The row exposes an amount input and a method select for
        // this invoice specifically. Scoping to the invoiceId keeps
        // multi-row pages unambiguous.
        const paymentForm = cashierPage
            .locator(`form:has(input[value="${invoiceId}"]):has(select[name="method"])`)
            .first();
        await paymentForm.locator('input[name="amount"]').fill("210.00");
        await paymentForm.locator('select[name="method"]').selectOption("CASH");
        await paymentForm.locator('button:not([type="button"])').click();
        // After payment records, the row's payment form detaches (the
        // invoice moves out of receivables). Bounded wait on that
        // detach as the deterministic signal. Was networkidle. AR
        // 2026-08-15.
        await paymentForm.waitFor({ state: "detached", timeout: 15_000 });

        // Step 9 — assert PAID on the invoice detail page.
        await cashierPage.goto(`/invoices/${invoiceId}`);
        const body = await cashierPage.locator("body").innerText();
        expect(body).toMatch(/PAID|paid/i);
    } finally {
        await cashierContext.close();
    }
});
