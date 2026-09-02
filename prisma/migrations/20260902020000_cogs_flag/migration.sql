-- AR 2026-09-02 — COGS-at-invoice rollout gate (C4a).
--
-- Per-garage feature flag. Same shape as erpSyncEnabled +
-- payablesEnabled — off by default, no existing garage's
-- generateInvoiceAction path changes on ship. Flip per garage
-- after Demo Garage rehearsal proves the ledger balances.
--
-- When true: invoice generation posts DR COGS / CR Inventory
-- for the frozen PART unitCost snapshots, all-or-nothing per
-- invoice. Void reverses.
ALTER TABLE "Garage"
    ADD COLUMN "cogsEnabled" BOOLEAN NOT NULL DEFAULT false;
