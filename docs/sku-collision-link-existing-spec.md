# Link-to-existing option on the bump caption

**Status:** SPEC — not built. Filed 2026-07-30 by AR immediately after the
SKU-bump indicator (`d286921`) shipped. Same failure class as duplicate
plates we found in the intake dedup work (`614b8d6` / commit-2 pending):
the schema doesn't stop us from creating a near-duplicate `Part`, so the
review flow has to.

## What the current bump caption does + doesn't say

The caption from `d286921` reads:

> Renamed from `BRAKE-SENSOR-FIXTURE` (already used by *Rear brake sensor*).

That correctly tells the owner **what happened** — the auto-generator
picked `BRAKE-SENSOR-FIXTURE-2` because the base was taken. It does NOT
tell them **what to do about it**. The owner clicks Add-to-inventory and
gets a second Part row, `BRAKE-SENSOR-FIXTURE-2` / *Brake sensor fixture*,
sitting alongside `BRAKE-SENSOR-FIXTURE` / *Rear brake sensor*.

Two scenarios end up looking the same in the DB:

1. **Same physical part, sloppy naming** — advisor typed *"Brake sensor
   fixture"* on the estimate when they meant the rear brake sensor
   that's already in the catalog. The owner should have linked to the
   existing Part; instead we get two rows for the same shelf item.
   Downstream every plate-lookup / stock-check / PO from now on has to
   distinguish between `BRAKE-SENSOR-FIXTURE` and `BRAKE-SENSOR-FIXTURE-2`
   — and the tech at the shelf can't.
2. **Genuinely different part** — front brake sensor vs. rear brake
   sensor, both real, both in the catalog. Two rows is correct.

The reviewer can't distinguish these from the current caption. Same-name
tolerance means the wrong choice never surfaces as an error.

## Why this maps to the duplicate-plates finding

We just spent commit 1 of intake dedup (`614b8d6`) closing the "same
plate, silently gets a second Vehicle row" gap because `Vehicle` has no
`@@unique` on `(garageId, plate)`. `Part` DOES have `@@unique([garageId,
sku])`, so the DB won't hold two rows with the same SKU — but the
bump-to-`-N` machinery routes around the constraint. Two rows with
different SKUs and near-identical names is functionally the same silent
data-quality bug, and same class of downstream ambiguity.

## Proposed fix (not built)

On the bump case ONLY (`kind: 'bumped'`), render an inline choice inside
the caption:

- Existing offer: `[✓] Link this line to the existing "Rear brake
  sensor" (BRAKE-SENSOR-FIXTURE) instead of creating a new Part.`
  When the checkbox is on, the review row's `sku_<lineId>` /
  `name_<lineId>` inputs disappear and a `linkTo_<lineId>` hidden
  input carries the existing Part id — exactly the same shape the
  `findNormalizedMatch` path already uses for name-matched rows. The
  server action reads whichever is present.

- **Do NOT default the checkbox to on.** The two scenarios above are
  genuinely 50/50; forcing the owner to actively pick means they read
  the two names side-by-side before committing. Auto-selecting the link
  is the exact failure mode the duplicate-plates finding warned about
  (destroying the wrong record silently).

## Data shape needed at render time

Zero schema changes. The bump case already has `takenBy: P` in the
`SkuChoice` tag — that's the existing Part. The review row form already
handles the `linkTo_<lineId>` field for the name-normalized-match path
(see `autoCreateLinkExisting`). Wiring together:

1. `SkuChoice.kind === 'bumped'` → render the checkbox with
   `value={takenBy.id}` under the same caption.
2. Server action (`autoCreatePartsFromEstimateLinesAction`) already
   branches on `linkTo_<id>` — no change needed there.

## Tests worth writing

1. `computeSkuChoice` returns `bumped` with the correct `takenBy` — already
   covered.
2. Review row rendering: given a `bumped` row, the checkbox for
   `linkTo_<id>` appears and is unchecked by default.
3. Submit with the checkbox ON → server links the estimate line to the
   existing Part; no new Part row created; row count on `Part` unchanged.
4. Submit with the checkbox OFF → server creates the new bumped Part
   (today's behavior).

## Related

- `docs/auto-create-sku-bump-indicator-spec.md` — the caption that
  informs but doesn't offer a choice (built).
- `docs/intake-duplicate-handling-spec.md` — same class of "no unique
  constraint, silent duplicate" bug on `Vehicle.plate`.
- `src/lib/estimate-to-po.ts` — `computeSkuChoice`, `findNormalizedMatch`.
- `src/app/actions/purchasing.ts` — `autoCreatePartsFromEstimateLinesAction`,
  the server action that already handles `linkTo_<id>` for the
  name-normalized-match path.
