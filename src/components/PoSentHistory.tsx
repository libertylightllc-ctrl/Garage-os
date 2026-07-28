import { Mail, MessageCircle } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getT, getLocale } from "@/i18n/server";
import { fmtDate } from "@/lib/format-datetime";
import { relativeTime } from "@/lib/relative-time";

/**
 * Sent-history section on the PO detail page. One row per send
 * attempt, newest first, no dedupe.
 *
 * The point of this table is answering "did we already ask this
 * supplier, and when?" — so every attempt is visible. Dedupe would
 * defeat the purpose: five rows in a minute reads as noise (staff
 * closed WhatsApp, opened it again), while five rows over three days
 * reads as "supplier not responding, follow up." That's the signal a
 * parts office actually acts on, and the relative-time hint next to
 * each timestamp is what makes it readable at a glance.
 *
 * Wording is deliberately honest about WhatsApp: HANDED_OFF renders
 * as "Opened in WhatsApp — delivery not confirmed", NOT "Sent." We
 * genuinely don't know if the user hit Send inside WhatsApp; a row
 * implying we do would be worse than no row.
 *
 * Recipient is NEVER masked. This is the garage's own supplier
 * contact, shown to the garage's own staff, and the point is
 * confirming where the message actually went. Masking would break the
 * feature.
 *
 * Sender name comes from the row's `sentByName` snapshot (frozen at
 * send). Falls back to the User join only when the snapshot is null,
 * which can't happen post-migration but the fallback is honest about
 * the ordering.
 */
export async function PoSentHistory({
    purchaseOrderId,
    garageId,
    timeZone,
}: {
    purchaseOrderId: string;
    garageId: string;
    timeZone: string;
}) {
    const t = await getT();
    const locale = await getLocale();

    const rows = await prisma.purchaseOrderSend.findMany({
        where: { purchaseOrderId, garageId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            channel: true,
            recipient: true,
            documentKind: true,
            sentByUserId: true,
            sentByName: true,
            status: true,
            errorCode: true,
            createdAt: true,
            sentBy: { select: { name: true, email: true } },
        },
    });

    return (
        <section className="print:hidden">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                {t("sendHistoryTitle")}
            </h2>
            {rows.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border bg-surface px-4 py-3 text-sm text-text-mute">
                    {t("sendHistoryEmpty")}
                </p>
            ) : (
                <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                    {rows.map((r) => {
                        const isWA = r.channel === "WHATSAPP";
                        const senderDisplay =
                            r.sentByName?.trim() || r.sentBy?.name?.trim() || r.sentBy?.email || "";
                        // Status → i18n key. HANDED_OFF is per-channel because
                        // "opened in WhatsApp" reads very differently from
                        // "handed to email provider" — same enum value,
                        // different truth on the ground.
                        let statusLabel: string;
                        if (r.status === "HANDED_OFF") {
                            statusLabel = isWA
                                ? t("sendStatus_HANDED_OFF_whatsapp")
                                : t("sendStatus_HANDED_OFF_email");
                        } else if (r.status === "SENT") {
                            statusLabel = t("sendStatus_SENT_email");
                        } else {
                            // FAILED. Only our whitelisted errorCode strings
                            // ever appear here — provider text goes to server
                            // logs, never to this string. Render code raw if
                            // set (already a stable slug); else the generic
                            // failed label.
                            statusLabel = r.errorCode
                                ? `${t("sendStatus_FAILED")} — ${r.errorCode}`
                                : t("sendStatus_FAILED");
                        }
                        const rel = relativeTime(r.createdAt, locale);
                        const abs = fmtDate(r.createdAt, locale, timeZone);
                        const docChip =
                            r.documentKind === "PO" ? t("sendDocChip_PO") : t("sendDocChip_RFQ");
                        return (
                            <li key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                                <span
                                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2"
                                    aria-hidden="true"
                                >
                                    {isWA ? (
                                        <MessageCircle className="h-4 w-4 text-[#25D366]" />
                                    ) : (
                                        <Mail className="h-4 w-4" />
                                    )}
                                </span>
                                <div className="min-w-0 flex-1 space-y-0.5">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold">
                                            {isWA ? t("sendChannel_WHATSAPP") : t("sendChannel_EMAIL")}
                                        </span>
                                        <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider">
                                            {docChip}
                                        </span>
                                        <span className="text-text-mute" title={abs}>
                                            {rel} · {abs}
                                        </span>
                                    </div>
                                    <div className="break-all">{r.recipient}</div>
                                    <div className="text-text-mute">
                                        {statusLabel} · {senderDisplay}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
