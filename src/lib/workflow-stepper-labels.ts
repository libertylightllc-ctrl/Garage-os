// Shared label-builder for <WorkflowStepper /> — keeps the 4 job views
// (advisor / technician / cashier estimate / cashier invoice) in lock-
// step so any future stage-rename touches one place.

import type { MessageKey } from "@/i18n/config";
import type { WorkflowStepperLabels } from "@/components/workflow-stepper";

export function buildStepperLabels(
    t: (k: MessageKey) => string,
): WorkflowStepperLabels {
    return {
        stages: {
            CHECK_IN: t("stage_CHECK_IN"),
            DIAGNOSIS: t("stage_DIAGNOSIS"),
            ESTIMATE: t("stage_ESTIMATE"),
            APPROVAL: t("stage_APPROVAL"),
            REPAIR: t("stage_REPAIR"),
            COMPLETE: t("stage_COMPLETE"),
            INVOICE: t("stage_INVOICE"),
            PAID: t("stage_PAID"),
            DELIVERED: t("stage_DELIVERED"),
        },
        cancelled: t("workflowCancelled"),
        pausedPrefix: t("workflowPaused"),
        holdReasons: {
            AWAITING_PART: t("hrAwaitingPart"),
            AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
            AWAITING_APPROVAL: t("hrAwaitingApproval"),
            OTHER: t("hrOther"),
        },
    };
}
