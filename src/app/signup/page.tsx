import Link from "next/link";
import { signupAction } from "@/app/actions/onboarding";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";

export const dynamic ="force-dynamic";

const field =
"w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm";

export default async function Signup({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const t = await getT();
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-8">
      <div>
        <p className="text-sm text-text-mute">Garage Os</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("signupTitle")}</h1>
        <p className="text-sm text-text-mute">{t("signupIntro")}</p>
      </div>

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {error ==="exists"? t("emailExists") : t("fillAllFields")}
        </p>
      ) : null}

      <form action={signupAction} className="flex flex-col gap-3">
        <input name="garageName" placeholder={t("garageName")} required className={field} />
        <input name="trn" placeholder={t("vatTrnOptional")} className={field} />
        <input name="name" placeholder={t("yourNameOwner")} required className={field} />
        <input name="email" type="email" placeholder={t("email")} required autoComplete="username" className={field} />
        <input
          name="password"
          type="password"
          placeholder={t("passwordMin6")}
          required
          minLength={6}
          autoComplete="new-password"
          className={field}
        />
        <Button>{t("createGarage")}</Button>
      </form>

      <p className="text-center text-sm text-text-mute">
        {t("alreadySetup")}{""}
        <Link href="/login" className="font-medium underline-offset-2 hover:underline">
          {t("signIn")}
        </Link>
      </p>
    </main>
  );
}
