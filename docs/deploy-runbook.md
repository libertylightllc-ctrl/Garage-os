# Deploy runbook

**One page. Read before touching production.**

This complements the laptop-side guards shipped in commit `c6ba462`
(2026-08-10): `PROD_DATABASE_URL` rename, `next dev` refuses hosted
DBs, `prisma migrate dev`/`db push`/`migrate reset` refuse hosted.
Those protect production **from a laptop**. This runbook protects
production **from a merge**. Both are needed.

---

## Environments

| | Branch | Domain | DB (Supabase project) | Purpose |
|---|---|---|---|---|
| **Staging** | `main` | Vercel auto-alias (see below) — `staging.garageos.shop` **not wired yet** | `garageos-preview` (set up 2026-08-01) | Every push lands here first. Uses seeded demo data, not real customer records. |
| **Production** | `production` | `www.garageos.shop` / `garageos.shop` | `garageos` (Prod) | Only moves on an explicit fast-forward from `main`. Serves real shops. |

**Staging URL — until the custom domain is wired.** Vercel auto-aliases
every deployment. For `main` HEAD:

- Branch alias (latest `main` deploy):
  `https://garage-os-git-main-libertylightllc-ctrls-projects.vercel.app`
- Commit-specific alias (pinned SHA):
  `https://garage-os-<12-char-hash>-libertylightllc-ctrls-projects.vercel.app`

If either 404s, the exact URLs are on the Vercel dashboard row for that
deployment — the "URL" column shows both.

**To make `staging.garageos.shop` real (one-time):**

1. Vercel dashboard → `garage-os` project → **Settings** → **Domains** →
   **Add** → `staging.garageos.shop` → attach to the **`main` branch**
   (NOT Production).
2. Add a CNAME at the DNS host for `garageos.shop`:

   | Type  | Host      | Value                    |
   |-------|-----------|--------------------------|
   | CNAME | `staging` | `cname.vercel-dns.com`   |

   Propagation is minutes. Vercel's Domains screen shows a "Valid" badge
   once the CNAME resolves.

After it's wired, delete this block and put the real URL back in the
table above.

The `production` branch is protected: no direct push, no force-push,
no deletion, no admin override. Required check: `typecheck + vitest`
on the exact commit.

---

## Promote to production

Every promotion is a fast-forward. If it can't fast-forward, that
means someone edited `production` directly and staging is out of
sync — stop and investigate before merging.

```bash
git checkout production
git pull --ff-only origin production
git merge --ff-only main
git push origin production
```

Then watch the Vercel dashboard: <https://vercel.com/libertylightllc-ctrls-projects/garage-os/deployments>.

- The top-of-list Production row should reach **Ready** in ~90 seconds.
- If CI on that commit is red, `git push` succeeds but Vercel refuses
  to build — you'll see a "Deployment Blocked — checks failing" row.
  Fix CI on `main` first, promote again.

**Verify the swap actually happened:**
```bash
curl -sI https://www.garageos.shop | grep -i x-vercel-id
```
The deployment id in the response should match the one Vercel shows
as Ready.

---

## Roll back

**Fast (preferred, ~10 seconds):**

1. Vercel dashboard → Deployments → filter by "Production".
2. Find the last known-good deployment (previous "Ready" row).
3. Click "…" → **Promote to Production**.

Done. `garageos.shop` swaps to the older build immediately. **No git
touched.** The `production` branch head still shows the bad commit —
that's fine, revert it in git separately when calm:

```bash
git checkout production
git revert HEAD --no-edit
git push origin production
```

**Slow (git-only, when Vercel dashboard is unreachable):**

Requires temporarily disabling branch protection because
`enforce_admins=true` blocks force-pushes:

1. GitHub → repo Settings → Branches → `production` protection rule →
   Edit → uncheck "Do not allow bypassing" → Save.
2. Force-push:
   ```bash
   git checkout production
   git reset --hard <known-good-sha>
   git push --force-with-lease origin production
   ```
3. Re-enable protection immediately.

Only use this if the Vercel dashboard is genuinely unreachable.

### Return to a stable tag

Distinct from "roll back the last bad commit" — this is for jumping to
a specific known-good snapshot marked with an annotated tag like
`stable-2026-08-23`. Use when a series of promotions have piled up
and the "just revert HEAD" path won't cleanly untangle them.

Both routes below get to the same place. Use whichever the situation
allows.

**Fast (Vercel Instant Rollback, ~10 seconds, no git touched):**

1. `git rev-parse <tag>^{commit}` locally to get the exact SHA the tag
   points at (e.g. `git rev-parse stable-2026-08-23^{commit}`).
2. Vercel dashboard → Deployments → filter by "Production".
3. Find the row whose commit SHA matches (short SHA is shown in the
   commit column). If there are several Production deployments for
   that SHA, pick the most recent one.
4. Click "…" → **Promote to Production**. `garageos.shop` swaps
   immediately.

Same caveat as the Fast rollback above: the `production` branch head
still shows whatever was there before, so `git log origin/production`
disagrees with the live site until you also do the git reset below.
Do the git reset at your leisure — nothing serves from the branch
head, Vercel serves what was last promoted.

**Slow (git-only, when Vercel dashboard is unreachable):**

Requires temporarily disabling branch protection (see the force-push
notes in the Slow rollback above). Once bypass is enabled:

```bash
git fetch origin --tags
git checkout production
git reset --hard stable-2026-08-23
git push --force-with-lease origin production
```

Re-enable protection immediately. Vercel picks up the new
`production` HEAD and builds + promotes on its own within a few
minutes (slower than Instant Rollback because it's a full rebuild,
not a swap).

If the stable tag pre-dates a schema migration currently on prod,
the rebuild's `prisma migrate deploy` step won't roll the migration
back — Prisma applies migrations forward only. In that case you need
a hand-written down-migration OR restore from the nightly DB backup;
neither is in scope for this runbook. Ask before doing either.

---

## What commit is production serving?

Three sources. If they disagree, someone promoted a specific Vercel
deployment out-of-band and the git branch head is stale.

1. **Git (source of truth if promotion is disciplined):**
   ```bash
   git fetch origin production
   git log origin/production --oneline -1
   ```

2. **Vercel dashboard:** Deployments tab → filter Production → top
   row.

3. **Vercel CLI:**
   ```bash
   vercel deployments --token "$VERCEL_TOKEN" \
     --scope libertylightllc-ctrls-projects | head -5
   ```

**Reconcile a mismatch:** whatever Vercel is actually serving is the
truth. Reset the `production` branch to match that SHA (temporarily
lift branch protection, force-push, re-enable — same steps as the
slow rollback).

---

## Emergency hotfix

If `main` has WIP that can't ship but production needs an urgent fix:

```bash
git checkout production
git pull --ff-only origin production
git checkout -b hotfix/<short-name>
# ... edit ...
git commit -am "hotfix: <what and why>"
git push origin hotfix/<short-name>
```

Open a PR against `production`. When CI is green, merge it. Vercel
deploys.

**After the hotfix lands, forward-port to staging so main doesn't
regress the fix:**

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff hotfix/<short-name>
git push origin main
```

Never edit `production` directly. Never skip the forward-port — the
next `main → production` promotion will otherwise revert the hotfix.

---

## Testing on staging

`staging.garageos.shop` runs against the `garageos-preview` Supabase
project. That DB carries **seeded demo data (Demo Garage + 4 demo
users), not production customer records**. Fine for logic, forms,
role guards, unit-adjacent smoke.

**Surfaces that need real invoices to look right** — the PDF
renderer, the print layout, the WhatsApp send body — can't be
answered by the seed data alone. Stage a realistic invoice on staging
first:

1. Sign in to `staging.garageos.shop` as `owner@demo.garage` /
   `password`.
2. Book an intake with a real-looking customer (name, plate, phone
   with proper `+9715...` E.164 shape).
3. Advisor: pre-assign to Tariq (tech).
4. Tech: claim → send for estimate.
5. Cashier: price the estimate → send to customer.
6. Approve the estimate via the `/c/estimate/<token>` link (test the
   raw-token path from the phone or by copying the URL to another tab).
7. Cashier: generate invoice → record payment.
8. The invoice is now a realistic shape. Test PDF at
   `/c/invoice/<token>/pdf`, WhatsApp draft on `/invoices/<id>`,
   print layout via browser print preview.

Repeat with multiple line items + Arabic-locale customer to exercise
the RTL rendering and the structured message body.

---

## Never do

- **Push directly to `production`.** Branch protection blocks it; if
  you find yourself trying, stop and use the promote flow.
- **Skip CI locally then push assuming it'll be fine on Vercel.** CI
  gates the promotion — you'll just watch it fail on the promotion
  commit instead. Fix red on `main` first.
- **Point local `npm run dev` at Prod.** The `next.config.ts` guard
  (c6ba462) will refuse to boot. If it lets you through, something's
  wrong with the guard — file it, don't work around.
- **Run `prisma migrate dev` / `db push` / `migrate reset` against
  Prod.** The `prisma.config.ts` guard (c6ba462) refuses. Same rule as
  above — if it doesn't refuse, the guard is broken.
- **Rotate `AUTH_SECRET` on Prod without a plan.** Per-doc tokens
  (Phase 2, commits `583c511` + `5189222`) decoupled customer links
  from `AUTH_SECRET`, so a rotation no longer orphans links. But
  cookies / sessions still key on it — a rotation logs everyone out.
  Do it deliberately, not by accident.
