import {
    WORKFLOW_STAGES,
    type WorkflowStageKey,
    type WorkflowState,
} from "@/lib/workflow-stage";

/**
 * Horizontal progress stepper rendered on every single-job page
 * (advisor / technician / cashier estimate + invoice). Pure-render
 * server component — no client JS, all data is derived from the
 * caller-supplied WorkflowState on every render.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ [✓ CHECK-IN]─[✓ DIAG]─[✓ EST]─[⏳ APPROVAL]─[ REPAIR]─[ ... ]│
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Mobile: the outer container is overflow-x-auto and each step is
 * shrink-0, so phones can scroll the bar horizontally instead of
 * overflowing the page layout. No horizontal scrollbar on the page
 * itself.
 *
 * Cancelled / on-hold edge cases:
 *   - CANCELLED → every step muted, an em-dash "Job cancelled" caption
 *     replaces the active highlight.
 *   - ON_HOLD → the current step still highlights, plus an amber
 *     "paused" pill below the bar with the hold reason.
 */
export interface WorkflowStepperLabels {
    /** stage_<KEY> for the 9 stages, e.g. labels.stage_CHECK_IN. */
    stages: Record<WorkflowStageKey, string>;
    /** "Job cancelled" caption shown when state.isCancelled. */
    cancelled: string;
    /** "Paused" pill prefix. */
    pausedPrefix: string;
    /** Hold-reason translations — passed through as-is when the
     *  caller wants a localised "Waiting for part" etc. */
    holdReasons: Record<string, string>;
}

interface Props {
    state: WorkflowState;
    labels: WorkflowStepperLabels;
}

const CONNECTOR_DONE = "bg-success-500/60";
const CONNECTOR_PENDING = "bg-border";

const STEP_DONE =
    "bg-success-500 text-white border-success-500";
const STEP_CURRENT =
    "bg-accent-500 text-brand-900 border-accent-500 ring-2 ring-accent-500/40 animate-pulse";
const STEP_PENDING =
    "bg-surface-2 text-text-mute border-border";
const STEP_CANCELLED =
    "bg-surface-2 text-text-mute border-border opacity-60";

const LABEL_DONE = "text-text font-medium";
const LABEL_CURRENT = "text-brand-900 dark:text-accent-500 font-semibold";
const LABEL_PENDING = "text-text-mute";

export function WorkflowStepper({ state, labels }: Props) {
    const { currentIndex, isCancelled, heldReason } = state;
    const holdLabel =
        heldReason ? labels.holdReasons[heldReason] ?? heldReason : null;

    return (
        // print:hidden — the workflow stepper is an INTERNAL
        // progress indicator (Check-in → Diagnosis → Estimate → …).
        // Customers don't need it on printed invoices/estimates, and
        // it eats ~66px per doc which was pushing normal print onto
        // a second A4 page. Component-level hide covers every
        // embedding (invoice edit, estimate edit — plus any future
        // ones automatically). AR 2026-08-14.
        <section className="flex flex-col gap-2 print:hidden">
            {/* Bar — scrolls horizontally on mobile; each item is
                shrink-0 so the row width is the natural sum of all 9
                steps, NOT the parent width. The outer container handles
                the scroll wrapper visually. */}
            <ol className="-mx-1 flex items-start gap-0 overflow-x-auto px-1 pb-2">
                {WORKFLOW_STAGES.map((stage, i) => {
                    const isDone = !isCancelled && i < currentIndex;
                    const isCurrent = !isCancelled && i === currentIndex;

                    const stepClass = isCancelled
                        ? STEP_CANCELLED
                        : isDone
                            ? STEP_DONE
                            : isCurrent
                                ? STEP_CURRENT
                                : STEP_PENDING;
                    const labelClass = isCancelled
                        ? LABEL_PENDING
                        : isDone
                            ? LABEL_DONE
                            : isCurrent
                                ? LABEL_CURRENT
                                : LABEL_PENDING;
                    const connectorClass = isDone ? CONNECTOR_DONE : CONNECTOR_PENDING;

                    const indicator = isDone ? "✓" : isCurrent ? "⏳" : String(i + 1);

                    return (
                        <li
                            key={stage}
                            className="flex shrink-0 items-start gap-0"
                            aria-current={isCurrent ? "step" : undefined}
                        >
                            <div className="flex w-14 flex-col items-center gap-1 px-0.5">
                                <span
                                    className={`inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold ${stepClass}`}
                                >
                                    {indicator}
                                </span>
                                <span className={`whitespace-nowrap text-[9px] uppercase tracking-wide ${labelClass}`}>
                                    {labels.stages[stage]}
                                </span>
                            </div>
                            {i < WORKFLOW_STAGES.length - 1 ? (
                                <span
                                    aria-hidden="true"
                                    className={`mt-3.5 h-0.5 w-2 shrink-0 ${connectorClass}`}
                                />
                            ) : null}
                        </li>
                    );
                })}
            </ol>

            {/* Edge-case captions */}
            {isCancelled ? (
                <p className="text-xs font-medium text-danger-700 dark:text-danger-500">
                    ⚠ {labels.cancelled}
                </p>
            ) : holdLabel ? (
                <p className="inline-flex items-center gap-1 self-start rounded-full border border-warning-500/40 bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                    ⏸ {labels.pausedPrefix}: {holdLabel}
                </p>
            ) : null}
        </section>
    );
}
