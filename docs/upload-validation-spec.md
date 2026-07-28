# Upload validation gap — CLOSED 2026-07-29

Discovered 2026-07-24 while considering an `.svg` MIME addition to
`CONTENT_TYPES` for a fixture. Fixed 2026-07-29 — see the "Fix as
shipped" section at the end. The rest of this document remains as the
threat-model record so the "why" survives if someone considers relaxing
the closure later.

## Current state

Logo uploads via `saveLogoUpload()` go through `validateLogoFile()` in
`src/lib/storage.ts:170-209`:

- 500 KB size cap
- MIME allowlist: `["image/png", "image/jpeg", "image/webp"]`
- Magic-byte sniff on the first 12 bytes (PNG / JPEG / WEBP signatures)
- Rejects `MIME_MISMATCH` when the header claims one thing and the
  bytes say another

Comment above the allowlist is explicit: **"SVG is excluded for
stored-XSS safety."**

Invoice OCR uploads via `parts-import.ts` also validate — same shape,
larger size cap (`validateInvoiceImage`).

## The gap

Three call sites use the raw `saveUpload()` helper **without any
validation** before writing:

| File | Line | What it uploads |
|---|---|---|
| `src/app/actions/intake.ts` | 37 | Intake photo (Moulkia / vehicle condition) |
| `src/app/actions/jobs.ts` | 579 | Tech job photo |
| `src/app/actions/techsteps.ts` | 52 | Tech-step photo |

`saveUpload()` writes whatever's handed to it. The header comment at
`storage.ts:105-106` calls this out:

> Logos run through validateLogoFile() before write; **the legacy
> saveUpload() trusts its caller.**

Those three callers don't check anything. Any authenticated advisor,
tech, or master role can upload arbitrary bytes with an arbitrary
extension, and the file lands in `.uploads/` (dev) or the private
Supabase bucket (prod).

## Attack path

The `/api/files/[name]` route serves whatever is in `.uploads/` with a
MIME derived from the file extension via `CONTENT_TYPES`. Today `.svg`
is NOT in `CONTENT_TYPES`, so any `.svg` uploaded via the unvalidated
`saveUpload` sites is served as `application/octet-stream` — the
browser downloads it as an opaque blob rather than rendering it. That
octet-stream fallback is the current mitigation.

**If `.svg` were added to `CONTENT_TYPES` while these three call sites
remain unvalidated:**

1. Attacker with any advisor / tech / master account uploads an SVG
   containing `<script>alert(document.cookie)</script>` disguised as a
   car photo through `intake.ts` or `techsteps.ts`.
2. File lands in `.uploads/attack.svg` (or the corresponding Supabase
   key).
3. Attacker sends the `/api/files/attack.svg` link to another user —
   or waits for a job-detail listing page to render it directly (any
   deep-linkable surface will do).
4. Victim opens the link (not through an `<img>`, but directly —
   clicking a link, opening in a new tab).
5. SVG loads as a **document**, and the `<script>` executes in
   `localhost:3000` (dev) or the app's prod domain — **same-origin
   stored XSS**.
6. Cookies stolen, cross-tenant DB reads via the acting session's
   `garageId`.

Note the origin distinction:
- Dev: `/api/files/*` is same-origin with the app.
- Prod: Supabase public bucket is `supabase.co` (cross-origin), so SVG
  script execution is scoped to `supabase.co`, not the app. Dev is the
  higher-risk surface for this class.

## Fix shape

Add a lightweight image validator to each of the three call sites —
same magic-byte discipline as `validateInvoiceImage`:

```ts
// src/lib/storage.ts
export async function validateGenericImage(file: File): Promise<void> {
  if (file.size === 0) throw new LogoValidationError("EMPTY", "…");
  if (file.size > INVOICE_MAX_BYTES) throw new LogoValidationError("TOO_LARGE", "…");
  if (!LOGO_ALLOWED_MIME.includes(file.type as (typeof LOGO_ALLOWED_MIME)[number])) {
    throw new LogoValidationError("BAD_MIME", "…");
  }
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const sniffed = sniffImageType(head);
  if (sniffed === null) throw new LogoValidationError("BAD_MAGIC", "…");
  if (sniffed !== file.type) throw new LogoValidationError("MIME_MISMATCH", "…");
}
```

Then call it before each `saveUpload`:

```ts
// intake.ts:37
if (photo instanceof File && photo.size > 0) {
  await validateGenericImage(photo);
  photoUrls.push(await saveUpload(photo, garageId));
}
```

Same pattern for `jobs.ts:579` and `techsteps.ts:52`.

## Tests worth writing

- Upload a PNG with a JPEG magic byte → `MIME_MISMATCH`.
- Upload an SVG with `image/png` MIME → `BAD_MAGIC`.
- Upload a valid PNG → succeeds.
- Upload a 20 MB PNG through intake → `TOO_LARGE`.
- Upload an empty file → `EMPTY`.
- All three actions error-map to friendly messages via existing
  `LogoValidationError` handling.

## After the fix ships

Only then reconsider adding `.svg` to `CONTENT_TYPES`. Even then the
threat model needs a second look:

- SVG `<script>` is blocked when the file is loaded via `<img>`, but
  executes when navigated to as a document. Serving SVG via
  `/api/files/*` invites the latter shape (any URL the user can click).
- A stricter mitigation: strip `<script>` from SVG server-side on
  upload, and set `Content-Disposition: inline; filename="…"` +
  `Content-Security-Policy: sandbox` on responses.
- Simpler mitigation: don't accept SVG at all. Every case where we
  need a scalable logo can be handled by a large-enough PNG.

## Not building tonight

- Add `validateGenericImage`.
- Wire it into the three unvalidated call sites.
- Add tests per the list above.
- Reconsider SVG only after those land.

## Fix as shipped (2026-07-29)

- `validateImageUpload(file, {maxBytes})` in `src/lib/storage.ts`. Same
  magic-byte discipline as `validateInvoiceImage`; SVG cannot pass
  because `sniffImageType` only accepts PNG/JPEG/WEBP.
- Two size caps: `PUBLIC_INTAKE_PHOTO_MAX_BYTES = 5 MB` for the
  unauthenticated `createBookingPublic` surface; `AUTH_PHOTO_MAX_BYTES
  = 8 MB` for the authenticated tech/advisor flows. Regression-pinned
  by a test that fails if `PUBLIC_INTAKE_PHOTO_MAX_BYTES` ≥
  `AUTH_PHOTO_MAX_BYTES`.
- All three call sites wired:
  - `intake.ts:37` — public path maps `LogoValidationError` to a
    user-facing `"Booking photo rejected: …"` error instead of a
    stack trace.
  - `jobs.ts:579` and `techsteps.ts:52` — throw-through per existing
    action pattern.
- Serve-route hardening in `src/app/api/files/[name]/route.ts`
  (defence-in-depth):
  - Extension allowlist first → 404 on miss. SVG explicitly excluded.
    Kills the "one PR later adds `.svg` to `CONTENT_TYPES`" regression
    path: the route refuses SVG regardless of what `CONTENT_TYPES`
    says.
  - `X-Content-Type-Options: nosniff` on every response — blocks
    browsers from re-classifying an `image/*` response as `text/html`.
  - `Content-Disposition: inline` for images (advisor + tech workflows
    depend on `<img src="/api/files/…">` rendering), `attachment` for
    audio (top-level nav downloads rather than attempting to render).
- Tests: `src/lib/__tests__/upload-validation.test.ts` (10 assertions
  covering happy path, five reject codes, size-cap invariant, error
  shape, and the structural "URL never contains the client filename"
  pin) + `src/app/api/files/[name]/__tests__/route.test.ts` (9
  assertions covering the extension allowlist, disposition switch,
  nosniff header, and path-traversal).

## What still isn't done

- **Prod data audit** — the audit script (`scratchpad-audit-uploads.ts`
  during dev, deleted before commit) could not connect to prod
  (`.env` credentials returned auth failure at time of fix). Local
  dev DB had 0 non-allowlisted extensions across `Booking.photoUrls`
  + `JobStep.photoUrl`. The prod audit remains an operator task —
  paste the same SQL against prod and confirm the row counts before
  assuming this is prevention-only.
- SVG is still not accepted. That's the point — the "reconsider adding
  SVG" line from the original section above should stay parked unless
  a real requirement lands. Every case seen so far can be handled by
  a large-enough PNG.
