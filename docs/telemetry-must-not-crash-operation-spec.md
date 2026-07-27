# Telemetry must never crash the operation it logs

**Status:** SPEC — report only. Do not build without an explicit
go-ahead from AR.

**Filed:** 2026-07-25 by AR, after an intake POST 500'd on a stale
JWT during local verification (digest `4090316057`).

## The rule

Analytics, telemetry, and audit-log writes — any write whose sole
purpose is observability, not correctness — MUST NOT be able to fail
the real operation. If the log write throws, the operation still
completes; the log is dropped and the failure is surfaced through
its own logging channel (`console.warn` at minimum), not the user's
response.

The operational write path is the primary. Telemetry is best-effort.

## Why this shape keeps recurring

This is the same failure mode as the sendWhatsApp-crashing-delivery
bug from earlier this session: a side-effect that is *supposed* to
be observability sits in the critical path of a user-facing action,
and any hiccup in the side-effect (network flake, FK violation,
provider outage) takes down what the user was actually trying to do.

The user experience is the worst possible: "I tried to check a car
in and got Something Went Wrong. My car isn't checked in, is it?"
— when in fact the check-in would have succeeded fine if we hadn't
insisted on recording a telemetry row about it.

## The bug that filed this

`src/app/actions/intake-moulkia.ts:49` — `logAttempts()` calls
`prisma.aiEvent.create({ data: { userId, ... } })` inside the
Moulkia OCR intake action. When the incoming session's `userId`
doesn't reference a real `User` row (in the case that fired: a
stale JWT after a local re-seed had rotated user ids), Postgres
returns `P2003 Foreign key constraint violated on AiEvent_userId_fkey`.
That error propagates all the way up through `moulkiaFrontAction`,
crashes the server action, and the user sees a full-page error.

The intake itself would have succeeded fine — the Moulkia OCR ran,
produced a result, and was ready to be saved. We threw it away
because we couldn't log the metadata.

## Call sites that need the same treatment

Every path that writes `AiEvent` from inside a user-triggered
action or route handler:

| File                                      | Fn                          |
|-------------------------------------------|-----------------------------|
| `src/app/actions/intake-moulkia.ts:49`    | `logAttempts` (this bug)    |
| `src/app/actions/parts-import.ts`         | (grep confirms)             |
| `src/lib/intake.ts`                       | (grep confirms)             |
| `src/lib/receptionist-engine.ts`          | (grep confirms)             |
| `src/app/owner/page.tsx`                  | (grep confirms; RSC read?)  |

Same principle applies to any future `AdminAuditLog.create`, ledger
audit writes, or WhatsApp delivery-record writes that sit inside a
mainline path — audit these on the same sweep.

## Fix shape — pick one per site (they compose)

**Shape A — catch and log (default, cheapest).** The write is
side-effectful and idempotent-if-lost. Just don't rethrow.

```ts
try {
    await prisma.aiEvent.create({ data: { ... } });
} catch (err) {
    // Best-effort telemetry — never crash the operation on log failure.
    console.warn("[aiEvent] insert failed, dropping row", err);
}
```

**Shape B — verify the FK before the write.** When we already have
the id in hand and can cheaply check it. Useful when we want to
distinguish "user genuinely doesn't exist" (bug — surface loudly)
from "row rejected for some other reason" (skip quietly).

```ts
const userExists = await prisma.user.count({ where: { id: userId } });
if (userExists) {
    await prisma.aiEvent.create({ data: { ... } });
}
// else drop — stale session or racing delete
```

**Shape C — write on a separate transaction / after redirect.**
When the main path is a `$transaction`, the telemetry write should
NOT be inside it. If the telemetry throws inside the transaction,
Postgres rolls back the whole thing. Move it outside.

**Shape D (belt-and-braces).** Combine A + C: telemetry happens
outside the main transaction AND the outside write is wrapped in
try/catch.

For `logAttempts` specifically: **Shape A** is the minimum bar. If
we also want to distinguish "the user id was actually bogus"
(a signal worth alerting on) from "the row insert just failed",
add **Shape B** so the caller can log the specific case.

## Test the rule

For each fixed site, add a test that pins the invariant:

```ts
it("logAttempts: FK violation on userId does NOT crash the caller", async () => {
    // Mock prisma so aiEvent.create throws a synthetic P2003.
    // Assert logAttempts resolves without throwing.
});
```

The test fails RED without the catch; goes green with the fix. Any
future refactor that removes the catch trips it.

## Not in scope for this spec

- Bulk-reconstructing telemetry from other sources when writes
  drop. If we lose an AiEvent row, we lose it — token spend
  accounting is best-effort, not accounting-of-record. The
  operational data (the JobCard, the invoice) is the source of
  truth.
- Rate-limiting or batching telemetry writes. Separate concern.
- Moving telemetry off Postgres to a fire-and-forget log stream.
  Nice to have long-term; not the fix for THIS shape.

## Related

- Same shape as sendWhatsApp-crashing-delivery (fixed earlier
  this session — same lesson, different call site).
- `docs/upload-validation-spec.md` — different rule, same pattern
  of "audit the sweep, don't just fix the one that fired."
