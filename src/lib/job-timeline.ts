// Pure event builder for the job timeline. Reads only the data the
// app already records — never invents a timestamp, never guesses an
// actor. Events with no recorded actor surface as `null` so the UI
// can render an honest em-dash rather than mis-attributing them.
//
// Actor coverage today (see verify report in the slice notes):
//   ✓ recorded: job-created (advisor), claim (tech), JobStep entries
//                (tech), findings submission (tech), part request
//                (tech), work-completed (tech, via claim), QC (qcBy),
//                delivery (deliveredBy).
//   ✗ NOT recorded: estimate-sent / estimate-approved / estimate-
//                rejected, invoice-issued / invoice-sent, payment-
//                recorded, advance-payment-received. These render with
//                a null actor for now.

export interface TimelineActor {
    name: string;
    role: string; // "ADVISOR" | "TECH" | "CASHIER" | "OWNER" (raw enum)
}

export interface TimelineEvent {
    at: Date;
    /** i18n key — caller maps to a localised label. */
    kindKey: string;
    /** Optional plain-text detail appended to the label
     *  (e.g. part description, payment amount). */
    detail?: string;
    actor: TimelineActor | null;
}

interface UserDir {
    [userId: string]: TimelineActor;
}

export interface BuildTimelineInput {
    job: {
        createdAt: Date;
        advisorId: string | null;
        claimedAt: Date | null;
        claimedById: string | null;
        sentForEstimateAt: Date | null;
        sentForReestimateAt: Date | null;
        workCompletedAt: Date | null;
        qcAt: Date | null;
        qcById: string | null;
        deliveredAt: Date | null;
        deliveredById: string | null;
        deliveryConfirmedAt: Date | null;
        invoiceSentAt: Date | null;
        invoiceDeliveredAt: Date | null;
        moulkiaConsentAt: Date | null;
    };
    steps: {
        type: string;
        createdAt: Date;
        techId: string | null;
        transcript: string | null;
    }[];
    finding: {
        submittedAt: Date | null;
        techId: string | null;
    } | null;
    partRequests: {
        description: string;
        qty: number;
        createdAt: Date;
        requestedById: string | null;
    }[];
    estimates: {
        createdAt: Date;
        sentAt: Date | null;
        deliveredAt: Date | null;
        approvedAt: Date | null;
        status: string;
    }[];
    invoices: { createdAt: Date }[];
    payments: { amount: number; paidAt: Date }[];
    advancePayments: { amount: number; receivedAt: Date }[];
    users: UserDir;
}

function actorFor(id: string | null | undefined, users: UserDir): TimelineActor | null {
    if (!id) return null;
    return users[id] ?? null;
}

export function buildJobTimeline(input: BuildTimelineInput): TimelineEvent[] {
    const ev: TimelineEvent[] = [];
    const { job, steps, finding, partRequests, estimates, invoices, payments, advancePayments, users } = input;

    // ── 0. Vehicle checked in / job created ──────────────────────
    ev.push({
        at: job.createdAt,
        kindKey: "tlVehicleCheckedIn",
        actor: actorFor(job.advisorId, users),
    });
    if (job.moulkiaConsentAt) {
        ev.push({
            at: job.moulkiaConsentAt,
            kindKey: "tlConsentRecorded",
            actor: actorFor(job.advisorId, users),
        });
    }

    // ── 1. Technician claim ──────────────────────────────────────
    if (job.claimedAt) {
        ev.push({
            at: job.claimedAt,
            kindKey: "tlClaimedByTech",
            actor: actorFor(job.claimedById, users),
        });
    }

    // ── 2. JobSteps (photo / voice). PART_REQUEST + FINISH are
    //      surfaced via their dedicated events (PartRequest + work-
    //      completed) so we skip them here to avoid duplicates. ──
    for (const s of steps) {
        if (s.type === "PHOTO") {
            ev.push({ at: s.createdAt, kindKey: "tlPhotoLogged", actor: actorFor(s.techId, users) });
        } else if (s.type === "VOICE") {
            ev.push({
                at: s.createdAt,
                kindKey: "tlVoiceLogged",
                actor: actorFor(s.techId, users),
                detail: s.transcript ?? undefined,
            });
        }
    }

    // ── 3. Part requests ─────────────────────────────────────────
    for (const pr of partRequests) {
        ev.push({
            at: pr.createdAt,
            kindKey: "tlPartRequested",
            actor: actorFor(pr.requestedById, users),
            detail: `${pr.qty}× ${pr.description}`,
        });
    }

    // ── 4. Findings submitted ────────────────────────────────────
    if (finding?.submittedAt) {
        ev.push({
            at: finding.submittedAt,
            kindKey: "tlFindingsSubmitted",
            actor: actorFor(finding.techId, users),
        });
    }

    // ── 5. Sent for (re-)estimate ────────────────────────────────
    if (job.sentForEstimateAt) {
        ev.push({
            at: job.sentForEstimateAt,
            kindKey: "tlSentForEstimate",
            // claim-holder is the canonical "tech who sent" — the
            // sendForEstimateAction requires the claim, so attributing
            // to claimedBy is accurate (not a guess).
            actor: actorFor(job.claimedById, users),
        });
    }
    if (job.sentForReestimateAt) {
        ev.push({
            at: job.sentForReestimateAt,
            kindKey: "tlSentForReestimate",
            actor: actorFor(job.claimedById, users),
        });
    }

    // ── 6. Estimate lifecycle (no actor recorded today) ──────────
    for (const e of estimates) {
        ev.push({ at: e.createdAt, kindKey: "tlEstimateCreated", actor: null });
        if (e.sentAt) ev.push({ at: e.sentAt, kindKey: "tlEstimateSent", actor: null });
        // tlEstimateDelivered fires ONLY when Estimate.deliveredAt is
        // populated — dormant in the wa.me era (webhook not wired
        // yet). Mirrors the invoice-side tlInvoiceDelivered pattern
        // below; see the schema comment on Estimate.deliveredAt.
        if (e.deliveredAt) ev.push({ at: e.deliveredAt, kindKey: "tlEstimateDelivered", actor: null });
        if (e.approvedAt) ev.push({ at: e.approvedAt, kindKey: "tlEstimateApproved", actor: null });
    }

    // ── 7. Work completed (tech via claim) ───────────────────────
    if (job.workCompletedAt) {
        ev.push({
            at: job.workCompletedAt,
            kindKey: "tlWorkCompleted",
            actor: actorFor(job.claimedById, users),
        });
    }

    // ── 8. QC sign-off ───────────────────────────────────────────
    if (job.qcAt) {
        ev.push({
            at: job.qcAt,
            kindKey: "tlQcPassed",
            actor: actorFor(job.qcById, users),
        });
    }

    // ── 9. Invoice issued / sent (no actor recorded today) ───────
    for (const i of invoices) {
        ev.push({ at: i.createdAt, kindKey: "tlInvoiceIssued", actor: null });
    }
    if (job.invoiceSentAt) {
        ev.push({ at: job.invoiceSentAt, kindKey: "tlInvoiceSent", actor: null });
    }
    // 2026-08-10 timestamp split — separate event when the invoice
    // actually reaches the customer. In the wa.me era this field
    // stays null; the future Meta Cloud API webhook writes it and
    // the timeline gets a distinct entry.
    if (job.invoiceDeliveredAt) {
        ev.push({
            at: job.invoiceDeliveredAt,
            kindKey: "tlInvoiceDelivered",
            actor: null,
        });
    }

    // ── 10. Payments + advance payments (no actor today) ─────────
    for (const a of advancePayments) {
        ev.push({
            at: a.receivedAt,
            kindKey: "tlAdvancePayment",
            detail: `AED ${Number(a.amount).toFixed(2)}`,
            actor: null,
        });
    }
    for (const p of payments) {
        ev.push({
            at: p.paidAt,
            kindKey: "tlPaymentRecorded",
            detail: `AED ${Number(p.amount).toFixed(2)}`,
            actor: null,
        });
    }

    // ── 11. Delivery + customer confirmation ─────────────────────
    if (job.deliveredAt) {
        ev.push({
            at: job.deliveredAt,
            kindKey: "tlDelivered",
            actor: actorFor(job.deliveredById, users),
        });
    }
    if (job.deliveryConfirmedAt) {
        ev.push({
            at: job.deliveryConfirmedAt,
            kindKey: "tlCollectionConfirmed",
            actor: null,
        });
    }

    // Chronological, oldest → newest, stable by insertion order on ties
    // (Array.sort is stable in ES2019+; we don't need a secondary key).
    return ev.sort((a, b) => a.at.getTime() - b.at.getTime());
}
