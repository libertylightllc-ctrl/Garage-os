import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { moulkiaExtractAction, plateLookupAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";

export const dynamic = "force-dynamic";

const ERR: Record<string, MessageKey> = {
  consent: "errConsent",
  nofile: "errNoFile",
  noplate: "errFields",
  fields: "errFields",
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

      {/* New customer — Moulkia OCR */}
      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-medium">{t("newCustomerMoulkia")}</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {t("moulkiaHint")}
          <span className="block">{t("moulkiaOrManualHint")}</span>
        </p>
        <form action={moulkiaExtractAction} className="mt-3 flex flex-col gap-2">
          <input type="file" name="file" accept="image/*" capture="environment" required className={`${field} w-full`} />
          <TechSelect techs={techs} unassignedLabel={t("unassigned")} />
          <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" name="consent" className="mt-0.5" required />
            {t("moulkiaConsent")}
          </label>
          <button className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-white dark:text-black">
            {t("scanMoulkia")}
          </button>
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
