-- AR 2026-08-30 — Payables delete guards (Phase 2/7).
--
-- Extends the ledger-source delete guard from 2026-08-19 to cover
-- the three new payables tables. Same shape as the customer-side
-- guards on Invoice / Payment / AdvancePayment.
--
-- Every SupplierBill row writes DR Inventory / CR AP the moment
-- it's inserted (Payables C3, next commit). Every
-- SupplierPaymentAllocation row writes DR AP / CR CASH the moment
-- it's inserted (Payables C5). Deleting any of them via the SQL
-- editor without a matching ledger cleanup leaks the exact way
-- the 78 Payment deletions did in 2026-08-19.
--
-- SupplierPayment itself doesn't write to the ledger directly (its
-- allocations do), but a payment with allocations left behind is
-- an inconsistent row. Guard it too.
--
-- Unlike Invoice which allows DRAFT deletion, SupplierBill has no
-- "unposted" state — the bill is created BY the receive path, in
-- the same tx as the ledger post. There's no window where a bill
-- exists without a matching DR Inventory / CR AP row. So no
-- carve-out; every bill delete needs the session flag.
--
-- Session flags (SET LOCAL, per-tx):
--   app.allow_supplier_bill_delete       = 'true'
--   app.allow_supplier_payment_delete    = 'true'
--   app.allow_supplier_allocation_delete = 'true'
--   app.delete_note (existing) = '<ticket + reason>'

-- ── Trigger functions ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION supplier_bill_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_supplier_bill_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    INSERT INTO "SupplierBillDeleteAudit" (
        "supplierBillId", "garageId", "supplierId", "billNumber",
        "status", "subtotal", "vatAmount", "total", "paidAmount",
        "billDate", "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."garageId", OLD."supplierId", OLD."billNumber",
        OLD.status::text, OLD.subtotal, OLD."vatAmount", OLD.total, OLD."paidAmount",
        OLD."billDate",
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

CREATE OR REPLACE FUNCTION supplier_payment_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_supplier_payment_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    INSERT INTO "SupplierPaymentDeleteAudit" (
        "supplierPaymentId", "garageId", "supplierId",
        "amount", "method", "paidAt",
        "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."garageId", OLD."supplierId",
        OLD.amount, OLD.method, OLD."paidAt",
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'SupplierPayment % (amount=%) cannot be deleted — its allocations write ledger rows (DR AP / CR Cash) and deleting the parent leaves them inconsistent. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_supplier_payment_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.id, OLD.amount
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- Allocation delete guard has no audit table by design — the
-- allocation's information (paymentId, billId, amount) is a subset
-- of both the SupplierPayment and SupplierBill audit rows that a
-- companion delete would produce. Blocked attempts still RAISE
-- with a clear message.
CREATE OR REPLACE FUNCTION supplier_allocation_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_supplier_allocation_delete', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'SupplierPaymentAllocation % cannot be deleted — allocations key ledger rows (DR AP / CR Cash) via sourceId. '
        'To correct: void the parent SupplierPayment (posts reversing entries) rather than deleting the allocation. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_supplier_allocation_delete = ''true''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ── Triggers ────────────────────────────────────────────────────

CREATE TRIGGER supplier_bill_delete_guard
    BEFORE DELETE ON "SupplierBill"
    FOR EACH ROW
    EXECUTE FUNCTION supplier_bill_delete_guard_fn();

CREATE TRIGGER supplier_payment_delete_guard
    BEFORE DELETE ON "SupplierPayment"
    FOR EACH ROW
    EXECUTE FUNCTION supplier_payment_delete_guard_fn();

CREATE TRIGGER supplier_allocation_delete_guard
    BEFORE DELETE ON "SupplierPaymentAllocation"
    FOR EACH ROW
    EXECUTE FUNCTION supplier_allocation_delete_guard_fn();
