import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { PrintButton } from "@/components/print-button";
import { JobNumberBadge } from "@/components/job-number-badge";
import { getT, getLocale } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import {
  EXTERIOR_OPTIONS,
  INTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
} from "@/lib/jobcard-fields";

export const dynamic = "force-dynamic";

/**
 * Printable customer job-card receipt — the CUSTOMER-facing paper the
 * shop hands the owner at drop-off. Mirrors the estimate/invoice preview
 * pattern: dedicated sibling route, PrintButton + JobNumberBadge reused,
 * pure Tailwind print: variants, white card on-screen too so dark-mode
 * previews match paper.
 *
 * CONTENT is deliberately the drop-off dispute shield: garage header +
 * TRN, job number, check-in stamp, customer identity, vehicle spec,
 * reception detail (mileage in / fuel level), complaint in the
 * customer's words, condition checklists (exterior + interior + valuables),
 * Moulkia consent stamp when applicable, and signature lines. Everything
 * the customer needs to sign "yes my car had these dents when I dropped
 * it off" is on this sheet.
 *
 * OMITTED by design: assigned tech, bay, priority, job status, and any
 * estimate/invoice state. Those are internal operational metadata. If
 * the shop later wants an internal-sheet variant (assigned tech / bay /
 * priority visible, dispute-shield fine print off), a ?variant=internal
 * query param on this same route is the future hook — don't build the
 * toggle yet.
 */
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
  const checkIn = job.createdAt.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  // Tick / empty box glyphs render cleanly on print (unlike inline SVG,
  // which some printer drivers strip) and read as a paper form the
  // customer is used to signing.
  const tick = (on: boolean) => (on ? "☑" : "☐");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 print:max-w-full print:min-h-0 print:bg-white print:p-0">
      {/* White paper card even on-screen so the preview reads like the
          document the customer will hold. Card chrome drops on print. */}
      <div className="rounded-xl border border-border bg-white p-6 text-zinc-900 shadow-sm dark:bg-white dark:shadow-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* Header — document identity left, garage header right. Same
            shape as the estimate/invoice previews so a shop that prints
            all three sees a consistent letterhead. */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("jobCardPrintTitle")}
            </h1>
            <p className="text-sm text-zinc-500">
              {job.vehicle.make} {job.vehicle.model}
              {job.vehicle.year ? ` (${job.vehicle.year})` : ""} · {job.vehicle.plate}
              {job.number ? (
                <>
                  {" "}
                  · <JobNumberBadge jobCard={job} className="tabular-nums" />
                </>
              ) : null}
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="font-medium">{garage.name}</div>
            <div className="text-zinc-500">TRN: {garage.trn ?? "—"}</div>
            <div className="text-zinc-500">{garage.country}</div>
          </div>
        </div>

        {/* Customer identity + check-in stamp. Reads like a receipt
            header: who dropped off, when. */}
        <div className="mt-6 flex justify-between gap-4 text-sm">
          <div>
            <div className="text-zinc-500">{t("secCustomer")}</div>
            <div className="font-medium">{customer.name}</div>
            <div className="text-zinc-500">{customer.phone}</div>
            {customer.email ? (
              <div className="text-zinc-500">{customer.email}</div>
            ) : null}
          </div>
          <div className="text-right text-zinc-500">
            <div>
              {t("checkInLabel")}:{" "}
              <span className="tabular-nums text-zinc-900">{checkIn}</span>
            </div>
          </div>
        </div>

        {/* Vehicle spec — every field on the intake form that identifies
            the car. Empty fields render as "—" so the customer can see
            what the shop DID and DIDN'T capture at check-in. */}
        <section className="mt-6 border-t border-black/10 pt-4">
          <h2 className="mb-2 text-sm font-semibold">{t("secVehicle")}</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div>
              <dt className="text-xs text-zinc-500">{t("make")}</dt>
              <dd>{job.vehicle.make}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("model")}</dt>
              <dd>{job.vehicle.model}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("yearLabel")}</dt>
              <dd>{job.vehicle.year ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("plate")}</dt>
              <dd className="font-medium">{job.vehicle.plate}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("vinLabel")}</dt>
              <dd className="tabular-nums">{job.vehicle.vin ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("engineSizeLabel")}</dt>
              <dd>{job.vehicle.engineSize ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("fuelTypeLabel")}</dt>
              <dd>
                {job.vehicle.fuelType
                  ? t(`fuelType_${job.vehicle.fuelType}` as MessageKey)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("mileageInLabel")}</dt>
              <dd className="tabular-nums">
                {job.mileageIn != null ? job.mileageIn.toLocaleString(locale) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">{t("fuelLevelLabel")}</dt>
              <dd>
                {job.fuelLevel ? t(`fuel_${job.fuelLevel}` as MessageKey) : "—"}
              </dd>
            </div>
          </dl>
        </section>

        {/* Complaint — the customer's own words. Kept as its own block
            so it stands out on the paper as "what you told us was wrong." */}
        {job.complaint ? (
          <section className="mt-4 border-t border-black/10 pt-4">
            <h2 className="mb-2 text-sm font-semibold">{t("secComplaint")}</h2>
            <p className="text-sm">{job.complaint}</p>
          </section>
        ) : null}

        {/* Condition at check-in — THE DISPUTE SHIELD. Every checkbox
            option renders whether ticked or not so the customer signs
            against a paper form they can read at a glance. */}
        <section className="mt-4 border-t border-black/10 pt-4">
          <h2 className="mb-2 text-sm font-semibold">{t("secCondition")}</h2>
          <div className="mb-3 text-sm">
            <div className="text-xs font-medium text-zinc-500">
              {t("exteriorLabel")}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-y-1 sm:grid-cols-3">
              {EXTERIOR_OPTIONS.map((v) => (
                <span key={v}>
                  {tick(job.exteriorCondition.includes(v))}{" "}
                  {t(`ext_${v}` as MessageKey)}
                </span>
              ))}
            </div>
            {job.exteriorRemarks ? (
              <p className="mt-1 text-xs italic text-zinc-600">
                — {job.exteriorRemarks}
              </p>
            ) : null}
          </div>
          <div className="text-sm">
            <div className="text-xs font-medium text-zinc-500">
              {t("interiorLabel")}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-y-1 sm:grid-cols-3">
              {INTERIOR_OPTIONS.map((v) => (
                <span key={v}>
                  {tick(job.interiorCondition.includes(v))}{" "}
                  {t(`int_${v}` as MessageKey)}
                </span>
              ))}
            </div>
            {job.interiorRemarks ? (
              <p className="mt-1 text-xs italic text-zinc-600">
                — {job.interiorRemarks}
              </p>
            ) : null}
          </div>
        </section>

        {/* Valuables — same paper-form shape as condition above. Even
            "NONE" needs to be visible + tickable so an unticked form
            can be spotted at a glance. */}
        <section className="mt-4 border-t border-black/10 pt-4">
          <h2 className="mb-2 text-sm font-semibold">{t("secValuables")}</h2>
          <div className="grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-3">
            {VALUABLES_OPTIONS.map((v) => (
              <span key={v}>
                {tick(job.valuables.includes(v))} {t(`val_${v}` as MessageKey)}
              </span>
            ))}
          </div>
          {job.valuablesNote ? (
            <p className="mt-1 text-xs italic text-zinc-600">
              — {job.valuablesNote}
            </p>
          ) : null}
        </section>

        {/* Moulkia consent stamp — appears ONLY when the intake path
            was the Moulkia OCR flow AND the advisor ticked consent. On
            manual / repeat intake this section is skipped entirely so
            the paper isn't cluttered with an irrelevant line. */}
        {job.moulkiaConsentAt ? (
          <p className="mt-4 border-t border-black/10 pt-4 text-xs text-zinc-500">
            {t("moulkiaConsentRecorded")}:{" "}
            <span className="tabular-nums">
              {job.moulkiaConsentAt.toLocaleString(locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </p>
        ) : null}

        {/* Fine print — the whole reason the customer signs. Kept
            single-paragraph and short so it fits comfortably above the
            signature block on A4 without hyphenation. */}
        <p className="mt-6 border-t border-black/10 pt-4 text-xs text-zinc-600">
          {t("disputeShieldNote")}
        </p>

        {/* Signature block — two ruled lines, 60% width each, printer-
            friendly. Timestamp under each line stays blank so signer
            writes it in ink — the sheet is proof of on-paper signature,
            not a digitally-signed record. */}
        <div className="mt-6 grid grid-cols-2 gap-8 text-sm">
          <div>
            <div className="mb-1 h-8 border-b border-black/60" />
            <div className="text-xs text-zinc-500">{t("signatureCustomer")}</div>
            <div className="mt-2 h-6 border-b border-black/40" />
            <div className="text-xs text-zinc-500">{t("signatureDate")}</div>
          </div>
          <div>
            <div className="mb-1 h-8 border-b border-black/60" />
            <div className="text-xs text-zinc-500">{t("signatureAdvisor")}</div>
            <div className="mt-2 h-6 border-b border-black/40" />
            <div className="text-xs text-zinc-500">{t("signatureDate")}</div>
          </div>
        </div>
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
