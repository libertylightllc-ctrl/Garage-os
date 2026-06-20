import Link from "next/link";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { getT } from "@/i18n/server";
import { Button } from "@/components/ui/button";

async function loginAction(formData: FormData) {
"use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("credentials", { email, password, redirectTo:"/"});
  } catch (err) {
    if (err instanceof AuthError) {
      redirect("/login?error=1");
    }
    throw err; // let Next's redirect signal propagate
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; new?: string }>;
}) {
  const { error, new: isNew } = await searchParams;
  const t = await getT();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/garageos-logo.png"
          alt="Garage Os"
          className="h-24 w-auto dark:invert"
        />
        <h1 className="text-2xl font-semibold tracking-tight">{t("signInTitle")}</h1>
      </div>

      {isNew ? (
        <p className="rounded-xl border border-success-500/40 bg-success-50 px-4 py-2.5 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/10 dark:text-success-500">
          {t("garageCreated")}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {t("invalid")}
        </p>
      ) : null}

      <form action={loginAction} className="flex flex-col gap-3">
        <input
          name="email"
          type="email"
          placeholder={t("email")}
          required
          autoComplete="username"
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
        />
        <input
          name="password"
          type="password"
          placeholder={t("password")}
          required
          autoComplete="current-password"
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
        />
        <Button type="submit">{t("signIn")}</Button>
      </form>

      <div className="rounded-md border border-border p-3 text-xs text-text-mute">
        <p className="mb-1 font-medium">{t("demoTitle")}</p>
        <ul className="space-y-0.5">
          <li>owner@demo.garage · advisor@demo.garage</li>
          <li>tech@demo.garage · cashier@demo.garage</li>
        </ul>
      </div>

      <p className="text-center text-sm text-text-mute">
        {t("newGarageQ")}{""}
        <Link href="/signup" className="font-medium underline-offset-2 hover:underline">
          {t("setOneUp")}
        </Link>
      </p>
    </main>
  );
}
