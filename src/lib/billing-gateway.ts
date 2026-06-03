import Stripe from "stripe";

// Stripe wrapper. Disabled (no charges, UI shows "not configured") when STRIPE_SECRET_KEY
// is absent — safe to build/run without keys. We never store raw card data; Stripe holds
// the tokenized payment method and we keep only its IDs.
export function stripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let _stripe: Stripe | null = null;
function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured");
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

export type SubStatus = "PILOT" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED";

export function mapStripeStatus(s: string): SubStatus {
  switch (s) {
    case "trialing":
      return "TRIALING";
    case "active":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
      return "PAST_DUE";
    case "canceled":
    case "incomplete_expired":
      return "CANCELED";
    default:
      return "ACTIVE";
  }
}

/** Pilots are NEVER charged. */
export function shouldCharge(garage: { isPilot: boolean }): boolean {
  return !garage.isPilot;
}

export async function createCheckoutSession(opts: {
  stripePriceId: string;
  garageId: string;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: opts.stripePriceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.customerEmail ?? undefined,
    metadata: { garageId: opts.garageId },
    subscription_data: { metadata: { garageId: opts.garageId } },
  });
  if (!session.url) throw new Error("Checkout session has no URL");
  return session.url;
}

export async function cancelAtPeriodEnd(stripeSubscriptionId: string): Promise<void> {
  await stripe().subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

export function verifyWebhook(payload: string, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET as string,
  );
}
