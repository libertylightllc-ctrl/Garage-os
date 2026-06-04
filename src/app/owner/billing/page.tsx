import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { ensureSubscription } from "@/app/actions/subscription";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const session = await requireRole("OWNER");
  const t = await getT();
  await ensureSubscription(session.user.garageId);

  const [garage, sub, plans] = await Promise.all([
    prisma.garage.findUnique({ where: { id: session.user.garageId }, select: { isPilot: true } }),
    prisma.subscription.findUnique({
      where: { garageId: session.user.garageId },
      include: { plan: true },
    }),
    prisma.plan.findMany({ where: { active: true }, orderBy: { priceMonthly: "asc" } }),
  ]);
  const isPilot = garage?.isPilot ?? true;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="billing" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("billing")}</h1>

      <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        {t("statusLabel")}: <span className="font-medium">{sub?.status ?? "PILOT"}</span>
        {sub?.plan ? ` · ${sub.plan.name}` : ""}
      </div>

      {isPilot ? (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          🟢 {t("onPilotNotBilled")}
        </p>
      ) : null}

      <p className="text-sm text-zinc-500 dark:text-zinc-400">{t("billingManual")}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        {plans.map((p) => (
          <div key={p.id} className="rounded-xl border border-black/10 p-4 dark:border-white/15">
            <div className="text-sm font-medium">{p.name}</div>
            <div className="mt-1 text-lg font-semibold">
              {p.currency} {Number(p.priceMonthly).toFixed(0)}
              <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                {" "}
                /{t("perMonth")}
              </span>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
