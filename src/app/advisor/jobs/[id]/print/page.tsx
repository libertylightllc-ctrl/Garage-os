import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { PrintButton } from "@/components/print-button";
import { JobNumberBadge } from "@/components/job-number-badge";
import { getT, getLocale } from "@/i18n/server";
import { fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import type { MessageKey } from "@/i18n/config";
import {
  EXTERIOR_OPTIONS,
  INTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
} from "@/lib/jobcard-fields";

export const dynamic = "force-dynamic";

/**
 * Printable customer job-card receipt — the CUSTOMER-facing paper the
 * shop hands the owner at drop-off. Redesigned 2026-07-23 as a bordered
 * WORKSHOP FORM (not a modern label/value card grid): every field sits
 * in its own ruled cell so the printed A4 reads like the paper form
 * customers are used to signing.
 *
 * Border colours:
 *   Cell / section borders use `border-zinc-800/40` — a computed RGBA
 *   that survives print CSS in every browser I've tested. Do NOT swap
 *   to `border-border` (a Tailwind CSS variable that gets stripped by
 *   `print:border-0` further up the tree). The outer card explicitly
 *   drops its border on print (via `print:border-0`); the INNER cell
 *   borders below are the ones that must show up on paper.
 *
 * RTL: uses logical properties throughout — `text-end`, `border-inline-*`,
 *   `flex justify-between`. Arabic flips layout without breaking cell
 *   grids. See the AR/RTL screenshot in the print-preview verification
 *   run (2026-07-23).
 *
 * CONTENT is unchanged from aed803d: garage header + TRN, job number,
 * check-in stamp, customer identity, vehicle spec, complaint in the
 * customer's words, condition checklists (exterior + interior +
 * valuables), Moulkia consent stamp when applicable, and signature
 * lines. Everything the customer needs to sign "yes my car had these
 * dents when I dropped it off" is on this sheet.
 *
 * OMITTED by design: assigned tech, bay, priority, job status, and any
 * estimate/invoice state. Those are internal operational metadata. If
 * the shop later wants an internal-sheet variant (assigned tech / bay /
 * priority visible, dispute-shield fine print off), a ?variant=internal
 * query param on this same route is the future hook — don't build the
 * toggle yet.
 */

// Cell shared by the Vehicle grid: label on top in small caps, value
// below. `bold`/`mono` opt-ins tune the value's typography (plate is
// bold, VIN + mileage use tabular-nums for alignment).
function Cell({
  label,
  value,
  bold,
  mono,
}: {
  label: string;
  value: string | number;
  bold?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="rounded border border-zinc-800/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">
        {label}
      </div>
      <div
        className={
          "mt-0.5 text-sm " +
          (bold ? "font-semibold " : "") +
          (mono ? "tabular-nums " : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

export default async function JobCardPrint({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Same guard as the edit page so an advisor / owner / master can open
  // this from the job detail. Not intended for tech / cashier — they
  // don't hand paper to the customer at drop-off.
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const locale = await getLocale();

  const job = await prisma.jobCard.findFirst({
    where: { id, garageId: session.user.garageId },
    include: {
      vehicle: { include: { customer: true } },
      garage: { select: { name: true, trn: true, country: true } },
    },
  });
  if (!job) notFound();

  const { customer } = job.vehicle;
  const { garage } = job;
  const tz = countryToTimeZone(garage.country);
  const checkIn = fmtDateTime(job.createdAt, locale, tz);
  // Tick / empty box glyphs render cleanly on print (unlike inline SVG,
  // which some printer drivers strip) and read as a paper form the
  // customer is used to signing.
  const tick = (on: boolean) => (on ? "☑" : "☐");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 print:max-w-full print:min-h-0 print:bg-white print:p-0">
      {/* White paper card even on-screen so the preview reads like the
          document the customer will hold. Card chrome drops on print. */}
      <div className="rounded-xl border border-border bg-white p-6 text-zinc-900 shadow-sm dark:bg-white dark:shadow-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* Header — stacked document identity on the start side, garage
            block on the end side. Each stack line is text-sm so the JC
            number stays the same size it was before the redesign — the
            change here is stacking, not sizing. */}
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("jobCardPrintTitle")}
            </h1>
            {job.number ? (
              <div className="text-sm text-zinc-600">
                <JobNumberBadge jobCard={job} className="tabular-nums" />
              </div>
            ) : null}
            <div className="text-sm text-zinc-600">
              {job.vehicle.make} {job.vehicle.model}
              {job.vehicle.year ? ` ${job.vehicle.year}` : ""}
            </div>
            <div className="text-sm text-zinc-600">{job.vehicle.plate}</div>
          </div>
          <div className="text-end text-sm">
            <div className="font-medium">{garage.name}</div>
            <div className="text-zinc-600">TRN: {garage.trn ?? "—"}</div>
            <div className="text-zinc-600">{garage.country}</div>
          </div>
        </header>

        {/* Customer + Check-in — bordered cells side by side. Customer
            gets 2/3 width because it holds name + phone + email; check-in
            takes 1/3. */}
        <section className="mt-5 grid grid-cols-3 gap-2 break-inside-avoid">
          <div className="col-span-2 rounded border border-zinc-800/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("secCustomer")}
            </div>
            <div className="mt-0.5 text-sm font-medium">{customer.name}</div>
            <div className="text-sm text-zinc-700">{customer.phone}</div>
            {customer.email ? (
              <div className="text-sm text-zinc-700">{customer.email}</div>
            ) : null}
          </div>
          <div className="rounded border border-zinc-800/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("checkInLabel")}
            </div>
            <div className="mt-0.5 text-sm tabular-nums">{checkIn}</div>
          </div>
        </section>

        {/* Vehicle — 3-column grid of bordered cells, one per field. */}
        <section className="mt-4 break-inside-avoid">
          <h2 className="mb-1.5 text-sm font-semibold">{t("secVehicle")}</h2>
          <div className="grid grid-cols-3 gap-2">
            <Cell label={t("make")} value={job.vehicle.make} />
            <Cell label={t("model")} value={job.vehicle.model} />
            <Cell label={t("yearLabel")} value={job.vehicle.year ?? "—"} />
            <Cell label={t("plate")} value={job.vehicle.plate} bold />
            <Cell label={t("vinLabel")} value={job.vehicle.vin ?? "—"} mono />
            <Cell
              label={t("engineSizeLabel")}
              value={job.vehicle.engineSize ?? "—"}
            />
            <Cell
              label={t("fuelTypeLabel")}
              value={
                job.vehicle.fuelType
                  ? t(`fuelType_${job.vehicle.fuelType}` as MessageKey)
                  : "—"
              }
            />
            <Cell
              label={t("mileageInLabel")}
              value={
                job.mileageIn != null ? job.mileageIn.toLocaleString(locale) : "—"
              }
              mono
            />
            <Cell
              label={t("fuelLevelLabel")}
              value={
                job.fuelLevel ? t(`fuel_${job.fuelLevel}` as MessageKey) : "—"
              }
            />
          </div>
        </section>

        {/* Complaint — one wide bordered box for the customer's own words. */}
        {job.complaint ? (
          <section className="mt-4 break-inside-avoid">
            <div className="rounded border border-zinc-800/40 p-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                {t("secComplaint")}
              </div>
              <p className="mt-0.5 text-sm">{job.complaint}</p>
            </div>
          </section>
        ) : null}

        {/* Vehicle condition at check-in — TWO stacked bordered boxes
            (Exterior + Interior), each rendering every checkbox option
            whether ticked or not. This is the DISPUTE SHIELD. */}
        <section className="mt-4 break-inside-avoid">
          <h2 className="mb-1.5 text-sm font-semibold">{t("secCondition")}</h2>
          <div className="grid grid-cols-1 gap-2">
            <div className="rounded border border-zinc-800/40 p-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                {t("exteriorLabel")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-3">
                {EXTERIOR_OPTIONS.map((v) => (
                  <span key={v}>
                    {tick(job.exteriorCondition.includes(v))}{" "}
                    {t(`ext_${v}` as MessageKey)}
                  </span>
                ))}
              </div>
              {job.exteriorRemarks ? (
                <p className="mt-1.5 border-t border-zinc-800/20 pt-1 text-xs italic text-zinc-700">
                  — {job.exteriorRemarks}
                </p>
              ) : null}
            </div>
            <div className="rounded border border-zinc-800/40 p-2">
              <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                {t("interiorLabel")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-3">
                {INTERIOR_OPTIONS.map((v) => (
                  <span key={v}>
                    {tick(job.interiorCondition.includes(v))}{" "}
                    {t(`int_${v}` as MessageKey)}
                  </span>
                ))}
              </div>
              {job.interiorRemarks ? (
                <p className="mt-1.5 border-t border-zinc-800/20 pt-1 text-xs italic text-zinc-700">
                  — {job.interiorRemarks}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* Valuables — bordered box; even NONE renders visible so an
            unticked form can be spotted at a glance. */}
        <section className="mt-4 break-inside-avoid">
          <div className="rounded border border-zinc-800/40 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("secValuables")}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-3">
              {VALUABLES_OPTIONS.map((v) => (
                <span key={v}>
                  {tick(job.valuables.includes(v))}{" "}
                  {t(`val_${v}` as MessageKey)}
                </span>
              ))}
            </div>
            {job.valuablesNote ? (
              <p className="mt-1.5 border-t border-zinc-800/20 pt-1 text-xs italic text-zinc-700">
                — {job.valuablesNote}
              </p>
            ) : null}
          </div>
        </section>

        {/* Moulkia consent stamp — appears ONLY when the intake path
            was the Moulkia OCR flow AND the advisor ticked consent. On
            manual / repeat intake this line is skipped so the paper
            isn't cluttered with an irrelevant stamp. */}
        {job.moulkiaConsentAt ? (
          <p className="mt-3 text-xs text-zinc-600">
            {t("moulkiaConsentRecorded")}:{" "}
            <span className="tabular-nums">
              {fmtDateTime(job.moulkiaConsentAt, locale, tz)}
            </span>
          </p>
        ) : null}

        {/* Fine print — dispute shield explanation. Kept single-
            paragraph and short so it fits above the signature block
            on A4 without hyphenation. */}
        <p className="mt-4 text-xs text-zinc-700">{t("disputeShieldNote")}</p>

        {/* Signature block — two bordered cells side by side. Each cell
            has a ruled line for the signature and a shorter ruled line
            for the date. The customer writes both in ink. */}
        <section className="mt-4 grid grid-cols-2 gap-3 break-inside-avoid">
          <div className="rounded border border-zinc-800/40 p-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("signatureCustomer")}
            </div>
            <div className="mt-6 border-t border-zinc-800/60" />
            <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-600">
              {t("signatureDate")}
            </div>
            <div className="mt-4 border-t border-zinc-800/40" />
          </div>
          <div className="rounded border border-zinc-800/40 p-3">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("signatureAdvisor")}
            </div>
            <div className="mt-6 border-t border-zinc-800/60" />
            <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-600">
              {t("signatureDate")}
            </div>
            <div className="mt-4 border-t border-zinc-800/40" />
          </div>
        </section>
      </div>

      {/* Action bar — visible on-screen, hidden on print. Go Back +
          Print only. No Send button here (a job card isn't sent — the
          shop hands the paper to the customer in person at drop-off). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <Link
          href={`/advisor/jobs/${job.id}`}
          className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-center text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60"
        >
          {t("estimatePreviewGoBack")}
        </Link>
        <PrintButton className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-transparent px-5 text-base font-semibold text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
          {t("jobCardPrintBtn")}
        </PrintButton>
      </div>
    </main>
  );
}
