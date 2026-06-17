import { describe, it, expect } from "vitest";
import { buildJobTimeline, type BuildTimelineInput } from "./job-timeline";

const t = (s: string) => new Date(s);
const users = {
    "u-aisha": { name: "Aisha", role: "ADVISOR" },
    "u-tariq": { name: "Tariq", role: "TECH" },
    "u-sara": { name: "Sara", role: "CASHIER" },
};

function emptyInput(): BuildTimelineInput {
    return {
        job: {
            createdAt: t("2026-06-17T09:00:00Z"),
            advisorId: null,
            claimedAt: null,
            claimedById: null,
            sentForEstimateAt: null,
            sentForReestimateAt: null,
            workCompletedAt: null,
            qcAt: null,
            qcById: null,
            deliveredAt: null,
            deliveredById: null,
            deliveryConfirmedAt: null,
            invoiceSentAt: null,
            moulkiaConsentAt: null,
        },
        steps: [],
        finding: null,
        partRequests: [],
        estimates: [],
        invoices: [],
        payments: [],
        advancePayments: [],
        users,
    };
}

describe("buildJobTimeline", () => {
    it("emits at least the check-in event for a fresh job", () => {
        const tl = buildJobTimeline({
            ...emptyInput(),
            job: { ...emptyInput().job, advisorId: "u-aisha" },
        });
        expect(tl).toHaveLength(1);
        expect(tl[0].kindKey).toBe("tlVehicleCheckedIn");
        expect(tl[0].actor).toEqual({ name: "Aisha", role: "ADVISOR" });
    });

    it("emits null actor when the advisor isn't recorded", () => {
        const tl = buildJobTimeline(emptyInput());
        expect(tl[0].actor).toBeNull();
    });

    it("sorts events chronologically oldest → newest", () => {
        const i = emptyInput();
        i.job.advisorId = "u-aisha";
        i.job.claimedAt = t("2026-06-17T09:30:00Z");
        i.job.claimedById = "u-tariq";
        i.job.sentForEstimateAt = t("2026-06-17T10:00:00Z");
        i.steps = [
            { type: "PHOTO", createdAt: t("2026-06-17T09:45:00Z"), techId: "u-tariq", transcript: null },
        ];
        i.partRequests = [
            { description: "brake pads", qty: 2, createdAt: t("2026-06-17T09:50:00Z"), requestedById: "u-tariq" },
        ];
        const tl = buildJobTimeline(i);
        const keys = tl.map((e) => e.kindKey);
        expect(keys).toEqual([
            "tlVehicleCheckedIn",
            "tlClaimedByTech",
            "tlPhotoLogged",
            "tlPartRequested",
            "tlSentForEstimate",
        ]);
    });

    it("PART_REQUEST + FINISH JobSteps are NOT duplicated as timeline rows", () => {
        // PartRequest carries richer detail (description + qty), and
        // workCompletedAt is the canonical "tech finished" event. The
        // matching JobStep types would duplicate them — verify they're
        // dropped at the timeline layer.
        const i = emptyInput();
        i.steps = [
            { type: "PART_REQUEST", createdAt: t("2026-06-17T09:50:00Z"), techId: "u-tariq", transcript: "Requested 2× brake pads" },
            { type: "FINISH", createdAt: t("2026-06-17T11:00:00Z"), techId: "u-tariq", transcript: null },
        ];
        const tl = buildJobTimeline(i);
        const keys = tl.map((e) => e.kindKey);
        expect(keys).not.toContain("tlPartRequested"); // PartRequest not provided
        expect(keys).not.toContain("tlWorkCompleted"); // workCompletedAt not provided
    });

    it("estimate sent + approved render with null actor (no actor recorded today)", () => {
        const i = emptyInput();
        i.estimates = [
            {
                createdAt: t("2026-06-17T09:50:00Z"),
                sentAt: t("2026-06-17T10:00:00Z"),
                approvedAt: t("2026-06-17T10:30:00Z"),
                status: "APPROVED",
            },
        ];
        const tl = buildJobTimeline(i);
        const sent = tl.find((e) => e.kindKey === "tlEstimateSent");
        const approved = tl.find((e) => e.kindKey === "tlEstimateApproved");
        expect(sent?.actor).toBeNull();
        expect(approved?.actor).toBeNull();
    });

    it("payments + advance payments include the amount as detail, null actor", () => {
        const i = emptyInput();
        i.payments = [{ amount: 245.7, paidAt: t("2026-06-17T11:30:00Z") }];
        i.advancePayments = [{ amount: 100, receivedAt: t("2026-06-17T10:15:00Z") }];
        const tl = buildJobTimeline(i);
        const ap = tl.find((e) => e.kindKey === "tlAdvancePayment");
        const p = tl.find((e) => e.kindKey === "tlPaymentRecorded");
        expect(ap?.detail).toBe("AED 100.00");
        expect(p?.detail).toBe("AED 245.70");
        expect(ap?.actor).toBeNull();
        expect(p?.actor).toBeNull();
    });

    it("QC + delivery preserve their dedicated actors", () => {
        const i = emptyInput();
        i.job.qcAt = t("2026-06-17T11:00:00Z");
        i.job.qcById = "u-sara";
        i.job.deliveredAt = t("2026-06-17T12:00:00Z");
        i.job.deliveredById = "u-aisha";
        const tl = buildJobTimeline(i);
        const qc = tl.find((e) => e.kindKey === "tlQcPassed");
        const del = tl.find((e) => e.kindKey === "tlDelivered");
        expect(qc?.actor).toEqual({ name: "Sara", role: "CASHIER" });
        expect(del?.actor).toEqual({ name: "Aisha", role: "ADVISOR" });
    });

    it("unknown user id (orphaned reference) → null actor, no throw", () => {
        const i = emptyInput();
        i.job.advisorId = "u-deleted";
        const tl = buildJobTimeline(i);
        expect(tl[0].actor).toBeNull();
    });
});
