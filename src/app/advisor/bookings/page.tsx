import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { confirmBookingAction, rejectBookingAction } from "@/app/actions/intake";
import type { IntakeProposal } from "@/lib/ai";

export const dynamic = "force-dynamic";

export default async function BookingsInbox() {
  const session = await requireRole("ADVISOR");

  const bookings = await prisma.booking.findMany({
    where: { garageId: session.user.garageId, status: "PROPOSED" },
    include: { customer: true, vehicle: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="bookings" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New bookings</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          AI proposed — you confirm. Confirming creates a job card.
        </p>
      </div>

      {bookings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-zinc-500 dark:border-white/20 dark:text-zinc-400">
          No pending bookings.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {bookings.map((b) => {
            const p = b.aiProposalJson as unknown as IntakeProposal | null;
            return (
              <li key={b.id} className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
                <div className="font-medium">
                  {b.vehicle?.make} {b.vehicle?.model}{" "}
                  <span className="text-zinc-500 dark:text-zinc-400">{b.vehicle?.plate}</span>
                </div>
                <div className="text-zinc-500 dark:text-zinc-400">
                  {b.customer.name} · {b.customer.phone}
                </div>
                <p className="mt-1 italic">“{b.rawText}”</p>
                {p ? (
                  <p className="mt-1 rounded bg-zinc-100 p-2 dark:bg-zinc-800">
                    🤖 {p.likelyIssue} — {p.suggestedServices.join(", ")} ({p.urgency})
                  </p>
                ) : null}
                {b.photoUrls.length > 0 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.photoUrls[0]} alt="customer photo" className="mt-2 max-h-40 rounded-md" />
                ) : null}
                <div className="mt-3 flex gap-2">
                  <form action={confirmBookingAction}>
                    <input type="hidden" name="bookingId" value={b.id} />
                    <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-black">
                      Confirm → create job
                    </button>
                  </form>
                  <form action={rejectBookingAction}>
                    <input type="hidden" name="bookingId" value={b.id} />
                    <button className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20">
                      Reject
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
