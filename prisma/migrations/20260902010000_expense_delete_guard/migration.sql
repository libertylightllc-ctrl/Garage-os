-- AR 2026-09-02 — Expense delete guard (E1b).
--
-- Extends the ledger-source delete guard pattern (2026-08-19 for
-- Invoice/Payment/AdvancePayment; 2026-08-30 for SupplierBill /
-- SupplierPayment / SupplierPaymentAllocation) to Expense. Same
-- discipline, same shape.
--
-- Every Expense row writes DR <expense account> / CR Cash/Bank the
-- moment recordExpenseAction commits (E1c, next commit). Deleting
-- one via the SQL editor without a matching ledger cleanup leaks
-- the exact way the 78 Payment deletions did in 2026-08-19.
--
-- Session flags (SET LOCAL, per-tx):
--   app.allow_expense_delete = 'true'
--   app.delete_note          = '<ticket + reason>'   (existing)
--
-- Corrections at the app layer are void + re-record (never delete),
-- per AR's Q3 direct-posting discipline. voidExpenseAction lands in
-- E1c alongside recordExpenseAction.

CREATE OR REPLACE FUNCTION expense_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_expense_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    INSERT INTO "ExpenseDeleteAudit" (
        "expenseId", "garageId", "category", "amount",
        "paidAt", "method", "status",
        "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."garageId", OLD.category::text, OLD.amount,
        OLD."paidAt", OLD.method, OLD.status::text,
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'Expense % (category=%, amount=%) cannot be deleted — every Expense writes a ledger row (DR <expense account> / CR Cash) and deleting one leaks. '
        'To correct a mis-recorded expense: void it (posts a compensating adjustment) rather than deleting. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_expense_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.id, OLD.category, OLD.amount
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER expense_delete_guard
    BEFORE DELETE ON "Expense"
    FOR EACH ROW
    EXECUTE FUNCTION expense_delete_guard_fn();
