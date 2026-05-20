param(
    [string]$Secret
)

# Cervellone V19 - Smoke test cron mail subagent sul deployment v19/email-subagent
#
# Test sicuri:
#   1. /api/cron/expire-pending - no side effects (0 pending in DB, ritorna 0)
#   2. /api/cron/monthly-foreign-invoices?dry=1 - legge IMAP info@, NO forward SMTP
#
# Prereq: vercel link + vercel login gia eseguiti.
# Uso: .\scripts\smoke-cron-mail.ps1 -Secret 'cron20mag2026safekey7XQ4vR9NwT2K6'
#   oppure senza arg per prompt interattivo.

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$base = 'https://cervellone-git-v19-email-subagent-raffaeles-projects-d3ea9cf9.vercel.app'

# MODALITA' MANUALE: CRON_SECRET settato DA DASHBOARD VERCEL (non da script).
# Evita encoding issue di stdin pipe Windows -> vercel CLI.
$defaultSecret = 'cron20mag2026safekey7XQ4vR9NwT2K6'
if ($Secret) {
    $cronSecret = $Secret.Trim()
    Write-Host "CRON_SECRET fornito via -Secret arg." -ForegroundColor Cyan
} else {
    Write-Host "CRON_SECRET non fornito via -Secret arg. Uso default: $defaultSecret" -ForegroundColor Cyan
    $cronSecret = $defaultSecret
}
Write-Host "CRON_SECRET in uso (lunghezza $($cronSecret.Length) char): $($cronSecret.Substring(0, [Math]::Min(8, $cronSecret.Length)))..." -ForegroundColor Green
Write-Host ""

# Bypass Vercel Deployment Protection: il preview URL e' privato.
# _vercel_share=<token> setta cookie session che il browser/PS porta nelle GET successive.
# Token generato via MCP get_access_to_vercel_url (scadenza ~23h).
$shareToken = 'DFeY1gAQ6fPsM809WcCQvHKbEKyFwajI'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Write-Host "Setup session cookie via _vercel_share..." -ForegroundColor Cyan
try {
    $null = Invoke-WebRequest -Uri "$base/?_vercel_share=$shareToken" -WebSession $session -MaximumRedirection 5 -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    Write-Host "Session cookie ottenuto." -ForegroundColor Green
} catch {
    Write-Host "WARN: setup session fallito: $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host ""

function Invoke-CronTest {
    param([string]$Path, [string]$Label)
    $url = "$base$Path"
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    Write-Host "GET $url" -ForegroundColor Gray
    $headers = @{ 'Authorization' = "Bearer $cronSecret" }
    try {
        $start = Get-Date
        $resp = Invoke-WebRequest -Uri $url -Headers $headers -WebSession $session -Method GET -UseBasicParsing -TimeoutSec 60
        $elapsed = ((Get-Date) - $start).TotalSeconds
        Write-Host ("HTTP {0} in {1:N2}s" -f $resp.StatusCode, $elapsed) -ForegroundColor Green
        try {
            $body = $resp.Content | ConvertFrom-Json
            $body | ConvertTo-Json -Depth 10 | Write-Host
        } catch {
            Write-Host $resp.Content
        }
    } catch {
        Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
        if ($_.Exception.Response) {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $body = $reader.ReadToEnd()
            Write-Host "Response body: $body" -ForegroundColor DarkRed
        }
    }
    Write-Host ""
}

Invoke-CronTest -Path '/api/cron/expire-pending' -Label 'Test 1/2: expire-pending (no side effects)'
Invoke-CronTest -Path '/api/cron/monthly-foreign-invoices?dry=1' -Label 'Test 2/2: monthly-foreign-invoices dry-run (IMAP read, no SMTP)'

Write-Host "Smoke test completato. Verifica i JSON di risposta per status atteso." -ForegroundColor Cyan
