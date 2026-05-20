# Cervellone V19 — Set 14 env vars TopHost mail su Vercel (production + preview)
#
# Uso:
#   1. vercel login   (oneshot)
#   2. vercel link    (oneshot, crea .vercel/project.json)
#   3. .\scripts\set-vercel-env-mail.ps1
#
# Idempotente: prima rimuove eventuale env esistente (no error se non esiste),
# poi aggiunge. Re-eseguibile senza danno.
#
# PS5 NB: $ErrorActionPreference = 'Continue' perche' Vercel CLI scrive su stderr
# anche durante operazioni success ("Retrieving project..." ecc.). In PS5
# native stderr -> ErrorRecord -> con 'Stop' lo script muore.

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.local'

if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: $envFile non trovato. Popolare prima i 14 placeholder." -ForegroundColor Red
    exit 1
}

$keys = @(
    'TOPHOST_IMAP_HOST',
    'TOPHOST_IMAP_PORT',
    'TOPHOST_IMAP_TLS',
    'TOPHOST_SMTP_HOST',
    'TOPHOST_SMTP_PORT',
    'TOPHOST_SMTP_STARTTLS',
    'EMAIL_INFO_USER',
    'EMAIL_INFO_PASS',
    'EMAIL_INFO_FROM_ADDRESS',
    'EMAIL_INFO_DISPLAY_NAME',
    'EMAIL_RAFFAELE_USER',
    'EMAIL_RAFFAELE_PASS',
    'EMAIL_RAFFAELE_FROM_ADDRESS',
    'EMAIL_RAFFAELE_DISPLAY_NAME'
)

# Parse .env.local in hashtable
$envMap = @{}
Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $idx = $line.IndexOf('=')
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim()
        $envMap[$k] = $v
    }
}

# Verifica che tutte le 14 chiavi siano popolate
$missing = @()
foreach ($k in $keys) {
    if (-not $envMap.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($envMap[$k]) -or $envMap[$k].StartsWith('PLACEHOLDER_')) {
        $missing += $k
    }
}
if ($missing.Count -gt 0) {
    Write-Host "ERROR: chiavi mancanti o placeholder in .env.local:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

# Helper: invoca Vercel CLI ignorando stderr non-fatal, ritorna $true se exit code 0
function Invoke-VercelEnvAdd {
    param([string]$Key, [string]$Value, [string]$Env)
    # Rimuove eventuale env esistente (silenzia stderr/exit code)
    & cmd /c "vercel env rm $Key $Env --yes >nul 2>&1" | Out-Null
    # Add nuovo via stdin pipe (cmd protegge da PS5 NativeCommandError)
    # Scriviamo il valore in un temp file per evitare quoting issues nel cmd /c
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($tmp, $Value, [System.Text.UTF8Encoding]::new($false))
        $out = & cmd /c "type `"$tmp`" | vercel env add $Key $Env 2>&1"
        return @{ exit = $LASTEXITCODE; out = ($out -join "`n") }
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Setting 14 env vars su Vercel (production + preview)..." -ForegroundColor Cyan
Write-Host ""

$failures = @()
$total = $keys.Count
$i = 0
foreach ($k in $keys) {
    $i++
    $v = $envMap[$k]
    $isSecret = $k -like '*PASS*' -or $k -like '*USER*'
    $display = if ($isSecret) { '***' } else { $v }
    Write-Host ("  [{0,2}/{1}] {2,-30} = {3}" -f $i, $total, $k, $display) -NoNewline

    $rProd = Invoke-VercelEnvAdd -Key $k -Value $v -Env 'production'
    if ($rProd.exit -ne 0) {
        Write-Host " FAIL(prod)" -ForegroundColor Red
        Write-Host "    -> $($rProd.out)" -ForegroundColor DarkRed
        $failures += "$k (production)"
        continue
    }

    $rPrev = Invoke-VercelEnvAdd -Key $k -Value $v -Env 'preview'
    if ($rPrev.exit -ne 0) {
        Write-Host " FAIL(preview)" -ForegroundColor Yellow
        Write-Host "    -> $($rPrev.out)" -ForegroundColor DarkYellow
        $failures += "$k (preview)"
        continue
    }

    Write-Host " OK" -ForegroundColor Green
}

Write-Host ""
if ($failures.Count -eq 0) {
    Write-Host "Tutte e 14 env vars settate su production + preview." -ForegroundColor Green
    Write-Host "Verifica con: vercel env ls" -ForegroundColor Cyan
} else {
    Write-Host "Failures ($($failures.Count)):" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
