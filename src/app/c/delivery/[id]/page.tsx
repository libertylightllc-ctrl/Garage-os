import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { confirmCollectionPublic } from "@/app/actions/delivery";
import { verifyToken } from "@/lib/tokens";
import { getT } from "@/i18n/server";

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
   <div>
    <p className="text-sm text-text-mute">{job.garage.name}</p>
    <h1 className="text-2xl font-semibold tracking-tight">{t("collectionTitle")}</h1>
    <p className="text-sm text-text-mute">
     {job.vehicle.make} {job.vehicle.model} · {job.vehicle.plate}
    </p>
   </div>

   {confirmed ? (
    <p className="rounded-xl border border-success-500/40 bg-success-50 p-4 text-center text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
     {t("collectionThanks")}
    </p>
   ) : (
    <>
     <p className="text-sm text-zinc-600 dark:text-text-mute">{t("collectionIntro")}</p>
     <form action={confirmCollectionPublic}>
      <input type=" hidden" name="token" value={token} />
      <button className="inline-flex w-full h-12 items-center justify-center rounded-lg bg-success-600 px-4 text-base font-semibold text-white hover:bg-success-700 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
       {t("confirmCollectionBtn")}
      </button>
     </form>
    </>
   )}
  </main>
 );
}
