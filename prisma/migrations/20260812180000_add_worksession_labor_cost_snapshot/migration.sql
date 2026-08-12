-- AR 2026-08-12 profit reporting Step 4 — freeze labour cost at
-- session close so a later rate change never rewrites historical
-- margins. Nullable = unknown (pre-Step-4 rows keep null; the
-- profit card counts them into its Unknown bucket).
ALTER TABLE "WorkSession"
  ADD COLUMN "laborCostSnapshot" DECIMAL(12, 2);
