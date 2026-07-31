# VIN duplicates — audit + merge plan

**Status:** SPEC. Queries A and A' in this doc are READ-ONLY audits.
Run BOTH regardless of what A returns — prod holds both normalised
(slice-5 writes) and legacy (pre-slice-5) formats, so a duplicate
pair may straddle the two representations, invisible to whichever
query looks only at one. The merge plan below is a placeholder
waiting on your make/model readout across shared VINs — the plan's
shape depends on whether the duplicates are genuine ownership
changes / mismerged intakes (merge) or OCR chassis misreads (do NOT
merge, keep separate, flag for manual correction).

This is slice 1a of the intake VIN-identity work. Prerequisite for
slice 1 (schema): the partial unique index on `(garageId, vin)` where
`vin IS NOT NULL` fails to create if any duplicates exist, so the
audit + merge come first, and the normalisation backfill (below)
runs before the index add.

## Query A — read-only VIN duplicate audit

Paste into Supabase SQL Editor. Read-only, garage-scoped in the
output columns so you can group by shop. Runs against exact-match
VIN duplicates (post-slice-5 writes are normalised; pre-slice-5 rows
may be raw). Query A' below catches normalisation-format duplicates
— run both, they surface complementary sets when prod holds a mix.

Per-row output includes `plate`, `moulkia_consent_at`, and
`vehicle_updated_at` so you can tell duplicate flavours apart at a
glance. Classification is driven by `make` / `model` / `plate` (see
"How to read" below); the two timestamp columns are for triage.

- `moulkia_consent_at` is captured per intake — its presence on a row
  says only "this vehicle went through Moulkia OCR at least once,"
  not anything about VIN accuracy. Do NOT use it to classify merge
  vs don't-merge. It matters at MERGE TIME as a preservation rule:
  if the discarded row holds a consent record the survivor lacks,
  the merge SQL must copy that consent (either onto the survivor's
  most recent JobCard, or as an audit note) before dropping the
  losing Vehicle. Losing a consent record is a compliance regression.
- `vehicle_updated_at` — big gap between rows in a group, only the
  newer row has recent jobs → the older row is likely dormant, safe
  to fold into the newer one after the make/model check confirms
  it's the same physical car.

```sql
-- Query A: exact-match VIN duplicates in the same garage.
WITH v_with_last AS (
    SELECT
        v."garageId",
        v.vin,
        v.id AS vehicle_id,
        c.name AS owner_name,
        c.phone,
        v.make,
        v.model,
        v.year,
        v.plate,
        v."updatedAt" AS vehicle_updated_at,
        (
            SELECT MAX(j."createdAt")
            FROM "JobCard" j
            WHERE j."vehicleId" = v.id
        ) AS last_job_at,
        (
            SELECT COUNT(*)
            FROM "JobCard" j
            WHERE j."vehicleId" = v.id
        ) AS job_count,
        (
            -- Latest consent timestamp captured on any JobCard for
            -- this Vehicle. NULL when no JobCard carries consent
            -- (manual intake, historical import, or Moulkia not used).
            SELECT MAX(j."moulkiaConsentAt")
            FROM "JobCard" j
            WHERE j."vehicleId" = v.id
        ) AS moulkia_consent_at
    FROM "Vehicle" v
    JOIN "Customer" c ON c.id = v."customerId"
    WHERE v.vin IS NOT NULL AND v.vin <> ''
),
dup_vins AS (
    SELECT "garageId", vin
    FROM v_with_last
    GROUP BY "garageId", vin
    HAVING COUNT(*) > 1
)
SELECT
    vwl."garageId",
    vwl.vin,
    vwl.vehicle_id,
    vwl.owner_name,
    vwl.phone,
    vwl.make,
    vwl.model,
    vwl.year,
    vwl.plate,
    vwl.moulkia_consent_at,
    vwl.vehicle_updated_at,
    vwl.last_job_at,
    vwl.job_count
FROM v_with_last vwl
JOIN dup_vins dv
  ON dv."garageId" = vwl."garageId" AND dv.vin = vwl.vin
ORDER BY vwl."garageId", vwl.vin, vwl.last_job_at DESC NULLS LAST;
```

## Query A' — normalisation-format duplicates

Catches the case where two rows hold the same underlying VIN in
different formats (e.g. `"5N1AR2MM7DC605739"` vs
`"5n1ar2 mm7dc-605739"`) — slice 5's writes are already normalised,
so this is entirely a legacy-row concern. Same output shape as A.

```sql
-- Query A': normalisation-format VIN duplicates in the same garage.
WITH v_with_norm AS (
    SELECT
        v."garageId",
        v.vin AS raw_vin,
        UPPER(REGEXP_REPLACE(v.vin, '[^A-Za-z0-9]', '', 'g')) AS norm_vin,
        v.id AS vehicle_id,
        c.name AS owner_name,
        c.phone,
        v.make,
        v.model,
        v.year,
        v.plate,
        v."updatedAt" AS vehicle_updated_at,
        (
            SELECT MAX(j."createdAt")
            FROM "JobCard" j
            WHERE j."vehicleId" = v.id
        ) AS last_job_at,
        (
            SELECT COUNT(*)
            FROM "JobCard" j
            WHERE j."vehicleId" = v.id
        ) AS job_count,
        (
            SELECT MAX(j."moulkiaConsentAt")
            FROM "JobCard" j
            WHERE j."vehicleId" = v.id
        ) AS moulkia_consent_at
    FROM "Vehicle" v
    JOIN "Customer" c ON c.id = v."customerId"
    WHERE v.vin IS NOT NULL AND v.vin <> ''
),
dup_norm_vins AS (
    SELECT "garageId", norm_vin
    FROM v_with_norm
    GROUP BY "garageId", norm_vin
    HAVING COUNT(*) > 1
)
SELECT
    vwn."garageId",
    vwn.norm_vin,
    vwn.raw_vin,
    vwn.vehicle_id,
    vwn.owner_name,
    vwn.phone,
    vwn.make,
    vwn.model,
    vwn.year,
    vwn.plate,
    vwn.moulkia_consent_at,
    vwn.vehicle_updated_at,
    vwn.last_job_at,
    vwn.job_count
FROM v_with_norm vwn
JOIN dup_norm_vins dv
  ON dv."garageId" = vwn."garageId" AND dv.norm_vin = vwn.norm_vin
ORDER BY vwn."garageId", vwn.norm_vin, vwn.last_job_at DESC NULLS LAST;
```

**A ∪ A' — run both regardless.** If A returns rows and A' returns
zero, all duplicates are already stored normalised (post-slice-5, or
prod was already normalised). If A returns zero and A' returns rows,
duplicates only exist because of format skew — the normalisation
backfill below dissolves them. If both return rows, either the same
group appears in both (all rows normalised in the same way, plus
extras that aren't) or two separate sets need to be reconciled
before the partial unique index can be added.

## How to read the results

For each `(garageId, vin)` group with ≥ 2 rows, look at `make`,
`model`, `year` across the rows:

- **Matching make/model/year** → genuine same-car duplicate. Common
  causes: same customer intake-d twice, ownership change written as a
  new Vehicle row, plate-collision fall-through under slice 5's
  non-blocking Case B. **Merge** — see the merge shape below.
- **Different make/model** → the VIN string was written to two
  physically different cars, which is only possible if one of the
  writes was an OCR chassis misread. **Do NOT merge** — merging
  moves JobCards from one physical car onto another, which is worse
  than the duplicate. Flag for manual correction (owner + advisor
  compare against paper Moulkia, one row gets its VIN nulled or
  edited to the correct chassis, the other stays).
- **Same make/model but wildly different `last_job_at`** and one row
  has `job_count = 0` — that's the leftover-fixture / dead-intake
  case; the empty row can be deleted after eyeballing.

## Merge plan — PLACEHOLDER

Waiting on the Query A + A' readouts to fill this in. The plan
depends on:

1. **How many** dupe groups exist.
2. **What share are same-make/model** (mergeable) vs different
   (OCR-misread, don't merge).
3. **Which row survives** in the mergeable groups — my default is:
   the row with the highest `job_count`, ties broken by the earliest
   `createdAt`. Preserves the most history in place.

Once we know 1–3, the plan spells out:

- The atomic merge SQL: repoint `JobCard.vehicleId`, `Reminder.vehicleId`,
  `PurchaseOrderLine.vehicleId` (snapshot column; do NOT repoint, it's a
  historical record — carry-over note), any other `vehicleId` FKs
  the schema exposes.
- What to do about the losing row's `Customer` FK if it differs from
  the survivor's — my default is to leave the losing Customer's row
  intact (keeps their other cars intact) and record the ownership
  change as a `VehicleOwnershipTransfer` row (slice 2 introduces
  that table).
- Plate history: any distinct plate across the merged rows becomes a
  `VehiclePlateHistory` row on the survivor (slice 2 also introduces
  that table). Slice 1a's SQL will emit them as INSERTs, not update
  the current-plate cache — that's the survivor's plate.

Do NOT run the merge until this section is filled in and reviewed.

## Normalisation backfill — runs before the slice 1 index add

Independent of the merge: slice 1a also owns backfilling the
`vin`, `phone`, and `plate` columns to their normalised forms so
existing rows behave like slice-5 writes.

```sql
-- Normalisation backfill. Run AFTER any merges (so we don't fight
-- unique conflicts mid-backfill) and BEFORE slice 1's partial unique
-- index on (garageId, vin). Wrap in a transaction.
BEGIN;

-- VIN: strip anything not [A-Za-z0-9], uppercase.
UPDATE "Vehicle"
SET vin = UPPER(REGEXP_REPLACE(vin, '[^A-Za-z0-9]', '', 'g'))
WHERE vin IS NOT NULL
  AND vin <> UPPER(REGEXP_REPLACE(vin, '[^A-Za-z0-9]', '', 'g'));

-- Plate: strip whitespace and dashes, uppercase.
UPDATE "Vehicle"
SET plate = UPPER(REGEXP_REPLACE(plate, '[\s\-]', '', 'g'))
WHERE plate <> UPPER(REGEXP_REPLACE(plate, '[\s\-]', '', 'g'));

-- Phone (UAE): strip spaces / parens / dashes / plus, then drop a
-- leading 00971 → 971 → 0 in that order. Same rule as
-- normalizeUaePhone() in src/lib/normalize.ts. This one can collide
-- against the (garageId, phone) unique — see the pre-check below.
--
-- PRE-CHECK: if this query returns any rows, two Customers in the
-- same garage will collide after normalisation; resolve those first
-- (merge the customers or flag for manual review) before running the
-- UPDATE.
SELECT
    "garageId",
    -- same rule as normalizeUaePhone(); regex chain matches JS one.
    REGEXP_REPLACE(
        REGEXP_REPLACE(
            REGEXP_REPLACE(
                REGEXP_REPLACE(phone, '[\s()\-+]', '', 'g'),
                '^00971', ''
            ),
            '^971', ''
        ),
        '^0+', ''
    ) AS norm_phone,
    COUNT(*) AS collides,
    array_agg(id) AS customer_ids
FROM "Customer"
GROUP BY "garageId", norm_phone
HAVING COUNT(*) > 1;

-- If the pre-check is empty:
UPDATE "Customer"
SET phone = REGEXP_REPLACE(
    REGEXP_REPLACE(
        REGEXP_REPLACE(
            REGEXP_REPLACE(phone, '[\s()\-+]', '', 'g'),
            '^00971', ''
        ),
        '^971', ''
    ),
    '^0+', ''
)
WHERE phone <> REGEXP_REPLACE(
    REGEXP_REPLACE(
        REGEXP_REPLACE(
            REGEXP_REPLACE(phone, '[\s()\-+]', '', 'g'),
            '^00971', ''
        ),
        '^971', ''
    ),
    '^0+', ''
);

COMMIT;
```

## Phase-2 note — vehicle lookup is per-branch, not per-company

`Vehicle.customerId → Customer.garageId` is the ownership chain, and
`garageId` in the schema represents a **branch**, not a company
(`Garage.branchOfId` self-relation, per-branch billing / staff /
WhatsApp per AGENTS.md Key Decision #8). Phase 1 is single-branch so
this doesn't bite; Phase 2 turns it into a duplicate-per-branch bug
the moment two branches under one company see the same physical car.

When Phase 2 lands:

- Every vehicle lookup that today filters `customer: { garageId: X }`
  should widen to `customer: { garageId: { in: branchesOf(X) } }` or
  equivalent — the set of branches under the same parent company.
- The partial unique index this slice adds should be scoped to
  company, not branch — i.e. `(companyId, vin)` where `companyId =
  COALESCE(branchOfId, id)`. Requires a `companyId` column or a
  computed helper; deferred to whichever slice ships Phase-2
  multi-branch first.
- Reminders / job history read paths already follow VIN via
  `Vehicle.customerId → Customer.garageId`; widening the lookup at
  those points keeps history discoverable across branches of the
  same shop.

Not fixing this in slice 1a — it's a Phase-2 concern. Recording so it
isn't lost when multi-branch ships.

## Related

- `src/lib/normalize.ts` — the write-side helpers slice 5 landed. Same
  rules are encoded in Query A' and the backfill SQL above so the
  DB and the app converge on identical canonical forms.
- `docs/intake-duplicate-handling-spec.md` — parent spec, includes
  slice ordering (5 → 1a → 1 → 3 → 2 → 4 → 6 → 7) and the
  disambiguation-panel design.
- `src/app/actions/intake-moulkia.ts` — `createCustomerVehicleJobAction`,
  `plateLookupAction`. The read paths this doc's backfill has to keep
  working.
