"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { validatePasswordChange } from "@/lib/password-change";

// Self-serve password change. ANY signed-in role (OWNER, ADVISOR, TECH,
// CASHIER) can change their OWN password. They cannot change anyone
// else's — the update is keyed strictly on session.user.id, which the
// JWT signed at sign-in (cannot be forged from the form).
//
// Errors and success are surfaced via redirect to
// /account/password?error=<code> or ?ok=1. The session is untouched,
// so the user stays signed in with the new credential (JWT validation
// is by `uid` not by hash — the next sign-in is when the new hash gets
// compared).

function back(error: string): never {
  redirect(`/account/password?error=${encodeURIComponent(error)}`);
}

export async function changePasswordAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  const userId = session.user.id;

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  // Look up THIS user's hash by their session id. There is no way to
  // address a different user — the where clause is `id: session.user.id`
  // verbatim, not anything from formData. Even a tampered form payload
  // can only ever update the signed-in user's own row.
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!me?.passwordHash) {
    // Should never happen for a signed-in user — defensive.
    back("current-wrong");
  }

  const result = await validatePasswordChange({
    currentPlain: current,
    newPlain: next,
    confirmPlain: confirm,
    storedHash: me.passwordHash,
  });
  if (!result.ok) {
    // Map enum to URL-safe slug; keep codes terse so query string stays clean.
    const slug = {
      MISSING_FIELDS: "missing",
      TOO_SHORT: "short",
      MISMATCH: "mismatch",
      CURRENT_WRONG: "current-wrong",
    }[result.error];
    back(slug);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: result.newHash },
  });

  redirect("/account/password?ok=1");
}
