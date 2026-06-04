import Link from "next/link";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { getT } from "@/i18n/server";

async function loginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
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
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">GarageOS</p>
        <h1 className="text-2xl font-semibold tracking-tight">{t("signInTitle")}</h1>
      </div>

      {isNew ? (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {t("garageCreated")}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
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
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20 dark:bg-transparent"
        />
        <input
          name="password"
          type="password"
          placeholder={t("password")}
          required
          autoComplete="current-password"
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20 dark:bg-transparent"
        />
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {t("signIn")}
        </button>
      </form>

      <div className="rounded-md border border-black/10 p-3 text-xs text-zinc-500 dark:border-white/15 dark:text-zinc-400">
        <p className="mb-1 font-medium">{t("demoTitle")}</p>
        <ul className="space-y-0.5">
          <li>owner@demo.garage · advisor@demo.garage</li>
          <li>tech@demo.garage · cashier@demo.garage</li>
        </ul>
      </div>

      <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
        {t("newGarageQ")}{" "}
        <Link href="/signup" className="font-medium underline-offset-2 hover:underline">
          {t("setOneUp")}
        </Link>
      </p>
    </main>
  );
}
