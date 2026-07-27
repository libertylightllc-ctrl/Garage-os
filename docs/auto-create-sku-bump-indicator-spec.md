# Show the owner when an auto-create SKU got bumped

**Status:** SPEC — report only. Not a blocker for the auto-create ship.

**Filed:** 2026-07-25 by AR, while click-verifying the Estimate → PO
auto-create feature. Silent bump behavior noted at the shelf-typeability
edge.

## What AR observed

Fixture line: `"Brake sensor (fixture — no inventory link)"`. The
review row's SKU input pre-fills with `BRAKE-SENSOR-FIXTURE-2` when an
existing Part in the same garage already holds `BRAKE-SENSOR-FIXTURE`
(a different part, e.g. a rear brake sensor). The `-2` is picked by
`withCollisionSuffix` — correct behavior, guarantees uniqueness. But
the input just shows the string. No badge, no tooltip, no "renamed
because taken" caption.

Same shape on the `AUTO-N` fallback path: if the description slugs to
`""` (empty / punctuation-only), `nextAutoSku` picks `AUTO-1` (or the
next free slot), and the owner just sees `AUTO-1` with no context.

## Why this is confusing at the shelf

A tech reads a SKU off the shelf and types it into inventory search. If
the review defaulted to `BRAKE-SENSOR-FIXTURE-2`, the owner accepted
it, the tech sees it, and then wonders:

- "Why is there a `-2`? Where's the `-1`?" → looks for it, finds
  `BRAKE-SENSOR-FIXTURE` on a completely different part (rear brake
  sensor). Now they're not sure which one they wanted.
- "Did the system rename mine?" → yes, but the review UI didn't say so.
- Owner also can't tell whether editing back to `BRAKE-SENSOR-FIXTURE`
  would just fail (collision on submit) or silently overwrite.

The `AUTO-N` case is worse — `AUTO-3` reads like a serial number for
nothing anyone would recognize.

## Fix shape

**On the review row**, when the default SKU was **bumped** OR
**AUTO-N-fallback-picked**, render a small muted caption *under* the
SKU input:

- Bumped: `"Renamed from BRAKE-SENSOR-FIXTURE (already used by
  Rear brake sensor)"` — carries WHY *and* WHICH existing part took
  the base name. Owner immediately sees whether it's the same physical
  part (should link instead) or genuinely different.
- AUTO-N: `"No name to slug from — using AUTO-1 as a placeholder.
  Please edit."` — makes it clear this is a fallback, not a
  meaningful code, and nudges toward editing.

Same caption gets a `title=` attribute on the input for screen readers.

## What NOT to do

- **Don't force the owner to resolve the collision.** They can still
  submit `BRAKE-SENSOR-FIXTURE-2` — that's the safe default. The
  caption is informational, not blocking. A modal or required-action
  turns a paper cut into friction.
- **Don't hide the bump.** Silently swapping to `-2` was the current
  bug; that's what we're fixing.
- **Don't add a "would you like to link to the existing one?"
  affordance in this spec** — that's the `findNormalizedMatch` job
  (and only fires when the *name* matches, which is not always the
  case on SKU collision). Keep the two orthogonal.

## Data shape needed at render time

The review UI already computes the `takenForDefaults` set + the raw
slug. Extend the per-row computation to carry two extra bits into the
render:

```ts
type SkuChoice =
    | { kind: "slug"; value: string }
    | { kind: "bumped"; value: string; base: string; takenBy: { name: string; id: string } }
    | { kind: "auto"; value: string };
```

`takenBy` is the existing Part whose SKU is the base — cheap lookup
against the same `existingParts` array we already load for the
normalized-match check.

## Test the rule

Two shapes to pin:

1. Given fixture line X and no collision → row renders with SkuChoice
   `{kind:"slug"}` and no caption.
2. Given fixture line X and an existing Part with the slug SKU → row
   renders with `{kind:"bumped", takenBy:{name}}` and the caption
   quotes both the base SKU and the `takenBy.name`.
3. Given a punctuation-only fixture line → `{kind:"auto"}` caption
   fires.

## Related

- `docs/Estimate-to-PO-Spec.md` — the auto-create locked design.
- `src/lib/estimate-to-po.ts` — `slugifyToSku`, `withCollisionSuffix`,
  `nextAutoSku`. No changes needed to the helpers; the UI computes the
  choice.
- `src/app/owner/purchasing/from-estimate/page.tsx` — the review row
  render (currently just `defaultValue={defaultSku}` on the input).
