"use server";

import { prisma } from "@/lib/prisma";

// Billing is MANUAL during the pilot (no Stripe yet). A garage stays on `isPilot` and is
// not charged; GarageOS sets plans up by hand for the first ~30 garages. This just ensures
// a Subscription row exists so the owner can see their plan/status.
export async function ensureSubscription(garageId: string) {
  const existing = await prisma.subscription.findUnique({ where: { garageId } });
  if (!existing) await prisma.subscription.create({ data: { garageId, status: "PILOT" } });
}
