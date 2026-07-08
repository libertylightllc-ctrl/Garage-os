import Link from "next/link";
import { requireAnyRole } from "@/lib/guard";
import { moulkiaBackAction } from "@/app/actions/intake-moulkia";
import { AppNav } from "@/components/app-nav";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

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
    vin?: string;
    make?: string;
    model?: string;
    year?: string;
    assignedToId?: string;
  }>;
}) {
  await requireAnyRole(["ADVISOR", "OWNER"]);
  const t = await getT();
  const {
    ownerName ="",
    plate ="",
    vin ="",
    make ="",
    model ="",
    year ="",
    assignedToId ="",
  } = await searchParams;

  // Build the skip URL — preserve everything we already extracted from the
  // front (owner + plate + vehicle specs).
  const skipParams = new URLSearchParams({ via:"moulkia", skippedBack:"1"});
  if (ownerName) skipParams.set("ownerName", ownerName);
  if (plate) skipParams.set("plate", plate);
  if (vin) skipParams.set("vin", vin);
  if (make) skipParams.set("make", make);
  if (model) skipParams.set("model", model);
  if (year) skipParams.set("year", year);
  if (assignedToId) skipParams.set("assignedToId", assignedToId);
  const skipHref = `/advisor/jobs/new/confirm?${skipParams.toString()}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6">
      <AppNav role="ADVISOR" active="jobs"/>
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
          {/* Carry the FRONT extraction across into the back action — every
              field the front captured rides along so the merge can see them. */}
          <input type="hidden" name="frontOwnerName" value={ownerName} />
          <input type="hidden" name="frontPlate" value={plate} />
          <input type="hidden" name="frontVin" value={vin} />
          <input type="hidden" name="frontMake" value={make} />
          <input type="hidden" name="frontModel" value={model} />
          <input type="hidden" name="frontYear" value={year} />
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
