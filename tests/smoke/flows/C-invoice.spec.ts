import { test, expect } from "@playwright/test";
import { storageStatePath } from "../support/roles";
import { bookManualIntake } from "../support/flows";

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

test("Flow C — cashier generates invoice + records payment", async ({ page, browser }) => {
    // Step 1 — intake as advisor.
    const { jobCardId } = await bookManualIntake(page, "C");

    // Step 2 — create estimate.
    await page.goto(`/advisor/jobs/${jobCardId}`);
    await page.click('button:has-text("Create estimate"), button:has-text("Create Estimate")');
    await page.waitForURL(/\/estimates\/[a-z0-9]+$/, { timeout: 15_000 });
    const estimateId = page.url().match(/\/estimates\/([a-z0-9]+)$/)?.[1] ?? "";

    // Step 3 — one labour line, priced.
    await page.selectOption('select[name="kind"]', "LABOR");
    await page.fill('input[name="description"], textarea[name="description"]', "Smoke C — labour line");
    await page.fill('input[name="unitPrice"]', "200");
    await page.locator('form:has(input[name="estimateId"][value="' + estimateId + '"]):has(input[name="unitPrice"]) button[type="submit"]').first().click();
    await page.waitForLoadState("networkidle");

    // Step 4 — SEND.
    await page.locator('form:has(input[name="status"][value="SENT"]) button').first().click();
    await page.waitForLoadState("networkidle");

    // Step 5 — grab customer link.
    const customerHref = await page.locator('a[href*="/c/estimate/"]').first().getAttribute("href");
    expect(customerHref).toMatch(/\/c\/estimate\/[A-Za-z0-9_-]+/);

    // Step 6 — customer approves.
    const customerContext = await browser.newContext();
    try {
        const customerPage = await customerContext.newPage();
        await customerPage.goto(customerHref!);
        await customerPage.click('form:has(input[name="token"]) button:has-text("Approve"), form:has(input[name="token"]) button:has-text("موافق")');
        await customerPage.waitForLoadState("networkidle");
    } finally {
        await customerContext.close();
    }

    // Step 7 — switch to cashier. Fresh context with cashier's
    // storageState — mid-test role switch is standard Playwright.
    const cashierContext = await browser.newContext({
        storageState: storageStatePath("cashier"),
    });
    try {
        const cashierPage = await cashierContext.newPage();

        // Cashier lands on /cashier and finds the approved estimate;
        // clicking Generate Invoice fires generateInvoiceAction and
        // redirects to /invoices/<id>.
        await cashierPage.goto(`/estimates/${estimateId}`);
        await cashierPage.locator('form:has(input[name="estimateId"][value="' + estimateId + '"]) button:has-text("Generate invoice"), form:has(input[name="estimateId"][value="' + estimateId + '"]) button:has-text("Generate Invoice")').first().click();
        await cashierPage.waitForURL(/\/invoices\/[a-z0-9]+/, { timeout: 15_000 });
        const invoiceUrl = cashierPage.url();
        const invoiceId = invoiceUrl.match(/\/invoices\/([a-z0-9]+)/)?.[1] ?? "";
        expect(invoiceId).toMatch(/^[a-z0-9]+$/);

        // Step 8 — payment recording lives on the /cashier Receivables
        // row, not the invoice detail. Go back there, find this
        // invoice, submit the record-payment form with method=CASH
        // and amount=invoice total (200 labour + 5% VAT = 210.00).
        await cashierPage.goto("/cashier");
        // The row exposes an amount input and a method select for
        // this invoice specifically. Scoping to the invoiceId keeps
        // multi-row pages unambiguous.
        const paymentForm = cashierPage
            .locator(`form:has(input[value="${invoiceId}"]):has(select[name="method"])`)
            .first();
        await paymentForm.locator('input[name="amount"]').fill("210.00");
        await paymentForm.locator('select[name="method"]').selectOption("CASH");
        await paymentForm.locator('button[type="submit"]').click();
        await cashierPage.waitForLoadState("networkidle");

        // Step 9 — assert PAID on the invoice detail page.
        await cashierPage.goto(`/invoices/${invoiceId}`);
        const body = await cashierPage.locator("body").innerText();
        expect(body).toMatch(/PAID|paid/i);
    } finally {
        await cashierContext.close();
    }
});
