# GarageOS — PWA & Device Setup Spec (for Claude Code)

Goal: make the existing Next.js web app installable on garage/technician devices as a Progressive Web App (PWA) — no app store, no native build. Plus the small onboarding pieces that make first-garage setup smooth.

---

## Why PWA, not native apps

- No download, no Apple/Google approval, no per-device updates.
- One URL (e.g. `app.garageos.ae`); fix a bug once, every device gets it.
- "Add to Home Screen" makes it open fullscreen with an icon, like a real app.
- Customers install nothing — they stay on WhatsApp.

Do NOT build native iOS/Android apps at this stage. Revisit only if deep device features are ever needed.

---

## Task 1 — Make the app a PWA

Hand this to Claude Code:

> Make the Next.js app a Progressive Web App. Add:
> 1. A web app manifest (`manifest.json` / Next metadata) with: name "GarageOS", short_name "GarageOS", theme + background colors matching our design system, display "standalone", and icons at 192px and 512px (maskable).
> 2. A service worker that caches the app shell so the app at least OPENS when the connection drops (offline shell, not full offline sync).
> 3. Verify it passes the browser "installable" check (Chrome → installable; Lighthouse PWA pass).
> Plan first, then implement. Don't build offline data sync — only the offline app shell.

**Acceptance:** On a budget Android in Chrome, the browser offers "Install app"; after install it opens fullscreen with the GarageOS icon; opening it with wifi off still shows the app shell (not a dead page).

---

## Task 2 — In-app "Add to Home Screen" prompt

Garage owners won't know they can install it unless you tell them.

> Add an "Install GarageOS" prompt for logged-in users on mobile:
> - On Android/Chrome: capture the `beforeinstallprompt` event and show a custom "Add GarageOS to your home screen" button that triggers it.
> - On iPhone/Safari (no install event): show simple instructions — tap Share → "Add to Home Screen".
> - Show it once, let users dismiss it, don't nag. Store dismissal in app state (not localStorage in artifacts; in the real app, a user setting/cookie is fine).
> Plan first.

**Acceptance:** A logged-in user on Android sees a working install button; on iPhone sees correct Safari instructions; dismissing it stops it reappearing.

---

## Task 3 — Shared-device technician login

Reality: one shared tablet on the workshop floor, not one phone per technician.

> Make the technician view work for a SHARED device:
> - Support a generic technician login that stays signed in on the floor tablet (long session, no forced logout).
> - Technician actions (photo, voice note, finish task) should optionally let the tech tag who did it via a quick tap-list of names, NOT a full re-login each time.
> - Keep the technician screen to large buttons, max 3 actions, no typing required.
> Plan first. Don't build per-technician accounts/passwords for the floor — that's over-engineering for now.

**Acceptance:** A floor tablet stays logged into technician mode across a day; a tech can attribute a photo/note to themselves with one tap.

---

## Task 4 — New-garage setup (admin)

So YOU can stand up a garage in ~15 minutes in person.

> Add an admin onboarding flow (for me, the operator) to create a new garage fast:
> - Create garage: name, logo upload, VAT number, country (UAE).
> - Add their services + prices in bulk (a simple repeatable list, not one-at-a-time forms).
> - Create the owner account + one shared technician login.
> - Set `isPilot = true` so they're not billed.
> - Generate the login link to hand them.
> Plan first.

**Acceptance:** From a blank state, I can create a fully usable garage (logo, services, accounts, login link) in under 15 minutes without touching the database directly.

---

## Known limitation to watch in pilots (do NOT build yet)

**Full offline sync** (work with no internet, sync later) is a real, separate engineering project. The offline *shell* (Task 1) only makes the app open, not function, offline. Most GCC garages have at least mobile data. Watch whether bad workshop wifi actually blocks technicians during pilots. Build true offline sync ONLY if real garages hit the wall. Premature offline-sync work could cost weeks for a problem you may not have.

---

## Device cheat-sheet

| Person | Device | How they get it | Installs? |
|---|---|---|---|
| Owner / Advisor | Own phone + front-desk PC | URL + login, add to home screen | PWA (you set up) |
| Technician | Shared floor tablet/phone | URL + shared tech login, add to home screen | PWA (you set up) |
| Car owner | Own phone | WhatsApp messages + links | Nothing — never |
