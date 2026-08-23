# Disaster Recovery — GarageOS

What this document is: the **runbook** for restoring the production database
from an off-Supabase backup.

**Read §1 first — Supabase provides no recovery on the current plan, so
this runbook is not a backup story, it is the ONLY recovery path.**

Last drilled **2026-06-29**, end-to-end, on real prod data, on AR's
Windows machine. Backup pipeline has been exercised every night since;
the RESTORE path hasn't been re-drilled since then and its dependencies
(Postgres 17 image, Windows GPG path, B2 credentials structure) have
had two months to drift. Re-drill before treating this as production
insurance.

---

## 1. What we have

> **Supabase provides NO recovery on this project's plan.** GarageOS
> production is on the Supabase Free plan (confirmed in the Supabase
> dashboard, 2026-08-23). Free tier has zero scheduled backups and
> Point-in-Time Recovery is not available — the "Backups" tab is
> empty and PITR requires a paid plan. Retention window is 0.
>
> If the production database is lost, corrupted, or the Supabase
> project is deleted, **Supabase has nothing to restore from**. The
> nightly B2 backup below is not a second layer — it is the sole
> recovery path.
>
> Upgrading to Supabase Pro ($25/month) adds 7-day platform-side
> daily backups. Adding PITR is +$10/month on top of Pro for
> minute-granularity restore. Not deciding yet — but the trade-off
> is worth writing down rather than rediscovered under pressure:
>
> - **Our B2 pipeline** covers *loss of the Supabase project* — the
>   dump lives in a different vendor's storage, encrypted with a key
>   Supabase never sees, and can restore onto a fresh Postgres
>   anywhere. It does NOT cover *loss of the B2 pipeline itself* —
>   if the nightly cron silently stops, the passphrase is lost, the
>   restore script rots against a stack drift, or the B2 bucket
>   itself has an outage, we have no fallback.
> - **Supabase Pro daily backups** cover the exact failure mode
>   ours can't: *our own recovery pipeline is what failed*. Supabase
>   holds their own snapshots at their end; if our B2 pipeline is
>   what broke on the day we need it, their console-restore is a
>   second, independent path. It does NOT cover loss of the Supabase
>   project itself (their snapshots are inside their platform).
>
> They cover different failure classes. On the current Free plan,
> the only class covered is "Supabase failed / went away" via B2 —
> and only IF our B2 pipeline is itself healthy on the day.
>
> Until that decision is made, treat the B2 pipeline as load-
> bearing: any nightly failure is a P0.

| Layer | Where it lives | Retention |
|-------|----------------|-----------|
| Daily encrypted SQL dump | Backblaze B2 bucket `garageos-backups-prod` | 90 days (lifecycle rule) |
| Daily encrypted files archive (garage-logos + garage-uploads) | Same B2 bucket, `files/` prefix | 90 days (same lifecycle rule) |
| Encryption key | GitHub Actions secret `GPG_PASSPHRASE` + AR's password manager | — |
| Restore tool | `scripts/restore-from-dump.mjs` (this repo) | — |
| Verification probe | `scripts/probe-restore.mjs` (recreate from runbook §5 below) | — |
| Dead-man-switch | Healthchecks.io ping, gated on both DB + files upload succeeding | — |

The dump is `pg_dump --schema=public --clean --if-exists` of the live
Supabase Postgres, gzipped, then GPG AES-256 symmetric-encrypted with the
passphrase. Backblaze never sees plaintext.

The backup job (`.github/workflows/nightly-backup.yml`) runs nightly at
22:00 UTC (02:00 UAE, off-peak). Confirmed running + succeeding as of
2026-08-23 (last five nights all green). The dead-man-switch fires only
when both the DB dump AND the files archive complete — a silent failure
of either half stops the ping and Healthchecks alerts within its
configured grace window.

## 2. RPO / RTO targets

- **RPO** (data we'd lose if everything failed *right now*): up to 24 hours
  once the nightly cron is on. Today (manual trigger): up to whatever the
  gap is since the last manual run.
- **RTO** (time to back online from a cold restore): **~15 minutes** end-to-end
  on a fresh Postgres, drilled, including the Vercel DATABASE_URL swap.

## 3. Which recovery path — pick before you type

**The one distinction that matters at 2 am: Vercel Instant Rollback
fixes CODE. Never DATA.** If a deploy corrupted rows, rolling back
the deploy puts the old code in front of the corrupted rows. The
symptom clears, the damage remains, and the next legitimate write
propagates it. This table exists so nobody reasons that out under
pressure.

| Scenario | First move | Then |
|---|---|---|
| **Bad schema migration, no data mutated yet** (added a column that broke a query, wrong FK cascade, etc.) | Vercel Instant Rollback — 10s, live traffic swaps back to the prior deploy. See `docs/deploy-runbook.md` "Roll back" for the click path. | Author a corrective migration; deploy through the normal main → staging → production path. The schema drift (old code + new migration) is only tolerable if the added column is nullable or if the removed column isn't referenced by the reverted code. Verify with a smoke run before considering it resolved. |
| **Migration mutated or dropped rows** (backfill, `NOT NULL` conversion with a default, a `DELETE FROM ... WHERE ...` in the migration SQL, a type cast that silently truncated) | **Instant Rollback does NOT help.** Code goes back; data doesn't come back. Go straight to §4 restore-from-B2. | Up to 24 h of data loss (whatever's happened since the last nightly cron). Post-restore, run the verification probe in §5 before swapping Vercel's `DATABASE_URL` back onto the restored DB. |
| **Data corruption not caused by a migration** (bug in a server action, misfired script, mass-update through Supabase SQL editor with a bad WHERE) | Same as row above — Instant Rollback fixes nothing. Restore from B2 per §4. Also consider Supabase's own daily-backup dashboard if the incident is fresh AND you're within Supabase's retention window (see §1). | Fix the offending code path BEFORE swapping DATABASE_URL back, or the same bug re-runs on the restored data. |
| **Whole DB corrupted / Supabase project deleted / total loss** | §4 restore-from-B2. Then §4d to swap Vercel onto a fresh Postgres. | RTO ~15 min drilled; longer if you also have to stand up a new Postgres project. |
| **Data corruption caught inside Supabase's own retention window** and PITR is on | Supabase dashboard → Database → Backups → point-in-time restore. Minute-granularity, minimal data loss. | Self-service on Pro+ plans; requires a Supabase Support ticket on Free tier. Confirm the plan in the dashboard BEFORE assuming this path is available. |

### Prisma migrations are forward-only. Plan for that BEFORE you deploy one.

`prisma migrate deploy` applies migrations in order and NEVER reverses
them. There is no `prisma migrate down`. A migration that mutates
data — backfill, `NOT NULL` conversion, type cast that reshapes
values, `DELETE FROM ... WHERE ...` — has **no automatic reverse**.

The only paths back are:

1. **Hand-written reverse migration.** Author a new forward migration
   that undoes the change (write the inverse SQL yourself), commit,
   deploy. Requires that the reverse is actually expressible: adding
   a dropped column back is easy; recovering the values the drop
   destroyed is impossible without a backup.
2. **Restore-and-replay.** §4 restore from B2 dump → swap Vercel per
   §4d → replay any writes that happened AFTER the backup but BEFORE
   the bad migration, if you have the audit trail to do so (server
   action logs, WhatsApp webhook history, ledger entries). Losses
   between backup and incident are the RPO tax.

Before shipping any migration that mutates data:
- Read the `.sql` file yourself; don't trust `migrate dev` to generate
  something safe.
- Verify last night's B2 backup succeeded (Healthchecks.io dashboard).
- If the migration is high-risk (destructive, large table, irreversible
  in the "recovering the values" sense), take a manual pre-migration
  dump: `bash scripts/backup-prod-db.sh` before running deploy.

---

## 4. The restore procedure

Two halves: **secret half** (you do this — it needs the passphrase + B2
credentials) and **mechanical half** (anyone with repo access can do it).

### 4a. Secret half — download + decrypt (5 min)

You need:
- Backblaze B2 web UI access (or the application key in 1Password)
- Your GPG passphrase from 1Password
- Git for Windows installed (it ships GPG at `C:\Program Files\Git\usr\bin\gpg.exe`)

```powershell
# In any PowerShell window:
$dir  = "C:\Users\Smart land\Documents\garage\backups"
mkdir $dir -ErrorAction SilentlyContinue
cd $dir

# 1. Download the latest .gpg file from B2 web UI into $dir.
#    Filename pattern: garageos-backup-YYYY-MM-DDTHH-MM-SSZ.sql.gz.gpg
$enc = (Get-ChildItem $dir -Filter "*.sql.gz.gpg" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$gz  = "$dir\dump.sql.gz"
$sql = "$dir\dump.sql"

# 2. Decrypt. PowerShell can't show a GPG TUI prompt — feed the passphrase via stdin.
$pass  = Read-Host -AsSecureString "GPG passphrase"
$plain = [System.Net.NetworkCredential]::new("", $pass).Password
$plain | & "C:\Program Files\Git\usr\bin\gpg.exe" `
  --batch --yes --pinentry-mode loopback --passphrase-fd 0 `
  --decrypt --output $gz $enc
$plain = $null   # drop the passphrase from memory

# 3. Gunzip via .NET (no gunzip.exe on Windows by default).
#    Use full paths — .NET file APIs don't follow PowerShell `cd`.
$in  = [System.IO.File]::OpenRead($gz)
$out = [System.IO.File]::Create($sql)
$dec = New-Object System.IO.Compression.GzipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
$dec.CopyTo($out); $dec.Close(); $out.Close(); $in.Close()
Remove-Item $gz

Get-Item $sql | Format-Table Name, Length    # expect ~200-500 KB plaintext
```

If you see `dump.sql` listed with a non-zero size, you're done with the
secret half.

> **Why pinentry-mode loopback:** Git's bundled GPG on Windows has no
> graphical pinentry helper. Without `--pinentry-mode loopback --passphrase-fd 0`
> it exits silently because it can't prompt the terminal, leaving a
> zero-byte output file (a bug we hit during the drill).

### 4b. Mechanical half — apply the dump (5 min)

Prereq: local Postgres reachable on `localhost:51214` (the Prisma 7 dev DB
— `npm run db:dev` starts it). The restore script creates a separate
database called `garageos_restore` and applies the dump there. Your seeded
`template1` dev DB is untouched.

```powershell
# From the repo root.
node scripts/restore-from-dump.mjs
```

This logs each chunk applied and finishes with row counts per table.
Expect (snapshot from 2026-06-29 drill):

```
Garage         6
User           13
Customer       8
Vehicle        22
JobCard        28
Estimate       33
Invoice        21
LedgerEntry    175
Booking        0
AiEvent        55
```

If any chunk fails, the script aborts with `--- statement ---` showing the
exact SQL that broke. **Don't keep running.** Debug, drop the partial DB,
re-run.

### 4c. Boot the app against the restore

Temporarily flip `.env.local` to point at the restored DB:

```powershell
# Before flipping, snapshot the current .env.local so you can roll back:
Copy-Item .env.local .env.local.dev-backup
```

Edit `.env.local` and swap the database name in `DATABASE_URL`:

```
template1 → garageos_restore
```

(Keep all other URL params identical.)

Then:

```powershell
npm run dev
# In another window — sign in as an OWNER, then:
curl -b cookies.txt http://localhost:3000/api/diagnose/db
```

`/api/diagnose/db` returns a plain-text table-vs-code column comparison
plus a garage count. It's auth-gated (any signed-in user), so grab the
`next-auth.session-token` cookie from your browser after signing in, or
use `curl -c cookies.txt` on the login POST first.

The bare-liveness `/api/health` (public) will also return `ok`, but it
tells you nothing about DB shape — use `/api/diagnose/db` for the
"restore looks right" check. If the endpoint is unreachable because
the app can't find a signed-in session, walk the owner dashboard by
hand instead — same signal, more clicks.

That confirms the app is reading real prod data from the restore.

### 4d. Real disaster — swap Vercel onto the restored DB

If this is an actual recovery (not a drill), you also need to:

1. Provision a fresh Postgres for the app to point at (new Supabase project,
   or a self-hosted Postgres). Apply `dump.sql` to it via the same
   `scripts/restore-from-dump.mjs` (change the `HOST`/`PORT`/`USER`/`PASS`
   constants at the top).
2. Update Vercel project env var `DATABASE_URL` to the new pooler URL
   (use the Singapore session pooler shape — see AGENTS.md "Dev DB vs
   Prod DB" — `aws-1-ap-southeast-1.pooler.supabase.com:6543?pgbouncer=true&connection_limit=1`).
3. Trigger a Vercel redeploy. Within ~90 sec the live site is on the
   restored data.

## 5. How to verify the restore is real prod data

This is the smell test — does the data look like prod, or has gunzip
silently produced garbage?

The 2026-06-29 drill verified by inspecting double-entry totals across
the ledger. Bookkeeping invariants don't survive corruption:

```powershell
# create this scratch script — DON'T commit, deletes after use
@'
import pg from "pg";
const c = new pg.Client({ connectionString:
  "postgres://postgres:postgres@localhost:51214/garageos_restore?sslmode=disable" });
await c.connect();
const r = await c.query(`SELECT account, COALESCE(SUM(debit)::text,'0') AS d,
  COALESCE(SUM(credit)::text,'0') AS cr FROM "public"."LedgerEntry"
  GROUP BY account ORDER BY account`);
for (const x of r.rows) console.log(x.account.padEnd(20), "D=" + x.d, "C=" + x.cr);
await c.end();
'@ | Out-File -Encoding utf8 scripts/probe.mjs
node scripts/probe.mjs
Remove-Item scripts/probe.mjs
```

Expected pattern (numbers will differ as time passes):
- `VAT Payable` credit total ≈ 5% of `Sales Revenue` credit total (UAE 5% VAT)
- `Cash/Bank` debits ≤ sum of `Sales Revenue` + `Customer Deposits`
- `Accounts Receivable` net (debit − credit) = unpaid invoices

If the VAT/sales ratio is wildly off, the dump is corrupt and you should
restore from the previous night's backup instead.

## 6. Cleanup after a drill

After verifying, leave nothing sensitive on disk:

```powershell
# drop the scratch DB
node -e "import('pg').then(async ({default:pg})=>{const c=new pg.Client({connectionString:'postgres://postgres:postgres@localhost:51214/template1?sslmode=disable'});await c.connect();await c.query('DROP DATABASE IF EXISTS \"garageos_restore\"');await c.end();console.log('dropped');})"

# restore .env.local from the snapshot
Move-Item .env.local.dev-backup .env.local -Force

# shred the plaintext dump and any working files
Remove-Item backups\dump.sql -Force
Remove-Item backups\restore.log -Force -ErrorAction SilentlyContinue
```

The encrypted `.gpg` file in `backups/` is fine to keep — it matches what's
in B2 and `backups/` is gitignored. Or delete it; doesn't matter.

## 6b. Restore FILES (Supabase Storage)

The nightly job also backs up the Storage buckets (`garage-logos`,
`garage-uploads`) as an encrypted tarball in B2 under the `files/`
prefix — same bucket, same GPG passphrase, same 90-day retention as the
DB dumps. Script: `scripts/backup-prod-files.sh`.

### Download + decrypt + unpack
```bash
# latest file archive is the last item in a listing (timestamped name)
aws s3 cp "s3://<B2_BUCKET>/files/garageos-files-<TS>.tar.gz.gpg" . \
  --endpoint-url "<B2_ENDPOINT>"        # B2 creds in env, same as DB restore

# decrypt with YOUR passphrase, then untar
gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
  --decrypt --output files.tar.gz garageos-files-<TS>.tar.gz.gpg   # type passphrase
tar xzf files.tar.gz
# → yields ./garage-logos/…  and ./garage-uploads/…
```

### Re-upload to Storage (recovered or new Supabase project)
```bash
# Supabase S3 creds in env (the read-only backup key can READ but not
# write — for restore you need a WRITE-capable key or the service role).
aws s3 sync ./garage-logos   "s3://garage-logos" \
  --endpoint-url "https://<ref>.storage.supabase.co/storage/v1/s3" --region ap-southeast-1
aws s3 sync ./garage-uploads "s3://garage-uploads" \
  --endpoint-url "https://<ref>.storage.supabase.co/storage/v1/s3" --region ap-southeast-1
```

### Two caveats (documented so a restore doesn't surprise you)
1. **Bucket ACLs are NOT in the tarball** — only the objects. Before
   re-uploading, re-create the buckets with the right visibility:
   `garage-logos` = **public-read**, `garage-uploads` = **private**.
   Getting this backwards would expose private inspection photos or
   break public logo links.
2. **URLs in the DB point at the original project ref.** If you restore
   to a *new* Supabase project (different ref), the `logoUrl` on
   `Garage` and the photo/voice URLs on `JobStep` still reference the
   old `<ref>.supabase.co` host and must be rewritten. For a *same
   project* recovery this is a non-issue — the refs match.
3. **The backup key is read-only.** `backup-prod-files.sh` only ever
   downloads. Restoring (writing back) needs a write-capable key, so
   don't try to reuse the nightly backup key for the re-upload step.

## 7. Known gotchas (from the 2026-06-29 drill)

These are the surprises we hit. Future-you should know.

- **GPG silently exits without pinentry.** Git for Windows ships GPG but
  no pinentry helper. Without `--pinentry-mode loopback --passphrase-fd 0`,
  decrypt fails silently with a zero-byte output. Use the §4a recipe.

- **`.NET` file APIs ignore PowerShell's `cd`.** `[System.IO.File]::OpenRead("dump.sql.gz")`
  resolves against `Environment.CurrentDirectory` (often `C:\Windows\System32`),
  not your shell's PWD. Always pass full paths.

- **`psql.exe` is not on AR's machine** and Docker isn't installed either.
  The restore script avoids both by using `node-postgres` directly. Don't
  swap back to `psql` casually — first install it.

- **Prisma 7's bundled "dev" Postgres (PGlite) chokes on big simple-query
  batches.** Our first-cut restore script ran the dump's entire schema-DDL
  block (~245 statements) as a single `client.query(text)`. PGlite died
  with no error message; the next connection got `ECONNREFUSED`. Fix:
  split each pg_dump SQL chunk into individual statements before sending.
  `scripts/restore-from-dump.mjs` already does this.

- **`pg-copy-streams` + PGlite produced `unexpected EOF on client connection
  with an open transaction`.** Either pg-copy-streams' COPY framing or
  PGlite's COPY-from-STDIN handler is broken in this combination. Fix:
  parse each COPY block and replay as parameterized `INSERT` statements
  (handles `\N`, `\t`, `\n` escapes). The restore script does this. For
  larger datasets where INSERT-per-row would be too slow, swap to a real
  Postgres (Docker or native install) so pg-copy-streams works.

- **Supabase server is PG 17.6, pg_dump is in `postgres:17` Docker image
  (17.10).** Older images (16.x) refuse with version mismatch. If Supabase
  upgrades again, bump `scripts/backup-prod-db.sh`'s docker image tag.

- **`--schema=public` is critical.** Supabase's internal schemas (auth,
  storage, realtime, extensions) are managed by Supabase and would be
  re-provisioned on a restore to a new project. Without `--schema=public`
  the `backup_reader` role hits `permission denied for schema auth` and
  pg_dump fails.

- **`BYPASSRLS` on the backup_reader role is required.** Without it,
  pg_dump fails on RLS-protected tables (`AdvancePayment` etc.):
  `query would be affected by row-level security policy for table…`.
  Set once with `ALTER ROLE backup_reader BYPASSRLS;`.

## 8. What's NOT in this runbook

- **WhatsApp tokens.** The `WhatsAppAccount` table holds encrypted access
  tokens. They restore fine, but Meta may have rotated them out from under
  us during the outage. Re-do the Embedded Signup flow per garage after
  recovery.
- **Supabase Storage objects** (uploaded photos, voice notes, garage logos).
  ✅ NOW COVERED (Phase 7, 2026-07-04) — backed up nightly by
  `scripts/backup-prod-files.sh` to B2 `files/`. Restore procedure: §6b.
- **The Auth schema.** We don't use Supabase Auth for staff (we use NextAuth
  with our own User table, which IS in `public`). Customer auth is
  passwordless via WhatsApp — no auth state to restore.
- **DNS / Vercel custom domain.** Live during recovery; nothing to restore.

---

## Deploy pipeline incident — 2026-07-04

**Symptom:** for ~1 week (June 27 → July 4), pushes to `main` built
successfully on Vercel but never went live on `www.garageos.shop`. The
admin panel and several other commits appeared "stuck."

**Root cause:** the production domain was pinned to a June-27 deployment
via an **Instant Rollback** that was never cleared (`lastRollbackTarget`
set on the Vercel project). While a rollback is active, new production
builds go READY but the custom domain does NOT auto-assign to them.
Every push since June 27 built fine and was simply never promoted.

**Fix:** promote the desired deployment to production via the Vercel API
(`POST /v10/projects/{id}/promote/{deploymentId}`), which clears the
rollback pin. After clearing, `lastRollbackTarget` is `null` and the
domains return to `(auto/latest)`, so normal auto-promotion resumes.

**How to detect recurrence:** if a push builds but the live site doesn't
change, check the Vercel project's `lastRollbackTarget` — if it's set,
a rollback is pinning the domain.
