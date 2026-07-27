import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { roleHome, type StaffRole } from "@/lib/roles";
import { sessionUserExists } from "@/lib/session-user";

/**
 * Server-component guard. Redirects to /login if unauthenticated, or to the
 * user's own home if they hit a screen for a different role.
 */
export async function requireRole(role: StaffRole) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== role) redirect(roleHome(session.user.role));
  // Stale JWT (dev reseed / prod hard-delete): the cookie is signed
  // fine but its sub no longer resolves to a live User. Sending the
  // request through would 500 on the first FK write. See
  // src/lib/session-user.ts.
  if (!(await sessionUserExists(session.user.id))) redirect("/login");
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
  // Same stale-JWT case as requireRole above.
  if (!(await sessionUserExists(session.user.id))) redirect("/login");
  return session;
}
