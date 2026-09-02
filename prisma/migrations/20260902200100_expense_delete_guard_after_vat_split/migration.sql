-- AR 2026-09-02 — fixup after 20260902200000_expense_vat_split.
--
-- The expense_delete_guard_fn (created by 20260902010000_expense_delete_guard)
-- references OLD.amount when writing the ExpenseDeleteAudit row and when
-- raising its "cannot be deleted" exception. E1f renamed
-- Expense.amount → total; ANY delete attempt (including the test-suite
-- allowed-delete inside SET LOCAL app.allow_expense_delete) now fails
-- with:
--     record "old" has no field "amount"
--
-- The ExpenseDeleteAudit table's own "amount" column stays as "amount"
-- — the audit table records what the row LOOKED LIKE, and every historical
-- delete-audit row was written under the "amount" name. Renaming the audit
-- column would break the audit trail. The trigger just reads OLD.total
-- and writes into ExpenseDeleteAudit.amount.

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
        OLD.id, OLD."garageId", OLD.category::text, OLD.total,
        OLD."paidAt", OLD.method, OLD.status::text,
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'Expense % (category=%, total=%) cannot be deleted — every Expense writes a ledger row (DR <expense account> / CR Cash) and deleting one leaks. '
        'To correct a mis-recorded expense: void it (posts a compensating adjustment) rather than deleting. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_expense_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.id, OLD.category, OLD.total
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
