import type { Page } from "@playwright/test";
import { smokeCustomerName, smokePhone, smokePlate } from "./unique-id";

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
    await page.check('input[name="consent"]');
    await page.click('button[type="submit"]');

    // Server action redirects to /advisor/jobs/<id> on success.
    await page.waitForURL(/\/advisor\/jobs\/[a-z0-9]+$/, { timeout: 15_000 });
    const url = page.url();
    const jobCardId = url.match(/\/advisor\/jobs\/([a-z0-9]+)$/)?.[1] ?? "";
    if (!jobCardId) throw new Error(`Could not extract jobCardId from ${url}`);
    return { jobCardId, plate };
}
