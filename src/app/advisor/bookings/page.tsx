import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { confirmBookingAction, rejectBookingAction } from "@/app/actions/intake";
import type { IntakeProposal } from "@/lib/ai";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

export default async function BookingsInbox() {
  const session = await requireRole("ADVISOR");
  const t = await getT();

  const bookings = await prisma.booking.findMany({
    where: { garageId: session.user.garageId, status:"PROPOSED"},
    include: { customer: true, vehicle: true },
    orderBy: { createdAt:"desc"},
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="bookings"/>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("newBookings")}</h1>
        <p className="text-sm text-text-mute">{t("bookingsIntro")}</p>
      </div>

      {bookings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-mute">
          {t("noPendingBookings")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {bookings.map((b) => {
            const p = b.aiProposalJson as unknown as IntakeProposal | null;
            return (
              <li key={b.id} className="rounded-lg border border-border p-4 text-sm">
                <div className="font-medium">
                  {b.vehicle?.make} {b.vehicle?.model}{""}
                  <span className="text-text-mute">{b.vehicle?.plate}</span>
                </div>
                <div className="text-text-mute">
                  {b.customer.name} · {b.customer.phone}
                </div>
                <p className="mt-1 italic">“{b.rawText}”</p>
                {p ? (
                  <p className="mt-1 rounded-lg bg-surface-2 p-2">
                    🤖 {p.likelyIssue} — {p.suggestedServices.join(",")} ({p.urgency})
                  </p>
                ) : null}
                {b.photoUrls.length > 0 ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.photoUrls[0]} alt="customer photo" className="mt-2 max-h-40 rounded-md"/>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <form action={confirmBookingAction}>
                    <input type=" hidden" name="bookingId" value={b.id} />
                    <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
                      {t("confirmCreateJob")}
                    </button>
                  </form>
                  <form action={rejectBookingAction}>
                    <input type=" hidden" name="bookingId" value={b.id} />
                    <button className="rounded-md border border-border px-4 py-2 text-sm font-medium">
                      {t("reject")}
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
