import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { roleHome, type StaffRole } from "@/lib/roles";

/**
 * Server-component guard. Redirects to /login if unauthenticated, or to the
 * user's own home if they hit a screen for a different role.
 */
export async function requireRole(role: StaffRole) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== role) redirect(roleHome(session.user.role));
  return session;
}
