import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { payInvoicePublic } from "@/app/actions/public";
import { formatInvoiceNo } from "@/lib/billing";
import { verifyToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function CustomerInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id: token } = await params;
  const id = verifyToken("invoice", token);
  if (!id) notFound();
  const inv = await prisma.invoice.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      payments: true,
      garage: true,
      jobCard: { include: { vehicle: true } },
    },
  });
  if (!inv) notFound();

  const total = Number(inv.total);
  const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
  const balance = Math.max(0, total - paid);
  const isPaid = inv.status === "PAID" || balance <= 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{inv.garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Your invoice</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {formatInvoiceNo(inv.number, inv.issuedAt.getFullYear())} ·{" "}
          {inv.jobCard.vehicle.make} {inv.jobCard.vehicle.model}
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {inv.lines.map((l) => (
          <li key={l.id} className="flex justify-between">
            <span>{l.description}</span>
            <span>{Number(l.lineTotal).toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <div className="border-t border-black/10 pt-2 text-right text-sm dark:border-white/15">
        <div>Subtotal: {money(Number(inv.subtotal))}</div>
        <div>VAT (5%): {money(Number(inv.vatAmount))}</div>
        <div className="text-lg font-semibold">Total: {money(total)}</div>
      </div>

      {isPaid ? (
        <p className="rounded-md bg-green-50 p-3 text-center text-sm font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
          ✅ Paid — thank you!
        </p>
      ) : (
        <form action={payInvoicePublic}>
          <input type="hidden" name="token" value={token} />
          <button className="w-full rounded-lg bg-green-600 px-4 py-3 font-semibold text-white hover:bg-green-500">
            Pay {money(balance)} (simulated)
          </button>
        </form>
      )}
    </main>
  );
}
