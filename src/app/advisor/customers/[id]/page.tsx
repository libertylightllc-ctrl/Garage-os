import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { updateCustomerAction } from "@/app/actions/customer";
import { friendlyStatus, type JobStatus } from "@/lib/jobcard-status";
import { FriendlyStatusBadge } from "@/components/friendly-status-badge";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate, countryToTimeZone } from "@/lib/format-datetime";
import { formatInvoiceNo } from "@/lib/billing";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

/**
 * Customer detail surface — the ONE place to edit customer identity
 * (name, phone, TRN) and see the whole relationship from the shop's
 * side: every vehicle they own and every job across those vehicles
 * in one reverse-chronological list.
 *
 * Reached from the vehicle detail page's customer-name link. Also
 * the natural home for the "plate transfer" edits AGENTS.md talks
 * about ("vehicle sold → advisor can edit owner name + mobile") —
 * one form here changes every vehicle's owner in one step, rather
 * than repeating on each vehicle page.
 *
 * Guard: ADVISOR + OWNER + MASTER; garage-scoped. The Customer WHERE
 * pins `garageId` so a stale/forged customerId that lives in another
 * garage returns notFound() rather than leaking.
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const { id } = await params;
  const t = await getT();
  const locale = await getLocale();

  const customer = await prisma.customer.findFirst({
    where: { id, garageId: session.user.garageId },
    select: {
      id: true,
      name: true,
      phone: true,
      phoneNeedsReview: true,
      trn: true,
      // Every vehicle the customer owns. Ordered by createdAt so the
      // list stays stable regardless of visit history.
      vehicles: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          make: true,
          model: true,
          year: true,
          plate: true,
        },
      },
    },
  });
  if (!customer) notFound();

  // Country → tz for the visit-date column. Read once, apply to every
  // date on the page.
  const garage = await prisma.garage.findUnique({
    where: { id: session.user.garageId },
    select: { country: true },
  });
  const tz = countryToTimeZone(garage?.country ?? "UAE");

  // Job history rolled up ACROSS the customer's vehicles. Ordered by
  // createdAt desc so the latest visit reads first. Only the fields
  // the summary row needs — status pill, invoice link, spend value.
  const jobs = await prisma.jobCard.findMany({
    where: {
      garageId: session.user.garageId,
      vehicle: { customerId: customer.id },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      status: true,
      claimedById: true,
      createdAt: true,
      invoiceSentAt: true,
      vehicle: { select: { make: true, model: true, plate: true } },
      invoices: {
        take: 1,
        orderBy: { issuedAt: "desc" },
        select: {
          id: true,
          number: true,
          issuedAt: true,
          total: true,
          payments: { select: { amount: true } },
        },
      },
      estimates: {
        take: 1,
        orderBy: { createdAt: "desc" },
        select: { status: true },
      },
    },
  });

  const totalSpend = jobs.reduce((s, j) => {
    const inv = j.invoices[0];
    if (!inv) return s;
    const paid = inv.payments.reduce((p, x) => p + Number(x.amount), 0);
    return s + paid;
  }, 0);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="vehicles" />

      {/* Header — customer identity + spend at-a-glance. Vehicles
          list follows for context (which cars is this customer)
          before the edit form (which asks "and are these fields
          right for them"). */}
      <div className="flex flex-col gap-1">
        <div className="text-xs uppercase tracking-widest text-text-mute">
          {t("customerDetailKicker")}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {customer.name}
          </h1>
          {/* AR 2026-08-25 Batch B — printable customer statement.
              One added element; existing page logic + reads
              unchanged below. */}
          <Link
            href={`/advisor/customers/${customer.id}/statement`}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold hover:bg-surface-3"
          >
            📄 {t("statementShortLink")}
          </Link>
        </div>
        <p className="text-sm text-text-mute">
          {customer.phone}
          {customer.trn ? (
            <>
              {" · "}
              {t("customerTrnLabel")}{" "}
              <span className="tabular-nums">{customer.trn}</span>
            </>
          ) : null}
        </p>
      </div>

      {/* Edit form — one save covers all three identity fields. This
          is the ONLY writable customer surface (previous per-vehicle
          TRN form was removed at the same time). */}
      <form
        action={updateCustomerAction}
        className="flex flex-col gap-3 rounded-xl border border-border p-4"
      >
        <input type="hidden" name="customerId" value={customer.id} />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-mute">
            {t("customerEditLegend")}
          </span>
          <span className="text-[11px] text-text-mute">
            {t("customerEditHint")}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-mute">
              {t("customerNameLabel")}
            </span>
            <input
              name="name"
              required
              defaultValue={customer.name}
              className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-mute">
              {t("customerPhoneLabel")}
            </span>
            <input
              name="phone"
              type="tel"
              inputMode="tel"
              // Loose shape guard on the client — must start with `+`
              // or a digit, must contain a digit, and can carry spaces
              // / dashes / parens in between. The server's
              // `normalizeCustomerPhoneForWrite` is the source of
              // truth; this just catches "abc" before the round-trip.
              pattern="^\+?[\d\s\-()]+$"
              title="Digits only, optional leading + or 0. Spaces and dashes are OK. UAE mobile: 0501234567 or +971501234567."
              required
              defaultValue={customer.phone}
              aria-invalid={customer.phoneNeedsReview || undefined}
              className={`rounded-md border ${customer.phoneNeedsReview ? "border-warning-500" : "border-border"} bg-transparent px-3 py-2 text-sm font-mono tabular-nums`}
            />
            {customer.phoneNeedsReview ? (
              <span className="text-[11px] text-warning-700 dark:text-warning-500">
                ⚠️ {t("customerPhoneNeedsReview")}
              </span>
            ) : null}
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-text-mute">
            {t("customerTrnLabel")}
          </span>
          <input
            name="trn"
            defaultValue={customer.trn ?? ""}
            placeholder="100000000000003"
            className="rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono tabular-nums"
          />
          <span className="text-[11px] text-text-mute">
            {t("customerTrnEditHint")}
          </span>
        </label>
        <div>
          <button
            type="submit"
            className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
          >
            {t("customerSaveButton")}
          </button>
        </div>
      </form>

      {/* Vehicles the customer owns. Links back to each vehicle's
          detail page. */}
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">
          {t("customerVehiclesHeading")} ({customer.vehicles.length})
        </h2>
        {customer.vehicles.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-mute">
            {t("customerNoVehicles")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {customer.vehicles.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/advisor/vehicles/${v.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface p-3 text-sm hover:bg-surface-2"
                >
                  <span>
                    <span className="font-medium">
                      {v.make} {v.model}
                    </span>
                    {v.year ? (
                      <span className="ms-2 text-text-mute">{v.year}</span>
                    ) : null}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-text-mute">
                    {v.plate}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Job history — rolled up across every vehicle this customer
          owns. Each row shows the job status pill + the invoice link
          (when one exists) so the advisor can jump straight in. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">
            {t("customerJobsHeading")} ({jobs.length})
          </h2>
          <span className="text-xs text-text-mute">
            {t("customerTotalPaid")}{" "}
            <span className="font-semibold tabular-nums text-text">
              {money(totalSpend)}
            </span>
          </span>
        </div>
        {jobs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-text-mute">
            {t("customerNoJobs")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {jobs.map((j) => {
              const inv = j.invoices[0];
              const paid = inv
                ? inv.payments.reduce((s, x) => s + Number(x.amount), 0)
                : 0;
              const invoicePaidInFull = inv
                ? paid >= Number(inv.total)
                : false;
              const fs = friendlyStatus({
                status: j.status as JobStatus,
                claimedById: j.claimedById,
                invoicePaidInFull,
                latestEstimateStatus: (j.estimates[0]?.status ?? null) as
                  | "DRAFT"
                  | "SENT"
                  | "APPROVED"
                  | "REJECTED"
                  | null,
              });
              return (
                <li
                  key={j.id}
                  className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">
                        {j.vehicle.make} {j.vehicle.model}
                      </span>
                      <span className="ms-2 text-xs text-text-mute tabular-nums">
                        {j.vehicle.plate}
                      </span>
                      {j.number != null ? (
                        <span className="ms-2 text-xs text-text-mute tabular-nums">
                          JC-{j.number}
                        </span>
                      ) : null}
                    </span>
                    <FriendlyStatusBadge status={fs} t={t} size="sm" />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-mute">
                    <span className="tabular-nums">
                      {fmtDate(j.createdAt, locale, tz)}
                    </span>
                    {inv ? (
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())}{" "}
                        · {money(Number(inv.total))}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
