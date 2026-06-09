import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { addStepAction } from "@/app/actions/techsteps";
import { requestPartAction } from "@/app/actions/parts";
import {
  leaveHelperAction,
  addExtraJobPartAction,
  removeExtraJobPartAction,
  sendForReestimateAction,
} from "@/app/actions/jobs";
import {
  saveFindingsAction,
  addRequiredPartAction,
  removeJobPartAction,
  submitFindingsAction,
  saveWorkNotesAction,
  addUsedPartAction,
  removeUsedPartAction,
  markWorkCompleteAction,
  signOffQcAction,
} from "@/app/actions/techfindings";
import { canSubmitFindings, repairUnlocked } from "@/lib/jobfindings";
import { QC_CHECKS, qcSignedOff } from "@/lib/jobcard-fields";
import { AppNav } from "@/components/app-nav";
import { getLocale, getT } from "@/i18n/server";
import { partStatusKey } from "@/i18n/config";
import type { MessageKey } from "@/i18n/config";
import { DictateInput, DictateTextarea } from "@/components/dictate";
import { PhotoCapture } from "@/components/photo-capture";

export const dynamic = "force-dynamic";

const STEP_ICON: Record<string, string> = {
  PHOTO: "📷",
  VOICE: "🎤",
  PART_REQUEST: "📦",
  FINISH: "✅",
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
      steps: { orderBy: { createdAt: "desc" } },
      partRequests: { orderBy: { createdAt: "desc" } },
      helpers: { include: { tech: { select: { id: true, name: true } } } },
      finding: true,
      jobParts: { orderBy: { createdAt: "asc" } },
      estimates: { where: { status: "APPROVED" }, select: { id: true }, take: 1 },
      qcBy: { select: { name: true } },
    },
  });
  if (!job) notFound();

  const me = session.user.id;
  const amHelper = job.claimedById !== null && job.claimedById !== me && job.helpers.some((h) => h.techId === me);
  const submitted = Boolean(job.finding?.submittedAt);
  const requiredParts = job.jobParts.filter((p) => p.kind === "REQUIRED");
  const usedParts = job.jobParts.filter((p) => p.kind === "USED");
  const extraParts = job.jobParts.filter((p) => p.kind === "EXTRA");
  // Tech can add/manage EXTRA items only during the work-in-progress
  // window. After Send-for-Approval flips the status, items are owned by
  // the cashier (as estimate lines) and no longer editable here.
  const canManageExtras = job.status === "APPROVED" || job.status === "REPAIR";
  const hasApprovedEstimate = job.estimates.length > 0;
  const repairOpen = repairUnlocked(hasApprovedEstimate, job.workCompletedAt);

  const parts = await prisma.part.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { name: "asc" },
  });

  const bigBtn =
    "flex flex-col items-center justify-center gap-1 rounded-2xl border border-black/10 p-6 text-center text-base font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="TECH" active="workshop" />
      <div>
        <Link href="/technician" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backWorkshop")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {job.vehicle.make} {job.vehicle.model}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{job.vehicle.plate}</p>
        {job.helpers.length > 0 ? (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t("helpersLabel")}: {job.helpers.map((h) => h.tech.name).join(", ")}
          </p>
        ) : null}
        {amHelper ? (
          <form action={leaveHelperAction} className="mt-1">
            <input type="hidden" name="jobId" value={job.id} />
            <button className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400">
              {t("leaveJob")}
            </button>
          </form>
        ) : null}
      </div>

      {job.status === "ON_HOLD" && job.holdReason ? (
        <p className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
          🟡 {t("onHold")}:{" "}
          {(
            {
              AWAITING_PART: t("hrAwaitingPart"),
              AWAITING_CUSTOMER: t("hrAwaitingCustomer"),
              AWAITING_APPROVAL: t("hrAwaitingApproval"),
              OTHER: t("hrOther"),
            } as Record<string, string>
          )[job.holdReason]}
          {job.holdNote ? ` — ${job.holdNote}` : ""}
        </p>
      ) : null}

      {/* Customer complaint (from reception) */}
      {job.complaint ? (
        <div className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">{t("complaintFromReception")}</div>
          <p>{job.complaint}</p>
          {job.mileageIn ? (
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {t("mileageInLabel")}: {job.mileageIn}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Findings & diagnosis + parts required (Job-Card-Data-Model.md) */}
      <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3 dark:border-white/15">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("jcFindings")}</h2>
          {submitted ? (
            <span className="text-xs text-green-700 dark:text-green-400">
              ✅ {t("submittedToCashier")} · {job.finding!.submittedAt!.toISOString().slice(0, 16).replace("T", " ")}
            </span>
          ) : null}
        </div>

        {submitted ? (
          <div className="text-sm">
            <p>{job.finding?.findings}</p>
            {job.finding?.diagnosis ? (
              <p className="mt-1 text-zinc-600 dark:text-zinc-300">{job.finding.diagnosis}</p>
            ) : null}
            <p className="mt-1 text-xs text-zinc-400">{t("findingsLocked")}</p>
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
              className="w-full rounded-md border border-black/15 bg-transparent px-2 py-1 pr-10 text-sm dark:border-white/20"
            />
            <DictateTextarea
              locale={locale}
              labels={dictLabels}
              name="diagnosis"
              defaultValue={job.finding?.diagnosis ?? ""}
              rows={2}
              placeholder={t("diagnosisLabel")}
              className="w-full rounded-md border border-black/15 bg-transparent px-2 py-1 pr-10 text-sm dark:border-white/20"
            />
            <button className="self-start rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
              {t("saveDraft")}
            </button>
          </form>
        )}

        {/* Parts required */}
        <h3 className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t("partsRequired")}</h3>
        {requiredParts.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noPartsRequired")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {requiredParts.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-md border border-black/10 p-2 dark:border-white/15"
              >
                <span>
                  {p.partNo ? <span className="text-zinc-400">{p.partNo} </span> : null}
                  {p.description} <span className="text-zinc-500 dark:text-zinc-400">×{p.qty}</span>
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

        {!submitted ? (
          <form action={addRequiredPartAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="jobId" value={job.id} />
            <select
              name="partId"
              defaultValue=""
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
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
              className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <DictateInput
              locale={locale}
              labels={dictLabels}
              name="description"
              placeholder={t("colDescription")}
              className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <input
              name="qty"
              type="number"
              min="1"
              defaultValue="1"
              aria-label={t("colQty")}
              className="w-16 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <button className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
              {t("addPartLine")}
            </button>
          </form>
        ) : null}

        <p className="text-xs text-zinc-400">📷 {t("photographDamaged")}</p>

        {!submitted && canSubmitFindings(job.finding) ? (
          <form action={submitFindingsAction}>
            <input type="hidden" name="jobId" value={job.id} />
            <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-black">
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
        <div className="flex flex-col gap-3 rounded-lg border border-rose-500/40 bg-rose-50 p-3 dark:border-rose-700/40 dark:bg-rose-950/30">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("extrasPanelTitle")}</h2>
            {extraParts.length > 0 ? (
              <span className="rounded-full bg-rose-600 px-2 py-0.5 text-xs font-medium text-white">
                {extraParts.length}
              </span>
            ) : null}
          </div>

          {extraParts.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              {t("extrasPanelEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {extraParts.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-rose-300/60 bg-white p-2 dark:border-rose-700/40 dark:bg-zinc-950"
                >
                  <span>
                    {p.partNo ? (
                      <span className="text-zinc-400">{p.partNo} </span>
                    ) : null}
                    {p.description}{" "}
                    <span className="text-zinc-500 dark:text-zinc-400">×{p.qty}</span>
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
              className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <DictateInput
              locale={locale}
              labels={dictLabels}
              name="description"
              placeholder={t("extrasDescriptionPlaceholder")}
              required
              className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <input
              name="qty"
              type="number"
              min="1"
              defaultValue="1"
              aria-label={t("colQty")}
              className="w-16 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <button className="rounded-md border border-rose-500 px-3 py-1 text-sm font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-400 dark:text-rose-200 dark:hover:bg-rose-900/50">
              {t("extrasAdd")}
            </button>
          </form>

          {/* The Send-for-Approval button lives down here as well as on
              the dashboard — handy for the tech who's already on the
              detail page reviewing what they added. */}
          {extraParts.length > 0 ? (
            <form action={sendForReestimateAction} className="self-start">
              <input type="hidden" name="jobId" value={job.id} />
              <button className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500">
                {t("extrasSendForApproval").replace("{count}", String(extraParts.length))}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {/* Repair — work completed & parts used (after Approval #1) */}
      {hasApprovedEstimate ? (
        <div className="flex flex-col gap-3 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("jcRepair")}</h2>
            {job.workCompletedAt ? (
              <span className="text-xs text-green-700 dark:text-green-400">
                ✅ {t("workCompletedBadge")} · {job.workCompletedAt.toISOString().slice(0, 16).replace("T", " ")}
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
                className="w-full rounded-md border border-black/15 bg-transparent px-2 py-1 pr-10 text-sm dark:border-white/20"
              />
              <button className="self-start rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
                {t("saveDraft")}
              </button>
            </form>
          ) : (
            <div className="text-sm">
              {job.workNotes ? <p>{job.workNotes}</p> : null}
              <p className="mt-1 text-xs text-zinc-400">{t("repairLockedNote")}</p>
            </div>
          )}

          {/* Parts used */}
          <h3 className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t("partsUsed")}</h3>
          {usedParts.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("noPartsUsed")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {usedParts.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-black/10 p-2 dark:border-white/15"
                >
                  <span>
                    {p.partNo ? <span className="text-zinc-400">{p.partNo} </span> : null}
                    {p.description} <span className="text-zinc-500 dark:text-zinc-400">×{p.qty}</span>
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
                  className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
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
                  className="w-24 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
                />
                <DictateInput
                  locale={locale}
                  labels={dictLabels}
                  name="description"
                  placeholder={t("colDescription")}
                  className="flex-1 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
                />
                <input
                  name="qty"
                  type="number"
                  min="1"
                  defaultValue="1"
                  aria-label={t("colQty")}
                  className="w-16 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
                />
                <button className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
                  {t("addPartLine")}
                </button>
              </form>

              <form action={markWorkCompleteAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <button className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500">
                  {t("markComplete")}
                </button>
              </form>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Quality Control — after work is complete */}
      {job.workCompletedAt ? (
        <div className="flex flex-col gap-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("jcQc")}</h2>
            {qcSignedOff(job.qcAt) ? (
              <span className="text-xs text-green-700 dark:text-green-400">
                ✅ {t("qcPassedBadge")} · {job.qcBy?.name ?? ""} · {job.qcAt!.toISOString().slice(0, 10)}
              </span>
            ) : null}
          </div>
          {qcSignedOff(job.qcAt) ? (
            <ul className="flex flex-col gap-0.5 text-sm">
              {job.qcChecks.map((c) => (
                <li key={c} className="text-green-700 dark:text-green-400">
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
              <button className="self-start rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500">
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
          <input type="hidden" name="type" value="PHOTO" />
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
          <input type="hidden" name="type" value="VOICE" />
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
              className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
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
              className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <input
              name="qty"
              type="number"
              min="1"
              defaultValue="1"
              aria-label={t("colQty")}
              className="mt-1 w-16 rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
            <button type="submit" className="mt-1 text-sm font-semibold underline">
              {t("request")}
            </button>
          </div>
        </form>

        <form action={addStepAction} className="contents">
          <input type="hidden" name="jobId" value={job.id} />
          <input type="hidden" name="type" value="FINISH" />
          <button type="submit" className={bigBtn}>
            <span className="text-3xl">✅</span>
            {t("finish")}
          </button>
        </form>
      </div>

      {/* Part requests + live status */}
      {job.partRequests.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("partRequests")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {job.partRequests.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between rounded-lg border border-black/10 p-2 dark:border-white/15"
              >
                <span>
                  📦 {r.qty}× {r.description}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t(partStatusKey(r.status))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Activity */}
      <div>
        <h2 className="mb-2 text-sm font-medium">{t("activity")}</h2>
        {job.steps.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("nothingYet")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {job.steps.map((s) => (
              <li key={s.id} className="rounded-lg border border-black/10 p-3 text-sm dark:border-white/15">
                <div className="mb-1 font-medium">
                  {STEP_ICON[s.type] ?? "•"} {s.type.replace("_", " ").toLowerCase()}
                </div>
                {s.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.photoUrl} alt="job photo" className="max-h-48 rounded-md" />
                ) : null}
                {s.voiceNoteUrl ? (
                  <audio controls src={s.voiceNoteUrl} className="w-full" />
                ) : null}
                {s.transcript ? <p className="text-zinc-600 dark:text-zinc-300">{s.transcript}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
