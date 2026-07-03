import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";

// Admin sign-in. Deliberately plain — no logo, no localization, no
// "forgot password" link. This page exists only for operators; it's
// not customer-facing surface and shouldn't look like one. Cross-link
// to /admin/* from regular pages is FORBIDDEN (see Phase 1 scope).
//
// Auth flow:
//   1. Submit credentials → signIn("admin-credentials")
//   2. NextAuth's adminProvider hits AdminUser table, sets isAdmin
//   3. On success, signIn redirects to /admin/garages where
//      requireAdmin() does the real gate
//   4. On any failure, bounce back here with ?error=1 — same shape as
//      the staff login so we never leak "user exists, password wrong"
//      vs "user doesn't exist"
async function adminLoginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("admin-credentials", {
      email,
      password,
      redirectTo: "/admin/garages",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      redirect("/admin/login?error=1");
    }
    throw err;
  }
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Operator
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Admin sign-in</h1>
      </div>

      {error ? (
        <p className="rounded-xl border border-danger-500/40 bg-danger-50 px-4 py-2.5 text-sm text-danger-700 dark:border-danger-500/30 dark:bg-danger-500/10 dark:text-danger-500">
          Invalid credentials.
        </p>
      ) : null}

      <form action={adminLoginAction} className="flex flex-col gap-3">
        <input
          name="email"
          type="email"
          placeholder="Email"
          required
          autoComplete="username"
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
        />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          autoComplete="current-password"
          className="rounded-md border border-border bg-transparent px-3 py-2 text-sm"
        />
        <Button type="submit">Sign in</Button>
      </form>
    </main>
  );
}
