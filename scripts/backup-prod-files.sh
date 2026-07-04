#!/usr/bin/env bash
#
# Nightly off-Supabase backup of Storage buckets (garage-logos, garage-uploads).
# Called by .github/workflows/nightly-backup.yml as a STEP after the DB
# backup — not for direct human use locally (env vars come from GitHub
# Actions secrets).
#
# Pipeline (mirrors scripts/backup-prod-db.sh's discipline):
#   1. aws s3 sync each Supabase Storage bucket (via S3 protocol) → local dir
#   2. tar both dirs together → single archive
#   3. GPG-encrypt with AES-256 + passphrase (SAME passphrase as the DB backup)
#   4. Upload encrypted blob to Backblaze B2 under files/ (same bucket + 90-day
#      retention as the DB dumps)
#   5. Confirm upload size in B2 matches local (catches truncation)
#   6. Clean up local files in a trap so nothing lingers on the runner's disk
#
# READ-ONLY: this script only ever DOWNLOADS from Supabase (aws s3 sync
# from the bucket to local). It never writes to Supabase Storage. Even if
# the storage key were granted write, this script cannot delete or modify
# any file — it only reads.
#
# NOTE: unlike backup-prod-db.sh, this script does NOT ping Healthchecks.
# The workflow pings ONCE, in a final step, only after both the DB step
# and this step succeed (one dead-man-switch for the pair).
#
# Required env (all from GitHub Actions secrets):
#   SUPABASE_S3_ACCESS_KEY_ID     — Supabase Storage S3 access key ID (read-only)
#   SUPABASE_S3_SECRET_ACCESS_KEY — secret value of that key
#   SUPABASE_S3_ENDPOINT          — https://<ref>.storage.supabase.co/storage/v1/s3
#   SUPABASE_S3_REGION            — e.g. ap-southeast-1
#   B2_APPLICATION_KEY_ID         — restricted application key (this bucket only)
#   B2_APPLICATION_KEY            — secret value of that key
#   B2_BUCKET_NAME                — e.g. garageos-backups-prod
#   B2_ENDPOINT                   — e.g. https://s3.us-east-005.backblazeb2.com
#   GPG_PASSPHRASE                — SAME 40+ char passphrase as the DB backup
#
# Exit codes:
#   0 — backup uploaded + verified
#   1 — sync or local-file error
#   2 — encryption error
#   3 — upload error
#   4 — verification mismatch (uploaded size != local size)

set -euo pipefail
# Explicitly disable xtrace — defense in depth so secrets are never traced.
set +x

# ── Loud required-env preflight ───────────────────────────────────────
# Fail immediately, naming the exact missing/misnamed secret, BEFORE
# touching Supabase or B2. On the first manual trigger this is what tells
# us a secret is wrong — and it runs as its own step, so the DB backup
# (a separate step that already ran) is untouched.
REQUIRED=(SUPABASE_S3_ACCESS_KEY_ID SUPABASE_S3_SECRET_ACCESS_KEY
          SUPABASE_S3_ENDPOINT SUPABASE_S3_REGION
          B2_APPLICATION_KEY_ID B2_APPLICATION_KEY B2_BUCKET_NAME B2_ENDPOINT
          GPG_PASSPHRASE)
MISSING=()
for v in "${REQUIRED[@]}"; do
  if [ -z "${!v:-}" ]; then MISSING+=("$v"); fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "FAIL: required env var(s) empty or unset: ${MISSING[*]}" >&2
  echo "      (check the GitHub Actions secret names match exactly)" >&2
  exit 1
fi

BUCKETS=(garage-logos garage-uploads)

# ── Filenames ─────────────────────────────────────────────────────────
# UTC ISO8601 timestamp, colons swapped to dashes for filesystem safety.
# Sorts lexicographically by time, so the latest is always last in a
# listing — same convention as the DB dumps.
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
WORKDIR=$(mktemp -d)
BASENAME="garageos-files-${TS}"
TAR_FILE="${WORKDIR}/${BASENAME}.tar.gz"
ENC_FILE="${WORKDIR}/${BASENAME}.tar.gz.gpg"
REMOTE_KEY="files/${BASENAME}.tar.gz.gpg"

# Clean up EVERYTHING (synced files + archive + encrypted blob) on any
# exit, including failure, so no tenant files linger on the runner disk.
trap 'rm -rf "$WORKDIR" 2>/dev/null || true' EXIT

echo "[files-backup] starting at ${TS} (UTC)"

# ── 1. Sync both buckets from Supabase Storage (S3 protocol) ──────────
# aws s3 sync pulls every object in the bucket down to the local dir.
# mkdir -p first so tar has a dir even when a bucket is empty.
#
# CHECKSUM WORKAROUND (added 2026-07-04 after the first manual run
# failed with SignatureDoesNotMatch): AWS CLI >= 2.23 enables "default
# integrity protections" — extra x-amz-checksum headers on requests —
# which Supabase's S3 gateway doesn't include in its signature
# verification, so every call fails signature validation. Setting both
# modes to when_required drops the new headers unless an operation
# genuinely needs them. This is the documented fix for S3-compatible
# providers. Applies only to the Supabase sync below; the B2 upload
# further down has its own env and B2 handles the new defaults fine.
for b in "${BUCKETS[@]}"; do
  echo "[files-backup] syncing bucket ${b} …"
  mkdir -p "${WORKDIR}/${b}"
  AWS_ACCESS_KEY_ID="$SUPABASE_S3_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$SUPABASE_S3_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="$SUPABASE_S3_REGION" \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
  AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  aws s3 sync "s3://${b}" "${WORKDIR}/${b}" \
    --endpoint-url "$SUPABASE_S3_ENDPOINT" \
    --no-progress \
    || { echo "FAIL: sync error on bucket ${b}" >&2; exit 1; }
done

# ── 2. tar both dirs together ──────────────────────────────────────────
# -C into WORKDIR so the archive holds clean relative paths
# (garage-logos/…, garage-uploads/…) — restore-friendly.
echo "[files-backup] archiving …"
tar -czf "$TAR_FILE" -C "$WORKDIR" "${BUCKETS[@]}" \
  || { echo "FAIL: tar error" >&2; exit 1; }

TAR_SIZE=$(stat -c%s "$TAR_FILE" 2>/dev/null || stat -f%z "$TAR_FILE")
echo "[files-backup] archive ok (${TAR_SIZE} bytes)"

# NOTE: deliberately NO minimum-size guard here (unlike the DB script's
# <2KB check). An empty / near-empty archive is VALID — pilot shops may
# have zero uploads yet, so "small" is expected, not a failure. A
# min-size check would false-fail a correct backup.

# ── 3. GPG-encrypt (same passphrase as the DB backup) ─────────────────
# AES-256 symmetric; passphrase via stdin (--passphrase-fd 0) so it never
# appears in argv.
echo "[files-backup] encrypting …"
printf '%s' "$GPG_PASSPHRASE" | gpg \
  --batch --yes \
  --pinentry-mode loopback \
  --passphrase-fd 0 \
  --cipher-algo AES256 \
  --symmetric \
  --output "$ENC_FILE" \
  "$TAR_FILE" \
  || { echo "FAIL: encryption error" >&2; exit 2; }

ENC_SIZE=$(stat -c%s "$ENC_FILE" 2>/dev/null || stat -f%z "$ENC_FILE")
echo "[files-backup] encrypted ok (${ENC_SIZE} bytes)"

# ── 4. Upload to Backblaze B2 under files/ ────────────────────────────
echo "[files-backup] uploading to B2 (${B2_BUCKET_NAME}/${REMOTE_KEY}) …"
AWS_ACCESS_KEY_ID="$B2_APPLICATION_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY" \
AWS_DEFAULT_REGION=auto \
aws s3 cp "$ENC_FILE" "s3://${B2_BUCKET_NAME}/${REMOTE_KEY}" \
  --endpoint-url "$B2_ENDPOINT" \
  --no-progress \
  || { echo "FAIL: B2 upload error" >&2; exit 3; }

# ── 5. Verify upload — head-object, compare size ──────────────────────
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
echo "[files-backup] verified remote size matches (${REMOTE_SIZE} bytes)"

echo "[files-backup] complete: s3://${B2_BUCKET_NAME}/${REMOTE_KEY} (${REMOTE_SIZE} bytes)"
