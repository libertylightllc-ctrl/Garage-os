import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { addStaffAction, removeStaffAction } from "@/app/actions/onboarding";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

const field =
  "rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20";

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const { error } = await searchParams;
  const t = await getT();

  const staff = await prisma.user.findMany({
    where: { garageId: session.user.garageId },
    orderBy: { createdAt: "asc" },
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="team" />
      <h1 className="text-2xl font-semibold tracking-tight">{t("team")}</h1>

      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error === "exists" ? t("emailExists") : t("teamError")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {staff.map((u) => (
          <li
            key={u.id}
            className="flex items-center justify-between rounded-lg border border-black/10 p-3 text-sm dark:border-white/15"
          >
            <span>
              <span className="font-medium">{u.name}</span>{" "}
              <span className="text-zinc-500 dark:text-zinc-400">· {u.role} · {u.email}</span>
            </span>
            {u.role !== "OWNER" ? (
              <form action={removeStaffAction}>
                <input type="hidden" name="userId" value={u.id} />
                <button className="text-xs text-red-600 hover:underline">{t("remove")}</button>
              </form>
            ) : (
              <span className="text-xs text-zinc-400">{t("ownerTag")}</span>
            )}
          </li>
        ))}
      </ul>

      <form action={addStaffAction} className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 dark:border-white/15">
        <h2 className="text-sm font-medium">{t("addStaff")}</h2>
        <div className="flex flex-wrap gap-2">
          <input name="name" placeholder={t("name")} required className={`${field} flex-1`} />
          <select name="role" className={field} defaultValue="ADVISOR">
            <option value="ADVISOR">{t("optAdvisor")}</option>
            <option value="TECH">{t("optTechnician")}</option>
            <option value="ACCOUNTANT">{t("optAccountant")}</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <input name="email" type="email" placeholder={t("email")} required className={`${field} flex-1`} />
          <input name="password" type="password" placeholder={t("tempPassword")} required minLength={6} className={`${field} flex-1`} />
          <button className="rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-white dark:text-black">
            {t("add")}
          </button>
        </div>
      </form>
    </main>
  );
}
