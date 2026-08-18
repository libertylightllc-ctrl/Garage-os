-- "Price this part" back-link (AR 2026-08-19). When the advisor
-- prices a technician-required part into an EstimateLine, the
-- JobPart carries the resulting line id here. Two things depend on
-- it:
--   1. The advisor's PartRow UI hides the "Price this part" button
--      once set — no duplicate lines from a second click.
--   2. When the advisor later deletes the EstimateLine, this FK
--      clears via ON DELETE SET NULL and the tech request becomes
--      priceable again. Deleting the line does NOT delete the
--      JobPart — the tech's request is still a real thing.
--
-- @unique because Prisma models this as a 1:1 optional relation and
-- the semantic matches: no EstimateLine is the priced-from target
-- of more than one JobPart.

ALTER TABLE "JobPart"
  ADD COLUMN "estimateLineId" TEXT;

ALTER TABLE "JobPart"
  ADD CONSTRAINT "JobPart_estimateLineId_fkey"
  FOREIGN KEY ("estimateLineId")
  REFERENCES "EstimateLine"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE UNIQUE INDEX "JobPart_estimateLineId_key"
  ON "JobPart"("estimateLineId");
