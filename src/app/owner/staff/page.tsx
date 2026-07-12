import { requireRole } from "@/lib/guard";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { addStaffAction, removeStaffAction } from "@/app/actions/onboarding";
import { listBranches } from "@/lib/branches";
import { getT } from "@/i18n/server";
import type { MessageKey } from "@/i18n/config";
import { Button } from "@/components/ui/button";

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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6 lg:max-w-5xl xl:max-w-6xl">
      <AppNav role="OWNER" active="team"/>
      <h1 className="text-2xl font-semibold tracking-tight">{t("team")}</h1>

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          {error ==="exists"? t("emailExists") : t("teamError")}
        </p>
      ) : null}

      {/* Two-column on lg+: staff list on the left, add-staff form on
          the right. Mobile keeps the existing stacked order. Remove
          buttons stay inline per row; the OWNER badge replaces the
          button for the garage owner's own user record. */}
      <div className="lg:grid lg:grid-cols-3 lg:gap-6 lg:items-start">
      <ul className="flex flex-col gap-1 lg:col-span-2">
        {staff.map((u) => (
          <li
            key={u.id}
            className="flex items-center justify-between rounded-xl border border-border p-3 text-sm"
          >
            <span>
              <span className="font-medium">{u.name}</span>{""}
              <span className="text-text-mute">
                · {t(`role${u.role}` as MessageKey)} · {u.email}
                {multiBranch ? ` · ${branchName.get(u.garageId) ?? ""}` :""}
              </span>
            </span>
            {u.role !=="OWNER"? (
              <form action={removeStaffAction}>
                <input type="hidden" name="userId" value={u.id} />
                <button className="text-xs text-danger-700 hover:underline">{t("remove")}</button>
              </form>
            ) : (
              <span className="text-xs text-text-mute">{t("ownerTag")}</span>
            )}
          </li>
        ))}
      </ul>

      <form action={addStaffAction} className="mt-6 flex flex-col gap-2 rounded-xl border border-border p-4 lg:mt-0">
        <h2 className="text-sm font-medium">{t("addStaff")}</h2>
        <div className="flex flex-wrap gap-2">
          <input name="name" placeholder={t("name")} required className={`${field} flex-1`} />
          <select name="role" className={field} defaultValue="ADVISOR">
            <option value="ADVISOR">{t("optAdvisor")}</option>
            <option value="TECH">{t("optTechnician")}</option>
            <option value="CASHIER">{t("optCashier")}</option>
            <option value="MASTER">{t("optMaster")}</option>
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
          <Button>{t("add")}</Button>
        </div>
      </form>
      </div>
    </main>
  );
}
