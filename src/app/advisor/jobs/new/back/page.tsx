import Link from "next/link";
import { requireRole } from "@/lib/guard";
import { moulkiaBackAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

// Step 2 of the Moulkia two-photo flow. The advisor has just captured the front
// (owner + plate); now we ask for the back (VIN, make, model, year, engine no.).
// Front fields ride along as hidden inputs so we can merge after the back OCR.
//
// Skip link: takes the advisor straight to the confirm page with skippedBack=1,
// front fields preserved. Reception can fill the back manually when the photo
// is unreadable — they're never blocked.
export default async function NewJobMoulkiaBack({
  searchParams,
}: {
  searchParams: Promise<{
    ownerName?: string;
    plate?: string;
    assignedToId?: string;
  }>;
}) {
  await requireRole("ADVISOR");
  const t = await getT();
  const { ownerName = "", plate = "", assignedToId = "" } = await searchParams;

  // Build the skip URL — preserve everything we already extracted.
  const skipParams = new URLSearchParams({ via: "moulkia", skippedBack: "1" });
  if (ownerName) skipParams.set("ownerName", ownerName);
  if (plate) skipParams.set("plate", plate);
  if (assignedToId) skipParams.set("assignedToId", assignedToId);
  const skipHref = `/advisor/jobs/new/confirm?${skipParams.toString()}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link
          href="/advisor/jobs/new"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("backOfMoulkia")}</h1>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t("step2of2")}</p>
      </div>

      <section className="rounded-lg border border-emerald-500/40 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/40">
        <p className="font-medium">{t("frontCaptured")}</p>
        {ownerName ? <p className="mt-1 text-xs">{ownerName}</p> : null}
        {plate ? <p className="text-xs">{plate}</p> : null}
      </section>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/15">
        <form action={moulkiaBackAction} className="flex flex-col gap-3">
          {/* Carry the front extraction across into the back action so we can merge. */}
          <input type="hidden" name="frontOwnerName" value={ownerName} />
          <input type="hidden" name="frontPlate" value={plate} />
          <input type="hidden" name="assignedToId" value={assignedToId} />
          <PhotoCapture
            name="file"
            mode="auto-submit"
            kind="photo"
            required
            buttonLabel={t("takePhotoMoulkiaBack")}
            retakeLabel={t("retake")}
            continueLabel={t("usePhoto")}
            tooBigLabel={t("fileTooBig")}
            wrongTypeLabel={t("wrongFileType")}
          />
        </form>
      </section>

      <div className="text-center">
        <Link
          href={skipHref}
          className="text-sm text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
        >
          {t("skipBackLink")}
        </Link>
      </div>
    </main>
  );
}
