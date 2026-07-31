# Intake action — plate / phone collision handling

Report generated 2026-07-24 while pausing before the header-sweep push, in
response to a `PrismaClientKnownRequestError` / `UniqueConstraintViolation`
on `POST /advisor/jobs/new/confirm?via=moulkia&…`. Not yet approved to
build — Case B needs a UX decision (see below). This doc captures the
problem shape so the analysis isn't lost.

## Source of truth

- Intake action lives under `src/app/advisor/jobs/new/**` (confirm page +
  action; not touched by any current commit).
- Schema (verified 2026-07-30 against `prisma/schema.prisma`):
  - `Customer @@unique([garageId, phone])`
  - `Vehicle` — **no `@@unique`**, only `@@index([customerId])`. Duplicate
    plates in the same garage are allowed by the schema; the intake action
    is the only line of defence. (Earlier revisions of this doc claimed
    `Vehicle @@unique([garageId, plate])` — that was wrong and had already
    been dropped from schema.prisma; corrected here so the branching logic
    isn't designed around a constraint that doesn't exist.)
  - `JobCard @@unique([garageId, number])`

## What happens today

The intake action on `POST /advisor/jobs/new/confirm` inserts the
Customer + Vehicle + JobCard optimistically. If either row already
collides on its unique constraint (Customer phone or Vehicle plate),
Prisma throws `UniqueConstraintViolation`, the server returns 500, and
the dev overlay surfaces it. **No recovery path is offered to the
advisor** — the OCR-decoded form data is stuck on the confirm screen,
and re-submitting will keep failing until they either change the
plate/phone manually or someone touches the DB.

## The real cases this needs to handle

There are three normal-path collisions, not one:

### Case A — Repeat customer, same car

Plate matches an existing Vehicle whose Customer matches the phone.

Correct behaviour: **skip both inserts, create a new JobCard on the
existing Vehicle**, then land on the assigned-advisor screen the same
way a plate-lookup entry does. Should probably route through the same
code path as the "Or pick an existing vehicle" tile — the OCR is a
fancier prefill for the same underlying action.

### Case B — Existing plate, DIFFERENT customer

Plate matches an existing Vehicle but the phone doesn't match its
owner. Two sub-cases:

- **Vehicle was sold.** Update the existing Vehicle's owner (this maps
  to the "vehicle sold → advisor can edit owner name + mobile" rule in
  `AGENTS.md` Key Decision #7).
- **Data-entry error.** Advisor typo'd the plate. Reject with a clear
  "This plate belongs to X, not Y — did you mean a different plate?"
  message.

The action **cannot tell these apart automatically**. This is a UX
problem, not just an action problem. Needs a confirm-or-cancel step
before either write. **AR's UX decision pending.**

### Case C — Existing phone, DIFFERENT plate

Customer already has an account (maybe from a booking or another car).

Correct behaviour: **upsert the Customer, insert the new Vehicle under
that same Customer**. Smooth path, no prompt needed.

## Shape of the fix (design sketch — not code)

Pre-flight lookup before writes:

1. Given `(plate, phone)` from the confirm form:
2. `existingVehicle = Vehicle.findFirst({ plate, customer.garageId })`
3. `existingCustomer = Customer.findFirst({ phone, garageId })`
4. Branch:
   - `existingVehicle && existingCustomer && existingVehicle.customerId === existingCustomer.id`
     → **Case A**: skip inserts, just create the JobCard.
   - `existingVehicle && existingCustomer && existingVehicle.customerId !== existingCustomer.id`
     → **Case B**: redirect to disambiguation surface, no writes.
   - `!existingVehicle && existingCustomer`
     → **Case C**: insert Vehicle under existingCustomer, then JobCard.
   - `!existingVehicle && !existingCustomer`
     → today's default path, insert everything fresh.
   - `existingVehicle && !existingCustomer`
     → shouldn't happen (Vehicle → Customer FK), but if the phone
     changed since the last intake, treat as Case B — plate exists
     under someone else.

## Open UX decisions (blocking the build)

1. **Case B disambiguation surface shape** — two options:
   - **In-page confirm modal** on the confirm screen listing the
     current owner + "Update owner" and "Cancel" buttons.
   - **Separate wizard step** at
     `/advisor/jobs/new/existing-vehicle/[vehicleId]` with the existing
     details rendered and a single decision. Leans toward this: makes
     the choice explicit and creates a natural place to enforce the
     "vehicle sold → capture consent" bit `AGENTS.md` flags for Moulkia.
2. **Confirmation copy** for the "vehicle sold" branch — needs consent
   language per Key Decision #7 in `AGENTS.md`.
3. **Case A visible feedback** — silently skipping inserts is
   technically correct but the advisor might not realise the OCR path
   just landed on an existing car. Consider a "Same car as JC-YYYY-NNNN"
   caption on the resulting JobCard.

## Tests worth writing before shipping

- Same customer, same plate → JobCard on existing Vehicle, no new
  Customer/Vehicle rows.
- New customer, same plate → disambiguation surface, no writes.
- Existing customer, new plate → new Vehicle under existing Customer,
  no duplicate Customer.
- Fully new customer → all three rows fresh.
- Moulkia OCR path (`via=moulkia`) replays the same branching.

## Not building until AR resolves

- The Case B UX shape (in-page modal vs. wizard step).
- Case A caption / feedback shape.
- Consent-capture copy for the "vehicle sold" branch.

Commit strategy when the go-ahead comes: one commit for the action's
branching + pre-flight lookup (Cases A + C + no-op default), a second
commit for the Case B disambiguation surface, tests alongside each.

### Landmine to defuse in commit 2 — the existing "Repeat customer" flow

The `plateLookupAction` + confirm form's `vehicleId` branch that today
handles "advisor picks an existing vehicle" runs `tx.customer.update({
where: existing.customerId, data: { name, phone, email } })` — it
MUTATES the previous owner's Customer row in place. That's fine for a
returning customer whose contact info changed, but it's data-corruption
if used to "reassign" a sold car: every OTHER row attached to the
previous Customer (their other cars, bookings, reminders, ledger) now
silently claims to belong to the new owner.

Commit 2's "Update owner" button MUST do a real reassignment:
  1. Find-or-create a Customer with the new phone under this garage.
  2. Move the Vehicle's `customerId` FK to that (new or matching) Customer.
  3. Leave the previous Customer's row and all of its other relations
     untouched. Consider capturing the ownership change as an audit row
     (a new `VehicleOwnershipChange` table, or reusing `AiEvent` /
     similar) so history remains queryable.

This is the reason the banner in commit 1 was softened to remove the
"use the existing-vehicle flow" pointer — that flow will corrupt data
if used for a sold-vehicle case.

## Slice ordering

Recorded here as the parent spec so downstream slice specs
(`vin-duplicate-audit-and-merge-plan-spec.md` etc.) can cross-reference
one place. Order: **5 → 1a → 1 → 3 → 2 → 4 → 6 → 7**.

- **Slice 5** — write-side normalisation on plate / VIN / phone
  (shipped `fe7e061`). Non-blocking Case B banner + VIN+phone shortcut.
- **Slice 1a** — VIN duplicate audit + merge plan + backfill. Deferred
  until there's real intake data to audit.
  See [vin-duplicate-audit-and-merge-plan-spec.md](vin-duplicate-audit-and-merge-plan-spec.md).
- **Slice 1** — partial unique index on `(garageId, vin)` where vin is
  not null. Blocked on slice 1a. Deferred with 1a.
- **Slice 3** — disambiguation panel on plate collisions (shipped
  `0551b05`, 2026-07-31). Four choices — same car/same owner, same
  car/owner changed, different car/same plate, wrong plate — with
  atomic writes and audit rows (`VehiclePlateHistory`,
  `VehicleOwnershipTransfer`). Replaces the hard-block from slice 5's
  Case B warning.
- **Slice 2** — wire plate history + normalisation into the remaining
  write paths that still bypass the intake action (booking → job-card
  promotion, `plateLookupAction`'s Case-A refresh, direct-vehicle
  metadata edits). Next slice.
- **Slice 4** — auto-plate-update on repeat intake when the customer
  brings the same car back with a new plate. Piggy-backs on slice 2's
  history table.
- **Slice 6** — find-vehicle search. See section below.
- **Slice 7** — public booking flag (`plateMatchesOtherCustomer`). See
  the createBookingPublic section further down.

## Slice 6 — Find-vehicle search

**Status:** not built. VIN-matching gap surfaced during slice-3
verification (2026-07-31) — recorded here so it's tracked, not left
as a session note.

### Today

`src/app/advisor/vehicles/page.tsx` matches a single `?q=` query
across three OR branches, all garage-scoped:

- `plate` — `contains: q`, case-insensitive
- `customer.name` — `contains: q`, case-insensitive
- `customer.phone` — `contains: <digits-only q>` when `q` has ≥ 3 digits

VIN is not searchable anywhere in the advisor UI. Detail pages fetch by
`id` only; the intake existing-vehicle picker at `/advisor/jobs/new`
lists every vehicle unfiltered.

### The gap slice 3 exposed

Slice 3's Choice 3 (different car — same plate) leaves the old
Vehicle with `plate: ""`. That vehicle stays findable by owner name
today — verified in the browser 2026-07-31 — but owner names drift
(rename, corporate rebadge, sale mid-repair). Once both plate and
current owner name have moved, VIN is the only stable identity left
on the row, and there's no UI to look it up. Every real garage
customer knows their VIN because it's stamped in the Moulkia they
already handed over at intake.

Related: fleet vehicles routinely rotate plates between cars, so
"search by current plate" ages out fastest of the three axes.

### Decision on record

**A plateless vehicle must be findable by VIN or owner name.** These
two together are the load-bearing lookup axes after slice 3 released
plate mutability. Plate stays as a search axis because it's the
common case, but slice 6 must not depend on it existing.

### What slice 6 adds

Extend the advisor-search OR with a VIN branch:

- Full-VIN match — `vin` equals the normalised query (17-char VIN
  input; already normalised at write time by slice 5's
  `normalizeVin`). Case-insensitive.
- Last-6-tail match — `vin` ends with the normalised query when the
  query is exactly 6 alphanumeric characters after normalisation.
  Covers the common case where the customer only remembers the last
  6 digits from their reg card.

Normalise the query the same way slice 5's helpers normalise writes,
so the compare is canonicalised on both sides.

### Cases the tests must cover

- Full VIN, exact match — finds it.
- Full VIN, mixed case + hyphens — finds it (normalisation).
- Last-6, matches one vehicle — finds it.
- Last-6, matches multiple vehicles in the same garage — returns all,
  advisor picks. No silent "first-match wins."
- Plateless vehicle (`plate: ""`) matched by VIN — returns it. This
  is the slice-3 regression guard.
- Cross-garage — VIN in another garage never leaks in.
- Legacy un-normalised VIN row (pre-slice-5 write) — currently
  won't match a normalised query. Note in the test that this is
  waiting on slice 1a's backfill; don't hard-fail the test today,
  but assert the match happens once the row is normalised.

### Open question — no undo path for Choices 2 and 3

Recorded 2026-07-31 after slice 3 shipped. Not building until real
intake data shows how often this bites.

Slice 3's atomic writes are one-way from the UI:

- **Choice 2** (same car, owner changed) — `Vehicle.customerId` moved
  and a `VehicleOwnershipTransfer` row written. If the advisor picked
  the wrong choice — the customer really was the same person, they
  just brought the car in on a different phone that day — the FK move
  stands. Nothing in the app rolls it back.
- **Choice 3** (different car, same plate) — old vehicle's plate
  blanked, its `VehiclePlateHistory` row closed, new Vehicle + fresh
  history row created. If the advisor picked this by mistake — it
  really was the same car and the plate had genuinely returned — the
  release stands, and the new plateless-old-vehicle now needs manual
  cleanup.

Both audit rows hold the previous state, so undo IS feasible:

- Choice-2 undo: read the most-recent `VehicleOwnershipTransfer` for
  the vehicle, move `customerId` back to `fromCustomerId`, delete the
  transfer row (or write a compensating "reverted" row — see below).
- Choice-3 undo: reopen the old vehicle's most-recent released
  `VehiclePlateHistory` row (clear `releasedAt` + `releasedByUserId`),
  restore `Vehicle.plate` from that history row's `plate` field, and
  delete the mistakenly-created new Vehicle + its plateHistory row +
  its JobCard.

Design questions to answer before building:

- **Delete the audit row, or keep it and add a compensating row?**
  Deleting is cleaner for the history query but loses the fact that
  the mistake happened. Compensating rows keep the audit trail honest
  but make "current owner" queries messier.
- **Who's allowed to undo?** Any advisor, only the one who made the
  original write, or owner-only? Time-limited (e.g. within the same
  shift)?
- **What if downstream state has moved on?** Choice-3's new Vehicle
  might have parts requested, an estimate priced, WhatsApp messages
  sent to the (wrong) new customer. Undo has to either cascade
  (delete all of that) or refuse (surface the block, tell the advisor
  what would have to be undone first).
- **UI surface.** Toast with an Undo link on the done page? An entry
  in the vehicle detail page's history section? Both?

Priority: park until we see the rate of Choice-2/3 mistakes in prod.
If it's < 1/month per shop, undo is a nice-to-have; if it's every
week, it moves up.

### Not in slice 6

- Public-facing search. Slice 6 is advisor-only.
- Fuzzy matching (Levenshtein / transposition). Exact + last-6 only.
- Merging duplicates found by VIN — that's slice 1a's job.
- Adding VIN to the intake existing-vehicle picker at
  `/advisor/jobs/new`. That list is unfiltered by design (pagination
  handles size); a separate VIN-search there is a slice-7+ concern
  if intake volume ever justifies it.

## Public intake — `createBookingPublic` (proposed, not built)

The public booking flow has the same silent-duplicate gap but no advisor
to disambiguate at the moment of intake. Chosen approach when the time
comes to build it: **flag it, don't block it.**

- Accept the booking as normal — customer flow never fails, never asks a
  question they can't answer.
- Add a boolean column on `Booking` (name it for what it observes, not
  what it means — e.g. `plateMatchesOtherCustomer`; a name like
  `plateCollision` breaks the moment the definition shifts).
- Set the flag at creation time when `(garageId, plate)` matches an
  existing Vehicle under a DIFFERENT customer. Do NOT set it when the
  match is under the SAME customer — that's a repeat customer, the
  good path; badging it would train advisors to ignore the badge.
- The `/advisor/bookings` list shows a "check owner" badge on flagged
  rows. Confirming that booking routes through the same disambiguation
  wizard commit 2 adds for the advisor path.

Two notes to carry forward when this is built:

1. **The flag is a snapshot, not a fact.** A collision can appear later
   (two customers book the same plate an hour apart; the first booking's
   flag was already false at write time). So the flag alone is not
   enough — the confirm-time action must ALSO recheck the collision
   before promoting a Booking to a JobCard, with the wizard as the real
   backstop. Flag catches most cases; flag + confirm-time recheck is
   complete.

2. **Name the column for what it observes, not what it means.** The
   business definition of "collision" may drift over time (does a match
   under the same customer's spouse count? what about a merged customer
   record?). `plateMatchesOtherCustomer` describes a query result, which
   is stable. `plateCollision` describes a judgment, which isn't.
