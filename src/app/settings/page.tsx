import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import {
  updateProfileNameAction,
  updateProfileEmailAction,
  updateDefaultPartsMarkupAction,
} from "@/app/actions/settings";
import { removeGarageLogoAction } from "@/app/actions/garage-logo";
import { GarageLogoForm } from "@/components/garage-logo-form";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { type StaffRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

interface SP {
  error?: string;
  ok?: string;
}

// Error code → i18n key. Codes are slugs in the URL; messages live in
// i18n so en/ar render right. Centralising here so the page render
// stays small.
const ERR_KEY: Record<string, MessageKey> = {
  "name-required": "settingsErrNameRequired",
  "name-too-long": "settingsErrNameTooLong",
  "email-missing": "settingsErrEmailMissing",
  "email-invalid": "settingsErrEmailInvalid",
  "email-current-wrong": "settingsErrEmailCurrentWrong",
  "email-taken": "settingsErrEmailTaken",
  "email-no-password": "settingsErrEmailNoPassword",
  // Logo upload — LogoValidationError.code from saveLogoUpload comes
  // through as `?error=logo-<code lowercased>` (see garage-logo.ts).
  "logo-missing": "settingsErrLogoMissing",
  "logo-empty": "settingsErrLogoEmpty",
  "logo-too_large": "settingsErrLogoTooLarge",
  "logo-bad_mime": "settingsErrLogoBadMime",
  "logo-bad_magic": "settingsErrLogoBadMagic",
  "logo-mime_mismatch": "settingsErrLogoMimeMismatch",
  // Owner-only markup edit
  "role": "settingsErrRole",
  "markup-invalid": "settingsErrMarkupInvalid",
  "markup-range": "settingsErrMarkupRange",
};
const OK_KEY: Record<string, MessageKey> = {
  name: "settingsOkName",
  email: "settingsOkEmail",
  "email-unchanged": "settingsOkEmailUnchanged",
  "logo-saved": "settingsOkLogoSaved",
  "logo-removed": "settingsOkLogoRemoved",
  "markup": "settingsOkMarkup",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const t = await getT();
  const { error, ok } = await searchParams;

  // Read the user's current name from DB rather than the JWT — JWT can
  // be stale after the last update, DB is authoritative for the form
  // default value.
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true },
  });
  if (!me) redirect("/login");

  const role = session.user.role as StaffRole;
  const isOwner = role === "OWNER";

  // Owners see the Garage details section, which currently surfaces the
  // logoUrl. Reading conditionally so non-owners' page render doesn't
  // hit the DB for a value they wouldn't see anyway.
  const garage = isOwner
    ? await prisma.garage.findUnique({
        where: { id: session.user.garageId },
        select: { logoUrl: true, defaultPartsMarkupPct: true },
      })
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role={role} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("settingsTitle")}</h1>
        <p className="mt-1 text-sm text-text-mute">{t("settingsIntro")}</p>
      </div>

      {ok && OK_KEY[ok] ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t(OK_KEY[ok])}
        </p>
      ) : null}

      {error && ERR_KEY[error] ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {t(ERR_KEY[error])}
        </p>
      ) : null}

      {/* Profile section */}
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">{t("settingsSecProfile")}</h2>
        <p className="mt-0.5 text-xs text-text-mute">{t("settingsSecProfileHint")}</p>

        {/* Two separate forms in this section:
              1. Name — no gate, low risk
              2. Email — current-password gated, high-impact change
            Splitting them avoids asking for the current password when
            the user just wants to fix a typo in their name. */}
        <form action={updateProfileNameAction} className="mt-4 flex flex-col gap-3">
          <label className="text-xs text-text-mute">
            {t("settingsProfileName")}
            <input
              name="name"
              defaultValue={me.name}
              required
              maxLength={80}
              className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <div>
            <Button type="submit">{t("settingsProfileSaveName")}</Button>
          </div>
        </form>

        <hr className="my-5 border-border" />

        <form action={updateProfileEmailAction} className="flex flex-col gap-3">
          <label className="text-xs text-text-mute">
            {t("settingsProfileEmail")}
            <input
              name="newEmail"
              type="email"
              defaultValue={me.email}
              required
              maxLength={200}
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <p className="rounded-md border border-warning-500/40 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-500">
            ⚠️ {t("settingsProfileEmailWarning")}
          </p>
          <label className="text-xs text-text-mute">
            {t("settingsProfileEmailCurrent")}
            <input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <div>
            <Button type="submit">{t("settingsProfileSaveEmail")}</Button>
          </div>
        </form>
      </section>

      {/* Password section — links to the existing /account/password form */}
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">{t("settingsSecPassword")}</h2>
        <p className="mt-0.5 text-xs text-text-mute">{t("settingsSecPasswordHint")}</p>
        <div className="mt-3">
          <Link
            href="/account/password"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-2 transition-colors"
          >
            {t("changePassword")} →
          </Link>
        </div>
      </section>

      {/* Owner-only sections — gated server-side. Non-owners never see this
          markup at all, so there's no information leak even before the
          owner-only actions independently verify role. */}
      {isOwner ? (
        <>
          {/* Garage details — Phase C of the per-garage logo upload.
              Only the logo is wired here for now; name + TRN edit
              fields will land on this section in a later phase. */}
          <section className="rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold">
              {t("settingsSecGarageLogo")}
            </h2>
            <p className="mt-0.5 text-xs text-text-mute">
              {t("settingsSecGarageLogoHint")}
            </p>
            <div className="mt-3">
              <GarageLogoForm
                currentLogoUrl={garage?.logoUrl ?? null}
                labels={{
                  pick: t("settingsLogoPick"),
                  picked: t("settingsLogoPicked"),
                  replace: t("settingsLogoReplace"),
                  upload: t("settingsLogoUpload"),
                  uploading: t("settingsLogoUploading"),
                  errTooLarge: t("settingsErrLogoTooLarge"),
                  errBadType: t("settingsErrLogoBadMime"),
                }}
              />
              {garage?.logoUrl ? (
                <form action={removeGarageLogoAction} className="mt-3">
                  <button
                    type="submit"
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-danger-700 hover:bg-danger-50 dark:text-danger-500 dark:hover:bg-danger-500/10 transition-colors"
                  >
                    {t("settingsLogoRemove")}
                  </button>
                </form>
              ) : null}
            </div>
          </section>

          {/* Pricing defaults — cost-based estimate pricing hint used
              by the advisor's line editor at line-create time. Internal
              to the shop; never appears on customer-facing surfaces.
              (AR 2026-08-12.) */}
          <section className="rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold">
              {t("settingsSecPricing")}
            </h2>
            <p className="mt-0.5 text-xs text-text-mute">
              {t("settingsSecPricingHint")}
            </p>
            <form
              action={updateDefaultPartsMarkupAction}
              className="mt-3 flex flex-col gap-2"
            >
              <label
                htmlFor="defaultPartsMarkupPct"
                className="text-sm font-medium"
              >
                {t("settingsPricingMarkupLabel")}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="defaultPartsMarkupPct"
                  name="defaultPartsMarkupPct"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  max="999.99"
                  placeholder={t("settingsPricingMarkupPlaceholder")}
                  defaultValue={
                    garage?.defaultPartsMarkupPct != null
                      ? String(garage.defaultPartsMarkupPct)
                      : ""
                  }
                  className="h-10 w-32 rounded-lg border border-border bg-transparent px-3 text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-accent-500/60"
                />
                <span className="text-sm text-text-mute">%</span>
                <Button type="submit" variant="primary">
                  {t("settingsSave")}
                </Button>
              </div>
              <p className="text-xs text-text-mute">
                {t("settingsPricingMarkupHint")}
              </p>
            </form>
          </section>

          <section className="rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold">{t("settingsSecTeam")}</h2>
            <p className="mt-0.5 text-xs text-text-mute">{t("settingsSecTeamHint")}</p>
            <div className="mt-3">
              <Link
                href="/owner/staff"
                className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-2 transition-colors"
              >
                {t("settingsSecTeamGo")} →
              </Link>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
