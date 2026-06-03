"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { appUrl } from "@/lib/whatsapp";
import {
  stripeEnabled,
  createCheckoutSession,
  cancelAtPeriodEnd,
  shouldCharge,
} from "@/lib/billing-gateway";

async function requireOwner() {
  const session = await auth();
  if (!session?.user || session.user.role !== "OWNER") throw new Error("Not authorized");
  return session.user;
}

/** Ensure a garage has a Subscription row (defaults to PILOT — never charged). */
export async function ensureSubscription(garageId: string) {
  const existing = await prisma.subscription.findUnique({ where: { garageId } });
  if (!existing) await prisma.subscription.create({ data: { garageId, status: "PILOT" } });
}

export async function subscribeAction(formData: FormData) {
  const owner = await requireOwner();
  const planId = String(formData.get("planId") ?? "");

  const garage = await prisma.garage.findUnique({ where: { id: owner.garageId } });
  if (!garage) throw new Error("Garage not found");
  if (!shouldCharge(garage)) {
    throw new Error("This garage is on a pilot and isn’t billed.");
  }
  if (!stripeEnabled()) {
    throw new Error("Billing isn’t configured yet.");
  }
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan?.stripePriceId) throw new Error("This plan isn’t available for checkout yet.");

  await prisma.subscription.update({ where: { garageId: garage.id }, data: { planId } });

  const url = await createCheckoutSession({
    stripePriceId: plan.stripePriceId,
    garageId: garage.id,
    customerEmail: owner.email,
    successUrl: `${appUrl()}/owner/billing?ok=1`,
    cancelUrl: `${appUrl()}/owner/billing`,
  });
  redirect(url);
}

export async function cancelSubscriptionAction() {
  const owner = await requireOwner();
  const sub = await prisma.subscription.findUnique({ where: { garageId: owner.garageId } });
  if (sub?.stripeSubscriptionId && stripeEnabled()) {
    await cancelAtPeriodEnd(sub.stripeSubscriptionId);
  }
  revalidatePath("/owner/billing");
}
