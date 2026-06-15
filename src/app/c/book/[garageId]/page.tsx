import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createBookingPublic } from "@/app/actions/intake";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

const field =
"w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

export default async function CustomerBooking({ params }: { params: Promise<{ garageId: string }> }) {
  const { garageId } = await params;
  const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { name: true } });
  if (!garage) notFound();
  const t = await getT();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-text-mute">{garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("bookTitle")}</h1>
        <p className="text-sm text-text-mute">{t("bookIntro")}</p>
      </div>

      <form action={createBookingPublic} className="flex flex-col gap-3">
        <input type=" hidden" name="garageId" value={garageId} />
        <div className="flex gap-2">
          <input name="name" placeholder={t("name")} className={field} />
          <input name="phone" placeholder={t("phone")} required className={field} />
        </div>
        <div className="flex gap-2">
          <input name="make" placeholder={t("make")} className={field} />
          <input name="model" placeholder={t("model")} className={field} />
          <input name="plate" placeholder={t("plate")} className={field} />
        </div>
        <textarea name="text" required rows={3} placeholder={t("describe")} className={field} />
        <div className="text-sm text-text-mute">
          {t("optionalPhoto")}
          <div className="mt-2">
            <PhotoCapture
              name="photo"
              mode="preview"
              kind="photo"
              buttonLabel={t("takePhoto")}
              retakeLabel={t("retake")}
              continueLabel={t("usePhoto")}
              tooBigLabel={t("fileTooBig")}
              wrongTypeLabel={t("wrongFileType")}
            />
          </div>
        </div>
        <button className="rounded-lg bg-zinc-900 px-4 py-3 font-semibold text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200">
          {t("getProposal")}
        </button>
      </form>
    </main>
  );
}
