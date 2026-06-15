import type { MessageKey } from "@/i18n/config";
import { durationBetween, elapsedSince } from "@/lib/duration";

interface Props {
    /** When the technician claimed the job. */
    claimedAt: Date | null;
    /** When the technician tapped 'Send for Estimate' (end of diagnosis). */
    sentForEstimateAt: Date | null;
    /** When the cashier flipped the estimate to SENT (end of pricing). */
    estimateSentAt: Date | null;
    /** Server-side 'now' for in-progress durations. Passed in to keep the
      *  component server-rendered without a client clock. */
    now: Date;
    /** i18n getter, passed in to keep this component dependency-free. */
    t: (k: MessageKey) => string;
    /** Compact (one row) vs. expanded (each duration on its own row). */
    variant?: "inline" | "stacked";
}

/**
  * The two workflow durations the user asked for, rendered as captions
  * under each job row. Shows finished durations as a static number, and
  * still-running stages with 'so far' wording so the advisor / tech /
  * cashier all see the same numbers.
  *
  *   Diagnosis: 12m              ← claim → send-for-estimate, finished
  *   Diagnosis: 5m so far        ← claimed but still diagnosing
  *   Pricing:   8m               ← send-for-estimate → estimate-sent, finished
  *   Pricing:   3m so far        ← cashier is still pricing
  *
  * Returns null when neither stage has started (so the row stays clean).
  */
export function JobTimings({
    claimedAt,
    sentForEstimateAt,
    estimateSentAt,
    now,
    t,
    variant = "inline",
}: Props) {
    // ---- Diagnosis window ----
    let diagnosis = "";
    if (claimedAt && sentForEstimateAt) {
        diagnosis = durationBetween(claimedAt, sentForEstimateAt);
    } else if (claimedAt) {
        const d = elapsedSince(claimedAt, now);
        if (d) diagnosis = `${d} ${t("durSoFar")}`;
    }

    // ---- Pricing window ----
    let pricing = "";
    if (sentForEstimateAt && estimateSentAt) {
        pricing = durationBetween(sentForEstimateAt, estimateSentAt);
    } else if (sentForEstimateAt) {
        const d = elapsedSince(sentForEstimateAt, now);
        if (d) pricing = `${d} ${t("durSoFar")}`;
    }

    if (!diagnosis && !pricing) return null;

    const sep = variant === "inline" ? " · " : null;
    return variant === "inline" ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {diagnosis ? (
                <>
                    <span className="font-medium">{t("durDiagnosis")}:</span> {diagnosis}
                </>
            ) : null}
            {diagnosis && pricing ? sep : null}
            {pricing ? (
                <>
                    <span className="font-medium">{t("durPricing")}:</span> {pricing}
                </>
            ) : null}
        </span>
    ) : (
        <div className="flex flex-col gap-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {diagnosis ? (
                <span>
                    <span className="font-medium">{t("durDiagnosis")}:</span> {diagnosis}
                </span>
            ) : null}
            {pricing ? (
                <span>
                    <span className="font-medium">{t("durPricing")}:</span> {pricing}
                </span>
            ) : null}
        </div>
    );
}
