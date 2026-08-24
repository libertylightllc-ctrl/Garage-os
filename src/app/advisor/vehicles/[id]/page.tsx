import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { friendlyStatus, type JobStatus } from "@/lib/jobcard-status";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { translateLineDescription } from "@/lib/line-item-translations";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { formatInvoiceNo } from "@/lib/billing";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Read-only vehicle service history — slice 'service history'.
 *
 * Pulls every JobCard for the vehicle (this garage only) with its
 * invoice + lines + payments + tech findings, then renders:
 *
 *   - A summary header card: total visits, total paid spend, last
 *     visit date, last oil change (date + mileage if found).
 *   - A reverse-chronological list of past visits. Each visit row
 *     shows: date, mileage IN, complaint, work-done (tech findings),
 *     job status badge, parts replaced (PART lines from the invoice),
 *     invoice number + total + paid amount.
 *
 * Read-only — no actions, no money writes. Garage-scoped via the
 * customer relation: a vehicle whose owner.garageId doesn't match the
 * caller is 404, not 403, so we don't leak existence of other-tenant
 * data.
 *
 * 'Last oil change' detection is a string heuristic over invoice line
 * descriptions: case-insensitive /oil/ match. Covers 'Engine oil',
 * 'Oil filter', 'Oil change service' alike. The dictionary in
 * line-item-translations.ts already maps these to Arabic at render.
 */

const OIL_RE = /oil/i;

export default async function VehicleHistory({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();
  const garage = await prisma.garage.findUnique({
    where: { id: session.user.garageId },
    select: { country: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");
  const ymd = (d: Date) => fmtDate(d, locale, tz);

  // Explicit `select` on every level instead of `include`. This
  // narrows the Prisma query to ONLY the columns the render reads —
  // so any schema column that exists in the Prisma client but isn't
  // in the live DB (a drift from prior unmigrated additions) no longer
  // affects this page. Also try/catch the fetch so we can surface a
  // human-friendly 'couldn't load history' message instead of the
  // generic red error card, AND log the real error to Vercel function
  // logs for follow-up debugging.
  async function loadVehicle() {
    return prisma.vehicle.findFirst({
      where: { id, customer: { garageId: session.user.garageId } },
      select: {
        id: true,
        make: true,
        model: true,
        year: true,
        plate: true,
        vin: true,
        // `id` + `trn` added 2026-08-07 for the customer-TRN edit
        // affordance further down: id targets the update, trn preloads
        // the input.
        customer: { select: { id: true, name: true, phone: true, trn: true } },
        jobCards: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            createdAt: true,
            claimedById: true,
            mileageIn: true,
            complaint: true,
            finding: { select: { findings: true, diagnosis: true } },
            invoices: {
              orderBy: { issuedAt: "desc" },
              select: {
                id: true,
                number: true,
                issuedAt: true,
                total: true,
                lines: {
                  orderBy: { createdAt: "asc" },
                  select: {
                    id: true,
                    kind: true,
                    description: true,
                    qty: true,
                    lineTotal: true,
                  },
                },
                payments: { select: { amount: true } },
              },
            },
          },
        },
      },
    });
  }
  type VehicleResult = Awaited<ReturnType<typeof loadVehicle>>;
  let vehicle: VehicleResult = null;
  let fetchError: string | null = null;
  try {
    vehicle = await loadVehicle();
  } catch (err) {
    // Log the real Prisma error to Vercel function logs so we have
    // it for follow-up. Then render a graceful fallback instead of
    // the red error card so the advisor can still take other actions.
    console.error("[vehicle-history]", err);
    fetchError =
      err instanceof Error ? err.message : "Unknown error loading history";
  }
  // ── Graceful fetch-error render ─────────────────────────────────
  // If the Prisma query threw (e.g. a column or relation expected by
  // the schema but missing from the live DB), render a clean fallback
  // page instead of letting the error bubble up to the red error
  // card. The advisor can still navigate back to the search and use
  // every other surface; only this page degrades.
  // (Guards split into two so TypeScript narrows `vehicle` to
  // non-null on the happy path below.)
  if (fetchError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
        <AppNav role="ADVISOR" active="vehicles" />
        <Link
          href="/advisor/vehicles"
          className="inline-block py-2 text-sm text-text-mute hover:underline"
        >
          ← {t("vehiclesBackToSearch")}
        </Link>
        <div className="flex flex-col gap-3 rounded-xl border border-danger-500/40 bg-danger-50 p-6 text-sm dark:border-danger-500/30 dark:bg-danger-500/10">
          <h1 className="text-lg font-semibold text-danger-700 dark:text-danger-500">
            {t("vehiclesLoadErrorTitle")}
          </h1>
          <p className="text-text">{t("vehiclesLoadErrorBody")}</p>
          <pre className="select-all whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 text-xs font-mono">
            {fetchError}
          </pre>
        </div>
      </main>
    );
  }
  if (!vehicle) {
    notFound();
    return null; // unreachable; satisfies TypeScript's narrowing
  }
  const jobs = vehicle.jobCards;

  // ── Summary aggregations ────────────────────────────────────────
  // totalSpend = sum of payments across all invoices for this vehicle.
  // Using Payment rows (not invoice.total) so an unpaid SENT invoice
  // doesn't inflate the 'spend' number — only money actually received.
  let totalSpend = 0;
  for (const j of jobs) {
    for (const inv of j.invoices) {
      for (const p of inv.payments) totalSpend += Number(p.amount);
    }
  }

  // Last oil change: scan invoice lines for /oil/ description on the
  // newest job that has one. Capture invoice issuedAt as the 'date'
  // and the matching JobCard.mileageIn as the 'mileage'.
  type OilHit = { at: Date; mileage: number | null; description: string };
  let lastOil: OilHit | null = null;
  for (const j of jobs) {
    for (const inv of j.invoices) {
      const oilLine = inv.lines.find(
        (l) => l.kind === "PART" || l.kind === "LABOR",
      )
        ? inv.lines.find((l) => OIL_RE.test(l.description))
        : null;
      if (oilLine) {
        const hitDate = inv.issuedAt;
        // jobs are sorted newest-first, so the first hit IS the most
        // recent. break the outer loop after capturing.
        if (!lastOil || hitDate > lastOil.at) {
          lastOil = {
            at: hitDate,
            mileage: j.mileageIn,
            description: oilLine.description,
          };
        }
      }
    }
  }

  const lastVisit = jobs[0]?.createdAt ?? null;
  const visitCount = jobs.length;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="vehicles" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/advisor/vehicles"
          className="inline-block py-2 text-sm text-text-mute hover:underline"
        >
          ← {t("vehiclesBackToSearch")}
        </Link>
        {/* AR 2026-08-25 Batch A. Discoverability for the new
            printable vehicle-history lookup. One-line addition;
            existing screen render below is unchanged. */}
        <Link
          href={`/advisor/vehicles/${vehicle.id}/history`}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold hover:bg-surface-3"
        >
          🖨 {t("vehicleHistoryPrintableLink")}
        </Link>
      </div>

      {/* Header — vehicle identity + owner. Big plate so the
          advisor can confirm at a glance they're on the right
          vehicle before reading any history. */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {vehicle.make} {vehicle.model}
          {vehicle.year ? ` · ${vehicle.year}` : ""}
        </h1>
        <p className="text-sm text-text-mute">
          <span className="font-semibold tabular-nums text-text">
            {vehicle.plate}
          </span>{" "}
          ·{" "}
          {/* Customer name links to the customer detail surface
              (/advisor/customers/[id]) — where name / phone / TRN
              edits and the customer's full history live. The old
              per-vehicle TRN edit form was removed at the same time:
              TRN belongs to the customer, not the car, and a
              customer with three cars used to see the field three
              times. */}
          <Link
            href={`/advisor/customers/${vehicle.customer.id}`}
            className="font-medium text-foreground hover:underline"
          >
            {vehicle.customer.name}
          </Link>{" "}
          · {vehicle.customer.phone}
          {vehicle.vin ? (
            <>
              <br />
              <span className="text-xs">VIN: {vehicle.vin}</span>
            </>
          ) : null}
        </p>
      </div>

      {/* Summary card — 4-up grid of headline numbers, same shape
          as the owner-dashboard metric cards. tabular-nums on every
          number so they read like an instrument cluster. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
            {t("vehiclesVisits")}
          </div>
          <div className="mt-auto pt-2 text-xl font-semibold tabular-nums">
            {visitCount}
          </div>
        </div>
        <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
            {t("vehiclesTotalSpend")}
          </div>
          <div className="mt-auto pt-2 text-xl font-semibold tabular-nums">
            {money(totalSpend)}
          </div>
        </div>
        <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
            {t("vehiclesLastVisit")}
          </div>
          <div className="mt-auto pt-2 text-base font-semibold tabular-nums">
            {lastVisit ? ymd(lastVisit) : "—"}
          </div>
        </div>
        <div className="flex h-full flex-col rounded-xl border border-border bg-surface p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
            {t("vehiclesLastOilChange")}
          </div>
          <div className="mt-auto pt-2 text-sm font-semibold">
            {lastOil ? (
              <>
                <div className="tabular-nums">{ymd(lastOil.at)}</div>
                {lastOil.mileage !== null ? (
                  <div className="text-xs font-normal text-text-mute tabular-nums">
                    {t("vehiclesAtMileage")}{" "}
                    {lastOil.mileage.toLocaleString()} km
                  </div>
                ) : null}
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>

      {/* History list — newest visit first. Each visit is a card
          with the visit metadata at the top and the parts/work
          breakdown inside. Empty state is its own dashed-border card
          so a brand-new vehicle reads cleanly as 'no history yet'. */}
      {jobs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("vehiclesNoHistory")}
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("vehiclesVisitHistory")}</h2>
          <ul className="flex flex-col gap-3">
            {jobs.map((j) => {
              const inv = j.invoices[0] ?? null;
              const paid = inv
                ? inv.payments.reduce((s, p) => s + Number(p.amount), 0)
                : 0;
              const partsLines = inv
                ? inv.lines.filter((l) => l.kind === "PART")
                : [];
              const laborLines = inv
                ? inv.lines.filter((l) => l.kind === "LABOR")
                : [];
              return (
                <li
                  key={j.id}
                  className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-sm"
                >
                  {/* Visit header — date + mileage + status badge */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold tabular-nums">
                        {ymd(j.createdAt)}
                      </div>
                      {j.mileageIn !== null ? (
                        <div className="text-xs text-text-mute tabular-nums">
                          {j.mileageIn.toLocaleString()} km
                        </div>
                      ) : null}
                    </div>
                    <FriendlyStatusBadge
                      status={friendlyStatus({
                        status: j.status as JobStatus,
                        claimedById: j.claimedById,
                      })}
                      t={t}
                      size="sm"
                    />
                  </div>

                  {j.complaint ? (
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
                        {t("vehiclesComplaint")}
                      </div>
                      <p className="mt-0.5">{j.complaint}</p>
                    </div>
                  ) : null}

                  {j.finding?.findings || j.finding?.diagnosis ? (
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
                        {t("vehiclesWorkDone")}
                      </div>
                      {j.finding?.findings ? (
                        <p className="mt-0.5">{j.finding.findings}</p>
                      ) : null}
                      {j.finding?.diagnosis ? (
                        <p className="mt-1 text-text-mute">
                          {j.finding.diagnosis}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {partsLines.length > 0 ? (
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
                        {t("vehiclesPartsReplaced")}
                      </div>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {partsLines.map((l) => (
                          <li
                            key={l.id}
                            className="flex justify-between gap-2"
                          >
                            <span>
                              {translateLineDescription(l.description, locale)}
                            </span>
                            <span className="tabular-nums text-text-mute">
                              ×{Number(l.qty)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {laborLines.length > 0 ? (
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-text-mute">
                        {t("vehiclesLabor")}
                      </div>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {laborLines.map((l) => (
                          <li
                            key={l.id}
                            className="flex justify-between gap-2"
                          >
                            <span>
                              {translateLineDescription(l.description, locale)}
                            </span>
                            <span className="tabular-nums text-text-mute">
                              {money(Number(l.lineTotal))}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {inv ? (
                    /* Invoice footer row — number + total + paid +
                       a 'View invoice' link to the detail page (still
                       garage-scoped via the invoice id). */
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                      <div className="flex flex-col gap-0.5">
                        <Link
                          href={`/invoices/${inv.id}`}
                          className="text-xs font-semibold text-text hover:underline"
                        >
                          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}
                        </Link>
                        <span className="text-xs text-text-mute">
                          {t("vehiclesPaid")}{" "}
                          <span className="tabular-nums text-text">
                            {money(paid)}
                          </span>{" "}
                          / {money(Number(inv.total))}
                        </span>
                      </div>
                      <span className="text-base font-semibold tabular-nums">
                        {money(Number(inv.total))}
                      </span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
