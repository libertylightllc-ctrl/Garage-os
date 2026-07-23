import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { Button } from "@/components/ui/button";
import { createPoFromEstimateAction } from "@/app/actions/purchasing";
import {
    pickEstimateForConversion,
    filterConvertibleLines,
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
    searchParams: Promise<{ jobNumber?: string; error?: string }>;
}) {
    const session = await requireAnyRole(["OWNER", "MASTER"]);
    const t = await getT();
    const locale = await getLocale();
    const { jobNumber: rawJobNumber, error } = await searchParams;
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
                              lines: {
                                  select: {
                                      id: true,
                                      kind: true,
                                      partId: true,
                                      declined: true,
                                      description: true,
                                      qty: true,
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
    const pickResult = jobCard
        ? pickEstimateForConversion(jobCard.estimates)
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
                {pickResult?.kind === "none-usable" ? (
                    <p className="rounded-xl border border-warning-500/40 bg-warning-50 px-4 py-3 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
                        {t("estimateNoneUsable").replace("{count}", String(pickResult.totalCount))}
                    </p>
                ) : null}

                {/* Estimate + lines — the convert form. Everything the
                    owner ticks flows into createPoFromEstimateAction. */}
                {jobCard && pickResult?.kind === "picked" && estimateForPreview && filtered ? (
                    <>
                        <section className="space-y-1 rounded-xl border border-border p-4">
                            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {t("estimateChosenHeader")}
                            </h2>
                            <p className="text-sm">
                                {pickResult.reason === "approved"
                                    ? t("estimateChosenApproved").replace(
                                          "{date}",
                                          fmtDate(estimateForPreview.approvedAt!, locale, tz),
                                      )
                                    : t("estimateChosenSent").replace(
                                          "{date}",
                                          fmtDate(estimateForPreview.sentAt!, locale, tz),
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

                                {/* Skipped groups — visible but muted. Tell
                                    the owner exactly what fell out and why,
                                    so they can go fix the underlying data
                                    (add to inventory, uncheck decline). */}
                                {filtered.skippedNoPartId.length > 0 ? (
                                    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide">
                                            {t("skippedNoInventoryHeader").replace(
                                                "{count}",
                                                String(filtered.skippedNoPartId.length),
                                            )}
                                        </p>
                                        <ul className="ms-4 list-disc space-y-0.5">
                                            {filtered.skippedNoPartId.map((l) => (
                                                <li key={l.id}>
                                                    {l.description}{" "}
                                                    <span className="text-xs">
                                                        — {t("skippedNoInventoryHint")}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                        <Link
                                            href="/owner/inventory"
                                            className="mt-1 inline-block text-xs font-medium underline"
                                        >
                                            {t("goToInventory")}
                                        </Link>
                                    </div>
                                ) : null}
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

                                <div className="pt-1">
                                    <Button
                                        type="submit"
                                        variant="hero"
                                        disabled={suppliers.length === 0}
                                    >
                                        {t("createDraftPoFromEstimate")}
                                    </Button>
                                </div>

                                {/* Totals footer for orientation — sum the
                                    convertible prefills so the owner can
                                    eyeball the ballpark before submitting.
                                    Not authoritative (the action re-reads
                                    the form). */}
                                {filtered.convertible.length > 0 ? (
                                    <p className="pt-1 text-xs text-muted-foreground">
                                        {t("approxTotal")}:{" "}
                                        {money(
                                            filtered.convertible.reduce((s, l) => {
                                                const q = Math.max(1, Math.ceil(Number(l.qty)));
                                                const c = l.part ? Number(l.part.cost) : 0;
                                                return s + q * c;
                                            }, 0),
                                        )}
                                    </p>
                                ) : null}
                            </form>
                        )}
                    </>
                ) : null}
            </main>
        </div>
    );
}
