# Cashier dashboard — tab cleanup spec

Report generated 2026-07-23 while paused on print-form verification. Not yet
approved to build — captured here so the duplication finding isn't lost.

## Source of truth
- `src/app/cashier/page.tsx`
- `src/components/cashier-tabs.tsx`

## What's there today

4 tabs: **Estimates · Invoices · Payments · Reports**, plus 6 counter badges
across the top of every tab.

| Tab | Sections | Cashier can act? |
|---|---|---|
| **Estimates** | Approved estimates | ✅ "Generate Invoice" — only when `TECH_COMPLETE` |
| | Coming up (Pending + Awaiting approval + Revised) | ❌ read-only, advisor-owned |
| | Waiting for diagnosis | ❌ read-only, tech still working |
| **Invoices** | To send (INVOICED, not sent) | ✅ "Send Invoice to Customer" |
| | Awaiting final invoice (`TECH_COMPLETE`) | ✅ "Generate Invoice" |
| | Receivables (unpaid) | ✅ "Mark as Paid" |
| **Payments** | Paid invoices archive | — read/filter |
| **Reports** | Revenue · VAT collected · Cash in · AR outstanding | — read |

## The problems

### 1. Duplicated section — `TECH_COMPLETE` jobs render TWICE
Same job, same "Generate Invoice" button, same target URL, appears under
**both**:
- Estimates → *Approved estimates* (rows where `techDone`) — `page.tsx:924-931`
- Invoices → *Awaiting final invoice* — `page.tsx:816-822`

Cashier sees the same "AED 1,240 · Generate Invoice" row twice on a single
dashboard.

### 2. Duplicated counter — "Approved" ⊇ "Ready for Invoice"
- `approvedEstimateJobs` = APPROVED estimate + no invoice → includes
  tech-still-working jobs
- `readyForInvoice` = `TECH_COMPLETE` only

"Approved" is a superset. The extra it counts is jobs the cashier can't act
on yet ("advisor priced, tech still wrenching"). Situational awareness with
no button.

### 3. Whole Estimates tab is off-role
Per Key Decision #5 in AGENTS.md (post 2026-06-23 flip): **advisor prices
estimates; cashier invoices + collects payment.**
- *Coming up* — 100% advisor-owned states. Cashier can't touch any of them.
- *Waiting for diagnosis* — tech surface. Cashier can't touch either.
- *Approved estimates* — the one actionable subset already lives in the
  Invoices tab.

The Estimates tab exists mostly to show the cashier what other roles are
doing. Violates the "max 3 primary actions per screen" rule and drags the
cashier back into a workflow they no longer own.

## Proposed removals

| # | Remove | Why |
|---|---|---|
| A | **Entire "Estimates" tab** (from `CASHIER_TABS` + all its sections) | Off-role for cashier post-workflow-flip; only actionable piece is already in Invoices tab |
| B | **"Approved estimates" section** (`page.tsx:853-939`) | Duplicates Invoices → Awaiting final invoice on the actionable rows; the rest is read-only advisor status |
| C | **"Coming up" section** (`page.tsx:959-1034`) | Read-only advisor status — no cashier action |
| D | **"Waiting for diagnosis" section** (`page.tsx:1043-1083`) | Read-only tech status — no cashier action |
| E | **"Approved" counter badge** (`page.tsx:593-599`) | Superset of "Ready for Invoice" which stays; nowhere to drill after A/B |
| F | Adjust `CashierTabs` — drop `"estimates"` from `CASHIER_TABS`; make **Invoices** the default tab | Follows from A |

**After cleanup:**
- 3 tabs: **Invoices · Payments · Reports**
- 5 counters: Ready for Invoice · Unpaid · Partially Paid · Overdue · Paid
- Every visible row on the cashier dashboard has a button the cashier can push.

## Flag before touching

1. **`?tab=estimates&filter=approved` deep-links** exist from the counter
   today. After cleanup, `VALID_TABS` no longer includes `estimates`, so
   those URLs silently fall back to the default (see `page.tsx:178-180`).
   Owner Copilot / any Slack pastes → land on Invoices tab. Acceptable but
   worth calling out.
2. **`/cashier/paid`** is a separate route
   (`src/app/cashier/paid/page.tsx`) that mirrors the Payments tab. Not in
   scope for this cleanup — but a fourth duplication if consolidating later.
3. **i18n keys to grep-before-delete**: `cashierTabEstimates`,
   `cashierApprovedEstimatesTitle`, `cashierApprovedEstimatesEmpty`,
   `cashierComingUpTitle`, `cashierComingUpHint`, `cashierComingUpEmpty`,
   `cashierWaitingDiagnosisTitle`, `cashierWaitingDiagnosisCaption`,
   `counterApprovedEstimates`, `cashierWorkInProgressCaption`,
   `cashierFilterActive`, `cashierClearFilter`. Same drill as Phase 5.
4. Tests to look at: `master-owner-boundary.test.ts` doesn't cover this.
   Likely a cashier permissions test in `src/lib/__tests__/` references the
   estimates tab — grep for `cashierTabEstimates` / `?tab=estimates` before
   deleting.
5. Commit strategy: default to one commit for the whole cleanup — the
   removals are all part of the same rev and roll back together cleanly.
