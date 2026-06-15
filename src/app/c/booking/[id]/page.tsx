import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import type { IntakeProposal } from "@/lib/ai";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

export default async function BookingConfirmation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { garage: { select: { name: true } }, vehicle: true },
  });
  if (!booking) notFound();
  const t = await getT();

  const proposal = booking.aiProposalJson as unknown as IntakeProposal | null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-text-mute">{booking.garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("thanksGotIt")}</h1>
      </div>

      <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        <p className="mb-2 text-text-mute">{t("youToldUs")}</p>
        <p className="mb-3 italic">“{booking.rawText}”</p>
        {proposal ? (
          <>
            <p className="font-medium">{t("ourFirstRead")}</p>
            <p>🔧 {proposal.likelyIssue}</p>
            <p className="text-zinc-600 dark:text-text-mute">
              {t("suggested")}: {proposal.suggestedServices.join(",")}
            </p>
            <p className="text-zinc-600 dark:text-text-mute">{t("urgencyLabel")}: {proposal.urgency}</p>
          </>
        ) : null}
      </div>

      <p className="rounded-xl border border-border bg-surface-2 p-4 text-center text-sm">
        {booking.status ==="CONFIRMED"
          ? t("bookingConfirmed")
          : booking.status ==="REJECTED"
            ? t("bookingRejected")
            : t("bookingPending")}
      </p>
    </main>
  );
}
