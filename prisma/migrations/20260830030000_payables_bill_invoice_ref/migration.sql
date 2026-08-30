-- AR 2026-08-30 — Capture supplier invoice reference on SupplierBill.
--
-- Two additions:
--   1. SupplierBill.supplierInvoiceRef — optional TEXT, no unique
--      index. Suppliers reuse invoice numbers across years and a
--      duplicate should never block a receive. Purpose: match the
--      shop's SupplierBill row back to the paper tax invoice the
--      supplier sent — the first thing anyone does when a supplier
--      queries a balance.
--   2. SupplierBillDeleteAudit.supplierInvoiceRef — mirror on the
--      audit table so a blocked delete attempt still records which
--      paper the row was tied to.
--
-- Trigger function updated to include the new column in the audit
-- INSERT.
--
-- billDate itself is unchanged in schema (already exists) — the
-- writer just starts populating it from a form field instead of
-- new Date(). No SQL for that here.

ALTER TABLE "SupplierBill"
    ADD COLUMN "supplierInvoiceRef" TEXT;

ALTER TABLE "SupplierBillDeleteAudit"
    ADD COLUMN "supplierInvoiceRef" TEXT;

-- Redefine the trigger function to include the new column. CREATE OR
-- REPLACE keeps the existing trigger wired to the new function body.
CREATE OR REPLACE FUNCTION supplier_bill_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_supplier_bill_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    INSERT INTO "SupplierBillDeleteAudit" (
        "supplierBillId", "garageId", "supplierId", "billNumber",
        "status", "subtotal", "vatAmount", "total", "paidAmount",
        "billDate", "supplierInvoiceRef",
        "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."garageId", OLD."supplierId", OLD."billNumber",
        OLD.status::text, OLD.subtotal, OLD."vatAmount", OLD.total, OLD."paidAmount",
        OLD."billDate", OLD."supplierInvoiceRef",
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'SupplierBill % (status=%, total=%) cannot be deleted — every SupplierBill writes a ledger row (DR Inventory / CR AP) at creation and deleting one leaks. '
        'To correct a mis-received bill: void it (posts a compensating adjustment row) rather than deleting. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_supplier_bill_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD."billNumber", OLD.status, OLD.total
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
