import { signOutAction } from "@/app/actions/auth";
import { ROLE_TITLE, type StaffRole } from "@/lib/roles";

// Near-empty role home screen. Max 3 primary actions per screen (spec). For now: just Sign out.
export function StaffHome({
  role,
  name,
}: {
  role: StaffRole;
  name?: string | null;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 p-8">
      <div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">GarageOS</p>
        <h1 className="text-3xl font-semibold tracking-tight">{ROLE_TITLE[role]}</h1>
        {name ? (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Signed in as {name}
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        Your workspace will appear here. (Build step 2: role routing only.)
      </div>

      <form action={signOutAction}>
        <button
          type="submit"
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
