import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { PrintButton } from "@/components/print-button";
import { DocumentHeader } from "@/components/document-header";
import { getT, getLocale } from "@/i18n/server";
import { fmtDateTime, countryToTimeZone } from "@/lib/format-datetime";
import type { MessageKey } from "@/i18n/config";
import {
  EXTERIOR_OPTIONS,
  INTERIOR_OPTIONS,
  VALUABLES_OPTIONS,
  formatJobNo,
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
    <div className="rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">
        {label}
      </div>
      <div
        className={
          "mt-0.5 text-sm print:leading-tight " +
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

  // ── Repeating page-header strip on overflow pages ─────────────────
  //
  // Requirement: when the job card spills onto a second page, the top
  // of every page after the first must carry the identifier strip
  //   JC-YYYY-NNNN · <plate> · Page 2 of 3
  // so a stack of loose sheets stays associated with the right car.
  //
  // Approach: CSS Paged Media `@page` margin boxes with `@page :first`
  // blanking. `counter(page)` / `counter(pages)` are real page counters,
  // so "2 of 3" is dynamic — not hardcoded. Page 1 is explicitly blank.
  //
  // Browser support (verified 2026-07-23):
  //   Chrome / Edge → ✅ full support since Chrome 85. THIS IS THE TARGET.
  //   Firefox / Safari → ⚠️ partial; strip degrades to empty on those,
  //     rest of the document is identical (acceptable degradation).
  //
  // RTL: emit @top-right for LTR, @top-left for RTL. Margin-box logical
  // properties (`@top-end`) have thinner Chrome coverage than the
  // physical variants, so we stick with physical + locale-swap. The
  // `content:` counter chain works identically in both directions.
  //
  // Content interpolation: JC number + plate come from the row; both
  // are safe to inline (JC-NNNN-NNNN is alphanumeric, plates are
  // alphanumeric+space). If plates ever contain a `"` we'd need to
  // escape — flagging here, not building for it yet.
  const jobNo = formatJobNo(job.number, job.createdAt.getFullYear()) ??
    `#${job.id.slice(-6)}`;
  const stripPrefix = `${jobNo} · ${job.vehicle.plate}`;
  const marginBox = locale === "ar" ? "@top-left" : "@top-right";
  const pageOf = locale === "ar" ? " · صفحة " : " · Page ";
  const pageOfBetween = locale === "ar" ? " من " : " of ";
  // Strip styling: 11pt semibold near-black. Sized to sit at the same
  // visual weight as the page-1 JC-number line (text-sm ≈ 11pt on A4).
  // Colour `#111827` (Tailwind zinc-900) so a fax or a mono photocopy
  // still reads it — the strip is the signature-page-to-job-card link,
  // and #666 at 9pt (previous) faded into footnote territory. Err
  // toward too prominent rather than too subtle.
  // ── @page margin: asymmetric bottom (18mm) absorbs Chrome's default
  // print footer strip (URL / page-number / timestamp) which the shop
  // advisor won't disable in the print dialog. Top / left / right stay
  // tight so page-1 content has room. Under the worst realistic case
  // (Chrome Default margins + Headers & footers ON), effective usable
  // area drops to ~900px — the layout below is measured to fit
  // ≤ 880px on the 12-line-complaint fixture, leaving 20px slack.
  const printCss = `
    @page {
      size: A4;
      margin: 10mm 10mm 18mm 10mm;
      ${marginBox} {
        content: "${stripPrefix}${pageOf}" counter(page) "${pageOfBetween}" counter(pages);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 11pt;
        font-weight: 600;
        color: #111827;
      }
    }
    @page :first {
      ${marginBox} { content: ""; }
    }
  `;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 print:max-w-full print:min-h-0 print:bg-white print:p-0">
      {/* Server-rendered @page CSS: repeating identifier strip on
          overflow pages + tightened 12mm print margins. See the block
          above for the full rationale and browser-support notes. */}
      <style dangerouslySetInnerHTML={{ __html: printCss }} />
      {/* White paper card even on-screen so the preview reads like the
          document the customer will hold. Card chrome drops on print. */}
      <div className="rounded-xl border border-border bg-white p-6 text-zinc-900 shadow-sm dark:bg-white dark:shadow-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* Header — standardized across every printable document via
            DocumentHeader (job card / estimate / invoice / delivery / PO
            all share the same stacked shape). See the component for the
            per-doc identity ordering. */}
        <DocumentHeader
          title={t("jobCardPrintTitle")}
          jobCard={job}
          vehicle={job.vehicle}
          garage={garage}
        />

        {/* Old header markup lived here; format is now pinned in the
            shared component so it can't fork across the 9 document
            surfaces. Do not reintroduce inline headers. */}

        {/* Customer + Check-in — bordered cells side by side. Customer
            gets 2/3 width because it holds name + phone + email; check-in
            takes 1/3. */}
        <section className="mt-5 grid grid-cols-3 gap-2 break-inside-avoid print:mt-2 print:gap-1 print:leading-tight">
          <div className="col-span-2 rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("secCustomer")}
            </div>
            <div className="mt-0.5 text-sm font-medium">{customer.name}</div>
            <div className="text-sm text-zinc-700">{customer.phone}</div>
            {customer.email ? (
              <div className="text-sm text-zinc-700">{customer.email}</div>
            ) : null}
          </div>
          <div className="rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("checkInLabel")}
            </div>
            <div className="mt-0.5 text-sm tabular-nums">{checkIn}</div>
          </div>
        </section>

        {/* Vehicle — 3-column grid of bordered cells, one per field. */}
        <section className="mt-4 break-inside-avoid print:mt-2">
          <h2 className="mb-1.5 text-sm font-semibold print:mb-0.5">{t("secVehicle")}</h2>
          <div className="grid grid-cols-3 gap-2 print:gap-1">
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
          <section className="mt-4 break-inside-avoid print:mt-2">
            <div className="rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
              <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                {t("secComplaint")}
              </div>
              {/* leading-snug on print — the complaint text is the tallest
                  block in the doc (12 lines × line-height eats vertical
                  fast). "snug" (1.375) stays readable but reclaims ~24px
                  on a 12-line complaint vs default. Not smaller text, just
                  tighter rows. */}
              <p className="mt-0.5 text-sm print:leading-snug">{job.complaint}</p>
            </div>
          </section>
        ) : null}

        {/* Vehicle condition at check-in — TWO stacked bordered boxes
            (Exterior + Interior), each rendering every checkbox option
            whether ticked or not. This is the DISPUTE SHIELD. */}
        <section className="mt-4 break-inside-avoid print:mt-2">
          <h2 className="mb-1.5 text-sm font-semibold print:mb-0.5">{t("secCondition")}</h2>
          <div className="grid grid-cols-1 gap-2 print:gap-1">
            <div className="rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
              <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                {t("exteriorLabel")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-y-1 text-sm print:mt-0.5 print:gap-y-0 print:leading-tight sm:grid-cols-3">
                {EXTERIOR_OPTIONS.map((v) => (
                  <span key={v}>
                    {tick(job.exteriorCondition.includes(v))}{" "}
                    {t(`ext_${v}` as MessageKey)}
                  </span>
                ))}
              </div>
              {job.exteriorRemarks ? (
                <p className="mt-1.5 border-t border-zinc-800/20 pt-1 text-xs italic text-zinc-700 print:mt-1 print:pt-0.5 print:leading-tight">
                  — {job.exteriorRemarks}
                </p>
              ) : null}
            </div>
            <div className="rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
              <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                {t("interiorLabel")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-y-1 text-sm print:mt-0.5 print:gap-y-0 print:leading-tight sm:grid-cols-3">
                {INTERIOR_OPTIONS.map((v) => (
                  <span key={v}>
                    {tick(job.interiorCondition.includes(v))}{" "}
                    {t(`int_${v}` as MessageKey)}
                  </span>
                ))}
              </div>
              {job.interiorRemarks ? (
                <p className="mt-1.5 border-t border-zinc-800/20 pt-1 text-xs italic text-zinc-700 print:mt-1 print:pt-0.5 print:leading-tight">
                  — {job.interiorRemarks}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* Valuables — bordered box; even NONE renders visible so an
            unticked form can be spotted at a glance. */}
        <section className="mt-4 break-inside-avoid print:mt-2">
          <div className="rounded border border-zinc-800/40 p-2 print:px-1 print:py-0.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("secValuables")}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-y-1 text-sm print:mt-0.5 print:gap-y-0 print:leading-tight sm:grid-cols-3">
              {VALUABLES_OPTIONS.map((v) => (
                <span key={v}>
                  {tick(job.valuables.includes(v))}{" "}
                  {t(`val_${v}` as MessageKey)}
                </span>
              ))}
            </div>
            {job.valuablesNote ? (
              <p className="mt-1.5 border-t border-zinc-800/20 pt-1 text-xs italic text-zinc-700 print:mt-1 print:pt-0.5 print:leading-tight">
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
          <p className="mt-3 text-xs text-zinc-600 print:mt-1 print:leading-tight">
            {t("moulkiaConsentRecorded")}:{" "}
            <span className="tabular-nums">
              {fmtDateTime(job.moulkiaConsentAt, locale, tz)}
            </span>
          </p>
        ) : null}

        {/* Fine print — dispute shield explanation. Kept single-
            paragraph and short so it fits above the signature block
            on A4 without hyphenation. */}
        <p className="mt-4 text-xs text-zinc-700 print:mt-1 print:leading-tight">{t("disputeShieldNote")}</p>

        {/* Signature block — two bordered cells side by side. Each cell
            has a ruled line for the signature and a shorter ruled line
            for the date. The customer writes both in ink. `break-inside
            -avoid` keeps both cells together on the same page so a
            customer never signs a stray sheet with just their name
            and no context. STAYS ATOMIC — a signature separated from
            its counterpart across pages defeats dispute-evidence value.
            If it can't fit page 1, it takes the whole block to page 2. */}
        <section className="mt-4 grid grid-cols-2 gap-3 break-inside-avoid print:mt-2 print:gap-1.5">
          <div className="rounded border border-zinc-800/40 p-3 print:p-1.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("signatureCustomer")}
            </div>
            <div className="mt-6 border-t border-zinc-800/60 print:mt-3" />
            <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-600 print:mt-1.5">
              {t("signatureDate")}
            </div>
            <div className="mt-4 border-t border-zinc-800/40 print:mt-2" />
          </div>
          <div className="rounded border border-zinc-800/40 p-3 print:p-1.5">
            <div className="text-[10px] uppercase tracking-wide text-zinc-600">
              {t("signatureAdvisor")}
            </div>
            <div className="mt-6 border-t border-zinc-800/60 print:mt-3" />
            <div className="mt-3 text-[10px] uppercase tracking-wide text-zinc-600 print:mt-1.5">
              {t("signatureDate")}
            </div>
            <div className="mt-4 border-t border-zinc-800/40 print:mt-2" />
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
