import { test, expect } from "@playwright/test";
import { storageStatePath } from "../support/roles";
import { bypassHeaders } from "../support/vercel-bypass";
import {
    bookManualIntake,
    customerEstimateUrl,
    markJobTechComplete,
    sendEstimateToCustomer,
    sendJobForEstimate,
    setEstimateLineCosts,
} from "../support/flows";

/**
 * Flow E — Nothing internal leaks onto printed invoices (AR 2026-08-14).
 *
 * A staff member prints /invoices/[id] and hands the sheet to a
 * customer. Whatever is on that printed sheet ends up in the customer's
 * hand — so cost prices, margins, workflow steppers, timelines and any
 * in-page editing form MUST NOT survive `@media print`.
 *
 * The specific class of leak we're pinning:
 *
 *   - PROFIT PANEL — cost + gross profit + margin %. Visible to
 *     OWNER / MASTER on screen via `canSeeMargin`. If it prints,
 *     the customer sees the shop's markup on a document that reads
 *     as their invoice.
 *   - WORKFLOW STEPPER — internal "Check-in → Diagnosis → Estimate…"
 *     row. Not customer-facing content.
 *   - JOB TIMELINE — who did what when. Internal audit, not customer
 *     content.
 *   - ADD-LINE FORM — editing affordance. Fine on screen, junk on paper.
 *   - DISCOUNT EDITOR — same.
 *
 * Method:
 *   - Log in as OWNER (both `canEditInvoice` allowed and `canSeeMargin`
 *     true — the intersection where the profit card renders on the
 *     invoice page).
 *   - Full workflow: intake → tech send-for-estimate → create estimate
 *     with a PART line at a KNOWN unitCost (77.77) → customer approve
 *     → mark tech-complete → generate invoice.
 *   - `page.emulateMedia({ media: 'print' })` — Playwright's official
 *     way to turn on print media queries. Every `@media print` rule
 *     fires as it would in the browser's own print preview.
 *   - Assert: every forbidden element is HIDDEN, AND the visible text
 *     under print media contains none of the forbidden strings.
 *
 * Two layers of assertion because the leak class has two failure
 * modes: (a) element still visible via display: initial override, or
 * (b) some other element on the page prints the same cost value via
 * a different render tree. Layer (a) catches the direct hide;
 * layer (b) catches indirect leaks.
 *
 * Red-then-green verified once locally by manually stripping
 * `print:hidden` from `src/components/job-profit-card.tsx`, running
 * this test to confirm it fails with a specific assertion
 * ("job profit card must be hidden in print"), restoring, and
 * confirming green. See commit message for the captured failure
 * output.
 */

// This flow does two context switches (tech send-for-estimate) plus
// the OWNER-context invoice generation, so it needs the same 3-min
// cap as Flow C.
test.setTimeout(180_000);

// OWNER role: can reach /invoices/[id] (canEditInvoice) AND sees
// margin (canSeeMargin). The intersection is what triggers the
// profit-card render — a CASHIER wouldn't see it at all, so a
// cashier-only test would vacuously pass.
test.use({ storageState: storageStatePath("owner") });

const KNOWN_COST = "77.77";
const KNOWN_UNIT_PRICE = "150";

test("Flow E — invoice edit page prints nothing internal", async ({
    page,
    browser,
}) => {
    // Full production workflow so the invoice's InvoiceLine.unitCost
    // gets the seeded value snapshotted from the estimate line at
    // invoice-generation time. Without this, the profit card's cost
    // number would render as em-dash (compute layer returns null when
    // any line has null unitCost) and the seed-string assertion would
    // vacuously pass.
    const { jobCardId } = await bookManualIntake(page, "E");
    await sendJobForEstimate(browser, jobCardId);

    // Create estimate + one PART line with known unitCost.
    await page.goto(`/advisor/jobs/${jobCardId}`);
    await page.click(
        'button:has-text("Create estimate"), button:has-text("Create Estimate")',
    );
    await page.waitForURL(/\/estimates\/[a-z0-9]+$/, { timeout: 15_000 });
    const estimateId =
        page.url().match(/\/estimates\/([a-z0-9]+)$/)?.[1] ?? "";
    expect(estimateId).toMatch(/^[a-z0-9]+$/);

    // PART kind so the invoice snapshot carries a real cost value
    // downstream. Add-line form accepts qty + unitPrice; the cost
    // gets set via `setEstimateLineCosts` a few lines below (the
    // screen add-line form has no cost input — it prefills from a
    // catalog Part or leaves null; the print-leak test needs a
    // known unitCost so the profit card has something concrete to
    // leak).
    await page.selectOption('select[name="kind"]', "PART");
    await page.fill(
        'input[name="description"], textarea[name="description"]',
        "Print-leak test — brake pad",
    );
    await page.fill('input[name="unitPrice"]', KNOWN_UNIT_PRICE);
    await page
        .locator(
            'form:has(input[name="estimateId"][value="' +
                estimateId +
                '"]):has(input[name="unitPrice"]) button:not([type="button"])',
        )
        .first()
        .click();
    // Deterministic wait for the added line's rendered text before
    // the setEstimateLineCosts raw-pg UPDATE runs — the row must
    // exist in the DB before we can UPDATE it. `.first()` because
    // estimate lines render twice (card + table view). Was
    // networkidle. AR 2026-08-15.
    await page
        .getByText("Print-leak test — brake pad")
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });

    // Force a known cost onto the line — this is what will snapshot
    // as InvoiceLine.unitCost at invoice generation and feed the
    // profit card's Cost / Gross Profit / Margin numbers.
    const updated = await setEstimateLineCosts(estimateId, KNOWN_COST);
    expect(
        updated,
        "expected exactly one PART line on the seeded estimate",
    ).toBe(1);

    // Send to customer + customer approves + mark tech-complete +
    // generate invoice. Same shape as Flow C.
    await sendEstimateToCustomer(page, estimateId);
    const customerHref = await customerEstimateUrl(estimateId);
    const customerContext = await browser.newContext({
        extraHTTPHeaders: bypassHeaders(),
    });
    try {
        const customerPage = await customerContext.newPage();
        await customerPage.goto(customerHref);
        // Wait for the approve POST response BEFORE the finally-block
        // context close, then assert the specific approved-banner text.
        // See Flow B for the smoke #102 dissection. AR 2026-08-23.
        const responsePromise = customerPage.waitForResponse(
            (r) =>
                r.url() === customerHref &&
                r.request().method() === "POST" &&
                r.status() === 200,
            { timeout: 15_000 },
        );
        await customerPage.click(
            'form:has(input[name="token"]) button:has-text("Approve"), form:has(input[name="token"]) button:has-text("موافق")',
        );
        await responsePromise;
        await expect(
            customerPage
                .getByText(/You approved this estimate|لقد وافقت على هذا التقدير/)
                .first(),
        ).toBeVisible({ timeout: 15_000 });
    } finally {
        await customerContext.close();
    }
    await markJobTechComplete(jobCardId);

    // Generate invoice from the estimate page (owner + master can).
    await page.goto(`/estimates/${estimateId}`);
    await page
        .getByRole("button", { name: /Generate invoice/i })
        .click({ timeout: 15_000 });
    await page.waitForURL(/\/invoices\/[a-z0-9]+/, { timeout: 15_000 });
    const invoiceId =
        page.url().match(/\/invoices\/([a-z0-9]+)/)?.[1] ?? "";
    expect(invoiceId).toMatch(/^[a-z0-9]+$/);

    // ── The actual print-leak assertions ─────────────────────────
    // Playwright's `emulateMedia` turns on the print media query.
    // Every `@media print { … }` rule in the compiled CSS fires —
    // including `.print\:hidden { display: none }` and my
    // `[data-print-omit-cost] { display: none !important }` rule.
    // Same effect as Chrome DevTools' "Emulate CSS media type:
    // print", but scripted + assertable.
    await page.emulateMedia({ media: "print" });
    // Force a reflow so :hover / focus states don't leave stale
    // computed styles from the pre-emulation render.
    await page.evaluate(() => void document.body.offsetHeight);

    // Layer 1 — every forbidden element must be HIDDEN.
    // Playwright's `toBeHidden` returns true iff the element has
    // display:none, visibility:hidden, or is off-screen. Under
    // `emulateMedia({media:"print"})`, print rules apply, so
    // `print:hidden` → display:none → hidden.
    await expect(
        page.getByTestId("job-profit-card"),
        "job profit card must be hidden in print — cost + margin on a customer's printout is the leak",
    ).toBeHidden();

    // Timeline / stepper are section elements with print:hidden on
    // their component root. Match by ARIA / heading rather than
    // testid so the test doesn't depend on component internals.
    await expect(
        page.getByRole("heading", { name: /^Job timeline$/i }),
        "job timeline heading must be hidden in print",
    ).toBeHidden();
    // Workflow stepper renders each step as text; check the first
    // known label. The stepper's own root is print:hidden; if it
    // regressed, this text would still be visible.
    await expect(
        page.getByText("Check-in", { exact: false }).first(),
        "workflow stepper must be hidden in print",
    ).toBeHidden();

    // Add-line + discount editor forms — check the action buttons
    // (labelled "Add line" and "Apply") which are only in those
    // forms; if the wrapper hide regressed, the buttons would
    // resurface.
    await expect(
        page.getByRole("button", { name: /Add line/i }),
        "add-line form must be hidden in print",
    ).toBeHidden();
    // The discount editor has two "Apply" buttons (one for %,
    // one for AED). If the wrapper regressed, the first would
    // become visible.
    const discountApply = page
        .getByRole("button", { name: /^Apply$/i })
        .first();
    await expect(
        discountApply,
        "discount editor must be hidden in print",
    ).toBeHidden();

    // Layer 2 — the visible text under print emulation must not
    // contain any of the forbidden signals. Catches indirect leaks
    // where a hide on one wrapper works but the same content
    // renders somewhere else on the page.
    //
    // Playwright's `innerText` respects computed visibility — text
    // inside display:none / visibility:hidden nodes is excluded.
    // Perfect for "what would actually be visible on the printed
    // page" assertions.
    const printedText = await page.locator("body").innerText();

    expect(
        printedText,
        `the seeded cost value ${KNOWN_COST} must not appear anywhere in the printed page`,
    ).not.toContain(KNOWN_COST);

    // Margin: the profit card renders labels like "Margin" (from
    // t("profitCardMargin")). If ANY margin/gross-profit label
    // survives print, the panel isn't fully hidden.
    expect(
        printedText.toLowerCase(),
        "the word 'margin' must not appear in the printed page (comes from the profit card)",
    ).not.toMatch(/margin/);
    expect(
        printedText.toLowerCase(),
        "the phrase 'gross profit' must not appear in the printed page (comes from the profit card)",
    ).not.toMatch(/gross profit/);

    // "Job timeline" heading — sanity check that the timeline
    // section really isn't rendering.
    expect(
        printedText.toLowerCase(),
        "'job timeline' heading must not appear in the printed page",
    ).not.toMatch(/job timeline/);
});
