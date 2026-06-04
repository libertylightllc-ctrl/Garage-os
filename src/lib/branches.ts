import { prisma } from "@/lib/prisma";

// Multi-branch (Role-Based-Dashboards). A company is the root Garage (branchOfId
// null); branches are child Garages. The owner sees all branches aggregated;
// branch staff stay scoped to their own garageId. The hierarchy uses the existing
// Garage.branchOf self-relation — no schema change.

/** Prisma `where` value that matches one garage or several (for owner aggregation). */
export function scopeWhere(garageId: string | string[]): string | { in: string[] } {
  return Array.isArray(garageId) ? { in: garageId } : garageId;
}

/** The company root id for a garage (itself if it's the root, else its parent). */
export function companyRootId(g: { id: string; branchOfId: string | null }): string {
  return g.branchOfId ?? g.id;
}

/** Every garageId in the owner's company: the root + all its branches. */
export async function companyGarageIds(garageId: string): Promise<string[]> {
  const g = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, branchOfId: true },
  });
  if (!g) return [garageId];
  const root = companyRootId(g);
  const kids = await prisma.garage.findMany({
    where: { branchOfId: root },
    select: { id: true },
  });
  return [root, ...kids.map((k) => k.id)];
}

export interface BranchRow {
  id: string;
  name: string;
  isPilot: boolean;
  isRoot: boolean;
}

/** The company's branches (root first), for the owner's branch/billing/staff views. */
export async function listBranches(garageId: string): Promise<BranchRow[]> {
  const g = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, branchOfId: true },
  });
  if (!g) return [];
  const root = companyRootId(g);
  const rows = await prisma.garage.findMany({
    where: { OR: [{ id: root }, { branchOfId: root }] },
    select: { id: true, name: true, isPilot: true, branchOfId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    isPilot: r.isPilot,
    isRoot: r.branchOfId === null,
  }));
}
