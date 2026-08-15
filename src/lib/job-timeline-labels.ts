// Shared label-builder for <JobTimeline /> — keeps every job view's
// labels dictionary in lock-step. Adding a new event key here once
// flows to advisor + technician + cashier surfaces automatically.

import type { MessageKey } from "@/i18n/config";
import type { JobTimelineLabels } from "@/components/job-timeline";

const EVENT_KEYS = [
    "tlVehicleCheckedIn",
    "tlConsentRecorded",
    "tlClaimedByTech",
    "tlPhotoLogged",
    "tlVoiceLogged",
    "tlPartRequested",
    "tlFindingsSubmitted",
    "tlSentForEstimate",
    "tlSentForReestimate",
    "tlEstimateCreated",
    "tlEstimateSent",
    // tlEstimateDelivered added AR 2026-08-15 as the estimate-side
    // mirror of tlInvoiceDelivered. Dormant until a Cloud API webhook
    // writes Estimate.deliveredAt; the job-timeline builder in
    // src/lib/job-timeline.ts will start emitting the event as soon
    // as the column is populated.
    "tlEstimateDelivered",
    "tlEstimateApproved",
    "tlWorkCompleted",
    "tlQcPassed",
    "tlInvoiceIssued",
    "tlInvoiceSent",
    "tlInvoiceDelivered",
    "tlAdvancePayment",
    "tlPaymentRecorded",
    "tlDelivered",
    "tlCollectionConfirmed",
] as const;

export function buildTimelineLabels(
    t: (k: MessageKey) => string,
): JobTimelineLabels {
    const events: Record<string, string> = {};
    for (const k of EVENT_KEYS) events[k] = t(k as MessageKey);
    return {
        title: t("tlTitle"),
        unknownActor: t("tlNoActor"),
        today: t("tlToday"),
        events,
        role: {
            ADVISOR: t("tlRole_ADVISOR"),
            TECH: t("tlRole_TECH"),
            CASHIER: t("tlRole_CASHIER"),
            OWNER: t("tlRole_OWNER"),
        },
    };
}
