-- Ledger-source delete guard (AR 2026-08-19). After the 2026-08-19
-- audit discovered 5 invoices had been manually DELETE'd from prod
-- via the SQL editor — breaking the gapless per-garage number
-- sequence (a UAE VAT requirement) and leaving orphan ledger rows.
-- The related audit also found 78 Payment rows had been deleted the
-- same way, leaving DR Cash / CR AR orphaned in the ledger.
--
-- Guard shape per AR's decision 2026-08-19: option 3 — trigger +
-- audit log + escape hatch. Extended the same afternoon to cover
-- ALL THREE tables that write to LedgerEntry (Invoice, Payment,
-- AdvancePayment). A guard that only covered Invoice would have
-- caught neither the past 78-row Payment incident nor a future
-- AdvancePayment one.
--
-- What this does:
--
--   1. NEW audit tables — one per protected table (InvoiceDeleteAudit,
--      PaymentDeleteAudit, AdvancePaymentDeleteAudit). Each records
--      every allowed DELETE with the row's essential fields at delete
--      time (id, garageId, amount/status, etc.) and a NOTE captured
--      from a session variable so an operator running a legitimate
--      cleanup can attach the reason. Rows are INSERT-only from
--      the trigger; no delete/update in normal use.
--
--      NOTE ON BLOCKED ATTEMPTS: the trigger INSERTs the audit row
--      BEFORE it RAISEs, but RAISE aborts the outer transaction, so
--      blocked-attempt audit rows do NOT durably persist. Only
--      allowed deletes leave an audit trail. The block itself is
--      the value — the SQL editor vector this guards can't reach
--      an application-layer sink either. See the invoice-delete-guard
--      test suite Case B for the pinned behavior.
--
--   2. NEW triggers — invoice_delete_guard on "Invoice",
--      payment_delete_guard on "Payment",
--      advance_payment_delete_guard on "AdvancePayment".
--
--      Invoice rule:
--        - status = 'DRAFT' → allow (drafts leak no ledger rows)
--        - session flag app.allow_invoice_delete = 'true' → allow
--        - else → RAISE EXCEPTION
--
--      Payment + AdvancePayment rule:
--        - session flag app.allow_payment_delete = 'true' (Payment)
--          or app.allow_advance_delete = 'true' (AdvancePayment) → allow
--        - else → RAISE EXCEPTION
--
--      There is no "DRAFT" for Payment / AdvancePayment — every row
--      of those tables writes to the ledger the moment it's inserted.
--      Deleting any of them without a matching ledger cleanup leaks.
--
--   3. Escape hatch: any session that wants to delete a protected
--      row for a genuine reason (test-tenant cleanup, migration,
--      VAT-authority-approved reversal) must run BEFORE the DELETE:
--
--          SET LOCAL app.allow_invoice_delete = 'true';   -- pick the
--          SET LOCAL app.allow_payment_delete = 'true';   -- flags
--          SET LOCAL app.allow_advance_delete = 'true';   -- you need
--          SET LOCAL app.delete_note = 'ticket-1234: reason';
--          DELETE FROM "Invoice" WHERE ...;
--
--      SET LOCAL is per-transaction — the flag automatically clears
--      at COMMIT/ROLLBACK, so a subsequent unrelated DELETE in a
--      different session still hits the guard.
--
-- Doesn't cover: hard `TRUNCATE`, dropping the trigger, direct FK
-- cascade from a table that DOES have ON DELETE CASCADE pointing
-- at any of the three. But those are all deliberate two-step
-- operations rather than the "one accidental SQL statement" vector
-- that caused the 2026-08-19 incidents.

-- ── Audit tables ────────────────────────────────────────────────

CREATE TABLE "InvoiceDeleteAudit" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "invoiceId"    TEXT NOT NULL,
    "garageId"     TEXT NOT NULL,
    "number"       INTEGER NOT NULL,
    "status"       TEXT NOT NULL,
    "subtotal"     DECIMAL(12,2) NOT NULL,
    "vatAmount"    DECIMAL(12,2) NOT NULL,
    "total"        DECIMAL(12,2) NOT NULL,
    "issuedAt"     TIMESTAMP(3),
    -- Only allowed deletes are durable (blocked attempts abort with
    -- the transaction). Kept as a column anyway so a future
    -- out-of-transaction logging shim can populate 'blocked' rows
    -- via the app layer without a schema change.
    "outcome"      TEXT NOT NULL,
    "attemptedBy"  TEXT NOT NULL,
    "note"         TEXT,
    "attemptedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDeleteAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InvoiceDeleteAudit_garageId_idx"    ON "InvoiceDeleteAudit"("garageId");
CREATE INDEX "InvoiceDeleteAudit_outcome_idx"     ON "InvoiceDeleteAudit"("outcome");
CREATE INDEX "InvoiceDeleteAudit_attemptedAt_idx" ON "InvoiceDeleteAudit"("attemptedAt");

CREATE TABLE "PaymentDeleteAudit" (
    "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "paymentId"    TEXT NOT NULL,
    "invoiceId"    TEXT NOT NULL,
    "amount"       DECIMAL(12,2) NOT NULL,
    "method"       TEXT NOT NULL,
    "paidAt"       TIMESTAMP(3) NOT NULL,
    "outcome"      TEXT NOT NULL,
    "attemptedBy"  TEXT NOT NULL,
    "note"         TEXT,
    "attemptedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentDeleteAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentDeleteAudit_outcome_idx"     ON "PaymentDeleteAudit"("outcome");
CREATE INDEX "PaymentDeleteAudit_attemptedAt_idx" ON "PaymentDeleteAudit"("attemptedAt");

CREATE TABLE "AdvancePaymentDeleteAudit" (
    "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "advancePaymentId"   TEXT NOT NULL,
    "garageId"           TEXT NOT NULL,
    "jobCardId"          TEXT NOT NULL,
    "amount"             DECIMAL(12,2) NOT NULL,
    "method"             TEXT NOT NULL,
    "paidAt"             TIMESTAMP(3) NOT NULL,
    "migratedAt"         TIMESTAMP(3),
    "outcome"            TEXT NOT NULL,
    "attemptedBy"        TEXT NOT NULL,
    "note"               TEXT,
    "attemptedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvancePaymentDeleteAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdvancePaymentDeleteAudit_garageId_idx"    ON "AdvancePaymentDeleteAudit"("garageId");
CREATE INDEX "AdvancePaymentDeleteAudit_outcome_idx"     ON "AdvancePaymentDeleteAudit"("outcome");
CREATE INDEX "AdvancePaymentDeleteAudit_attemptedAt_idx" ON "AdvancePaymentDeleteAudit"("attemptedAt");

-- ── Trigger functions ───────────────────────────────────────────
-- current_setting(name, missing_ok=true) returns NULL if unset —
-- avoids the "unrecognized configuration parameter" error a bare
-- current_setting() would raise on the first session-flag check.

CREATE OR REPLACE FUNCTION invoice_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_invoice_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_is_draft   BOOLEAN := (OLD.status = 'DRAFT');
    v_allowed    BOOLEAN := v_is_draft OR v_allow_flag = 'true';
BEGIN
    INSERT INTO "InvoiceDeleteAudit" (
        "invoiceId", "garageId", "number", "status",
        "subtotal", "vatAmount", "total", "issuedAt",
        "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."garageId", OLD.number, OLD.status,
        OLD.subtotal, OLD."vatAmount", OLD.total, OLD."issuedAt",
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'Invoice #% (status=%) cannot be deleted — non-DRAFT invoices are protected. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_invoice_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.number, OLD.status
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION payment_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_payment_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    INSERT INTO "PaymentDeleteAudit" (
        "paymentId", "invoiceId", "amount", "method", "paidAt",
        "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."invoiceId", OLD.amount, OLD.method, OLD."paidAt",
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'Payment % (amount=%) cannot be deleted — every Payment writes a ledger row (DR Cash / CR AR) and deleting one leaks. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_payment_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.id, OLD.amount
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION advance_payment_delete_guard_fn() RETURNS TRIGGER AS $$
DECLARE
    v_allow_flag TEXT := current_setting('app.allow_advance_delete', true);
    v_note       TEXT := current_setting('app.delete_note', true);
    v_allowed    BOOLEAN := v_allow_flag = 'true';
BEGIN
    -- AdvancePayment uses `receivedAt`; the audit table normalises
    -- to `paidAt` so the two audit tables share vocabulary.
    INSERT INTO "AdvancePaymentDeleteAudit" (
        "advancePaymentId", "garageId", "jobCardId",
        "amount", "method", "paidAt", "migratedAt",
        "outcome", "attemptedBy", "note"
    ) VALUES (
        OLD.id, OLD."garageId", OLD."jobCardId",
        OLD.amount, OLD.method, OLD."receivedAt", OLD."migratedAt",
        CASE WHEN v_allowed THEN 'allowed' ELSE 'blocked' END,
        current_user, v_note
    );

    IF v_allowed THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'AdvancePayment % (amount=%) cannot be deleted — every AdvancePayment writes a ledger row (DR Cash / CR Customer Deposits) and deleting one leaks. '
        'For a legitimate cleanup, set the session flag first:  '
        'SET LOCAL app.allow_advance_delete = ''true''; '
        'SET LOCAL app.delete_note = ''<ticket + reason>''; '
        'then re-run the DELETE inside the same transaction.',
        OLD.id, OLD.amount
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- ── Triggers ────────────────────────────────────────────────────

CREATE TRIGGER invoice_delete_guard
    BEFORE DELETE ON "Invoice"
    FOR EACH ROW
    EXECUTE FUNCTION invoice_delete_guard_fn();

CREATE TRIGGER payment_delete_guard
    BEFORE DELETE ON "Payment"
    FOR EACH ROW
    EXECUTE FUNCTION payment_delete_guard_fn();

CREATE TRIGGER advance_payment_delete_guard
    BEFORE DELETE ON "AdvancePayment"
    FOR EACH ROW
    EXECUTE FUNCTION advance_payment_delete_guard_fn();
