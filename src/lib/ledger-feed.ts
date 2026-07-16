// Owner ledger "Individual payments" feed — the JS merge that page.tsx
// runs today over Payment + AdvancePayment rows. Extracted so the exact
// same ordering can be asserted against the server-side UNION query used
// by pagination (see src/lib/__tests__/ledger-feed-union-parity.test.ts).
//
// If the JS merge and the SQL UNION drift, the owner ledger misreports
// which payments landed on which page — a silent money-ordering bug that
// would never throw. The parity test exists to make it loud.

export type FeedItem =
  | {
      kind: "PAYMENT";
      id: string;
      at: Date;
      amount: number;
      method: string;
      customer: string;
      invoiceNumber: number;
    }
  | {
      kind: "ADVANCE";
      id: string;
      at: Date;
      amount: number;
      method: string;
      customer: string;
      migrated: boolean;
    };

export interface PaymentRow {
  id: string;
  amount: unknown;
  method: string;
  paidAt: Date;
  invoice: {
    number: number;
    jobCard: { vehicle: { customer: { name: string } } };
  };
}

export interface AdvanceRow {
  id: string;
  amount: unknown;
  method: string;
  receivedAt: Date;
  migratedAt: Date | null;
  jobCard: { vehicle: { customer: { name: string } } };
}

/** Merge Payment + AdvancePayment rows into one time-sorted feed.
 *  Behaviour matches page.tsx exactly:
 *   - order = at DESC
 *   - ties broken by INSERTION ORDER (Array.sort is stable in V8),
 *     which means Payment beats Advance at the same timestamp.
 *  The SQL UNION reproduces both rules via ORDER BY at DESC, kind_ord ASC. */
export function mergeLedgerFeed(
  payments: PaymentRow[],
  advances: AdvanceRow[],
): FeedItem[] {
  return [
    ...payments.map<FeedItem>((p) => ({
      kind: "PAYMENT" as const,
      id: p.id,
      at: p.paidAt,
      amount: Number(p.amount),
      method: p.method,
      customer: p.invoice.jobCard.vehicle.customer.name,
      invoiceNumber: p.invoice.number,
    })),
    ...advances.map<FeedItem>((a) => ({
      kind: "ADVANCE" as const,
      id: a.id,
      at: a.receivedAt,
      amount: Number(a.amount),
      method: a.method,
      customer: a.jobCard.vehicle.customer.name,
      migrated: a.migratedAt !== null,
    })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime());
}
