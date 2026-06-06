import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { moulkiaFrontAction, plateLookupAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

const ERR: Record<string, MessageKey> = {
  consent: "errConsent",
  nofile: "errNoFile",
  noplate: "errFields",
  fields: "errFields",
  ocr: "errOcrFailed",
};

const FIELD = "rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

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
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("ADVISOR");
  const t = await getT();
  const { error } = await searchParams;

  const [vehicles, techs] = await Promise.all([
    prisma.vehicle.findMany({
      where: { customer: { garageId: session.user.garageId } },
      include: { customer: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.findMany({
      where: { garageId: session.user.garageId, role: "TECH" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const field = FIELD;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href="/advisor" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("newJobTitle")}</h1>
      </div>

      {error && ERR[error] ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {t(ERR[error])}
        </p>
      ) : null}

      {/* New customer — Moulkia OCR. One-tap camera; the act of scanning IS consent.
          NOTE (legal review pending): the explicit consent checkbox was replaced
          with a clear by-action statement. moulkiaConsentAt is still stamped on
          the resulting JobCard. If the legal review requires an explicit tick,
          add the checkbox back and remove the hidden `consent=on` input. */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-medium">{t("newCustomerMoulkia")}</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {t("moulkiaConsentInline")}
          <span className="block">{t("moulkiaOrManualHint")}</span>
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("step1of2")}</p>
        <form action={moulkiaFrontAction} className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="consent" value="on" />
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
            framingTips={{
              heading: t("framingTipsHeading"),
              fill: t("framingTipFill"),
              flat: t("framingTipFlat"),
              glare: t("framingTipGlare"),
            }}
            blurWarning={{
              message: t("blurryWarn"),
              retake: t("retake"),
              useAnyway: t("useAnyway"),
            }}
          />
        </form>
      </section>

      {/* Repeat customer — plate lookup */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-medium">{t("repeatCustomer")}</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("plateLookupHint")}</p>
        <form action={plateLookupAction} className="mt-3 flex gap-2">
          <input name="plate" placeholder={t("plate")} required className={`${field} flex-1`} />
          <button className="rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
            {t("lookupBtn")}
          </button>
        </form>
      </section>

      {/* Manual entry — no Moulkia photo (or OCR failed/skipped) */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-medium">{t("manualEntry")}</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("manualEntryHint")}</p>
        <Link
          href="/advisor/jobs/new/confirm?via=manual"
          className="mt-3 inline-block rounded-md border border-black/15 px-3 py-1 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          {t("enterManually")}
        </Link>
      </section>

      {/* Or pick an existing vehicle — also goes through the Reception form (prefilled) */}
      {vehicles.length > 0 ? (
        <div>
          <h2 className="mb-2 text-sm font-medium">{t("orPickExisting")}</h2>
          <ul className="flex flex-col gap-2">
            {vehicles.map((v) => {
              const q = new URLSearchParams({
                via: "repeat",
                vehicleId: v.id,
                ownerName: v.customer.name,
                phone: v.customer.phone,
                plate: v.plate,
                make: v.make,
                model: v.model,
                year: v.year ? String(v.year) : "",
                vin: v.vin ?? "",
                engineNumber: v.engineNumber ?? "",
              });
              if (v.customer.email) q.set("email", v.customer.email);
              return (
                <li key={v.id}>
                  <Link
                    href={`/advisor/jobs/new/confirm?${q.toString()}`}
                    className="flex items-center justify-between rounded-lg border border-black/10 p-4 hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                  >
                    <span>
                      <span className="block font-medium">
                        {v.make} {v.model}
                        <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400">{v.plate}</span>
                      </span>
                      <span className="block text-sm text-zinc-500 dark:text-zinc-400">{v.customer.name}</span>
                    </span>
                    <span className="text-sm font-medium">{t("start")}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
