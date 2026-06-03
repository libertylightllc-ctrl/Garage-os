import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import type { IntakeProposal } from "@/lib/ai";

export const dynamic = "force-dynamic";

export default async function BookingConfirmation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { garage: { select: { name: true } }, vehicle: true },
  });
  if (!booking) notFound();

  const proposal = booking.aiProposalJson as unknown as IntakeProposal | null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{booking.garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">Thanks — we’ve got it</h1>
      </div>

      <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        <p className="mb-2 text-zinc-500 dark:text-zinc-400">You told us:</p>
        <p className="mb-3 italic">“{booking.rawText}”</p>
        {proposal ? (
          <>
            <p className="font-medium">Our first read:</p>
            <p>🔧 {proposal.likelyIssue}</p>
            <p className="text-zinc-600 dark:text-zinc-300">
              Suggested: {proposal.suggestedServices.join(", ")}
            </p>
            <p className="text-zinc-600 dark:text-zinc-300">Urgency: {proposal.urgency}</p>
          </>
        ) : null}
      </div>

      <p className="rounded-md bg-zinc-100 p-3 text-center text-sm dark:bg-zinc-800">
        {booking.status === "CONFIRMED"
          ? "✅ An advisor confirmed your booking."
          : booking.status === "REJECTED"
            ? "An advisor will call you to discuss."
            : "🕒 An advisor will confirm shortly. This is a proposal, not a final quote."}
      </p>
    </main>
  );
}
