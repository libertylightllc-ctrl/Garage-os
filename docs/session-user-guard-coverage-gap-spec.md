# Session-user guard — action test coverage gap

**Status:** SPEC — not built. Filed 2026-07-29 while shipping the
`editPoLineAction` stale-write guard. The gap surfaced there and had
to be worked around; it exists across the entire action-test surface.
This document records it so it doesn't get lost in a code comment.

## What the gap is

Friday's stale-JWT guard (`sessionUserExists`, wired into
`requireRole` / `requireAnyRole` in `src/lib/guard.ts` and
`src/lib/action-guards.ts`, backed by `src/lib/session-user.ts`)
verifies the JWT's user id resolves to a live `User` row on every
protected request. If the user has been hard-deleted or the seed
rotated, the guard redirects to `/login` before the action runs.

The guard was added, and **the existing action-isolation test suites
were not updated**. Those tests mock `@/auth` to return a session
whose user id (`po-iso-test-u`, `est-iso-test-u`, and similar) is
never inserted into the DB. Post-guard, every mocked action call
should redirect to `/login` on the `prisma.user.count` check.

They didn't get caught because:

- The vitest suites' `redirect()` is mocked to throw `"REDIRECT:"` +
  URL; the `call()` helper swallows and returns the URL. A `/login`
  redirect looked identical in the return value to a successful
  `?error=...` redirect for tests that were only checking "did the
  DB change" — the DB didn't change either way (the guard fired
  before the writer), so both interpretations of the return value
  passed the assertion.
- Retries (`{ retry: 3 }` on every describe block) hide any flake
  from a passing-by-coincidence chain.

The stale-write fix hit this because its NEW happy-path test asserts
the row DID change (qty 2 → 9). The guard-blocks-write case makes
that assertion fail loudly. Mocking `sessionUserExists` unblocked
the fix and made all 48 tests in the file pass.

## Test suites known to share the shape

By construction — anything using `mockAuth.mockResolvedValueOnce(...)`
with an in-test-only user id, without seeding a matching User row.
Found by grep 2026-07-29:

- `src/lib/__tests__/purchasing-isolation.test.ts` — patched in the
  concurrency commit.
- `src/lib/__tests__/estimate-isolation.test.ts`
- `src/lib/__tests__/billing-isolation.test.ts`
- `src/lib/__tests__/inventory-isolation.test.ts`
- `src/lib/__tests__/vehicles-isolation.test.ts`
- `src/lib/__tests__/jobs-isolation.test.ts`

Verify each with `grep -c "sessionUserExists\|user.count" <file>` — a
zero means the guard isn't mocked and the tests are passing by
coincidence, not by exercising the action.

## Why this is a real coverage gap, not a test-infra nit

Any of those isolation suites is our only automated proof that the
underlying server action does what it claims — cross-garage
rejection, DRAFT-only guards, quantity validation, all of it. A
green run whose actual code path is "guard redirected before the
action ran" reports "isolation invariants hold" while proving
nothing about the action. If we regressed
`createPurchaseOrderAction` to accept a foreign supplier tomorrow,
the isolation test would keep passing until someone opened the file.

The guard shipped Friday. The full-suite run at the time was green
because every suite continued to hit the `/login` redirect the same
way it does now — the tests weren't catching that the guard was in
front of every action call.

## Proposed fix (spec)

Two options; pick per-suite based on effort vs. clarity.

**Option A — mock at the module boundary.** Add one line per suite,
same shape as the concurrency commit:

```ts
vi.mock("@/lib/session-user", () => ({ sessionUserExists: async () => true }));
```

Pros: one line. No fixture to seed. Every suite passes with the same
mock.
Cons: doesn't exercise the real code path. If `sessionUserExists`
grows a second responsibility, the tests continue to bypass it.

**Option B — seed a `User` row alongside the garages.** In each
suite's `beforeEach`, `prisma.user.create` with the id the mockAuth
returns. `cleanup()` deletes it. Now the guard runs against real
data.

Pros: real code path.
Cons: an extra INSERT and DELETE per test; ~15 test files if we
sweep the whole thing.

Recommendation: **A across the board**, plus one dedicated end-to-end
test per action module that seeds a real user and drives the guard
positively. That end-to-end test proves the guard works; the
per-action isolation tests get to focus on the action's own logic
without contorting fixtures.

## Not the same class as the concurrency gap this doc lives next to

`docs/optimistic-concurrency-spec.md` is about a production write
path that can silently corrupt data. This document is about test
coverage for guards that are working correctly in production. Both
are gaps; only one is a runtime hazard. Don't conflate them when
deciding what to prioritise.

## Related

- `src/lib/session-user.ts` — the guard's implementation and its
  own rationale comment.
- `src/lib/guard.ts`, `src/lib/action-guards.ts` — the two guard
  helpers that call it.
- `src/lib/__tests__/session-user-guard.test.ts` — proves the guard
  behaves correctly when mocked appropriately. That's not the gap;
  the gap is upstream in every action-isolation suite that mocks
  the wrong layer.
- `src/lib/__tests__/purchasing-isolation.test.ts` — patched with
  Option A in the concurrency commit.
