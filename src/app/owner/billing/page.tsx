import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import { stripeEnabled } from "@/lib/billing-gateway";
import {
  ensureSubscription,
  subscribeAction,
  cancelSubscriptionAction,
} from "@/app/actions/subscription";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const session = await requireRole("OWNER");
  const t = await getT();
  await ensureSubscription(session.user.garageId);

  const [garage, sub, plans] = await Promise.all([
    prisma.garage.findUnique({ where: { id: session.user.garageId } }),
    prisma.subscription.findUnique({
      where: { garageId: session.user.garageId },
      include: { plan: true },
    }),
    prisma.plan.findMany({ where: { active: true }, orderBy: { priceMonthly: "asc" } }),
  ]);

  const isPilot = garage?.isPilot ?? true;
  const configured = stripeEnabled();
  const active = sub?.status === "ACTIVE" || sub?.status === "TRIALING" || sub?.status === "PAST_DUE";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="billing" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("billing")}</h1>

      <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        <div>
          {t("statusLabel")}: <span className="font-medium">{sub?.status ?? "PILOT"}</span>
          {sub?.plan ? ` · ${sub.plan.name}` : ""}
          {sub?.currentPeriodEnd ? ` · ${t("renewsLabel")} ${sub.currentPeriodEnd.toISOString().slice(0, 10)}` : ""}
        </div>
      </div>

      {isPilot ? (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          🟢 {t("onPilotNotBilled")}
        </p>
      ) : !configured ? (
        <p className="rounded-md bg-zinc-100 p-3 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {t("billingNotConfigured")}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {plans.map((p) => (
          <div key={p.id} className="rounded-xl border border-black/10 p-4 dark:border-white/15">
            <div className="text-sm font-medium">{p.name}</div>
            <div className="mt-1 text-lg font-semibold">
              {p.currency} {Number(p.priceMonthly).toFixed(0)}
              <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400"> /{t("perMonth")}</span>
            </div>
            <form action={subscribeAction} className="mt-3">
              <input type="hidden" name="planId" value={p.id} />
              <button
                disabled={isPilot || !configured}
                className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
              >
                {t("subscribe")}
              </button>
            </form>
          </div>
        ))}
      </div>

      {active ? (
        <form action={cancelSubscriptionAction}>
          <button className="text-sm text-red-600 hover:underline">{t("cancelSubscription")}</button>
        </form>
      ) : null}
    </main>
  );
}
