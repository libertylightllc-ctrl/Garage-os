import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { ButtonLink } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// Inventory 2a — purchase orders list. OWNER-only, garage-scoped. Open
// orders (DRAFT/ORDERED) on top, closed ones (RECEIVED/CANCELLED) below.
export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const t = await getT();
  const { error } = await searchParams;

  const orders = await prisma.purchaseOrder.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { createdAt: "desc" },
    include: {
      supplier: { select: { name: true } },
      lines: { select: { qty: true, unitCost: true } },
    },
  });

  const money = (v: number) =>
    new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(v);
  const poTotal = (lines: { qty: number; unitCost: unknown }[]) =>
    lines.reduce((s, l) => s + l.qty * Number(l.unitCost), 0);

  const open = orders.filter((o) => o.status === "DRAFT" || o.status === "ORDERED");
  const closed = orders.filter((o) => o.status === "RECEIVED" || o.status === "CANCELLED");

  return (
    <div>
      <AppNav role="OWNER" active="purchasing" />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t("purchasingTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("purchasingSubtitle")}</p>
          </div>
          <ButtonLink href="/owner/purchasing/new">{t("newPurchaseOrder")}</ButtonLink>
        </header>

        {error ? (
          <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
            {error}
          </p>
        ) : null}

        <POTable rows={open} title={t("purchasingOpen")} money={money} poTotal={poTotal} t={t} empty={t("noPurchaseOrders")} />
        {closed.length > 0 ? (
          <POTable rows={closed} title={t("purchasingClosed")} money={money} poTotal={poTotal} t={t} muted />
        ) : null}
      </main>
    </div>
  );
}

function POTable({
  rows,
  title,
  money,
  poTotal,
  t,
  empty,
  muted,
}: {
  rows: {
    id: string;
    status: string;
    reference: string | null;
    supplier: { name: string };
    lines: { qty: number; unitCost: unknown }[];
  }[];
  title: string;
  money: (v: number) => string;
  poTotal: (lines: { qty: number; unitCost: unknown }[]) => number;
  t: (k: MessageKey) => string;
  empty?: string;
  muted?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className={`overflow-hidden rounded-xl border ${muted ? "border-dashed" : ""} border-border`}>
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">{t("poSupplier")}</th>
              <th className="px-4 py-3">{t("poReference")}</th>
              <th className="px-4 py-3 text-center">{t("poStatus")}</th>
              <th className="px-4 py-3 text-right">{t("poLines")}</th>
              <th className="px-4 py-3 text-right">{t("poTotal")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((o) => (
              <tr key={o.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/owner/purchasing/${o.id}`} className="hover:underline">
                    {o.supplier.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{o.reference ?? "—"}</td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={o.status} label={t(`poStatus_${o.status}` as MessageKey)} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{o.lines.length}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(poTotal(o.lines))}</td>
              </tr>
            ))}
            {rows.length === 0 && empty ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">{empty}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone: Record<string, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    ORDERED: "bg-info-50 text-info-700 dark:bg-info-500/10 dark:text-info-500",
    RECEIVED: "bg-success-50 text-success-700 dark:bg-success-500/10 dark:text-success-500",
    CANCELLED: "bg-danger-50 text-danger-700 dark:bg-danger-500/10 dark:text-danger-500",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone[status] ?? "bg-muted"}`}>
      {label}
    </span>
  );
}
