// Role -> home screen routing. Pure + dependency-free so it's trivially testable.
export const ROLE_HOME = {
  OWNER: "/owner",
  ADVISOR: "/advisor",
  TECH: "/technician",
  CASHIER: "/cashier",
  // MASTER runs the whole operational flow; the jobs board is its hub.
  // Deliberately SHARES /advisor — it has no owner dashboard.
  MASTER: "/advisor",
} as const;

export type StaffRole = keyof typeof ROLE_HOME;

export const STAFF_ROLES: StaffRole[] = ["OWNER", "ADVISOR", "TECH", "CASHIER", "MASTER"];

export const ROLE_TITLE: Record<StaffRole, string> = {
  OWNER: "Owner",
  ADVISOR: "Service Advisor",
  TECH: "Technician",
  CASHIER: "Cashier",
  MASTER: "Master Admin",
};

/** Where a given role should land after login. Unknown/missing role -> /login. */
export function roleHome(role: string | null | undefined): string {
  if (role && role in ROLE_HOME) return ROLE_HOME[role as StaffRole];
  return "/login";
}
