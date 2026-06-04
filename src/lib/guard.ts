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

/**
 * Like requireRole, but for screens shared by several roles (e.g. the estimate
 * editor, which the Cashier prices and the Advisor sends). Redirects to /login
 * if unauthenticated, or to the user's own home if their role isn't allowed.
 */
export async function requireAnyRole(roles: StaffRole[]) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!roles.includes(session.user.role as StaffRole)) redirect(roleHome(session.user.role));
  return session;
}
