import { prisma } from "@/lib/prisma";

/**
 * Log ONE send attempt against a PurchaseOrder.
 *
 * This is the single call site both channels use — the WhatsApp
 * action writes a row here BEFORE the wa.me redirect, and C's email
 * action writes here with { channel: "EMAIL", status: ... } after
 * calling Resend. Same shape both ways, so the two channels can't
 * drift on what a "send" record looks like.
 *
 * Fire-and-forget-safe: a write failure is swallowed and logged
 * server-side. Losing an audit row is strictly worse than blocking a
 * legitimate send — a supplier with an urgent parts request should
 * not fail to receive the message because our audit table is having
 * a bad time. If this becomes a persistent problem the recovery is
 * "look at the wa.me logs on the user's phone", which is what a
 * garage does today without any audit table at all.
 *
 * All string inputs (recipient, sentByName) MUST be snapshots — the
 * exact address/phone that was used and the sender's name at send
 * time. NOT joins to Supplier/User at read time. History that
 * rewrites itself when the supplier's email changes or the sender is
 * offboarded is not history; it's a lie.
 *
 * errorCode is CONSTRAINED to our own MailErrorCode-style enum. Never
 * pass the provider's own message here — those go to `console.error`
 * server-side and stay there. The point of the enum is that the
 * whitelist on the render side (see /owner/purchasing/[id]/page.tsx
 * emailError code check) can safely `t(\`errCode_${row.errorCode}\`)`
 * without letting arbitrary provider strings reach the DOM.
 */
export interface LogPoSendInput {
    purchaseOrderId: string;
    garageId: string;
    channel: "WHATSAPP" | "EMAIL";
    /** Snapshot: the email address or phone number ACTUALLY used. */
    recipient: string;
    /** Snapshot: what the document was at send time (poDocKind result). */
    documentKind: "PO" | "RFQ";
    sentByUserId: string;
    /** Snapshot: the sender's display name at send time. */
    sentByName: string;
    status: "HANDED_OFF" | "SENT" | "FAILED";
    /** Email only — Resend message id. Never for WHATSAPP. */
    providerMessageId?: string;
    /** Our enum only — never provider text. */
    errorCode?: string;
}

export async function logPoSend(input: LogPoSendInput): Promise<void> {
    try {
        await prisma.purchaseOrderSend.create({
            data: {
                purchaseOrderId: input.purchaseOrderId,
                garageId: input.garageId,
                channel: input.channel,
                recipient: input.recipient,
                documentKind: input.documentKind,
                sentByUserId: input.sentByUserId,
                sentByName: input.sentByName,
                status: input.status,
                providerMessageId: input.providerMessageId ?? null,
                errorCode: input.errorCode ?? null,
            },
        });
    } catch (e) {
        // Never propagate. Server log carries the detail; the send
        // itself must still complete (wa.me redirect or Resend call).
        console.error("[po-send-log] failed to record send:", e);
    }
}
