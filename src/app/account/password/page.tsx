import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { changePasswordAction } from "@/app/actions/account";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { type StaffRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

interface SP {
  error?: string;
  ok?: string;
}

const ERR_KEY: Record<string, MessageKey> = {
  "current-wrong": "pwdErrCurrent",
  short: "pwdErrShort",
  mismatch: "pwdErrMismatch",
  missing: "pwdErrMissing",
};

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const t = await getT();
  const { error, ok } = await searchParams;
  const errKey = error ? ERR_KEY[error] : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-6">
      <AppNav role={session.user.role as StaffRole} />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("changePasswordTitle")}</h1>
        <p className="mt-1 text-sm text-text-mute">{t("changePasswordIntro")}</p>
      </div>

      {ok ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("passwordChanged")}
        </p>
      ) : null}

      {errKey ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {t(errKey)}
        </p>
      ) : null}

      <form action={changePasswordAction} className="flex flex-col gap-3">
        <label className="text-xs text-text-mute">
          {t("currentPassword")}
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs text-text-mute">
          {t("newPasswordLabel")}
          <input
            name="next"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs text-text-mute">
          {t("confirmNewPassword")}
          <input
            name="confirm"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
          />
        </label>
        <Button type="submit">{t("changePasswordSubmit")}</Button>
      </form>
    </main>
  );
}
