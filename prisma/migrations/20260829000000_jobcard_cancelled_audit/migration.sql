-- AR 2026-08-29 — JobCard cancellation audit fields.
--
-- Every other lifecycle transition on JobCard has some form of
-- timestamp + actor pair. Cancellation had neither — the only
-- trace was updatedAt changing and status flipping to CANCELLED.
-- "Who cancelled this, when, and why" was unanswerable.
--
-- Additive only. All three columns are nullable. Cancellations
-- that happened BEFORE this migration are permanently
-- unattributable; noted in docs/business-rules.md so nobody
-- spends time investigating one.
ALTER TABLE "JobCard"
    ADD COLUMN "cancelledAt"       TIMESTAMP(3),
    ADD COLUMN "cancelledByUserId" TEXT,
    ADD COLUMN "cancelReason"      TEXT;

ALTER TABLE "JobCard"
    ADD CONSTRAINT "JobCard_cancelledByUserId_fkey"
    FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
