import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { addStaffAction, removeStaffAction } from "@/app/actions/onboarding";
import { listBranches } from "@/lib/branches";
import { getT } from "@/i18n/server";

export const dynamic ="force-dynamic";

const field =
"rounded-md border border-border bg-transparent px-2 py-1 text-sm";

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireRole("OWNER");
  const { error } = await searchParams;
  const t = await getT();

  const branches = await listBranches(session.user.garageId);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const multiBranch = branches.length > 1;

  const staff = await prisma.user.findMany({
    where: { garageId: { in: branches.map((b) => b.id) } },
    orderBy: { createdAt:"asc"},
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <AppNav role="OWNER" active="team"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("team")}</h1>

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {error ==="exists"? t("emailExists") : t("teamError")}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {staff.map((u) => (
          <li
            key={u.id}
            className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
          >
            <span>
              <span className="font-medium">{u.name}</span>{""}
              <span className="text-text-mute">
                · {u.role} · {u.email}
                {multiBranch ? ` · ${branchName.get(u.garageId) ?? ""}` :""}
              </span>
            </span>
            {u.role !=="OWNER"? (
              <form action={removeStaffAction}>
                <input type="hidden" name="userId" value={u.id} />
                <button className="text-xs text-red-600 hover:underline">{t("remove")}</button>
              </form>
            ) : (
              <span className="text-xs text-text-mute">{t("ownerTag")}</span>
            )}
          </li>
        ))}
      </ul>

      <form action={addStaffAction} className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <h2 className="text-sm font-medium">{t("addStaff")}</h2>
        <div className="flex flex-wrap gap-2">
          <input name="name" placeholder={t("name")} required className={`${field} flex-1`} />
          <select name="role" className={field} defaultValue="ADVISOR">
            <option value="ADVISOR">{t("optAdvisor")}</option>
            <option value="TECH">{t("optTechnician")}</option>
            <option value="CASHIER">{t("optCashier")}</option>
          </select>
          {multiBranch ? (
            <select name="branchId" className={field} defaultValue={branches[0]?.id}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <input name="email" type="email" placeholder={t("email")} required className={`${field} flex-1`} />
          <input name="password" type="password" placeholder={t("tempPassword")} required minLength={6} className={`${field} flex-1`} />
          <button className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold bg-brand-900 text-white hover:bg-brand-700 transition-colors dark:bg-white dark:text-brand-900 dark:hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60">
            {t("add")}
          </button>
        </div>
      </form>
    </main>
  );
}
