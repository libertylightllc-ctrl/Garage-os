import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { updateProfileNameAction } from "@/app/actions/settings";
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
};
const OK_KEY: Record<string, MessageKey> = {
  name: "settingsOkName",
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
          <label className="text-xs text-text-mute">
            {t("settingsProfileEmail")}
            <input
              type="email"
              defaultValue={me.email}
              disabled
              className="mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-mute"
            />
            <span className="mt-1 block text-xs text-text-mute">
              {t("settingsProfileEmailLockedHint")}
            </span>
          </label>
          <div>
            <Button type="submit">{t("settingsProfileSave")}</Button>
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
          <section className="rounded-xl border border-border p-4">
            <h2 className="text-base font-semibold">{t("settingsSecGarage")}</h2>
            <p className="mt-0.5 text-xs text-text-mute">{t("settingsSecGarageComingSoon")}</p>
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
