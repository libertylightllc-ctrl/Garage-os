import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { confirmCollectionPublic } from "@/app/actions/delivery";
import { verifyToken } from "@/lib/tokens";
import { getT } from "@/i18n/server";
import { DocumentHeader } from "@/components/document-header";

export const dynamic ="force-dynamic";

// Customer-facing collection-confirm page (the WhatsApp link's destination).
// Authorization is the signed capability token in the URL; no staff auth.
export default async function CustomerCollection({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: token } = await params;
  const id = verifyToken("delivery", token);
  if (!id) notFound();
  const job = await prisma.jobCard.findUnique({
    where: { id },
    include: { vehicle: { include: { customer: true } }, garage: true },
  });
  if (!job) notFound();
  const t = await getT();
  const confirmed = !!job.deliveryConfirmedAt;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="flex flex-col items-start gap-3">
        {/* Customer-facing document — pass raw logoUrl. When null, the
            header falls back to text-only garage name; we deliberately
            do NOT show the GarageOS mark on a customer's document. */}
        <DocumentHeader
          title={t("documentDelivery")}
          jobCard={job}
          vehicle={job.vehicle}
          garage={job.garage}
          logoUrl={job.garage.logoUrl}
        />
      </div>

      {confirmed ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 p-4 text-center text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("collectionThanks")}
        </p>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-text-mute">{t("collectionIntro")}</p>
          <form action={confirmCollectionPublic}>
            <input type="hidden" name="token" value={token} />
            <button className="inline-flex w-full h-12 items-center justify-center rounded-lg bg-success-600 px-4 text-base font-semibold text-white hover:bg-success-700 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
              {t("confirmCollectionBtn")}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
