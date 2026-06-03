import { prisma } from "@/lib/prisma";
import { verifyWebhook, mapStripeStatus, stripeEnabled } from "@/lib/billing-gateway";

interface EventObj {
  id?: string;
  customer?: string | null;
  subscription?: string | null;
  status?: string;
  current_period_end?: number;
  metadata?: { garageId?: string };
}

export async function POST(req: Request) {
  if (!stripeEnabled()) return new Response("ok", { status: 200 });

  const sig = req.headers.get("stripe-signature") ?? "";
  const body = await req.text();

  let event;
  try {
    event = verifyWebhook(body, sig);
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  // Idempotency: first insert wins; a duplicate event id is a no-op.
  try {
    await prisma.billingEvent.create({
      data: { stripeEventId: event.id, type: event.type, payloadJson: event.data.object as object },
    });
  } catch {
    return new Response("ok", { status: 200 });
  }

  try {
    const obj = event.data.object as unknown as EventObj;
    const garageId = obj.metadata?.garageId;
    const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000) : undefined;

    if (event.type === "checkout.session.completed" && garageId) {
      await prisma.subscription.updateMany({
        where: { garageId },
        data: {
          stripeCustomerId: obj.customer ?? undefined,
          stripeSubscriptionId: obj.subscription ?? undefined,
          status: "ACTIVE",
        },
      });
    } else if (event.type.startsWith("customer.subscription.")) {
      const status = mapStripeStatus(obj.status ?? "active");
      if (obj.id) {
        await prisma.subscription.updateMany({
          where: { stripeSubscriptionId: obj.id },
          data: { status, currentPeriodEnd: periodEnd },
        });
      }
      if (garageId) {
        await prisma.subscription.updateMany({
          where: { garageId },
          data: { status, currentPeriodEnd: periodEnd },
        });
      }
    } else if (event.type === "invoice.payment_failed" && obj.subscription) {
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: obj.subscription },
        data: { status: "PAST_DUE" },
      });
    }
  } catch {
    // never make Stripe retry on our internal errors
  }

  return new Response("ok", { status: 200 });
}
