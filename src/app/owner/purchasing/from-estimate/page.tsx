import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { Button } from "@/components/ui/button";
import { FromEstimateSubmit } from "@/components/from-estimate-submit";
import {
    createPoFromEstimateAction,
    autoCreatePartsFromEstimateLinesAction,
} from "@/app/actions/purchasing";
import {
    pickEstimateForConversion,
    filterConvertibleLines,
    slugifyToSku,
    nextAutoSku,
    withCollisionSuffix,
    findNormalizedMatch,
} from "@/lib/estimate-to-po";
import { formatJobNo } from "@/lib/jobcard-fields";

export const dynamic = "force-dynamic";

// Convert an advisor's estimate into a DRAFT purchase order. Two-step
// flow driven by search params:
//   1. no jobNumber → show the lookup input.
//   2. ?jobNumber=42 → resolve the job, pick the right estimate
//      (APPROVED > SENT, per docs/Estimate-to-PO-Spec.md §2.2), and
//      show the parts picker + supplier picker + confirm.
// See docs/Estimate-to-PO-Spec.md for locked design decisions.
export default async function ConvertFromEstimatePage({
    searchParams,
}: {
    searchParams: Promise<{
        jobNumber?: string;
        estimateId?: string;
        error?: string;
    }>;
}) {
    const session = await requireAnyRole(["OWNER", "MASTER"]);
    const t = await getT();
    const locale = await getLocale();
    const {
        jobNumber: rawJobNumber,
        estimateId: rawEstimateId,
        error,
    } = await searchParams;
    // Whitespace/empty guard — a stray `?estimateId=` in the URL should
    // fall back to "no explicit id" instead of failing the find().
    const estimateId = rawEstimateId?.trim() ? rawEstimateId.trim() : undefined;
    const garageId = session.user.garageId;
    const garageRow = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { country: true },
    });
    const tz = countryToTimeZone(garageRow?.country ?? "UAE");

    // Accept either a raw integer or the formatted "JC-YYYY-NNNN" — pull
    // the last group of digits (any leading JC- / year prefix is ignored)
    // so pasted job labels work as well as typed numbers.
    const digits = rawJobNumber?.match(/(\d+)\s*$/)?.[1] ?? null;
    const jobNumberInt = digits ? Number.parseInt(digits, 10) : null;
    const searchAttempted = Boolean(rawJobNumber && rawJobNumber.trim() !== "");

    // Load the job — with its vehicle, customer, estimates + lines with
    // part cost — in a single query so we can walk the whole preview
    // without N+1 round trips (the DB proxy already flakes enough).
    const jobCard =
        jobNumberInt !== null && Number.isFinite(jobNumberInt) && jobNumberInt > 0
            ? await prisma.jobCard.findFirst({
                  where: { garageId, number: jobNumberInt },
                  select: {
                      id: true,
                      number: true,
                      createdAt: true,
                      vehicle: {
                          select: {
                              make: true,
                              model: true,
                              plate: true,
                              customer: { select: { name: true } },
                          },
                      },
                      estimates: {
                          select: {
                              id: true,
                              status: true,
                              approvedAt: true,
                              sentAt: true,
                              // updatedAt — DRAFT tie-break inside the
                              // `multiple` picker sort. See
                              // pickEstimateForConversion for the rule.
                              updatedAt: true,
                              // total — surfaced as a column in the
                              // `multiple` picker list so the owner can
                              // eyeball which revision is which.
                              total: true,
                              lines: {
                                  select: {
                                      id: true,
                                      kind: true,
                                      partId: true,
                                      declined: true,
                                      description: true,
                                      qty: true,
                                      // unitPrice — needed to default
                                      // Part.price in the review form.
                                      // Customer already approved this
                                      // number so it's a safe default.
                                      unitPrice: true,
                                      part: {
                                          select: {
                                              name: true,
                                              sku: true,
                                              cost: true,
                                          },
                                      },
                                  },
                              },
                          },
                      },
                  },
              })
            : null;

    // If the owner searched but nothing came back — either the id was
    // malformed or the number doesn't exist in this garage. Same message
    // for both to avoid enumerating job numbers.
    const notFound = searchAttempted && !jobCard;

    // The picker only makes sense once a job resolves. Compute the
    // estimate + line partitions here so the JSX below stays readable.
    // `estimateId` narrows the pick when the owner clicked a row on
    // the `multiple` list; if the id is stale (e.g., points at a
    // REJECTED row now), the classifier falls back to `multiple` so
    // the owner sees what's actually available.
    const pickResult = jobCard
        ? pickEstimateForConversion(jobCard.estimates, estimateId)
        : null;
    const estimateForPreview =
        pickResult?.kind === "picked" ? pickResult.estimate : null;
    const filtered = estimateForPreview
        ? filterConvertibleLines(estimateForPreview.lines)
        : null;

    // Active suppliers for the picker (dropdown). MASTER-scoped like
    // every other supplier surface.
    const suppliers = estimateForPreview
        ? await prisma.supplier.findMany({
              where: { garageId, active: true },
              orderBy: { name: "asc" },
              select: { id: true, name: true },
          })
        : [];

    // Load existing garage parts for the "link to existing" suggestion.
    // The review form calls findNormalizedMatch against this set per row
    // to render "Looks like your existing X — link, or create new?".
    // Only fetched when there's actually a review section to render
    // (skippedNoPartId > 0) — no need to load 2000 parts on every render.
    const hasAutoCreateCandidates =
        (filtered?.skippedNoPartId.length ?? 0) > 0;
    const existingParts = hasAutoCreateCandidates
        ? await prisma.part.findMany({
              where: { garageId, active: true },
              select: { id: true, sku: true, name: true },
              orderBy: { name: "asc" },
          })
        : [];

    // Job-card year (rendering only) — used with formatJobNo(number, year)
    // to render the familiar JC-YYYY-NNNN label.
    const jobYear = jobCard ? jobCard.createdAt.getFullYear() : new Date().getFullYear();

    const money = (v: number) =>
        new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);

    return (
        <div>
            <AppNav role="OWNER" active="purchasing" />
            <main className="mx-auto max-w-3xl space-y-6 p-6">
                <div>
                    <Link
                        href="/owner/purchasing"
                        className="text-xs uppercase tracking-widest text-muted-foreground underline-offset-2 hover:underline"
                    >
                        {t("backToPurchasing")}
                    </Link>
                    <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                        {t("convertFromEstimateTitle")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t("convertFromEstimateHint")}
                    </p>
                </div>

                {error ? (
                    <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
                        {error}
                    </p>
                ) : null}

                {/* Step 1 — job-card lookup. Always visible so the owner
                    can search again without back-buttoning. */}
                <form
                    method="get"
                    className="flex flex-wrap items-end gap-3 rounded-xl border border-border p-4"
                >
                    <label className="flex min-w-[200px] flex-1 flex-col gap-1">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                            {t("jobCardNumberLabel")}
                        </span>
                        <input
                            name="jobNumber"
                            type="text"
                            inputMode="numeric"
                            placeholder={t("jobCardNumberPlaceholder")}
                            defaultValue={rawJobNumber ?? ""}
                            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                        />
                    </label>
                    <Button type="submit">{t("lookupJob")}</Button>
                </form>

                {notFound ? (
                    <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
                        {t("jobCardNotFound")}
                    </p>
                ) : null}

                {/* Step 2 — job resolved. Show what we found so the owner
                    can confirm it's the right car BEFORE ticking anything. */}
                {jobCard ? (
                    <section className="space-y-2 rounded-xl border border-border p-4">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t("jobConfirmHeader")}
                        </h2>
                        <p className="text-base font-medium">
                            {formatJobNo(jobCard.number, jobYear) ?? "—"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                            {jobCard.vehicle.make} {jobCard.vehicle.model} · {jobCard.vehicle.plate}
                            {jobCard.vehicle.customer?.name
                                ? <> · {jobCard.vehicle.customer.name}</>
                                : null}
                        </p>
                    </section>
                ) : null}

                {/* Estimate selection outcomes — every branch must have a
                    helpful message; a silent "nothing here" would leave
                    the owner unsure whether they picked the wrong job or
                    the advisor hasn't priced it yet. */}
                {pickResult?.kind === "no-estimate" ? (
                    <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        {t("estimateNone")}
                    </p>
                ) : null}
                {pickResult?.kind === "all-rejected" ? (
                    <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        {t("estimateAllRejected").replace("{count}", String(pickResult.totalCount))}
                    </p>
                ) : null}

                {/* Multi-usable picker — the owner explicitly clicks the
                    revision they want, rather than us guessing between
                    (say) an APPROVED and a DRAFT. Each row links back to
                    this same page with `estimateId=…` so the picked
                    branch fires on the next render and everything below
                    (convertible lines, review, supplier picker) renders
                    exactly as today. */}
                {jobCard && pickResult?.kind === "multiple" ? (
                    <section className="space-y-3 rounded-xl border border-border p-4">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t("estimateMultipleHeader")}
                        </h2>
                        <ul className="flex flex-col gap-2">
                            {pickResult.estimates.map((e) => {
                                const stampIso =
                                    e.approvedAt?.toISOString() ??
                                    e.sentAt?.toISOString() ??
                                    e.updatedAt.toISOString();
                                const stamp = fmtDate(new Date(stampIso), locale, tz);
                                const statusLabel = t(
                                    `estimateStatus_${e.status}` as const,
                                );
                                const partsIn = e.lines.length;
                                const href = `/owner/purchasing/from-estimate?jobNumber=${jobCard.number}&estimateId=${encodeURIComponent(e.id)}`;
                                return (
                                    <li
                                        key={e.id}
                                        className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded-lg border border-border/60 p-3 text-sm"
                                    >
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                                                    {statusLabel}
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                    {stamp}
                                                </span>
                                            </div>
                                        </div>
                                        <span className="tabular-nums text-xs text-muted-foreground">
                                            {t("estimateLinesCount").replace(
                                                "{count}",
                                                String(partsIn),
                                            )}
                                        </span>
                                        <span className="tabular-nums text-sm font-medium">
                                            {money(Number(e.total))}
                                        </span>
                                        <Link
                                            href={href}
                                            className="rounded-md border border-border bg-surface-2 px-3 py-1 text-xs font-medium hover:underline"
                                        >
                                            {t("estimateUseThis")}
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ) : null}

                {/* Estimate + lines — the convert form. Everything the
                    owner ticks flows into createPoFromEstimateAction. */}
                {jobCard && pickResult?.kind === "picked" && estimateForPreview && filtered ? (
                    <>
                        <section className="space-y-1 rounded-xl border border-border p-4">
                            <div className="flex items-center gap-2">
                                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    {t("estimateChosenHeader")}
                                </h2>
                                {/* Source-status label — informational only,
                                    not a gate. Tells the owner whether the
                                    PO they're about to file was sourced
                                    from a DRAFT / SENT / APPROVED estimate.
                                    Reads at a glance next to the header. */}
                                <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {t(
                                        `estimateStatus_${estimateForPreview.status}` as const,
                                    )}
                                </span>
                            </div>
                            <p className="text-sm">
                                {pickResult.reason === "approved"
                                    ? t("estimateChosenApproved").replace(
                                          "{date}",
                                          fmtDate(estimateForPreview.approvedAt!, locale, tz),
                                      )
                                    : pickResult.reason === "sent"
                                    ? t("estimateChosenSent").replace(
                                          "{date}",
                                          fmtDate(estimateForPreview.sentAt!, locale, tz),
                                      )
                                    : t("estimateChosenDraft").replace(
                                          "{date}",
                                          fmtDate(estimateForPreview.updatedAt, locale, tz),
                                      )}
                            </p>
                        </section>

                        {filtered.convertible.length === 0 ? (
                            <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                                {t("noConvertibleParts")}
                            </p>
                        ) : (
                            <form
                                action={createPoFromEstimateAction}
                                className="space-y-4 rounded-xl border border-border p-4"
                            >
                                <input type="hidden" name="jobCardId" value={jobCard.id} />
                                <input type="hidden" name="estimateId" value={estimateForPreview.id} />

                                <div className="space-y-2">
                                    <h2 className="text-base font-semibold tracking-tight">
                                        {t("partsToConvertHeader")}
                                    </h2>
                                    <p className="text-xs text-muted-foreground">
                                        {t("partsToConvertHint")}
                                    </p>
                                </div>

                                {/* Convertible lines — checkbox on the left,
                                    qty + cost inputs on the right. Cost is
                                    prefilled from Part.cost, NEVER from the
                                    estimate's unitPrice (customer charge). */}
                                <div className="space-y-2">
                                    {filtered.convertible.map((l) => {
                                        // qty prefill: EstimateLine.qty is Decimal but
                                        // PurchaseOrderLine.qty is Int. Ceil handles the
                                        // rare fractional case (0.5L oil → order 1L)
                                        // without ever dropping to 0.
                                        const qtyPrefill = Math.max(
                                            1,
                                            Math.ceil(Number(l.qty)),
                                        );
                                        const costPrefill = l.part
                                            ? Number(l.part.cost).toFixed(2)
                                            : "0.00";
                                        return (
                                            <label
                                                key={l.id}
                                                className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 border-b border-border/60 pb-2 last:border-0"
                                            >
                                                <input
                                                    type="checkbox"
                                                    name="include"
                                                    value={l.id}
                                                    defaultChecked
                                                    className="h-4 w-4"
                                                />
                                                <span className="min-w-0 truncate text-sm">
                                                    <span className="font-medium">
                                                        {l.part?.name ?? l.description}
                                                    </span>
                                                    {l.part?.sku ? (
                                                        <span className="ms-2 font-mono text-xs text-muted-foreground">
                                                            {l.part.sku}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                <input
                                                    type="number"
                                                    name={`qty_${l.id}`}
                                                    min="1"
                                                    step="1"
                                                    required
                                                    defaultValue={qtyPrefill}
                                                    aria-label={t("colQty")}
                                                    className="w-16 rounded-md border border-border bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                                                />
                                                <input
                                                    type="number"
                                                    name={`cost_${l.id}`}
                                                    min="0"
                                                    step="0.01"
                                                    required
                                                    defaultValue={costPrefill}
                                                    aria-label={t("poUnitCost")}
                                                    className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-right text-sm tabular-nums"
                                                />
                                            </label>
                                        );
                                    })}
                                </div>

                                {filtered.skippedDeclined.length > 0 ? (
                                    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide">
                                            {t("skippedDeclinedHeader").replace(
                                                "{count}",
                                                String(filtered.skippedDeclined.length),
                                            )}
                                        </p>
                                        <ul className="ms-4 list-disc space-y-0.5">
                                            {filtered.skippedDeclined.map((l) => (
                                                <li key={l.id}>{l.description}</li>
                                            ))}
                                        </ul>
                                    </div>
                                ) : null}

                                <label className="flex flex-col gap-1">
                                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                                        {t("poSupplier")}
                                    </span>
                                    {suppliers.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">
                                            {t("noSuppliersForPo")}{" "}
                                            <Link
                                                href="/owner/suppliers"
                                                className="font-medium text-foreground hover:underline"
                                            >
                                                {t("tabSuppliers")}
                                            </Link>
                                            .
                                        </p>
                                    ) : (
                                        <select
                                            name="supplierId"
                                            required
                                            defaultValue=""
                                            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
                                        >
                                            <option value="" disabled>
                                                {t("choosePlaceholder")}
                                            </option>
                                            {suppliers.map((s) => (
                                                <option key={s.id} value={s.id}>
                                                    {s.name}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </label>

                                {/* Button label + approx-total live in a
                                    client component that watches the actual
                                    cost inputs — the doc kind switches to
                                    "Create request for quotation" the moment
                                    any cost is 0 (or blank / negative), and
                                    approx-total disappears in that case. See
                                    from-estimate-submit.tsx. */}
                                {filtered.convertible.length > 0 ? (
                                    <FromEstimateSubmit
                                        disabled={suppliers.length === 0}
                                        labelPo={t("createDraftPoFromEstimate")}
                                        labelRfq={t("createRfqFromEstimate")}
                                        approxTotalLabel={t("approxTotal")}
                                        // Client component re-runs the total
                                        // over the LIVE inputs (not the server
                                        // prefill, which is 0 for
                                        // uncosted-in-inventory parts). Locale
                                        // + currency matches the internal
                                        // `money()` above so the two hints in
                                        // this file agree on formatting.
                                        locale="en-AE"
                                        currency="AED"
                                    />
                                ) : (
                                    <div className="pt-1">
                                        <Button
                                            type="submit"
                                            variant="hero"
                                            disabled={suppliers.length === 0}
                                        >
                                            {t("createDraftPoFromEstimate")}
                                        </Button>
                                    </div>
                                )}
                            </form>
                        )}

                        {/* Free-text lines review — SIBLING of the PO form,
                            not a descendant. Nested <form>s are invalid HTML
                            and produced the hydration warning AR flagged as
                            "2 Issues". Rendering here also makes the review
                            reachable when there are NO convertible lines
                            (previously it was hidden inside the convertible
                            branch). autoCreatePartsFromEstimateLinesAction
                            back-fills EstimateLine.partId only. */}
                        {filtered.skippedNoPartId.length > 0 ? (
                            <form
                                action={autoCreatePartsFromEstimateLinesAction}
                                className="rounded-lg border border-warning-500/40 bg-warning-50 p-4 dark:border-warning-500/30 dark:bg-warning-500/10"
                            >
                                <input type="hidden" name="jobCardId" value={jobCard.id} />
                                <input
                                    type="hidden"
                                    name="estimateId"
                                    value={estimateForPreview!.id}
                                />
                                <p className="mb-3 text-sm font-semibold text-warning-700 dark:text-warning-500">
                                    {t("autoCreateHeader").replace(
                                        "{count}",
                                        String(filtered.skippedNoPartId.length),
                                    )}
                                </p>
                                <p className="mb-4 text-xs text-warning-700 dark:text-warning-500">
                                    {t("autoCreateHint")}
                                </p>
                                <ul className="flex flex-col gap-3">
                                    {(() => {
                                        const takenForDefaults = new Set(
                                            existingParts.map((p) => p.sku),
                                        );
                                        return filtered.skippedNoPartId.map((l) => {
                                            const match = findNormalizedMatch(
                                                l.description,
                                                existingParts,
                                            );
                                            const slug = slugifyToSku(l.description);
                                            const defaultSku = slug
                                                ? withCollisionSuffix(slug, takenForDefaults)
                                                : nextAutoSku(takenForDefaults);
                                            takenForDefaults.add(defaultSku);
                                            return (
                                                <li
                                                    key={l.id}
                                                    className="rounded-lg border border-border bg-surface p-3"
                                                >
                                                    <div className="mb-2 text-sm font-medium">
                                                        {l.description}
                                                    </div>
                                                    {match ? (
                                                        <label className="mb-2 flex items-start gap-2 rounded border border-info-500/40 bg-info-50 p-2 text-xs text-info-700 dark:border-info-500/30 dark:bg-info-500/10 dark:text-info-500">
                                                            <input
                                                                type="checkbox"
                                                                name={`linkTo_${l.id}`}
                                                                value={match.id}
                                                                className="mt-0.5"
                                                                defaultChecked
                                                            />
                                                            <span>
                                                                {t("autoCreateLinkExisting")
                                                                    .replace("{name}", match.name)
                                                                    .replace("{sku}", match.sku)}
                                                            </span>
                                                        </label>
                                                    ) : null}
                                                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                                        <label className="flex flex-col gap-1">
                                                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                                {t("colSku")}
                                                            </span>
                                                            <input
                                                                name={`sku_${l.id}`}
                                                                defaultValue={defaultSku}
                                                                className="rounded border border-border bg-transparent px-2 py-1 text-sm tabular-nums"
                                                            />
                                                        </label>
                                                        <label className="flex flex-col gap-1">
                                                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                                {t("colName")}
                                                            </span>
                                                            <input
                                                                name={`name_${l.id}`}
                                                                defaultValue={l.description}
                                                                className="rounded border border-border bg-transparent px-2 py-1 text-sm"
                                                            />
                                                        </label>
                                                        <label className="flex flex-col gap-1">
                                                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                                {t("colCost")}
                                                            </span>
                                                            <input
                                                                name={`cost_${l.id}`}
                                                                type="number"
                                                                step="0.01"
                                                                min="0"
                                                                defaultValue="0"
                                                                className="rounded border border-border bg-transparent px-2 py-1 text-sm tabular-nums"
                                                            />
                                                            <span className="text-[10px] text-muted-foreground">
                                                                {t("autoCreateCostHint")}
                                                            </span>
                                                        </label>
                                                        <label className="flex flex-col gap-1">
                                                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                                {t("colPrice")}
                                                            </span>
                                                            <input
                                                                name={`price_${l.id}`}
                                                                type="number"
                                                                step="0.01"
                                                                min="0"
                                                                defaultValue={Number(
                                                                    l.unitPrice,
                                                                ).toFixed(2)}
                                                                className="rounded border border-border bg-transparent px-2 py-1 text-sm tabular-nums"
                                                            />
                                                        </label>
                                                    </div>
                                                </li>
                                            );
                                        });
                                    })()}
                                </ul>
                                <div className="mt-4 flex flex-wrap items-center gap-3">
                                    <Button type="submit">
                                        {t("autoCreateSubmit")}
                                    </Button>
                                    <Link
                                        href="/owner/inventory"
                                        className="text-xs font-medium text-muted-foreground underline"
                                    >
                                        {t("goToInventory")}
                                    </Link>
                                </div>
                            </form>
                        ) : null}
                    </>
                ) : null}
            </main>
        </div>
    );
}
