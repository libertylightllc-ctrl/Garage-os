import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createBookingPublic } from "@/app/actions/intake";
import { PhotoCapture } from "@/components/photo-capture";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

// AR 2026-08-26 — public booking page. Garage name in the title
// so a customer searching for their shop can actually find this
// URL through Google. The garage row is a single indexed lookup
// against Garage.id (cuid); the page render below does the same
// query, but generateMetadata runs before the render so the two
// requests can't share the fetch here — kept small and separate.
// A missing garage returns a generic title; the render then
// notFound()s on the same missing id.
export async function generateMetadata(
    { params }: { params: Promise<{ garageId: string }> },
): Promise<Metadata> {
    const { garageId } = await params;
    const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { name: true },
    });
    if (!garage) {
        return {
            title: "Book a service",
            robots: { index: false, follow: false },
        };
    }
    return {
        title: `Book a service with ${garage.name}`,
        description: `Book your car in for service, repair or diagnosis at ${garage.name}. Send photos, register the vehicle, and get a WhatsApp reply from the workshop.`,
        alternates: {
            canonical: `/c/book/${garageId}`,
        },
        openGraph: {
            title: `Book a service with ${garage.name}`,
            description: `Book your car in for service at ${garage.name}. Powered by GarageOS.`,
            url: `https://www.garageos.shop/c/book/${garageId}`,
            type: "website",
        },
        // Public by design — index this page. Explicit so a future
        // sitewide noindex default doesn't accidentally silence it.
        robots: { index: true, follow: true },
    };
}

const field =
"w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm dark:border-white/20";

export default async function CustomerBooking({
  params,
  searchParams,
}: {
  params: Promise<{ garageId: string }>;
  searchParams: Promise<{ photoError?: string }>;
}) {
  const { garageId } = await params;
  const { photoError } = await searchParams;
  const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { name: true } });
  if (!garage) notFound();
  const t = await getT();

  // Render-side whitelist for the photo rejection banner. Same
  // discipline as the ?emailError= handling on the purchasing PO
  // page — only the known enum codes from validateImageUpload's
  // LogoValidationError can render as a specific message. Anything
  // else (URL fuzzing, a code we later add server-side, a browser
  // extension mangling the query string) falls through to the generic
  // copy. Never t(`bookPhotoErr_${code}`) with an untrusted code —
  // that would send arbitrary URL-supplied strings into i18n lookup.
  const KNOWN_PHOTO_ERRORS = new Set([
    "EMPTY",
    "TOO_LARGE",
    "BAD_MIME",
    "BAD_MAGIC",
    "MIME_MISMATCH",
  ] as const);
  type KnownPhotoError = typeof KNOWN_PHOTO_ERRORS extends Set<infer T> ? T : never;
  const photoErrorMessage: string | null = photoError
    ? KNOWN_PHOTO_ERRORS.has(photoError as KnownPhotoError)
      ? t(`bookPhotoErr_${photoError as KnownPhotoError}` as const)
      : t("bookPhotoErr_generic")
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-sm text-text-mute">{garage.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("bookTitle")}</h1>
        <p className="text-sm text-text-mute">{t("bookIntro")}</p>
      </div>

      {photoErrorMessage ? (
        <div
          role="alert"
          className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500"
        >
          <div className="font-semibold">{t("bookPhotoErrorTitle")}</div>
          <div className="mt-0.5">{photoErrorMessage}</div>
        </div>
      ) : null}

      <form action={createBookingPublic} className="flex flex-col gap-3">
        <input type="hidden" name="garageId" value={garageId} />
        <div className="flex gap-2">
          <input name="name" placeholder={t("name")} className={field} />
          <input name="phone" type="tel" inputMode="tel" pattern="^\+?[\d\s\-()]+$" title={t("customerPhonePatternHint")} placeholder={t("phone")} required className={field} />
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
