# Disaster Recovery — GarageOS

What this document is: the **runbook** for restoring the production database
from an off-Supabase backup. Last drilled **2026-06-29**, end-to-end, on
real prod data, on AR's Windows machine — every command below worked.

If everything goes wrong at the same time — Supabase project deleted, our
database corrupted, somebody fat-fingered a DROP — this is what gets us
back online.

---

## 1. What we have

| Layer | Where it lives | Retention |
|-------|----------------|-----------|
| Daily encrypted SQL dump | Backblaze B2 bucket `garageos-backups-prod` | 90 days (lifecycle rule) |
| Encryption key | GitHub Actions secret `GPG_PASSPHRASE` + AR's password manager | — |
| Restore tool | `scripts/restore-from-dump.mjs` (this repo) | — |
| Verification probe | `scripts/probe-restore.mjs` (recreate from runbook §4 below) | — |

The dump is `pg_dump --schema=public --clean --if-exists` of the live
Supabase Postgres, gzipped, then GPG AES-256 symmetric-encrypted with the
passphrase. Backblaze never sees plaintext.

The backup job (`.github/workflows/nightly-backup.yml`) is **manual trigger
only** at the time of this drill. Phase 6 will switch it to a nightly cron.

## 2. RPO / RTO targets

- **RPO** (data we'd lose if everything failed *right now*): up to 24 hours
  once the nightly cron is on. Today (manual trigger): up to whatever the
  gap is since the last manual run.
- **RTO** (time to back online from a cold restore): **~15 minutes** end-to-end
  on a fresh Postgres, drilled, including the Vercel DATABASE_URL swap.

## 3. The restore procedure

Two halves: **secret half** (you do this — it needs the passphrase + B2
credentials) and **mechanical half** (anyone with repo access can do it).

### 3a. Secret half — download + decrypt (5 min)

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

### 3b. Mechanical half — apply the dump (5 min)

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

### 3c. Boot the app against the restore

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
# In another window:
curl http://localhost:3000/api/health
```

`/api/health` should return `{"ok":true,"db":"connected","tableCount":30,"garageCount":6,...}`.

That confirms the app is reading real prod data from the restore. Sign in
with any production user email + password (you have those) and walk the
owner dashboard to be sure.

### 3d. Real disaster — swap Vercel onto the restored DB

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

## 4. How to verify the restore is real prod data

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

## 5. Cleanup after a drill

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

## 6. Known gotchas (from the 2026-06-29 drill)

These are the surprises we hit. Future-you should know.

- **GPG silently exits without pinentry.** Git for Windows ships GPG but
  no pinentry helper. Without `--pinentry-mode loopback --passphrase-fd 0`,
  decrypt fails silently with a zero-byte output. Use the §3a recipe.

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

## 7. What's NOT in this runbook

- **WhatsApp tokens.** The `WhatsAppAccount` table holds encrypted access
  tokens. They restore fine, but Meta may have rotated them out from under
  us during the outage. Re-do the Embedded Signup flow per garage after
  recovery.
- **Supabase Storage objects** (uploaded photos, voice notes, garage logos).
  Not covered by this backup. Phase 7 will add a Storage backup job.
- **The Auth schema.** We don't use Supabase Auth for staff (we use NextAuth
  with our own User table, which IS in `public`). Customer auth is
  passwordless via WhatsApp — no auth state to restore.
- **DNS / Vercel custom domain.** Live during recovery; nothing to restore.
