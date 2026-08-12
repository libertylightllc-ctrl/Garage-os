import type {
    Reporter,
    TestCase,
    TestResult,
    FullResult,
} from "@playwright/test/reporter";
import fs from "node:fs";
import path from "node:path";

/**
 * Custom reporter — surfaces flakes where a human will actually see them.
 *
 * Two channels, together:
 *
 *   1. `$GITHUB_STEP_SUMMARY` — a markdown block at the very top of the
 *      run's job page. First line reads either:
 *        ✅ Smoke tests — all N tests passed on first attempt.
 *        ⚠️ Smoke tests — X tests passed on retry: <names>. Investigate.
 *      No clicking, no artifact opening. Visible on the run page.
 *
 *   2. `::warning file=...::` GitHub workflow commands — annotate the
 *      COMMIT (and any PR touching that commit) when a test under
 *      `tests/smoke/flows/` needed a retry. Flow specs are the four
 *      money-adjacent flows (intake, estimate approval, invoice, RFQ);
 *      a retry there is worth interrupting the reviewer for. Role
 *      page-load retries stay in the summary only.
 *
 * A retry-to-pass still counts as a pass for the gate. This reporter
 * only surfaces them — it does not fail. The gate blocks on tests
 * that fail all attempts.
 */
export default class FlakeReporter implements Reporter {
    private flakes: Array<{
        title: string;
        file: string;
        attempts: number;
        isFlow: boolean;
    }> = [];
    private passedFirstTry = 0;
    private hardFailures: string[] = [];

    onTestEnd(test: TestCase, result: TestResult) {
        if (result.status === "passed" && result.retry === 0) {
            this.passedFirstTry += 1;
            return;
        }
        if (result.status === "passed" && result.retry > 0) {
            const relFile = path.relative(process.cwd(), test.location.file);
            const isFlow = relFile.replace(/\\/g, "/").includes("tests/smoke/flows/");
            this.flakes.push({
                title: test.title,
                file: relFile,
                attempts: result.retry + 1,
                isFlow,
            });
            // Flow retries also get a commit annotation. GitHub renders
            // ::warning:: as a yellow banner on the commit page + on
            // any PR the commit is part of. Role page-load retries
            // stay in the summary block only to keep the signal-to-noise
            // reasonable.
            if (isFlow && process.env.GITHUB_ACTIONS) {
                const line = test.location.line || 1;
                const msg = `Smoke flow "${test.title}" retried and passed (attempt ${result.retry + 1}). Quotation/invoice flow is flaking — investigate before it becomes a hard failure.`;
                console.log(
                    `::warning file=${relFile.replace(/\\/g, "/")},line=${line}::${msg}`,
                );
            }
            return;
        }
        if (result.status === "failed" || result.status === "timedOut") {
            // Only the LAST attempt counts as a hard failure for the
            // job outcome; Playwright will still retry. We flag it
            // here so the summary block accurately counts hard fails
            // (even though the workflow exit code is Playwright's
            // authoritative signal).
            if (result.retry === test.retries) {
                this.hardFailures.push(test.title);
            }
        }
    }

    async onEnd(result: FullResult) {
        const summaryPath = process.env.GITHUB_STEP_SUMMARY;
        if (!summaryPath) return; // local run — no-op; list reporter has the detail.

        const total = this.passedFirstTry + this.flakes.length + this.hardFailures.length;
        const lines: string[] = [];

        if (result.status === "failed") {
            lines.push(
                `### ❌ Smoke tests — ${this.hardFailures.length} hard failure(s). Promotion is blocked.`,
            );
            for (const t of this.hardFailures) {
                lines.push(`- ${t}`);
            }
            lines.push("");
        } else if (this.flakes.length > 0) {
            const names = this.flakes.map((f) => `\`${f.title}\``).join(", ");
            lines.push(
                `### ⚠️ Smoke tests — ${this.flakes.length} test(s) passed on retry: ${names}. Investigate before this becomes a hard failure.`,
            );
        } else {
            lines.push(
                `### ✅ Smoke tests — all ${total} tests passed on first attempt.`,
            );
        }

        if (this.flakes.length > 0) {
            lines.push("");
            lines.push("| Test | File | Attempts | Flow? |");
            lines.push("|---|---|---|---|");
            for (const f of this.flakes) {
                lines.push(
                    `| ${f.title} | ${f.file} | ${f.attempts} | ${f.isFlow ? "✅ flow (annotated)" : "role page-load"} |`,
                );
            }
        }

        lines.push("");
        try {
            fs.appendFileSync(summaryPath, lines.join("\n") + "\n");
        } catch {
            // Summary file write failures are not worth failing the
            // run over — the raw stdout is preserved regardless.
        }
    }
}
