import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { DocumentHeader } from "@/components/document-header";
import { type StaffRole } from "@/lib/roles";
import { getLocale, getT } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import type { MessageKey } from "@/i18n/config";
import { DictateInput } from "@/components/dictate";
import {
  addEstimateLineAction,
  addLineFromPartAction,
  setEstimateStatusAction,
  generateInvoiceAction,
  recordAdvancePaymentAction,
} from "@/app/actions/billing";
import {
  balanceDue,
  LINE_FORM_ERROR_CODES,
  type LineFormErrorCode,
  findZeroPricedPartLines,
} from "@/lib/billing";
import {
  canEditEstimate as roleCanEditEstimate,
  canEditInvoice as roleCanEditInvoice,
  canSeeMargin,
} from "@/lib/permissions";
import { translateLineDescription } from "@/lib/line-item-translations";
import { EstimateLineRow } from "@/components/estimate-line-row";
import { EstimateLineCard } from "@/components/estimate-line-card";
import { WorkflowStepper } from "@/components/workflow-stepper";
import { workflowStage } from "@/lib/workflow-stage";
import { buildStepperLabels } from "@/lib/workflow-stepper-labels";
import { JobTimeline } from "@/components/job-timeline";
import { loadJobTimeline } from "@/lib/job-timeline-server";
import { buildTimelineLabels } from "@/lib/job-timeline-labels";
import { CatalogPartSelect } from "@/components/catalog-part-select";
import { stockOptionSuffix } from "@/lib/stock-label";

export const dynamic ="force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

// A technician part row with a one-click"Price this part"button (when editable).
function PartRow({
  p,
  estimateId,
  editable,
  t,
}: {
  p: { id: string; partNo: string | null; description: string; qty: number };
  estimateId: string;
  editable: boolean;
  t: (k: MessageKey) => string;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-base text-text-mute">
      <span>
        • {p.partNo ? `${p.partNo} ` :""}
        {p.description} ×{p.qty}
      </span>
      {editable ? (
        <form action={addLineFromPartAction}>
          <input type="hidden" name="estimateId" value={estimateId} />
          <input type="hidden" name="jobPartId" value={p.id} />
          <button className="shrink-0 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2">
            {t("priceThisPart")}
          </button>
        </form>
      ) : null}
    </li>
  );
}

// Shared screen: the Cashier sets prices here; the Advisor can view + send it.
export default async function EstimateEditor({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // Optional so unit tests can call the page component without wiring
  // a searchParams promise. In real Next-App-Router usage the runtime
  // always supplies one (empty object if no query string).
  searchParams?: Promise<{ formError?: string }>;
}) {
  const { id } = await params;
  // Server actions on this page redirect with ?formError=<code> when a
  // validation refusal fires (add-line, update-line-price, price-this-
  // part). Read the code, whitelist it, and render a banner. Never
  // t(`lineFormErr_${code}`) with an untrusted code — same discipline
  // as the /c/book photoError handling.
  const { formError } = (await searchParams) ?? {};
  const lineFormErrorMessage: string | null = formError
    ? LINE_FORM_ERROR_CODES.has(formError as LineFormErrorCode)
      ? await getT().then((t) =>
          t(`lineFormErr_${(formError as LineFormErrorCode).replace(/-/g, "_")}` as MessageKey),
        )
      : await getT().then((t) => t("lineFormErr_generic"))
    : null;
  // Both advisor + cashier can land on this page after KEY DECISION #5
  // (rev. 2026-06-23): the ADVISOR creates + prices + sends the estimate,
  // the CASHIER opens it to generate the invoice / record advance payment.
  const session = await requireAnyRole(["ADVISOR","CASHIER","OWNER","MASTER"]);
  const role = session.user.role as StaffRole;
  // Split per KEY DECISION #5 (rev. 2026-06-23):
  //   - canEditEstimate: edit line items + send to customer  → ESTIMATE_CREATE_ROLES
  //   - canInvoice:      generate invoice + advance payment  → INVOICE_ROLES
  // Read from the SHARED permissions helpers, never a local role list —
  // a private copy here is exactly how MASTER shipped without an
  // estimate editor (and how incident ref 3426515655 happened server-side).
  const canEditEstimate = roleCanEditEstimate(role);
  const canInvoice = roleCanEditInvoice(role);
  // AR 2026-08-14 — cost / markup / margin are advisor + owner + master
  // only. Cashier can open this page to generate an invoice, but MUST
  // NOT see supplier cost or margin (same rule as the customer surface,
  // just enforced role-side instead of token-side). Data-level: when
  // false, the server nulls unitCost + markupPct BEFORE handing the
  // line to the client component, so RSC payload carries no cost
  // number for the cashier's browser to view-source out of.
  const canShowCost = canSeeMargin(role);

  const est = await prisma.estimate.findFirst({
    where: { id, jobCard: { garageId: session.user.garageId } },
    include: {
      // 3b — include the linked catalog part (if any) so linked lines can
      // show a SKU + stock hint in the editor. Display only.
      lines: {
        orderBy: { createdAt:"asc"},
        include: { part: { select: { sku: true, qtyOnHand: true, reorderLevel: true } } },
      },
      jobCard: {
        // jobCard.status is what gates 'Generate Invoice' per spec —
        // the cashier must NOT be able to invoice while the technician
        // is still doing the work. Only TECH_COMPLETE (or beyond,
        // when an invoice already exists) unlocks the action.
        include: {
          vehicle: true,
          finding: true,
          // Pulled for <GarageBrand> in the header — same garageId
          // we're already scoping on, so no extra row, just the
          // existing one joined with logoUrl in scope.
          garage: { select: { name: true, trn: true, logoUrl: true, country: true } },
          jobParts: { orderBy: { createdAt:"asc"} },
          // Slice 6b — show advances received against this job in the
          // UI block below. Ordered oldest-first so the audit list reads
          // naturally top-to-bottom.
          advancePayments: { orderBy: { receivedAt:"asc"} },
          // Also pull sibling approved estimates so the SUM-based
          // approved-total ceiling matches what the server action uses
          // for its overpayment block. Same query, no round trip.
          estimates: {
            where: { status:"APPROVED"},
            select: { id: true, total: true },
          },
        },
      },
      invoice: { select: { id: true } },
    },
  });
  if (!est) notFound();
  const tz = countryToTimeZone(est.jobCard.garage.country);
  // Pull the job-card status out for readability — it drives the
  // Generate-Invoice gate below.
  const jobStatus = est.jobCard.status;
  const workNotComplete = jobStatus ==="APPROVED"|| jobStatus ==="REPAIR";
  const t = await getT();
  const locale = await getLocale();
  const dictLabels = {
    start: t("dictateStart"),
    stop: t("dictateStop"),
    listening: t("dictateListening"),
    error: t("dictateError"),
  };
  const finding = est.jobCard.finding;
  const requiredParts = est.jobCard.jobParts.filter((p) => p.kind ==="REQUIRED");
  const usedParts = est.jobCard.jobParts.filter((p) => p.kind ==="USED");
  const workNotes = est.jobCard.workNotes;

  // Workflow stepper — latest estimate on this job + latest invoice.
  // est itself is one of those estimates; we may be looking at an OLD
  // revision, so query for the actual most recent one.
  const [latestEstimate, latestInvoice] = await Promise.all([
    prisma.estimate.findFirst({
      where: { jobCardId: est.jobCardId },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    }),
    prisma.invoice.findFirst({
      where: { jobCardId: est.jobCardId },
      orderBy: { createdAt: "desc" },
      select: { total: true, payments: { select: { amount: true } } },
    }),
  ]);
  const invoicePaid = latestInvoice
    ? latestInvoice.payments.reduce((s, p) => s + Number(p.amount), 0) >=
      Number(latestInvoice.total) - 0.005
    : false;
  const stepperState = workflowStage({
    status: est.jobCard.status,
    heldFrom: est.jobCard.heldFrom,
    heldReason: est.jobCard.holdReason,
    latestEstimateStatus: latestEstimate?.status ?? null,
    invoicePaid,
  });
  const timelineEvents = await loadJobTimeline(est.jobCardId, session.user.garageId);

  const editable = canEditEstimate && est.status ==="DRAFT";
  const canDecline = canEditEstimate && !est.invoice; // skip lines until the invoice is cut

  // 3b — read-only stock hint (reuses 3a's rules) + optional catalog picker
  // options for the add-line form. Display/link only; no stock movement.
  const stockHint = (p: { qtyOnHand: number; reorderLevel: number }) =>
    stockOptionSuffix(p.qtyOnHand, p.reorderLevel, {
      inStock: t("inStockShort"),
      low: t("lowStockTag"),
      out: t("outOfStock"),
    });
  const catalogOptions = editable
    ? (
        await prisma.part.findMany({
          where: { garageId: session.user.garageId, active: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true, sku: true, price: true, qtyOnHand: true, reorderLevel: true },
        })
      ).map((p) => ({
        id: p.id,
        label: `${p.name} (${p.sku}) · ${stockHint(p)}`,
        name: p.name,
        sku: p.sku,
        price: String(p.price),
      }))
    : [];
  // MASTER works the estimate from the job like an advisor, so it gets the
  // same back-to-job link; cashier (and owner arriving from accounts) goes
  // back to the accounts board.
  const jobSide = role === "ADVISOR" || role === "MASTER";
  const backHref = jobSide ? `/advisor/jobs/${est.jobCardId}` : "/cashier";

  return (
    <main data-print-document="estimate-edit" className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6 lg:max-w-6xl xl:max-w-7xl">
      <AppNav role={role} active={jobSide ? "jobs" : "accounts"} />
      <div>
        <Link href={backHref} className="inline-block py-2 text-base text-text-mute hover:underline">
          {jobSide ? t("backJob") : t("accounts")}
        </Link>
        {/* Logo lives inside DocumentHeader's garage block now — see
            document-header.tsx. The standalone <GarageBrand> above the
            header is removed; the doc reads as one shape across every
            surface. Internal doc: fall back to the GarageOS mark. */}
        <DocumentHeader
          title={t("estimate")}
          jobCard={est.jobCard}
          vehicle={est.jobCard.vehicle}
          garage={est.jobCard.garage}
          logoUrl={est.jobCard.garage.logoUrl ?? "/brand/garageos-logo.png"}
        />
        {/* Status + pricing-by-advisor moved below the header so the
            standardized stacked shape stays clean. Status stayed inline
            in the h1 before the header sweep. */}
        <p className="mt-1 text-sm text-text-mute">
          <span className="font-medium">{est.status}</span>
          {!canEditEstimate ? <> · {t("pricingByAdvisor")}</> : null}
        </p>
        {est.approvedAt ? (
          <p className="text-sm text-success-700 dark:text-success-500">
            ✅ {t("approvedOn")} AED {Number(est.approvedAmount ?? est.total).toFixed(2)} ·{""}
            {fmtDate(est.approvedAt, locale, tz)}
          </p>
        ) : null}
      </div>

      <WorkflowStepper state={stepperState} labels={buildStepperLabels(t)} />

      {/* Inline validation banner — a server action redirected here
          with ?formError=<code>. See LINE_FORM_ERROR_CODES in
          src/lib/billing.ts. Uses `role="alert"` + off-print so a
          user who happens to print an estimate mid-refusal doesn't
          see the banner on paper. AR 2026-08-18.
          When the code is `zero-part-lines-invoice`, also enumerate
          the offending line names (so the advisor sees exactly which
          rows need fixing) and render a "Generate anyway" form that
          resubmits generateInvoiceAction with confirmZeroParts=1. */}
      {lineFormErrorMessage ? (
        <div
          role="alert"
          className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 print:hidden dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500"
        >
          <div className="font-semibold">{t("lineFormErrorTitle")}</div>
          <div className="mt-0.5">{lineFormErrorMessage}</div>
          {formError === "zero-part-lines-invoice" ? (() => {
            const zeroLines = findZeroPricedPartLines(est.lines);
            if (zeroLines.length === 0) return null;
            return (
              <>
                <div className="mt-2 font-medium">{t("lineFormErr_zeroPartsHeading")}</div>
                <ul className="mt-1 list-inside list-disc">
                  {zeroLines.map((l) => (
                    <li key={l.id}>{l.description}</li>
                  ))}
                </ul>
                <form action={generateInvoiceAction} className="mt-3">
                  <input type="hidden" name="estimateId" value={est.id} />
                  <input type="hidden" name="confirmZeroParts" value="1" />
                  <button className="inline-flex h-10 items-center justify-center rounded-lg border border-danger-500/60 bg-danger-50 px-4 text-sm font-semibold text-danger-700 hover:bg-danger-100 dark:bg-danger-500/10 dark:text-danger-500 dark:hover:bg-danger-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-500/60">
                    {t("lineFormErr_generateAnyway")}
                  </button>
                </form>
              </>
            );
          })() : null}
        </div>
      ) : null}

      {/* Two-column layout at lg+ — main work content (findings, parts,
          line items, timeline) on the left; summary, action buttons,
          advance payments, status captions on the right rail. Mobile
          stays single column; the grid collapses to one column below
          the lg: breakpoint. lg:items-start so the aside doesn't get
          stretched to match the (taller) main column's height. */}
      <div className="lg:grid lg:grid-cols-3 lg:gap-6 lg:items-start">
      <section className="flex min-w-0 flex-col gap-6 lg:col-span-2">

      {/* Technician findings & parts required — what the cashier prices from */}
      {finding?.submittedAt || requiredParts.length > 0 ? (
        <div className="rounded-xl border border-border p-4 text-base">
          <h2 className="mb-2 text-base font-semibold">{t("techFindingsPanel")}</h2>
          {finding?.findings ? <p>{finding.findings}</p> : null}
          {finding?.diagnosis ? (
            <p className="text-text-mute">{finding.diagnosis}</p>
          ) : null}
          {requiredParts.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {requiredParts.map((p) => (
                <PartRow key={p.id} p={p} estimateId={est.id} editable={editable} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Parts used & work notes (Repair stage) — reconcile Final Billing */}
      {usedParts.length > 0 || workNotes ? (
        <div className="rounded-xl border border-border p-4 text-base">
          <h2 className="mb-2 text-base font-semibold">{t("partsUsedPanel")}</h2>
          {workNotes ? <p className="text-text-mute">{workNotes}</p> : null}
          {usedParts.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {usedParts.map((p) => (
                <PartRow key={p.id} p={p} estimateId={est.id} editable={editable} t={t} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Lines — responsive layout:
          - Mobile (< md / 768px): stacked cards. Action buttons fit on
            the same row as the Type badge, so Edit / Skip / Delete are
            never cut off. Vehicle make/model/year appear as a small
            one-liner under the badge.
          - Desktop (md+): the wide 9-column table, scoped to a single
            overflow-x-auto container in case a narrow laptop window
            still needs a sideways nudge.
          Both render the same data + actions — only the layout differs,
          so totals/VAT/qty/price flow identically. */}
      {est.lines.length > 0 ? (
        <>
          {/* Mobile card list */}
          <div className="flex flex-col gap-3 md:hidden">
            {est.lines.map((l) => (
              <EstimateLineCard
                key={l.id}
                estimateId={est.id}
                editable={editable}
                canShowCost={canShowCost}
                canDecline={canDecline}
                vehicle={{
                  make: est.jobCard.vehicle.make,
                  model: est.jobCard.vehicle.model,
                  year: est.jobCard.vehicle.year,
                }}
                line={{
                  id: l.id,
                  kind: l.kind,
                  description: l.description,
                  qty: Number(l.qty),
                  // AR 2026-08-12 — cost + markup pass through as
                  // nullable numbers; the client component decides
                  // whether to render the tri-input based on kind.
                  // AR 2026-08-14 — role-gated. Cashier + tech get
                  // null here so the RSC payload carries no supplier
                  // cost or markup. The client component honours
                  // canShowCost as belt-and-braces (renders the
                  // plain qty+unit form when false).
                  unitCost: canShowCost && l.unitCost != null ? Number(l.unitCost) : null,
                  markupPct: canShowCost && l.markupPct != null ? Number(l.markupPct) : null,
                  unitPrice: Number(l.unitPrice),
                  lineTotal: Number(l.lineTotal),
                  declined: l.declined,
                }}
                displayDescription={translateLineDescription(l.description, locale) + (l.part ? ` — ${l.description.includes(l.part.sku) ? "" : `${l.part.sku} · `}${stockHint(l.part)}` : "")}
                labels={{
                  edit: t("editLine"),
                  delete: t("deleteLine"),
                  save: t("saveLine"),
                  cancel: t("cancelLine"),
                  skip: t("skip"),
                  restore: t("restore"),
                  confirmDelete: t("confirmDeleteLine"),
                  kindLabor: t("labor"),
                  kindPart: t("part"),
                  kindFee: t("fee"),
                  kindDiscount: t("discount"),
                  qty: t("colQty"),
                  cost: t("costLabel"),
                  markup: t("markupLabel"),
                  unit: t("colUnit"),
                  margin: t("marginLabel"),
                }}
              />
            ))}
          </div>

          {/* Desktop table — fits the container, no horizontal scroll.
              Make / Model / Year collapsed into one "Vehicle" column
              ("Ford Focus 2014") to free width. Part / description gets
              the flex/auto column so it takes whatever remains; the
              numeric cells (Qty / Unit / Total) and the Type badge are
              tight + right-aligned. table-layout:auto lets the browser
              shrink the long description before the narrow numerics. */}
          <div className="hidden rounded-xl border border-border md:block">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs uppercase tracking-wide text-text-mute">
                <tr>
                  <th className="px-2 py-2 text-left">{t("colKind")}</th>
                  <th className="px-2 py-2 text-left">{t("colVehicle")}</th>
                  <th className="px-2 py-2 text-left">{t("colPart")}</th>
                  <th className="w-16 px-2 py-2 text-right">{t("colQty")}</th>
                  <th className="w-20 px-2 py-2 text-right">{t("colUnit")}</th>
                  <th className="w-24 px-2 py-2 text-right">{t("colTotal")}</th>
                  {editable || canDecline ? (
                    <th className="px-2 py-2 text-left">{t("colActions")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {est.lines.map((l) => (
                  <EstimateLineRow
                    key={l.id}
                    estimateId={est.id}
                    editable={editable}
                    canShowCost={canShowCost}
                    canDecline={canDecline}
                    vehicle={{
                      make: est.jobCard.vehicle.make,
                      model: est.jobCard.vehicle.model,
                      year: est.jobCard.vehicle.year,
                    }}
                    columnCount={editable || canDecline ? 7 : 6}
                    line={{
                      id: l.id,
                      kind: l.kind,
                      description: l.description,
                      qty: Number(l.qty),
                      // Role-gated (same rule as the mobile-card mapping
                      // ~line 330). Cashier + tech get null so the RSC
                      // payload for the desktop table row carries no
                      // supplier cost or markup. Missing this gate was
                      // the second-mapping leak that shipped in commit
                      // 7b3b8c9 — mobile was fixed, desktop was not,
                      // and the RSC payload contains BOTH regardless of
                      // which one CSS reveals.
                      unitCost: canShowCost && l.unitCost != null ? Number(l.unitCost) : null,
                      markupPct: canShowCost && l.markupPct != null ? Number(l.markupPct) : null,
                      unitPrice: Number(l.unitPrice),
                      lineTotal: Number(l.lineTotal),
                      declined: l.declined,
                    }}
                    displayDescription={translateLineDescription(l.description, locale) + (l.part ? ` — ${l.description.includes(l.part.sku) ? "" : `${l.part.sku} · `}${stockHint(l.part)}` : "")}
                    labels={{
                      edit: t("editLine"),
                      delete: t("deleteLine"),
                      save: t("saveLine"),
                      cancel: t("cancelLine"),
                      skip: t("skip"),
                      restore: t("restore"),
                      confirmDelete: t("confirmDeleteLine"),
                      kindLabor: t("labor"),
                      kindPart: t("part"),
                      kindFee: t("fee"),
                      kindDiscount: t("discount"),
                      qty: t("colQty"),
                      cost: t("costLabel"),
                      markup: t("markupLabel"),
                      unit: t("colUnit"),
                      margin: t("marginLabel"),
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("noLineItems")}
        </p>
      )}

      </section>

      {/* Right rail — summary, add-line, advance payments, lifecycle
          actions. On mobile this just stacks naturally below the main
          panels (lg:mt-0 cancels the mt-6 spacer above the lg breakpoint). */}
      <aside className="mt-6 flex min-w-0 flex-col gap-6 lg:mt-0">

      <div className="ml-auto text-right text-base tabular-nums">
        <div className="text-text-mute">{t("subtotal")}: {money(Number(est.subtotal))}</div>
        <div className="text-text-mute">{t("vat5")}: {money(Number(est.vatAmount))}</div>
        <div className="mt-1 text-lg font-semibold">{t("total")}: {money(Number(est.total))}</div>
      </div>

      {editable ? (
        <form action={addEstimateLineAction} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <input type="hidden" name="estimateId" value={est.id} />
          {/* 3b — optional catalog link: picking prefills description + price
              (still editable); leaving it on the placeholder keeps the
              free-text flow exactly as before. */}
          <CatalogPartSelect
            parts={catalogOptions}
            placeholder={t("catalogPartOptional")}
            className="h-10 w-full rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          />
          <div className="flex flex-wrap gap-2">
            <select name="kind" className="h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              <option value="LABOR">{t("labor")}</option>
              <option value="PART">{t("part")}</option>
              <option value="FEE">{t("fee")}</option>
              <option value="DISCOUNT">{t("discount")}</option>
            </select>
            <DictateInput locale={locale} labels={dictLabels} name="description" placeholder={t("description")} required className="min-w-40 flex-1 h-10 rounded-lg border border-border bg-transparent px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"/>
          </div>
          <div className="flex flex-wrap gap-2">
            <input name="qty" type="number" step="any" min="0" inputMode="decimal" defaultValue="1" className="w-20 rounded-md border border-border bg-transparent px-3 py-2 text-base text-right"/>
            <input name="unitPrice" type="number" step="any" min="0" inputMode="decimal" placeholder="Unit price" required className="min-w-32 flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-base text-right"/>
            <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("addLine")}
            </button>
          </div>
          {/* Explanatory hint shown only when a picked catalogue part
              has no meaningful price. The `required` attribute on the
              input above is still the enforcement — this line just
              tells the advisor WHY the field is blank instead of
              pre-filled, so the browser's generic "please fill out
              this field" doesn't leave them guessing. Toggled by
              CatalogPartSelect via `.hidden`, which keeps it out of
              the paint + accessibility tree when not needed. AR
              2026-08-17. */}
          <p
            data-hint="no-catalogue-price"
            hidden
            className="text-xs text-warning-700 dark:text-warning-500"
          >
            {t("catalogPartNoPriceHint")}
          </p>
        </form>
      ) : null}

      {/* ─── Slice 6b: Advance payments ───────────────────────────
          Visible to cashier/owner once the estimate is APPROVED and
          before the invoice exists. Shows running totals against the
          SUM of all approved-estimate totals (so a re-estimate that
          raised the price doesn't suddenly make a prior advance look
          like an overpayment) and the audit list of advances. The
          form is hidden once the balance reaches 0 — no further
          advances can be taken once the approved total is covered. */}
      {canInvoice && est.status ==="APPROVED"&& !est.invoice ? (
        (() => {
          const approvedTotal = est.jobCard.estimates.reduce(
            (s, e) => s + Number(e.total),
            0,
          );
          const advancePaid = est.jobCard.advancePayments.reduce(
            (s, a) => s + Number(a.amount),
            0,
          );
          const advanceBalance = balanceDue(approvedTotal, advancePaid);
          return (
            <section className="rounded-xl border border-warning-500/40 bg-warning-50 p-4 dark:border-warning-500/30 dark:bg-warning-500/10">
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-warning-700 dark:text-warning-500">
                  {t("advancePaymentsTitle")}
                </h2>
                <p className="text-xs text-warning-700 dark:text-warning-500">
                  {t("advancePaymentsCeiling")}: {money(approvedTotal)}
                </p>
              </header>
              {/* Running totals — same math as the invoice screen so
                  the cashier reads identical numbers across both
                  surfaces. balanceDue() guarantees
                  advancePaid + advanceBalance === approvedTotal. */}
              <dl className="mt-3 grid grid-cols-[max-content_max-content] gap-x-6 gap-y-1 text-sm tabular-nums">
                <dt className="text-text">
                  {t("invoiceAdvancePaid")}
                </dt>
                <dd className="text-end">{money(advancePaid)}</dd>
                <dt className="font-semibold">{t("invoiceBalanceDue")}</dt>
                <dd className="text-end font-semibold">{money(advanceBalance)}</dd>
              </dl>
              {/* Audit list — each advance recorded individually, with
                  date and method, per spec 'full audit trail'. */}
              {est.jobCard.advancePayments.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm tabular-nums">
                  {est.jobCard.advancePayments.map((a) => (
                    <li
                      key={a.id}
                      className="flex justify-between gap-3 text-warning-700 dark:text-warning-500"
                    >
                      <span>
                        {fmtDate(a.receivedAt, locale, tz)} ·{""}
                        {a.method ==="CASH"? t("methodCash") : t("methodCardPos")}
                      </span>
                      <span>{money(Number(a.amount))}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {/* Receive Advance Payment form — hidden once balance
                  is zero (no overpayment possible from the UI either,
                  the action still re-checks at the server). */}
              {advanceBalance > 0 ? (
                <form
                  action={recordAdvancePaymentAction}
                  className="mt-4 flex flex-wrap items-end gap-2"
                >
                  <input
                    type="hidden"
                    name="jobCardId"
                    value={est.jobCard.id}
                  />
                  <label className="flex flex-col text-xs text-warning-700 dark:text-warning-500">
                    {t("amount")}
                    <input
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={advanceBalance.toFixed(2)}
                      defaultValue={advanceBalance.toFixed(2)}
                      required
                      className="h-10 w-32 rounded-lg border border-border bg-surface px-3 text-right text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    />
                  </label>
                  <label className="flex flex-col text-xs text-warning-700 dark:text-warning-500">
                    {t("method")}
                    <select
                      name="method"
                      defaultValue="CASH"
                      className="h-10 rounded-lg border border-border bg-surface px-3 text-base text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
                    >
                      <option value="CASH">{t("methodCash")}</option>
                      <option value="CARD_POS">{t("methodCardPos")}</option>
                    </select>
                  </label>
                  <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                    {t("receiveAdvancePayment")}
                  </button>
                </form>
              ) : (
                <p className="mt-3 text-sm text-warning-700 dark:text-warning-500">
                  ✓ {t("advancePaymentsFullyCovered")}
                </p>
              )}
            </section>
          );
        })()
      ) : null}

      {/* Lifecycle actions */}
      <div className="flex flex-wrap gap-2">
        {/* Preview gate — same pattern as the invoice flow. The cashier
            must review the customer-facing layout BEFORE the WhatsApp
            send (setEstimateStatusAction(SENT) here) goes out. The
            send action itself now only fires from
            /estimates/[id]/preview, so a typo noticed mid-edit can't
            slip into a one-tap send. */}
        {canEditEstimate && est.status ==="DRAFT"&& est.lines.length > 0 ? (
          <Link
            href={`/estimates/${est.id}/preview`}
            className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            {t("estimatePreviewButton")}
          </Link>
        ) : null}
        {/* Once the estimate is past DRAFT, the preview stays reachable
            as the permanent printable customer-facing record — for
            every role allowed on this page. */}
        {est.status !== "DRAFT" && est.lines.length > 0 ? (
          <Link
            href={`/estimates/${est.id}/preview`}
            className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            {t("estimateViewPrint")}
          </Link>
        ) : null}
        {est.status ==="SENT"? (
          <>
            <StatusButton estimateId={est.id} status="APPROVED" label={t("markApproved")} primary />
            <StatusButton estimateId={est.id} status="REJECTED" label={t("markRejected")} />
          </>
        ) : null}
        {/* Generate Invoice — gated on jobCard.status === TECH_COMPLETE per
            spec, NOT on estimate.status === APPROVED alone. While the
            tech is still doing the work (job at APPROVED / REPAIR) the
            button is suppressed and a caption explains why. Once the
            tech taps Mark Complete the job flips to TECH_COMPLETE and
            the button reappears here AND in the cashier dashboard's
            'Awaiting final invoice' bucket. */}
        {canInvoice && est.status ==="APPROVED"&& !est.invoice && jobStatus ==="TECH_COMPLETE"? (
          <form action={generateInvoiceAction}>
            <input type="hidden" name="estimateId" value={est.id} />
            <button className="inline-flex h-12 items-center justify-center rounded-lg bg-accent-500 px-5 text-base font-semibold text-brand-900 hover:bg-accent-400 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("generateInvoice")}
            </button>
          </form>
        ) : null}
        {est.invoice ? (
          <Link href={`/invoices/${est.invoice.id}`} className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
            {t("viewInvoice")}
          </Link>
        ) : null}
      </div>
      {/* Status caption visible WHILE the tech still has the car. Replaces
          the Generate-Invoice button per spec so the cashier sees an
          explicit 'why is there no button right now' message instead of
          guessing. */}
      {est.status ==="APPROVED"&& !est.invoice && workNotComplete ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("estimateApprovedSentToTech")}
        </p>
      ) : null}
      {/* Continue to Workshop — shortcut for MASTER (advisor + tech + cashier
          under one login). Once the estimate is approved and the tech hasn't
          marked complete yet, MASTER often wants to switch hats and go do the
          repair. The tech page's guard is ["TECH","MASTER"], so ADVISOR /
          CASHIER / OWNER wouldn't be able to reach it — button hidden for
          those roles. */}
      {role === "MASTER" && est.status === "APPROVED" && !est.invoice && workNotComplete ? (
        <Link
          href={`/technician/jobs/${est.jobCardId}`}
          className="inline-flex h-12 items-center justify-center rounded-lg bg-brand-900 px-5 text-base font-semibold text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("continueToWorkshop")}
        </Link>
      ) : null}
      <p className="text-xs text-text-mute">
        (Send/approve here simulates the customer; the real WhatsApp approval link is also sent on Send.)
      </p>

      <JobTimeline events={timelineEvents} labels={buildTimelineLabels(t)} />

      </aside>
      </div>
    </main>
  );
}

function StatusButton({
  estimateId,
  status,
  label,
  primary,
}: {
  estimateId: string;
  status: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <form action={setEstimateStatusAction}>
      <input type="hidden" name="estimateId" value={estimateId} />
      <input type="hidden" name="status" value={status} />
      <button
        className={
          primary
            ?"inline-flex h-12 items-center justify-center rounded-lg px-5 text-base font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
            :"inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        }
      >
        {label}
      </button>
    </form>
  );
}
