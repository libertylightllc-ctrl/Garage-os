import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { createCustomerVehicleJobAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

interface SP {
  ownerName?: string;
  phone?: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: string;
  vin?: string;
  vehicleId?: string;
  assignedToId?: string;
}

export default async function ConfirmNewCustomer({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  await requireRole("ADVISOR");
  const t = await getT();
  const sp = await searchParams;

  const field =
    "mt-1 w-full rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";
  const isRepeat = Boolean(sp.vehicleId);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link href="/advisor/jobs/new" className="text-sm text-zinc-500 hover:underline dark:text-zinc-400">
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("confirmCustomerTitle")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {isRepeat ? t("prefilledFromRecord") : t("confirmHint")}
        </p>
      </div>

      <form action={createCustomerVehicleJobAction} className="flex flex-col gap-3">
        <input type="hidden" name="vehicleId" defaultValue={sp.vehicleId ?? ""} />
        <input type="hidden" name="assignedToId" defaultValue={sp.assignedToId ?? ""} />

        <label className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("ownerName")}
          <input name="ownerName" defaultValue={sp.ownerName ?? ""} required className={field} />
        </label>
        <label className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("mobile")}
          <input name="phone" type="tel" defaultValue={sp.phone ?? ""} placeholder="+9715XXXXXXXX" required className={field} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("plate")}
            <input name="plate" defaultValue={sp.plate ?? ""} required className={field} />
          </label>
          <label className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("yearLabel")}
            <input name="year" type="number" min="1950" max="2100" defaultValue={sp.year ?? ""} className={field} />
          </label>
          <label className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("make")}
            <input name="make" defaultValue={sp.make ?? ""} required className={field} />
          </label>
          <label className="text-sm text-zinc-500 dark:text-zinc-400">
            {t("model")}
            <input name="model" defaultValue={sp.model ?? ""} required className={field} />
          </label>
        </div>

        <label className="text-sm text-zinc-500 dark:text-zinc-400">
          {t("vinLabel")}
          <input name="vin" defaultValue={sp.vin ?? ""} className={field} />
        </label>

        <button className="rounded-lg bg-zinc-900 px-4 py-3 text-base font-semibold text-white dark:bg-white dark:text-black">
          {t("startJobCard")}
        </button>
      </form>
    </main>
  );
}
