import Link from "next/link";
import { getT } from "@/i18n/server";

export default async function NotFound() {
  const t = await getT();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t("notFoundTitle")}</h1>
      <p className="text-sm text-text-mute">{t("notFoundBody")}</p>
      <Link
        href="/"
        className="rounded-md border border-border px-4 py-2 text-sm font-medium"
      >
        {t("notFoundGoHome")}
      </Link>
    </main>
  );
}
