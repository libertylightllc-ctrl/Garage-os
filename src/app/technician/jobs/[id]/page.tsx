import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { addStepAction } from "@/app/actions/techsteps";
import { requestPartAction } from "@/app/actions/parts";
import {
  leaveHelperAction,
  addExtraJobPartAction,
  removeExtraJobPartAction,
  sendForReestimateAction,
  // sendForEstimateAction is the same action that drives the home-page
  // 'Send for Estimate' button — wiring it here too keeps the detail
  // page and home page on a single path. It only requires the tech to
  // be the claimer + the job to be in a pre-estimate stage; no
  // findings text required.
  sendForEstimateAction,
  // markCompleteAction is the workflow-completing action: flips
  // status to TECH_COMPLETE, sets workCompletedAt, and revalidates
  // the cashier dashboard so the job hops over to 'Awaiting final
  // invoice'. Per spec the dashboard no longer has a Finish button —
  // the tech taps Mark Complete on this page instead.
  markCompleteAction,
} from "@/app/actions/jobs";
import {
  saveFindingsAction,
  addRequiredPartAction,
  removeJobPartAction,
  saveWorkNotesAction,
  addUsedPartAction,
  removeUsedPartAction,
  signOffQcAction,
} from "@/app/actions/techfindings";
import { repairUnlocked } from "@/lib/jobfindings";
import { QC_CHECKS, qcSignedOff, formatVehicleSpec } from "@/lib/jobcard-fields";
import { AppNav } from "@/components/app-nav";
import { getLocale, getT } from "@/i18n/server";
import { partStatusKey } from "@/i18n/config";
import type { MessageKey } from "@/i18n/config";
import { DictateInput, DictateTextarea } from "@/components/dictate";
import { PhotoCapture } from "@/components/photo-capture";

export const dynamic ="force-dynamic";

const STEP_ICON: Record<string, string> = {
  PHOTO:"📷",
  VOICE:"🎤",
  PART_REQUEST:"📦",
  FINISH:"✅",
};

export default async function Workshop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireRole("TECH");

  const t = await getT();
  const locale = await getLocale();
  const dictLabels = {
    start: t("dictateStart"),
    stop: t("dictateStop"),
    listening: t("dictateListening"),
    error: t("dictateError"),
  };
  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      vehicle: true,
      steps: { orderBy: { createdAt:"desc"} },
      partRequests: { orderBy: { createdAt:"desc"} },
      helpers: { include: { tech: { select: { id: true, name: true } } } },
      finding: true,
      jobParts: { orderBy: { createdAt:"asc"} },
      estimates: {
        where: { status:"APPROVED"},
        // approvedAt is the cutoff for 'work proof' — any photo, voice
        // note, or finding edit AFTER that timestamp counts as evidence
        // that the tech has actually started the repair, vs. just
        // landing on the page right after the customer approved.
        select: { id: true, approvedAt: true },
        orderBy: { approvedAt:"desc"},
        take: 1,
      },
      qcBy: { select: { name: true } },
      // invoices include removed — the terminal-state banner that
      // referenced it was deleted per spec. Terminal-state jobs now
      // redirect off this route entirely.
    },
  });
  if (!job) notFound();

  // Per spec: finished jobs are not the technician's concern. If the
  // job has moved past TECH_COMPLETE — INVOICED, DELIVERED, or
  // CANCELLED — kick the tech back to the workshop list rather than
  // rendering a 'job complete' read-only view. This complements the
  // dashboard query exclusions (same four statuses) so a stale link
  // or browser back-button can't surface a finished car here either.
  if (
    job.status ==="INVOICED"||
    job.status ==="DELIVERED"||
    job.status ==="CANCELLED"
  ) {
    redirect("/technician");
  }

  const me = session.user.id;
  const amHelper = job.claimedById !== null && job.claimedById !== me && job.helpers.some((h) => h.techId === me);
  const submitted = Boolean(job.finding?.submittedAt);
  const requiredParts = job.jobParts.filter((p) => p.kind ==="REQUIRED");
  const usedParts = job.jobParts.filter((p) => p.kind ==="USED");
  const extraParts = job.jobParts.filter((p) => p.kind ==="EXTRA");
  // Tech can add/manage EXTRA items only during the work-in-progress
  // window. After Send-for-Approval flips the status, items are owned by
  // the cashier (as estimate lines) and no longer editable here.
  const canManageExtras = job.status ==="APPROVED"|| job.status ==="REPAIR";
  const hasApprovedEstimate = job.estimates.length > 0;
  const repairOpen = repairUnlocked(hasApprovedEstimate, job.workCompletedAt);

  // Mark Complete gate per spec: the button only appears after the
  // technician has actually done something on the car post-approval.
  // 'Something' = at least one new PHOTO step, VOICE step, or finding
  // edit after the customer-approval cutoff. Until then we render a
  // 'Begin your work' caption instead of the green CTA, so a tap-
  // before-touch is impossible.
  //
  // approvedAt is the cutoff. If no estimate has been approved yet
  // (shouldn't happen at APPROVED/REPAIR status, but defending), we
  // treat work proof as absent → no button.
  const approvedAt = job.estimates[0]?.approvedAt ?? null;
  const photoOrVoiceAfterApproval = approvedAt
    ? job.steps.some(
        (s) =>
          (s.type ==="PHOTO"|| s.type ==="VOICE") &&
          s.createdAt > approvedAt,
      )
    : false;
  const findingTouchedAfterApproval = Boolean(
    approvedAt &&
      job.finding &&
      job.finding.updatedAt > approvedAt &&
      (job.finding.findings?.trim().length ?? 0) > 0,
  );
  const hasWorkProof =
    photoOrVoiceAfterApproval || findingTouchedAfterApproval;

  const parts = await prisma.part.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { name:"asc"},
  });

  const bigBtn =
  "flex flex-col items-center justify-center gap-1 rounded-2xl border border-border p-6 text-center text-base font-medium hover:bg-surface-2 transition-colors";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop"/>
      <div>
        <Link href="/technician" className="text-sm text-text-mute hover:underline">
          {t("backWorkshop")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-text-mute">{job.vehicle.plate}</p>
        {/* Full vehicle spec one-liner — "Toyota Prado 2014 · 2.7 · Petrol".
            Lets the technician glance at the right part-spec without
            digging into the job card. The same line repeats below next
            to every part request so the tech / parts supplier sees it
            wherever a part is mentioned. */}
        {formatVehicleSpec(job.vehicle).length > 0 ? (
          <p className="mt-1 inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-text">
            🔧 {formatVehicleSpec(job.vehicle)}
          </p>
        ) : null}
        {job.helpers.length > 0 ? (
          <p className="mt-1 text-xs text-text-mute">
            {t("helpersLabel")}: {job.helpers.map((h) => h.tech.name).join(",")}
          </p>
        ) : null}
        {amHelper ? (
          <form action={leaveHelperAction} className="mt-1">
            <input type="hidden" name="jobId" value={job.id} />
            <button className="text-xs text-text-mute underline hover:text-zinc-700 dark:text-text-mute">
              {t("leaveJob")}
            </button>
          </form>
        ) : null}
      </div>

      {/* Status banner — reads LIVE job.status and tells the technician
          where the job is in the workflow at this moment, with the
          appropriate next-step CTA. Per spec the banner must update
          when the cashier/customer move the job forward, so the tech
          isn't left looking at a stale 'sent for estimate' message
          after the customer has already approved.

          Three states get a dedicated banner; everything else (ARRIVED,
          INSPECTION, EXTRA_WORK_AWAITING_APPROVAL, INVOICED…) falls
          through to the existing sections below, which already explain
          themselves contextually. */}
      {job.status ==="ESTIMATE"? (
        // Tech sent for estimate; cashier owns the next step.
        <section className="rounded-xl border border-info-500/40 bg-info-50 p-6 text-center dark:border-info-500/30 dark:bg-info-500/10">
          <div className="text-4xl">💸</div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">
            {t("sentToCashierTitle")}
          </h2>
          <p className="mt-1 text-sm text-text">
            {t("sentToCashierSubtitle")}
          </p>
        </section>
      ) : job.status ==="APPROVED"|| job.status ==="REPAIR"? (
        // Customer approved → tech does the actual work. CTA: Mark
        // Complete, BUT only after the tech has actually started
        // working — at least one photo, voice note, or finding edit
        // logged after the estimate-approval cutoff. Before that, we
        // show a 'Begin your work' caption so the button can't be
        // tapped before the car has been touched.
        //
        // The same action stays wired further down in the Repair
        // section (gated on repairOpen) for cases where the tech has
        // scrolled past the banner — that gate already requires
        // hasApprovedEstimate, so it ALSO won't show prematurely, but
        // we additionally gate it on hasWorkProof below to keep both
        // surfaces in sync.
        <section className="rounded-xl border border-success-500/40 bg-success-50 p-6 text-center dark:border-success-500/30 dark:bg-success-500/10">
          <div className="text-4xl">🔧</div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">
            {t("jobApprovedStartWorkTitle")}
          </h2>
          <p className="mt-1 text-sm text-text">
            {t("jobApprovedStartWorkSubtitle")}
          </p>
          {!amHelper && hasWorkProof ? (
            <form action={markCompleteAction} className="mt-4">
              <input type="hidden" name="jobId" value={job.id} />
              <button
                type="submit"
                className="inline-flex h-12 items-center justify-center rounded-lg px-5 text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
              >
                {t("markComplete")}
              </button>
            </form>
          ) : !amHelper ? (
            // Pre-work-proof state. Surfaces clearly what counts as
            // 'work has started' so the tech knows what to do next
            // (snap a photo, hit Save on findings, etc.) and doesn't
            // think the page is broken because the button is missing.
            <p className="mt-3 inline-block rounded-xl border border-success-500/40 bg-success-50 px-3 py-2 text-xs text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
              ⏳ {t("beginYourWorkHint")}
            </p>
          ) : null}
        </section>
      ) : job.status ==="TECH_COMPLETE"? (
        // Tech tapped Mark Complete; cashier owns the next step
        // (invoice prep + send). No actions here — read-only banner so
        // the tech can confirm the handoff went through.
        <section className="rounded-xl border border-info-500/40 bg-info-50 p-6 text-center dark:border-info-500/30 dark:bg-info-500/10">
          <div className="text-4xl">🧾</div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">
            {t("sentToCashierForInvoiceTitle")}
          </h2>
          <p className="mt-1 text-sm text-text">
            {t("sentToCashierForInvoiceSubtitle")}
          </p>
        </section>
      ) : null}
      {/* Terminal-state banners (INVOICED / DELIVERED / CANCELLED)
          removed per spec — the redirect at the top of this page now
          sends a tech off the route entirely if the job is past
          TECH_COMPLETE, so 'Job complete — no further action needed'
          and 'This job was cancelled' are no longer reachable here. */}

      {job.status ==="ON_HOLD"&& job.holdReason ? (
        <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-2.5 text-sm text-warning-600 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
          🟡 {t("onHold")}:{""}
          {(
            {
              AWAITING_PART: t("hrAwaitingPart"),
              AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
              AWAITING_APPROVAL: t("hrAwaitingApproval"),
              OTHER: t("hrOther"),
            } as Record<string, string>
          )[job.holdReason]}
          {job.holdNote ? ` — ${job.holdNote}` :""}
        </p>
      ) : null}

      {/* Customer complaint (from reception) */}
      {job.complaint ? (
        <div className="rounded-lg border border-border p-3 text-sm">
          <div className="text-xs text-text-mute">{t("complaintFromReception")}</div>
          <p>{job.complaint}</p>
          {job.mileageIn ? (
            <p className="mt-1 text-xs text-text-mute">
              {t("mileageInLabel")}: {job.mileageIn}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Findings & diagnosis + parts required (Job-Card-Data-Model.md) */}
      <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("jcFindings")}</h2>
          {submitted ? (
            <span className="text-xs text-success-700 dark:text-success-500">
              ✅ {t("submittedToCashier")} · {job.finding!.submittedAt!.toISOString().slice(0, 16).replace("T","")}
            </span>
          ) : null}
        </div>

        {submitted ? (
          <div className="text-sm">
            <p>{job.finding?.findings}</p>
            {job.finding?.diagnosis ? (
              <p className="mt-1 text-text">{job.finding.diagnosis}</p>
            ) : null}
            <p className="mt-1 text-xs text-text-mute">{t("findingsLocked")}</p>
          </div>
        ) : (
          <form action={saveFindingsAction} className="flex flex-col gap-2">
            <input type="hidden" name="jobId" value={job.id} />
            <DictateTextarea
              locale={locale}
              labels={dictLabels}
              name="findings"
              defaultValue={job.finding?.findings ?? ""}
              rows={3}
              placeholder={t("findingsLabel")}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 pr-10 text-sm"
            />
            <DictateTextarea
              locale={locale}
              labels={dictLabels}
              name="diagnosis"
              defaultValue={job.finding?.diagnosis ?? ""}
              rows={2}
              placeholder={t("diagnosisLabel")}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1 pr-10 text-sm"
            />
            <button className="self-start inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors transition-colors">
              {t("saveDraft")}
            </button>
          </form>
        )}

        {/* Parts required */}
        <h3 className="text-xs font-medium text-text">{t("partsRequired")}</h3>
        {requiredParts.length === 0 ? (
          <p className="text-sm text-text-mute">{t("noPartsRequired")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {requiredParts.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-md border border-border p-2"
              >
                <span>
                  {p.partNo ? <span className="text-text-mute">{p.partNo} </span> : null}
                  {p.description} <span className="text-text-mute">×{p.qty}</span>
                </span>
                {!submitted ? (
                  <form action={removeJobPartAction}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="partLineId" value={p.id} />
                    <button className="text-red-600">✕</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* Add Parts form — only available during the diagnosis stage so
            the tech can build up the required-parts list before sending
            for estimate. Once sendForEstimateAction flips the status to
            ESTIMATE, the form disappears (further changes need to go
            through the Extras / re-estimate flow instead). */}
        {job.status ==="ARRIVED"|| job.status ==="INSPECTION"? (
          <form action={addRequiredPartAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="jobId" value={job.id} />
            <select
              name="partId"
              defaultValue=""
              className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              <option value="">{t("catalogPartOptional")}</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              name="partNo"
              placeholder={t("partNoLabel")}
              className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <DictateInput
              locale={locale}
              labels={dictLabels}
              name="description"
              placeholder={t("colDescription")}
              className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <input
              name="qty"
              type="number"
              min="1"
              defaultValue="1"
              aria-label={t("colQty")}
              className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors transition-colors">
              {t("addPartLine")}
            </button>
          </form>
        ) : null}

        <p className="text-xs text-text-mute">📷 {t("photographDamaged")}</p>

        {/* 'Send to Cashier for Estimate' button — Per spec, this appears
            once the tech has at least one Required part listed. The button
            fires sendForEstimateAction (NOT submitFindingsAction): no
            findings text is required, status flips ARRIVED/INSPECTION →
            ESTIMATE, sentForEstimateAt is stamped, and the tech is
            redirected to the /sent-to-cashier confirmation page so they
            see"Job sent to cashier for estimate"before going back to
            the workshop list. Hidden once the job has already left the
            diagnosis stage, and for helpers (only the claimer can send). */}
        {requiredParts.length > 0 &&
        !amHelper &&
        (job.status ==="ARRIVED"|| job.status ==="INSPECTION") ? (
          <form action={sendForEstimateAction}>
            <input type="hidden" name="jobId" value={job.id} />
            <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("submitToCashier")}
            </button>
          </form>
        ) : null}
      </div>

      {/* Extras — tech adds parts/issues found mid-job while doing the
          approved work. Each item lives as a JobPart(kind=EXTRA) until
          'Send for Approval' rolls them into a new draft Estimate. Only
          shown while status is APPROVED / REPAIR (active work window). */}
      {canManageExtras ? (
        <div className="flex flex-col gap-3 rounded-xl border border-danger-500/40 bg-danger-50 p-4 dark:border-danger-500/30 dark:bg-danger-500/10">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("extrasPanelTitle")}</h2>
            {extraParts.length > 0 ? (
              <span className="inline-flex items-center rounded-full bg-danger-600 px-2 py-0.5 text-xs font-semibold text-white">
                {extraParts.length}
              </span>
            ) : null}
          </div>

          {extraParts.length === 0 ? (
            <p className="text-sm text-text">
              {t("extrasPanelEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {extraParts.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-lg border border-danger-500/30 bg-surface p-2"
                >
                  <span>
                    {p.partNo ? (
                      <span className="text-text-mute">{p.partNo} </span>
                    ) : null}
                    {p.description}{""}
                    <span className="text-text-mute">×{p.qty}</span>
                  </span>
                  <form action={removeExtraJobPartAction}>
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="jobPartId" value={p.id} />
                    <button className="text-red-600" aria-label={t("extrasRemove")}>
                      ✕
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          {/* Add an extra item — description required, qty default 1.
              Cashier owns pricing, tech just specifies the what. */}
          <form action={addExtraJobPartAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="jobId" value={job.id} />
            <input
              name="partNo"
              placeholder={t("partNoLabel")}
              className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <DictateInput
              locale={locale}
              labels={dictLabels}
              name="description"
              placeholder={t("extrasDescriptionPlaceholder")}
              required
              className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <input
              name="qty"
              type="number"
              min="1"
              defaultValue="1"
              aria-label={t("colQty")}
              className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <button className="inline-flex h-8 items-center justify-center rounded-lg border border-danger-500/40 bg-transparent px-3 text-xs font-semibold text-danger-700 hover:bg-danger-50 transition-colors dark:text-danger-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("extrasAdd")}
            </button>
          </form>

          {/* The Send-for-Approval button lives down here as well as on
              the dashboard — handy for the tech who's already on the
              detail page reviewing what they added. */}
          {extraParts.length > 0 ? (
            <form action={sendForReestimateAction} className="self-start">
              <input type="hidden" name="jobId" value={job.id} />
              <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-danger-600 text-white hover:bg-danger-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                {t("extrasSendForApproval").replace("{count}", String(extraParts.length))}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* Repair — work completed & parts used (after Approval #1) */}
      {hasApprovedEstimate ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("jcRepair")}</h2>
            {job.workCompletedAt ? (
              <span className="text-xs text-success-700 dark:text-success-500">
                ✅ {t("workCompletedBadge")} · {job.workCompletedAt.toISOString().slice(0, 16).replace("T","")}
              </span>
            ) : null}
          </div>

          {repairOpen ? (
            <form action={saveWorkNotesAction} className="flex flex-col gap-2">
              <input type="hidden" name="jobId" value={job.id} />
              <DictateTextarea
                locale={locale}
                labels={dictLabels}
                name="workNotes"
                defaultValue={job.workNotes ?? ""}
                rows={2}
                placeholder={t("workNotesLabel")}
                className="w-full rounded-md border border-border bg-transparent px-2 py-1 pr-10 text-sm"
              />
              <button className="self-start inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors transition-colors">
                {t("saveDraft")}
              </button>
            </form>
          ) : (
            <div className="text-sm">
              {job.workNotes ? <p>{job.workNotes}</p> : null}
              <p className="mt-1 text-xs text-text-mute">{t("repairLockedNote")}</p>
            </div>
          )}

          {/* Parts used */}
          <h3 className="text-xs font-medium text-text">{t("partsUsed")}</h3>
          {usedParts.length === 0 ? (
            <p className="text-sm text-text-mute">{t("noPartsUsed")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {usedParts.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-border p-2"
                >
                  <span>
                    {p.partNo ? <span className="text-text-mute">{p.partNo} </span> : null}
                    {p.description} <span className="text-text-mute">×{p.qty}</span>
                  </span>
                  {repairOpen ? (
                    <form action={removeUsedPartAction}>
                      <input type="hidden" name="jobId" value={job.id} />
                      <input type="hidden" name="partLineId" value={p.id} />
                      <button className="text-red-600">✕</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {repairOpen ? (
            <>
              <form action={addUsedPartAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="jobId" value={job.id} />
                <select
                  name="partId"
                  defaultValue=""
                  className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                >
                  <option value="">{t("catalogPartOptional")}</option>
                  {parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  name="partNo"
                  placeholder={t("partNoLabel")}
                  className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
                <DictateInput
                  locale={locale}
                  labels={dictLabels}
                  name="description"
                  placeholder={t("colDescription")}
                  className="flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
                <input
                  name="qty"
                  type="number"
                  min="1"
                  defaultValue="1"
                  aria-label={t("colQty")}
                  className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                />
                <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors transition-colors">
                  {t("addPartLine")}
                </button>
              </form>

              {/* 'Mark Complete' — moved from the tech home page per
                  spec. Fires markCompleteAction which flips status to
                  TECH_COMPLETE, stamps workCompletedAt, revalidates
                  the cashier dashboard, and redirects to the
                  /marked-complete confirmation page. The job
                  disappears from the technician dashboard immediately
                  (mine query excludes TECH_COMPLETE) and shows up on
                  the cashier dashboard under 'Awaiting final invoice'.
                  Gated on hasWorkProof so it can't be tapped before
                  the tech has actually started working — same gate as
                  the banner CTA above, keeps both surfaces consistent. */}
              {hasWorkProof ? (
                <form action={markCompleteAction}>
                  <input type="hidden" name="jobId" value={job.id} />
                  <button className="inline-flex h-10 items-center justify-center rounded-lg bg-accent-500 px-4 text-sm font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                    {t("markComplete")}
                  </button>
                </form>
              ) : (
                <p className="rounded-xl border border-success-500/40 bg-success-50 px-3 py-2 text-xs text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
                  ⏳ {t("beginYourWorkHint")}
                </p>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {/* Quality Control — after work is complete */}
      {job.workCompletedAt ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("jcQc")}</h2>
            {qcSignedOff(job.qcAt) ? (
              <span className="text-xs text-success-700 dark:text-success-500">
                ✅ {t("qcPassedBadge")} · {job.qcBy?.name ?? ""} · {job.qcAt!.toISOString().slice(0, 10)}
              </span>
            ) : null}
          </div>
          {qcSignedOff(job.qcAt) ? (
            <ul className="flex flex-col gap-0.5 text-sm">
              {job.qcChecks.map((c) => (
                <li key={c} className="text-success-700 dark:text-success-500">
                  ✓ {t(`qc_${c}` as MessageKey)}
                </li>
              ))}
            </ul>
          ) : (
            <form action={signOffQcAction} className="flex flex-col gap-2">
              <input type="hidden" name="jobId" value={job.id} />
              <div className="grid grid-cols-2 gap-1">
                {QC_CHECKS.map((c) => (
                  <label key={c} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" name="qc" value={c} />
                    {t(`qc_${c}` as MessageKey)}
                  </label>
                ))}
              </div>
              <button className="self-start inline-flex h-10 items-center justify-center rounded-lg bg-accent-500 px-4 text-sm font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                {t("signOffQc")}
              </button>
            </form>
          )}
        </div>
      ) : null}

      {/* Big-button, no-typing actions */}
      <div className="grid grid-cols-2 gap-3">
        <form action={addStepAction} className="contents">
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="PHOTO"/>
          <PhotoCapture
            name="file"
            mode="preview"
            kind="photo"
            required
            buttonLabel={t("addPhoto")}
            retakeLabel={t("retake")}
            continueLabel={t("usePhoto")}
            tooBigLabel={t("fileTooBig")}
            wrongTypeLabel={t("wrongFileType")}
          />
        </form>

        <form action={addStepAction} className="contents">
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="VOICE"/>
          <PhotoCapture
            name="file"
            mode="preview"
            kind="voice"
            required
            buttonLabel={t("voiceNote")}
            retakeLabel={t("retake")}
            continueLabel={t("useRecording")}
            tooBigLabel={t("fileTooBig")}
            wrongTypeLabel={t("wrongFileType")}
          />
        </form>

        <form action={requestPartAction} className="contents">
          <input type="hidden" name="jobId" value={job.id} />
          <div className={bigBtn}>
            <span className="text-3xl">📦</span>
            {t("requestPart")}
            <select
              name="partId"
              defaultValue=""
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            >
              <option value="">{t("pickPart")}</option>
              {parts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.qtyOnHand} {t("inStockShort")}
                </option>
              ))}
            </select>
            <DictateInput
              locale={locale}
              labels={dictLabels}
              name="description"
              placeholder={t("orTypePart")}
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <input
              name="qty"
              type="number"
              min="1"
              defaultValue="1"
              aria-label={t("colQty")}
              className="mt-1 w-16 rounded-md border border-border bg-transparent px-2 py-1 text-sm"
            />
            <button type="submit" className="mt-1 text-sm font-semibold underline">
              {t("request")}
            </button>
          </div>
        </form>

        {/* Legacy 'Finish' big-button removed — it only logged a tech-step,
            it didn't change job status. The real workflow-completing
            'Finish' button now lives on the tech home (and is also
            mirrored in the workflow section below) and fires
            markCompleteAction so the job actually flips to
            TECH_COMPLETE. */}
      </div>

      {/* Part requests + live status. Each row carries the vehicle spec
          inline so the technician (and whoever they hand the phone to:
          parts orderer, supplier on a call) can see exactly what
          vehicle the part fits without scrolling back to the header.
          Spec is hidden when empty so legacy rows still render
          cleanly. */}
      {job.partRequests.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("partRequests")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {job.partRequests.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-1 rounded-lg border border-border p-2"
              >
                <div className="flex items-center justify-between">
                  <span>
                    📦 {r.qty}× {r.description}
                  </span>
                  <span className="text-xs text-text-mute">
                    {t(partStatusKey(r.status))}
                  </span>
                </div>
                {formatVehicleSpec(job.vehicle).length > 0 ? (
                  <span className="text-xs text-text-mute">
                    🔧 {formatVehicleSpec(job.vehicle)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Activity */}
      <div>
        <h2 className="mb-2 text-sm font-medium">{t("activity")}</h2>
        {job.steps.length === 0 ? (
          <p className="text-sm text-text-mute">{t("nothingYet")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {job.steps.map((s) => (
              <li key={s.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="mb-1 font-medium">
                  {STEP_ICON[s.type] ??"•"} {s.type.replace("_","").toLowerCase()}
                </div>
                {s.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.photoUrl} alt="job photo" className="max-h-48 rounded-md"/>
                ) : null}
                {s.voiceNoteUrl ? (
                  <audio controls src={s.voiceNoteUrl} className="w-full"/>
                ) : null}
                {s.transcript ? <p className="text-text">{s.transcript}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
