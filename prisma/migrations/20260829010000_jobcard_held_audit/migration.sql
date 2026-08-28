-- AR 2026-08-29 — JobCard hold audit fields.
--
-- Companion to 20260829000000_jobcard_cancelled_audit. The
-- CANCELLED gap was found by accident; the wider audit surfaced
-- ON_HOLD as the same class of missing-timestamp-or-actor bug
-- (heldFrom + holdReason + holdNote existed; heldAt + heldByUserId
-- didn't). "Why is this on hold" was answerable via holdReason;
-- "when did it go on hold and who paused it" wasn't.
--
-- Additive. Both columns nullable. Holds recorded BEFORE this
-- migration have both fields NULL; timeline shows nothing for
-- them; documented in docs/business-rules.md as unattributable.
ALTER TABLE "JobCard"
    ADD COLUMN "heldAt"       TIMESTAMP(3),
    ADD COLUMN "heldByUserId" TEXT;

ALTER TABLE "JobCard"
    ADD CONSTRAINT "JobCard_heldByUserId_fkey"
    FOREIGN KEY ("heldByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
