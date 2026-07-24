# Upload validation gap — three saveUpload call sites need magic-byte validation

Discovered 2026-07-24 while considering an `.svg` MIME addition to
`CONTENT_TYPES` for a fixture. Not built tonight — this doc captures the
attack path + fix shape so the work isn't lost.

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
