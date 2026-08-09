import { prisma } from "@/lib/prisma";

/**
 * Log ONE send attempt against an Invoice — parallel to logPoSend for
 * PurchaseOrderSend. This is the single call site the invoice send
 * action uses so the read side (cashier dashboard, customer-support
 * "did they get it?" question) has one row shape to consult.
 *
 * Fire-and-forget-safe: a write failure here is swallowed and logged
 * server-side. The wa.me redirect must still fire — a cashier trying
 * to hand off an urgent invoice should not be blocked because our
 * audit table is having a bad time. If audit writes start failing
 * persistently, that shows up in server logs; the fallback for "did
 * they get it?" is the operator's own WhatsApp history on their
 * phone, which is what the shop does today with no audit at all.
 *
 * All string inputs (recipient, sentByName) MUST be snapshots — the
 * exact address/phone used and the sender's name at send time. NOT
 * joins to Customer/User at read time. History that rewrites itself
 * when the customer's phone changes or a staff member is offboarded
 * is not history; it's a lie.
 *
 * `providerMessageId` and `errorCode` are reserved for the Meta Cloud
 * API commit that follows this one. WhatsApp wa.me hand-off leaves
 * both null.
 */
export interface LogInvoiceSendInput {
    invoiceId: string;
    garageId: string;
    channel: "WHATSAPP" | "EMAIL";
    /** Snapshot: the email address or phone number ACTUALLY used. */
    recipient: string;
    sentByUserId: string;
    /** Snapshot: the sender's display name at send time. */
    sentByName: string;
    status: "HANDED_OFF" | "SENT" | "FAILED";
    /** Meta Cloud API only — reserved for the follow-up commit. */
    providerMessageId?: string;
    /** Our enum only — never provider text. */
    errorCode?: string;
}

export async function logInvoiceSend(input: LogInvoiceSendInput): Promise<void> {
    try {
        await prisma.invoiceSend.create({
            data: {
                invoiceId: input.invoiceId,
                garageId: input.garageId,
                channel: input.channel,
                recipient: input.recipient,
                sentByUserId: input.sentByUserId,
                sentByName: input.sentByName,
                status: input.status,
                providerMessageId: input.providerMessageId ?? null,
                errorCode: input.errorCode ?? null,
            },
        });
    } catch (e) {
        // Never propagate. Server log carries the detail; the send
        // itself must still complete (wa.me redirect / Meta Cloud API
        // call once that ships).
        console.error("[invoice-send-log] failed to record send:", e);
    }
}
