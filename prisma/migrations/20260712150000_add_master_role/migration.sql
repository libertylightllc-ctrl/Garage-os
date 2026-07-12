-- Master Admin: one login that does ADVISOR + TECH + CASHIER work (full
-- operational flow) but never sees the owner dashboard/financials.
-- Purely additive: no existing role value or row changes.
ALTER TYPE "Role" ADD VALUE 'MASTER';
