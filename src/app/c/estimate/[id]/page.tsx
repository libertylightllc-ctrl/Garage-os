import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { approveEstimatePublic, rejectEstimatePublic } from "@/app/actions/public";
import { verifyToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";

const money = (n: number) => `AED ${n.toFixed(2)}`;

export default async function CustomerEstimate({ params }: { params: Promise<{ id: string }> }) {
  const { id: token } = await params;
  const id = verifyToken("estimate", token);
  if (!id) notFound();
  const est = await prisma.estimate.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      jobCard: { include: { vehicle: { include: { customer: true } }, garage: true } },
    },
  });
  if (!est) notFound();

  const decided = est.status === "APPROVED" || est.status === "REJECTED";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{est.jobCard.garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Your estimate</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {est.jobCard.vehicle.make} {est.jobCard.vehicle.model} · {est.jobCard.vehicle.plate}
        </p>
      </div>

      <ul className="flex flex-col gap-1 text-sm">
        {est.lines.map((l) => (
          <li key={l.id} className="flex justify-between">
            <span>{l.description}</span>
            <span>{Number(l.lineTotal).toFixed(2)}</span>
          </li>
        ))}
      </ul>
      <div className="border-t border-black/10 pt-2 text-right text-sm dark:border-white/15">
        <div>Subtotal: {money(Number(est.subtotal))}</div>
        <div>VAT (5%): {money(Number(est.vatAmount))}</div>
        <div className="text-lg font-semibold">Total: {money(Number(est.total))}</div>
      </div>

      {decided ? (
        <p className="rounded-md bg-zinc-100 p-3 text-center text-sm font-medium dark:bg-zinc-800">
          {est.status === "APPROVED" ? "✅ You approved this estimate." : "❌ You declined this estimate."}
        </p>
      ) : est.status === "SENT" ? (
        <div className="flex gap-2">
          <form action={approveEstimatePublic} className="flex-1">
            <input type="hidden" name="token" value={token} />
            <button className="w-full rounded-lg bg-green-600 px-4 py-3 font-semibold text-white hover:bg-green-500">
              Approve
            </button>
          </form>
          <form action={rejectEstimatePublic} className="flex-1">
            <input type="hidden" name="token" value={token} />
            <button className="w-full rounded-lg border border-black/15 px-4 py-3 font-medium dark:border-white/20">
              Decline
            </button>
          </form>
        </div>
      ) : (
        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          This estimate isn’t ready for approval yet.
        </p>
      )}
    </main>
  );
}
