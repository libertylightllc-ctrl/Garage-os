-- Purchase-order lines can now be description-only (no linked Part)
-- and can distinguish "awaiting a quote" (unitCost null) from
-- "quoted as no-charge" (unitCost 0). Layer 0 of AR's 2026-08-01
-- approved reshape.
--
-- Column widens:
--   partId       NOT NULL → NULL   (Part row is born at goods receipt,
--                                    not at estimate time — the whole
--                                    point of the reshape)
--   unitCost     NOT NULL → NULL   (null = awaiting quote; 0 = quoted
--                                    as no-charge, e.g. a supplier
--                                    warranty replacement. The two
--                                    facts are now distinguishable)
--   description  added, nullable   (free-text label. Written once at
--                                    line create; PERSISTS after
--                                    Layer 5 attaches partId at
--                                    receive, so the "originally
--                                    asked for" record survives.
--                                    Render rule: Part.name when
--                                    linked, description otherwise)
--   sku          added, nullable   (supplier SKU; captured on quote or
--                                    at receive)
--
-- Row-level invariant enforced by CHECK: every line has EITHER a
-- linked Part OR a description (or both). A line with neither is
-- nonsense and is rejected at the row level, not only in the action.
--
-- No data movement. Existing rows all satisfy partId NOT NULL and
-- have real unitCost values. Dropping the two NOT NULL constraints
-- rewrites nothing.
--
-- Backfill: DELIBERATELY not converting existing unitCost=0 rows to
-- NULL. Those are all pre-quotation-flow rows and will be re-quoted
-- under the new flow anyway (AR, 2026-08-01).

ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "partId"   DROP NOT NULL;
ALTER TABLE "PurchaseOrderLine" ALTER COLUMN "unitCost" DROP NOT NULL;
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "description" TEXT;
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "sku"         TEXT;
ALTER TABLE "PurchaseOrderLine"
    ADD CONSTRAINT "PurchaseOrderLine_part_or_description_ck"
    CHECK ("partId" IS NOT NULL OR "description" IS NOT NULL);
