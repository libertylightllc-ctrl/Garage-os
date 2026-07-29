# New-PO form draft persistence

**Status:** SPEC — not built. Filed 2026-07-29 alongside the
`beforeunload` warning that landed on the new-PO form
(`src/app/owner/purchasing/new/page.tsx`,
`src/components/unsaved-changes-guard.tsx`). This document sketches
the wider "don't lose typed work" behavior in case a decision comes
later to build it.

## What the narrow fix does

`UnsavedChangesGuard` attaches `beforeunload` when any input is
edited and detaches on submit. The browser shows its native "Leave
site?" prompt when the owner tries to close the tab, navigate away,
or reload with unsaved fields. Nothing persists — accept the prompt
and the typed data is gone.

That closes the accidental-loss case (misclick, reflex tab-close)
but not deliberate-loss cases (browser crash, OS restart, "I'll
come back to this" behavior).

## What draft persistence would do

Store the form's typed values in `localStorage` on every input,
restore on mount, clear on successful submit. Owner opens the new
PO form 15 minutes later and their supplier / reference / note is
still there.

### Storage shape

```
localStorage["gos.newPo.draft"] = JSON.stringify({
  supplierId: string | null,
  reference: string,
  note: string,
  garageId: string,       // gate the restore — never bleed one garage's draft into another
  savedAt: number,        // for stale expiry (24h?)
})
```

`garageId` guard: a MASTER logging out of demo-garage and back into
a customer garage must NOT see the demo draft. Compare on restore;
discard if mismatch.

### Save cadence

- On every `input` / `change` event, debounce ~300ms.
- Do NOT save on load (would overwrite a fresh restore with empty
  values if the restored form is rendered blank for any reason).

### Restore rules

- On mount, read the key. If empty → nothing to do.
- If `garageId` doesn't match the current session's `garageId` →
  discard.
- If `savedAt` is more than 24h old → discard (keeps the drawer
  from filling up with abandoned drafts from months ago).
- Otherwise, populate the fields via `setNativeValue` (same trick
  the concurrency browser test used) so React state, if any,
  picks up the values.
- Show a small "Restored from your last session, [dismiss ×]"
  indicator so the owner knows why the fields are pre-filled.

### Clear rules

- On successful submit → `removeItem`.
- On explicit dismiss of the "Restored" indicator → `removeItem` +
  clear form fields.
- On the 24h staleness expiry → `removeItem`.

## Why this is not built now

- Storage-shape mistakes (wrong garageId gate, missing
  session-check, restoring an admin's draft to a staff account)
  are silent data leaks. The narrow `beforeunload` fix has zero of
  those failure modes.
- The new-PO form is 3 fields — supplier, reference, note. Not
  filling those 3 in again is annoying, not catastrophic. The
  ROI of persistence is smaller than it looks.
- Persistence spans a real behavioral change (owner learns
  "closing tab is fine"), which affects the mental model of every
  other form in the app. Do it as a considered rollout or not at
  all — not as a copy of the pattern into one form.

## When to reconsider

- If any garage reports actually losing typed drafts to browser
  crashes / OS restarts (i.e., not "misclicked Back" — that's
  already covered).
- If we add a form with more fields where retyping IS
  catastrophic (customer intake, VIN decode results, estimate
  lines when the tech is on a shared-tablet workflow).
- If we build a "return to draft later" surface — a list of
  in-progress documents the owner can pick up. That would need
  server-side persistence, not localStorage, and would be a
  separate design.

## Related

- `src/components/unsaved-changes-guard.tsx` — the narrow fix.
- `src/app/owner/purchasing/new/page.tsx` — the form it protects.
- `docs/optimistic-concurrency-spec.md` — sibling doc, same
  "narrow first, catalog wider" pattern.
- `docs/apex-www-cookie-scope-spec.md` — same pattern for cookies.
