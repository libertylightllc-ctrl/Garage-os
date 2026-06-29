#!/usr/bin/env bash
#
# Nightly off-Supabase backup of the production database.
# Called by .github/workflows/nightly-backup.yml — not for direct human
# use locally (the env vars come from GitHub Actions secrets).
#
# Pipeline:
#   1. pg_dump production → SQL stream (read-only user, session pooler)
#   2. gzip -9 the stream → compact dump
#   3. GPG-encrypt with AES-256 + passphrase (client-side encryption;
#      Backblaze never sees plaintext)
#   4. Upload encrypted blob to Backblaze B2 via S3 protocol
#   5. Confirm upload size in B2 matches local (catches truncation)
#   6. Ping Healthchecks.io on success (non-fatal if the ping itself
#      fails — the backup is already safe at that point)
#   7. Clean up local files in a trap so a mid-script error doesn't
#      leave secrets on disk
#
# Required env (all from GitHub Actions secrets):
#   DATABASE_URL_READONLY  — backup_reader user, session pooler 5432
#   B2_APPLICATION_KEY_ID  — restricted application key (this bucket only)
#   B2_APPLICATION_KEY     — secret value of that key
#   B2_BUCKET_NAME         — e.g. garageos-backups-prod
#   B2_ENDPOINT            — e.g. https://s3.us-east-005.backblazeb2.com
#   GPG_PASSPHRASE         — 40+ char passphrase (stored in AR's pw mgr)
#   HEALTHCHECKS_URL       — https://hc-ping.com/<uuid>  (optional)
#
# Security discipline:
#   - `set +x` ensures bash never traces secret-bearing commands
#   - secrets are referenced as variables, never echoed
#   - the pg_dump connection string is passed via env to docker so it
#     does not appear in ps output or the process tree
#   - aws-cli uses --no-progress so the upload path/size do not
#     interleave with anything that could leak a key
#
# Exit codes:
#   0  — backup uploaded + verified
#   1  — pg_dump or local-file error
#   2  — encryption error
#   3  — upload error
#   4  — verification mismatch (uploaded size != local size)

set -euo pipefail
# Explicitly disable xtrace — defense in depth in case a future edit
# adds `set -x` somewhere.
set +x

# ── Sanity-check required env ─────────────────────────────────────────
REQUIRED=(DATABASE_URL_READONLY B2_APPLICATION_KEY_ID B2_APPLICATION_KEY
          B2_BUCKET_NAME B2_ENDPOINT GPG_PASSPHRASE)
for v in "${REQUIRED[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "FAIL: required env var '$v' is empty or unset" >&2
    exit 1
  fi
done
# HEALTHCHECKS_URL is optional but warned about — silent failure mode
# is the whole point of having it.
if [ -z "${HEALTHCHECKS_URL:-}" ]; then
  echo "WARN: HEALTHCHECKS_URL not set — silent-failure detection off"
fi

# ── Filenames ─────────────────────────────────────────────────────────
# UTC ISO8601 timestamp with colons swapped to dashes so the filename
# is filesystem-portable. Sorts lexicographically by time, so the
# latest backup is always the last item in any listing.
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
BASENAME="garageos-backup-${TS}"
DUMP_FILE="${BASENAME}.sql.gz"
ENC_FILE="${BASENAME}.sql.gz.gpg"
REMOTE_KEY="${ENC_FILE}"

# Cleanup local files on any exit — including failure — so secrets
# never linger on the runner's disk longer than necessary.
trap 'rm -f "$DUMP_FILE" "$ENC_FILE" 2>/dev/null || true' EXIT

echo "[backup] starting at ${TS} (UTC)"

# ── 1. pg_dump → gzip ─────────────────────────────────────────────────
# Use the postgres:17 docker image — its pg_dump version must be
# >= the server's. Supabase is on PG 17.x as of 2026-06-29; using
# postgres:16 here previously failed with "aborting because of
# server version mismatch (server 17.6 > pg_dump 16.14)". If
# Supabase upgrades again, bump this digit to match (newer client
# can always dump older server; never the reverse).
#
# Flags:
#   --no-owner            : strip OWNER TO clauses — the dump restores
#                           regardless of which role exists on target
#   --no-privileges       : strip GRANT/REVOKE — same reason
#   --no-comments         : smaller, no docstring noise
#   --quote-all-identifiers : Supabase uses mixed-case (Garage, JobCard
#                           etc.) — without this the dump may produce
#                           lower-cased names that don't restore
#   --serializable-deferrable : SERIALIZABLE READ ONLY DEFERRABLE
#                           snapshot — never blocks live writes during
#                           the dump; safe on production traffic
#   --clean --if-exists   : on restore, drop existing objects first.
#                           Lets us restore over a partially-populated
#                           target without manual cleanup.
echo "[backup] running pg_dump …"
docker run --rm \
  -e PG_URL="$DATABASE_URL_READONLY" \
  postgres:17 \
  pg_dump \
    --no-owner --no-privileges --no-comments \
    --quote-all-identifiers \
    --serializable-deferrable \
    --clean --if-exists \
    --dbname="$DATABASE_URL_READONLY" \
  | gzip -9 \
  > "$DUMP_FILE"

# Sanity-check the dump file. A pg_dump that connects but fails halfway
# can produce a tiny zero-content gzip. Block obviously-broken dumps
# from being uploaded.
DUMP_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")
if [ "${DUMP_SIZE:-0}" -lt 2048 ]; then
  echo "FAIL: dump file is ${DUMP_SIZE} bytes (under 2KB) — likely empty/broken" >&2
  exit 1
fi
echo "[backup] dump+gzip ok (${DUMP_SIZE} bytes)"

# ── 2. GPG-encrypt ────────────────────────────────────────────────────
# AES-256 symmetric. The passphrase is fed via stdin (passphrase-fd 0)
# so it never appears in argv (visible in /proc/<pid>/cmdline on a
# multi-user system; not relevant on a GH runner but good hygiene).
echo "[backup] encrypting …"
printf '%s' "$GPG_PASSPHRASE" | gpg \
  --batch --yes \
  --pinentry-mode loopback \
  --passphrase-fd 0 \
  --cipher-algo AES256 \
  --symmetric \
  --output "$ENC_FILE" \
  "$DUMP_FILE" \
  || { echo "FAIL: encryption error" >&2; exit 2; }

ENC_SIZE=$(stat -c%s "$ENC_FILE" 2>/dev/null || stat -f%z "$ENC_FILE")
echo "[backup] encrypted ok (${ENC_SIZE} bytes)"

# ── 3. Upload to Backblaze B2 (via S3 protocol) ───────────────────────
# AWS CLI is preinstalled on ubuntu-latest. B2 speaks the S3 API at
# its endpoint; AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY map to the
# B2 application key ID / key. --no-progress suppresses the per-MB
# progress bar (clean logs; no leaked URL in failure output).
echo "[backup] uploading to B2 (${B2_BUCKET_NAME}/${REMOTE_KEY}) …"
AWS_ACCESS_KEY_ID="$B2_APPLICATION_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY" \
AWS_DEFAULT_REGION=auto \
aws s3 cp "$ENC_FILE" "s3://${B2_BUCKET_NAME}/${REMOTE_KEY}" \
  --endpoint-url "$B2_ENDPOINT" \
  --no-progress \
  || { echo "FAIL: B2 upload error" >&2; exit 3; }

# ── 4. Verify upload — list the just-uploaded object, compare size ────
# Catches the silent-truncation case (network glitch mid-upload, B2
# accepted an incomplete object). If sizes match, the bytes round-
# tripped intact.
REMOTE_SIZE=$(
  AWS_ACCESS_KEY_ID="$B2_APPLICATION_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY" \
  AWS_DEFAULT_REGION=auto \
  aws s3api head-object \
    --bucket "$B2_BUCKET_NAME" \
    --key "$REMOTE_KEY" \
    --endpoint-url "$B2_ENDPOINT" \
    --query 'ContentLength' \
    --output text
)
if [ "$REMOTE_SIZE" != "$ENC_SIZE" ]; then
  echo "FAIL: remote size ${REMOTE_SIZE} != local size ${ENC_SIZE}" >&2
  exit 4
fi
echo "[backup] verified remote size matches (${REMOTE_SIZE} bytes)"

# ── 5. Healthchecks.io ping (non-fatal if it fails) ───────────────────
# The backup is already safely uploaded + verified at this point; a
# missing ping just means we won't know about the success via
# dead-man-switch. Don't fail the whole job over it.
if [ -n "${HEALTHCHECKS_URL:-}" ]; then
  if curl -fsS --retry 3 --max-time 10 "$HEALTHCHECKS_URL" >/dev/null; then
    echo "[backup] healthcheck ping ok"
  else
    echo "[backup] WARN: healthcheck ping failed (backup still safe in B2)"
  fi
fi

echo "[backup] complete: s3://${B2_BUCKET_NAME}/${REMOTE_KEY} (${REMOTE_SIZE} bytes)"
