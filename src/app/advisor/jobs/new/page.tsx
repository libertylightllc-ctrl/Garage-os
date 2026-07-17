import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { moulkiaFrontAction, plateLookupAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { Paginator } from "@/components/paginator";
import { PER_PAGE_OPTIONS, computeWindow } from "@/lib/pagination";

export const dynamic ="force-dynamic";

const ERR: Record<string, MessageKey> = {
  consent:"errConsent",
  nofile:"errNoFile",
  noplate:"errFields",
  fields:"errFields",
  ocr:"errOcrFailed",
};

const FIELD ="rounded-md border border-border bg-transparent px-2 py-1 text-sm";

function TechSelect({
  techs,
  unassignedLabel,
}: {
  techs: { id: string; name: string }[];
  unassignedLabel: string;
}) {
  return (
    <select name="assignedToId" defaultValue="" className={`${FIELD} w-full`}>
      <option value="">{unassignedLabel}</option>
      {techs.map((tech) => (
        <option key={tech.id} value={tech.id}>
          {tech.name}
        </option>
      ))}
    </select>
  );
}

export default async function NewJobCard({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; page?: string; per?: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const { error, page: rawPage, per: rawPer } = await searchParams;
  const garageId = session.user.garageId;

  // Vehicle picker is paginated — the "Or pick an existing vehicle" list
  // is unbounded otherwise, and even at ~10 rows today it grows with every
  // intake. Count first so ?page / ?per can clamp before the slice fetch.
  // Scope filter is relation-through (`customer.garageId`), reused verbatim
  // for both queries. No status/enum field on Vehicle, so nothing can
  // silently vanish from this list.
  const vehicleWhere = {
    customer: { garageId },
  };
  const [vehicleTotal, techs] = await Promise.all([
    prisma.vehicle.count({ where: vehicleWhere }),
    prisma.user.findMany({
      where: { garageId, role:"TECH"},
      orderBy: { name:"asc"},
      select: { id: true, name: true },
    }),
  ]);
  const vehicleWindow = computeWindow({
    rawPage,
    rawPer,
    totalCount: vehicleTotal,
  });
  const vehicles = await prisma.vehicle.findMany({
    where: vehicleWhere,
    include: { customer: true },
    orderBy: { createdAt:"desc"},
    skip: vehicleWindow.skip,
    take: vehicleWindow.take,
  });

  const field = FIELD;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs"/>
      <div>
        <Link href="/advisor" className="text-sm text-text-mute hover:underline">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("newJobTitle")}</h1>
      </div>

      {error && ERR[error] ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {t(ERR[error])}
        </p>
      ) : null}

      {/* New customer — Moulkia OCR. One-tap camera; the act of scanning IS consent.
          NOTE (legal review pending): the explicit consent checkbox was replaced
          with a clear by-action statement. moulkiaConsentAt is still stamped on
          the resulting JobCard. If the legal review requires an explicit tick,
          add the checkbox back and remove the hidden `consent=on` input. */}
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">{t("newCustomerMoulkia")}</h2>
        <p className="mt-1 text-xs text-text-mute">
          {t("moulkiaConsentInline")}
          <span className="block">{t("moulkiaOrManualHint")}</span>
        </p>
        <p className="mt-1 text-xs text-text-mute">{t("step1of2")}</p>
        <form action={moulkiaFrontAction} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="consent" value="on"/>
          <TechSelect techs={techs} unassignedLabel={t("unassigned")} />
          <PhotoCapture
            name="file"
            mode="auto-submit"
            kind="photo"
            required
            buttonLabel={t("takePhotoMoulkiaFront")}
            retakeLabel={t("retake")}
            continueLabel={t("usePhoto")}
            tooBigLabel={t("fileTooBig")}
            wrongTypeLabel={t("wrongFileType")}
            optimizeForOcr
            optimizingLabel={t("optimizingPhoto")}
          />
        </form>
      </section>

      {/* Repeat customer — plate lookup */}
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">{t("repeatCustomer")}</h2>
        <p className="mt-1 text-xs text-text-mute">{t("plateLookupHint")}</p>
        <form action={plateLookupAction} className="mt-3 flex gap-2">
          <input name="plate" placeholder={t("plate")} required className={`${field} flex-1`} />
          <button className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors">
            {t("lookupBtn")}
          </button>
        </form>
      </section>

      {/* Manual entry — no Moulkia photo (or OCR failed/skipped) */}
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">{t("manualEntry")}</h2>
        <p className="mt-1 text-xs text-text-mute">{t("manualEntryHint")}</p>
        <Link
          href="/advisor/jobs/new/confirm?via=manual"
          className="mt-3 inline-block inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-semibold text-text hover:bg-surface-2 transition-colors"
        >
          {t("enterManually")}
        </Link>
      </section>

      {/* Or pick an existing vehicle — also goes through the Reception form (prefilled) */}
      {vehicleTotal > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("orPickExisting")}</h2>
          <ul className="flex flex-col gap-2">
            {vehicles.map((v) => {
              const q = new URLSearchParams({
                via:"repeat",
                vehicleId: v.id,
                ownerName: v.customer.name,
                phone: v.customer.phone,
                plate: v.plate,
                make: v.make,
                model: v.model,
                year: v.year ? String(v.year) :"",
                vin: v.vin ?? "",
              });
              if (v.customer.email) q.set("email", v.customer.email);
              return (
                <li key={v.id}>
                  <Link
                    href={`/advisor/jobs/new/confirm?${q.toString()}`}
                    className="flex items-center justify-between rounded-xl border border-border p-4 hover:bg-surface-2 transition-colors"
                  >
                    <span>
                      <span className="block font-medium">
                        {v.make} {v.model}
                        <span className="ml-2 text-sm text-text-mute">{v.plate}</span>
                      </span>
                      <span className="block text-sm text-text-mute">{v.customer.name}</span>
                    </span>
                    <span className="text-sm font-medium">{t("start")}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <Paginator
            currentPath="/advisor/jobs/new"
            // Round-trip the effective `per` so page-number / Prev / Next
            // clicks don't silently reset rows-per-page back to the default.
            // The Paginator's hrefWith() rebuilds URLs from
            // currentSearchParams and only overrides the field being
            // changed; without this, per=20 would drop off the next-page
            // link.
            currentSearchParams={`per=${vehicleWindow.perPage}`}
            page={vehicleWindow.page}
            perPage={vehicleWindow.perPage}
            pageCount={vehicleWindow.pageCount}
            from={vehicleWindow.from}
            to={vehicleWindow.to}
            total={vehicleWindow.totalCount}
            perPageOptions={PER_PAGE_OPTIONS}
            labels={{
              showing: t("paginationShowing"),
              rowsPerPage: t("paginationRowsPerPage"),
              prev: t("paginationPrev"),
              next: t("paginationNext"),
            }}
          />
        </div>
      ) : null}
    </main>
  );
}
