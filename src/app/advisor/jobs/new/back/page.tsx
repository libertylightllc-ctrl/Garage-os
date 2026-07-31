import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireAnyRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { moulkiaBackAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

// Step 2 of the Moulkia two-photo flow. The advisor has captured the front
// (owner + plate); now we ask for the back (VIN, make, model, year).
//
// The extracted front fields live server-side in an IntakeDraft row keyed
// by the opaque draftId in the URL. Nothing PII rides the URL — this fix
// closes what slice 3's fix commit (6663146) left open on the OCR pipeline.
// See docs/intake-duplicate-handling-spec.md § "PII in URL — pattern and
// remaining follow-up".
//
// Skip link: takes the advisor straight to the confirm page carrying just
// the draftId + a `skippedBack=1` flag. Reception can fill the back manually
// when the photo is unreadable — they're never blocked.
export default async function NewJobMoulkiaBack({
  searchParams,
}: {
  searchParams: Promise<{ draftId?: string }>;
}) {
  const session = await requireAnyRole(["ADVISOR", "OWNER", "MASTER"]);
  const t = await getT();
  const { draftId } = await searchParams;
  if (!draftId) notFound();

  const now = new Date();
  const draft = await prisma.intakeDraft.findFirst({
    where: {
      id: draftId,
      garageId: session.user.garageId,
      expiresAt: { gt: now },
    },
  });
  // Stale / cross-garage / never-existed → fresh start. Not a 500 —
  // a timeout on a two-hour draft is a normal user story.
  if (!draft) redirect("/advisor/jobs/new");

  // Read-only summary card showing what the front OCR captured. This is
  // the advisor's own garage's own draft's data; rendering it is not the
  // PII-in-URL leak (that was carrying it through address bar / referrer
  // headers / access logs). Here it lives only in the rendered HTML the
  // advisor is looking at.
  const { ownerName, plate, vin, make, model, year } = draft;

  const skipHref = `/advisor/jobs/new/confirm?draftId=${encodeURIComponent(
    draft.id,
  )}&via=moulkia&skippedBack=1`;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs" />
      <div>
        <Link
          href="/advisor/jobs/new"
          className="text-sm text-text-mute hover:underline"
        >
          {t("backActiveJobs")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{t("backOfMoulkia")}</h1>
        <p className="mt-1 text-xs text-text-mute">{t("step2of2")}</p>
      </div>

      <section className="rounded-xl border border-success-500/40 bg-success-50 p-4 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
        <p className="font-medium">{t("frontCaptured")}</p>
        {ownerName ? <p className="mt-1 text-xs">{ownerName}</p> : null}
        {plate ? <p className="text-xs">{plate}</p> : null}
        {make || model || year ? (
          <p className="text-xs">
            {[make, model, year].filter(Boolean).join("·")}
          </p>
        ) : null}
        {vin ? <p className="text-xs">{vin}</p> : null}
      </section>

      <section className="rounded-xl border border-border p-4">
        <form action={moulkiaBackAction} className="flex flex-col gap-3">
          {/* Only the opaque draft id rides forward — the back action
              looks up the front fields from the draft row itself. */}
          <input type="hidden" name="draftId" value={draft.id} />
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
            optimizeForOcr
            optimizingLabel={t("optimizingPhoto")}
          />
        </form>
      </section>

      <div className="text-center">
        <Link
          href={skipHref}
          className="text-sm text-text-mute underline-offset-2 hover:underline dark:text-text-mute"
        >
          {t("skipBackLink")}
        </Link>
      </div>
    </main>
  );
}
