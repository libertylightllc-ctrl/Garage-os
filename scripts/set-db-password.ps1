# One-step .env DATABASE_URL fixer.
#
# What it does:
#   1. Prompts you for the new password (typed into a SecureString prompt
#      so it doesn't show on screen and doesn't end up in shell history).
#   2. URL-encodes the password automatically — handles @, :, /, ?, #, &,
#      +, %, space, every special char correctly.
#   3. Replaces the DATABASE_URL line in .env with the canonical pooler
#      URL shape (Vercel-compatible).
#
# Why this script exists:
#   Claude can't paste passwords into files. This script lets you paste
#   the password once, with no manual encoding, and it writes the file.
#
# Run from project root:
#   .\scripts\set-db-password.ps1
#
# When the password prompt appears, paste your password and press Enter.
# Nothing echoes to screen. Script writes .env. Delete this file after if
# you want — `Remove-Item scripts\set-db-password.ps1`.

$ErrorActionPreference = "Stop"

# Read password securely. PowerShell hides it from screen + shell history.
$pwSecure = Read-Host -AsSecureString "New Supabase password (will not echo)"
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwSecure)
try {
    $pwPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    # Zero the BSTR so the plaintext isn't sitting in memory longer than needed.
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrEmpty($pwPlain)) {
    Write-Error "Empty password. Aborted, .env untouched."
    exit 1
}

# URL-encode the password. EscapeDataString handles all RFC 3986 reserved chars.
$pwEncoded = [System.Uri]::EscapeDataString($pwPlain)

# Canonical pooler URL (Vercel-compatible). User-segment + host + port +
# flags are all fixed; only the password slot varies.
$newUrl = 'DATABASE_URL="postgresql://postgres.yxcbucjqpkrqrfkkhssh:' + $pwEncoded + '@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"'

$envPath = Join-Path (Get-Location) ".env"
if (-not (Test-Path $envPath)) {
    Write-Error "No .env at $envPath. Aborted."
    exit 1
}

# Read .env, replace the active DATABASE_URL= line (not the commented ones),
# write back. UTF-8 no BOM so dotenv parses it cleanly.
$lines = Get-Content $envPath
$replaced = $false
$out = $lines | ForEach-Object {
    if ($_ -match '^\s*DATABASE_URL=' -and -not $replaced) {
        $replaced = $true
        $newUrl
    } else {
        $_
    }
}
if (-not $replaced) {
    Write-Error "No active DATABASE_URL= line found in .env. Aborted."
    exit 1
}

# Atomic-ish write: tempfile + rename so a crash mid-write doesn't truncate .env.
$tmp = "$envPath.tmp"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($tmp, $out, $utf8NoBom)
Move-Item -Force $tmp $envPath

# Clear plaintext from memory.
$pwPlain = $null
[System.GC]::Collect()

Write-Host ""
Write-Host "OK - .env updated. Now say 'check' to Claude and it'll verify."
