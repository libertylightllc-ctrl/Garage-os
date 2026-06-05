import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { confirmCollectionPublic } from "@/app/actions/delivery";
import { verifyToken } from "@/lib/tokens";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

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
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{job.garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("collectionTitle")}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {job.vehicle.make} {job.vehicle.model} · {job.vehicle.plate}
        </p>
      </div>

      {confirmed ? (
        <p className="rounded-lg bg-green-50 p-4 text-center text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {t("collectionThanks")}
        </p>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t("collectionIntro")}</p>
          <form action={confirmCollectionPublic}>
            <input type="hidden" name="token" value={token} />
            <button className="w-full rounded-lg bg-green-600 px-4 py-3 text-base font-semibold text-white hover:bg-green-500">
              {t("confirmCollectionBtn")}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
