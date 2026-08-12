import { test, expect } from "@playwright/test";
import { storageStatePath } from "../support/roles";
import { bookManualIntake } from "../support/flows";

/**
 * Flow A — Intake creates a job.
 *
 * Advisor books a new car via the MANUAL intake path (skips Moulkia
 * OCR, which needs a real photo + Anthropic API). Fills the required
 * fields with unique-per-run values, submits, asserts the resulting
 * job card page shows the plate we typed.
 *
 * File location: this file is under tests/smoke/flows/, so if it
 * retries-to-pass on CI, the flake reporter emits a ::warning::
 * commit annotation. Money-adjacent flows warrant that noise.
 */

test.use({ storageState: storageStatePath("advisor") });

test("Flow A — advisor books a new job via manual intake", async ({ page }) => {
    const { jobCardId, plate } = await bookManualIntake(page, "A");

    // Landing page is /advisor/jobs/<jobCardId> and shows the plate.
    // Case-insensitive to survive the app's uppercase-on-save
    // convention.
    expect(jobCardId).toMatch(/^[a-z0-9]+$/);
    const body = await page.locator("body").innerText();
    expect(body.toLowerCase()).toContain(plate.toLowerCase());
});
