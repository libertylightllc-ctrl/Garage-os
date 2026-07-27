# WhatsApp Click-to-Share — Design & Decisions

**Status:** design locked, not built.
**Owner:** AR.
**Author of this spec:** captured from an investigation on 2026-07-19.

Purpose: replace API auto-send with a **click-to-share** button on every
customer-facing outbound point. Advisor taps the button, THEIR OWN WhatsApp
opens with a pre-filled message + signed `/c/*` link, they hit Send. The
message goes from the garage's own phone number. No Meta Cloud API call,
no token, no mock.

This document freezes the investigation findings and the locked decisions so
the intent doesn't evaporate between sessions.

---

## 1. Send-point map — where "send" happens today

`sendWhatsApp()` fires from **eight** callsites. **Five** are customer-facing
outbound (this spec's scope). Three are internal (out of scope — stay on the
API path).

### 1.1 Customer-facing (in scope — get share buttons)

| # | File:line | Trigger | Body | `/c/*` link |
|---|---|---|---|---|
| 1 | `src/app/actions/billing.ts:379` | `setEstimateStatusAction` → status flips to `SENT` | inline string | `/c/estimate/<signed>` |
| 2 | `src/app/actions/billing.ts:~876-891` (`sendInvoiceToCustomerAction`) | Cashier "Send invoice" button | `invoiceMessage()` template | `/c/invoice/<signed>` |
| 3 | `src/app/actions/delivery.ts:51` | `markDeliveredAction` → tech marks delivered | inline string | `/c/delivery/<signed>` |
| 4 | `src/app/actions/jobs.ts:605` | `nudgeCollectionAction` (ready-for-collection nudge) | inline string + optional invoice link | optional `/c/invoice/<signed>` |
| 5 | `src/app/actions/reminders.ts:66` | `sendReminderAction` (maintenance reminder) | `reminderBody()` localized | — none — |

**Point 2 is already partially migrated.** `src/app/invoices/[id]/page.tsx:180-201`
renders a `SendViaWhatsAppButton` beside the API path. That's the pattern to
copy on points 1, 3, 4, 5.

### 1.2 Internal (out of scope — API path stays)

| File:line | Purpose |
|---|---|
| `src/app/actions/chat.ts:46, 72` | Advisor's manual reply on `/advisor/chats/[id]` |
| `src/lib/receptionist-engine.ts:96, 114, 121` | AI auto-reply (BOT mode) |

These need the real `sendWhatsApp()` path to persist message history in
`WhatsAppThread`/`WhatsAppMessage` and to reply into an active conversation.
A human "click to share" doesn't fit — the AI reply engine has no human to click.

---

## 2. Locked decisions

Decisions taken by AR on 2026-07-19. All future work on this feature must
respect these unless AR explicitly reverses.

### 2.1 Coexistence rule — Option C (share primary, API dormant for customers)

- **Customer-facing (5 points):** default is the share button. Remove the
  auto-firing `sendWhatsApp()` call from the corresponding server action.
- **Internal (chat replies + AI auto-reply):** `sendWhatsApp()` stays intact.
  No behavior change.
- `sendWhatsApp()` stays a **usable primitive** — not deleted. Two-way chat
  history in `WhatsAppThread`/`WhatsAppMessage` continues to work for
  inbound conversations. A future per-garage toggle to re-enable API auto-send
  on the 5 customer-facing points is additive (not part of v1).

### 2.2 Status flip — Shape 1 (optimistic on tap)

Tapping the share button both opens WhatsApp AND flips the entity's status
server-side.

- Estimate: `DRAFT → SENT`, stamps `sentAt = now()`.
- Invoice: sets `sentAt` (invoice status model unchanged).
- Delivery: sets the delivery-sent flag matching current API-path behavior.
- Nudge / reminder: writes the same `WhatsAppMessage` row the API path would
  have written, so history is preserved.

The advisor's tap IS the commit. If the advisor cancels inside WhatsApp:
they revert to `DRAFT` on the estimate editor. Two-tap safety belt not built —
observed pilot behavior can pivot this to Shape 2 later without a schema
change.

**No new enum values. No schema change.**

### 2.3 Templates — 4 new + 1 existing

Add to `src/lib/wa-templates.ts` mirroring the existing `invoiceMessage()`
shape (both `en` and `ar` outputs, appUrl as input param):

- `estimateMessage({ customer, vehicle, total, estimateLink, lang, appUrl })`
- `deliveryMessage({ customer, vehicle, confirmLink, lang, appUrl })`
- `readyForCollectionMessage({ customer, vehicle, invoiceLink?, lang, appUrl })`
- `reminderMessage({ customer, vehicle, reminderType, dueDate, lang })` —
  no `/c/*` link (matches current inline body in `reminders.ts`)

`invoiceMessage()` stays as-is.

### 2.4 Phone normalization — reuse existing

`src/lib/wa.ts:28-61` (`normalizeToE164`) already handles:
- `+971509633280` → `971509633280`
- `00971509633280` → `971509633280`
- `0509633280` (UAE local, default country `971`) → `971509633280`
- Rejects <8 or >15 digit results as `null`

`buildWaMeUrl(phoneE164, text)` at `wa.ts:68` produces the `wa.me` URL.
No changes.

### 2.5 Button component — reuse existing

`src/components/SendViaWhatsAppButton.tsx` handles the disabled state when
phone is unparseable. Same component on all 5 points. Existing invoice-page
wiring at `src/app/invoices/[id]/page.tsx:180-201` is the reference
implementation.

### 2.6 Resend is free — the share button persists past `SENT`

The share button is **not a one-shot**. On estimate, invoice, delivery, and
reminder pages the button stays visible after status flips to `SENT` /
`sentAt` is stamped. Every tap re-opens WhatsApp with the same drafted body.

**This IS the resend feature.** No separate "Resend" action, no separate
route, no separate history model. A customer who lost the WhatsApp message,
switched phones, or asked "can you send the link again?" — the advisor
opens the same page and taps the same button.

- **Label adapts** to `sentAt` state on the record:
  - `sentAt` null → **"Send via WhatsApp"**
  - `sentAt` set → **"Resend"** (i18n key `waResend`; ar: `إعادة الإرسال`)
- Same button component (`SendViaWhatsAppButton`), same underlying share
  action. Only the label prop differs.
- On a resend tap, the server action:
  - Does NOT re-flip status (already `SENT`).
  - DOES update `sentAt = now()` so the "last shared" timestamp is honest.
  - DOES write a new `WhatsAppMessage` history row so `/advisor/chats` and
    the timeline show every share attempt.
- **The signed `/c/*` link is stable across resends.** `signId(kind, id)`
  in `src/lib/wa-signing.ts` is deterministic on the record id — a resent
  link is byte-identical to the original. The customer can open whichever
  message they still have; both point to the same live URL.

Applies uniformly on all four customer-facing surfaces (estimate, invoice,
delivery, reminder). Nudge collapses into "resend the invoice from the job
page" — see §3.1 for how nudge's own surface treats this.

### 2.7 `APP_URL` still matters

The `/c/*` link inside the pre-filled body is still built from `appUrl()`
in `src/lib/whatsapp.ts:7-9`. Customer taps the link in their WhatsApp →
lands on `APP_URL/c/estimate/<signed>`. Wrong `APP_URL` → unprofessional URL.
Fix is orthogonal to this feature (see separate `APP_URL` env change).

---

## 3. Wire-up — 5 pages, 4 actions, 4 templates

### 3.1 Pages that gain a `SendViaWhatsAppButton`

| Send point | Page | Notes |
|---|---|---|
| Estimate | `/advisor/estimates/[id]` (and cashier's `/estimates/[id]` view) | Button appears once estimate has ≥1 line and a resolvable phone. Stays visible after `SENT`; label swaps to "Resend" (§2.6). |
| Invoice | `/invoices/[id]` | ✅ ALREADY wired. Extend for label-swap on `sentAt` set. Stays visible after send. |
| Delivery | `/technician/jobs/[id]` (or the delivery subroute) | Button appears once job is at `READY_FOR_COLLECTION`. Stays visible; label swaps after first share. |
| Nudge | Wherever `nudgeCollectionAction` is currently triggered | Under the resend model, "nudge" is just a resend of the invoice link from the job's collection surface. The dedicated nudge button collapses into "Resend invoice" on that page. Confirm with AR at build time whether to keep nudge as a separate labelled button or fold it entirely. |
| Reminder | `/advisor/reminders/*` list rows | Button per row. Stays visible after first send; label swaps to "Resend". Reminder rows don't carry a signed `/c/*` link today — resend rebuilds the same body text. |

### 3.2 Server actions that stop auto-sending on tap

Remove the `sendWhatsApp()` call. Keep every other side effect (status
flip, `sentAt` stamp, `WhatsAppMessage` row write, timeline entry):

- `setEstimateStatusAction` — keep the status flip, DROP the auto-send.
  Add a `stampEstimateSharedAction(estimateId)` (or reuse the same action)
  invoked by the share button on tap.
- `sendInvoiceToCustomerAction` — already has both paths on the invoice
  page; DROP the auto-send from this action (or gate it with a flag).
- `markDeliveredAction` — keep the delivery-flag update, DROP the auto-send.
  Move the send to a new `shareDeliveryLinkAction`.
- `nudgeCollectionAction` — DROP the auto-send. Replace with
  `shareCollectionNudgeAction` invoked by the button.
- `sendReminderAction` — DROP the auto-send. Replace with
  `shareReminderAction`.

Every "share*" action writes a `WhatsAppMessage` row with
`status = "PENDING"` or a new `"SHARED"` status marker so the timeline can
still say "shared with customer at HH:MM".

### 3.3 Templates to add

In `src/lib/wa-templates.ts`, mirror `invoiceMessage`'s function signature
+ en/ar branches. ~15 LOC per template. ~60 LOC total.

---

## 4. Preconditions before building

**Do NOT start this feature until:**

1. `APP_URL` is set to the canonical `https://garageos.shop` on Vercel prod.
   Otherwise every share-link built by the new templates carries the
   preview host and looks like phishing to the customer.
2. The 4 estimate/delivery/nudge/reminder templates exist and are unit-tested
   in `src/lib/__tests__/wa.test.ts` alongside the existing `invoiceMessage`
   test.
3. AR is fresh — this is a real feature, not a tail-of-session task.

---

## 5. Definition of done

- Every one of the 5 send points renders a `SendViaWhatsAppButton` when a
  parseable phone exists, disabled with a hint otherwise.
- Tapping opens WhatsApp (via `wa.me`) with the drafted message pre-filled.
- The tap commits the status flip / `sentAt` / `WhatsAppMessage` history row
  server-side (Shape 1 optimistic).
- **Button persists past `SENT`** on all 4 customer-facing surfaces
  (estimate, invoice, delivery, reminder). Label reads "Send via WhatsApp"
  when `sentAt` is null, "Resend" when set (§2.6).
- **Resend does NOT re-flip status** but DOES update `sentAt = now()` and
  write a new `WhatsAppMessage` history row.
- Resent `/c/*` link is byte-identical to the first send (deterministic
  `signId`) — verified with a unit test that calls `signId` twice on the
  same record and asserts equality.
- Removing the `sendWhatsApp()` call from the 5 customer-facing actions
  does NOT break chat replies (`chat.ts`) or the AI receptionist
  (`receptionist-engine.ts`) — both keep working via the surviving primitive.
- Unit tests cover: templates output correct en+ar bodies; the tap-driven
  share action writes the expected message-history row.
- Human click-through on all 5 points from the advisor's phone.
- `wa.test.ts` extended with template tests.
- `permissions.ts` unchanged — button visibility follows existing
  `SEND_ROLES`.

---

## 6. Explicitly out of scope

- Any change to `chat.ts` or `receptionist-engine.ts`. AI reply stays on API.
- Any Meta Embedded Signup or per-garage WhatsApp connect UI change. That
  path stays for future use.
- Two-way inbound messaging via `wa.me` — impossible by design; inbound
  still requires the API + webhook (which is why `sendWhatsApp` survives).
- A "mark as sent" confirmation button (that's Shape 2 — deferred).
- A `SENT_DRAFTED` intermediate status (that's Shape 3 — deferred).
- Bulk-share for reminders (crawl through 20 due reminders in one go).
  v1 is one-at-a-time.
- A separate "Resend" mechanism, dedicated action, or resend-history model.
  Resend IS the same share button with an adaptive label (§2.6). If a shop
  later asks for "how many times did we resend this?", it's a count query
  on `WhatsAppMessage` for that record — no schema change.
