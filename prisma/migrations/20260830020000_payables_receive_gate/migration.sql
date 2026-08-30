-- AR 2026-08-30 — Payables receive gate (Phase 3/7).
--
-- Per-garage feature flag. When false (the default for every
-- existing garage) the receivePurchaseOrderAction path is
-- identical to what shipped before this commit — no bill row,
-- no AP ledger post. When true, the receive action creates a
-- SupplierBill and posts DR Inventory + DR VAT-Input / CR AP
-- inside the same $transaction as the PartMovement writes.
--
-- Same shape as erpSyncEnabled — off by default, per-garage
-- rollout gate. Blast radius zero until an owner opts in.
ALTER TABLE "Garage"
    ADD COLUMN "payablesEnabled" BOOLEAN NOT NULL DEFAULT false;
