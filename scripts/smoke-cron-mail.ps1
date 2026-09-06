param(
    [string]$Secret,
    [string]$Share
)

# Cervellone V19 - Smoke test cron mail subagent sul deployment v19/email-subagent
#
# Test sicuri:
#   1. /api/cron/expire-pending - no side effects (0 pending in DB, ritorna 0)
#   2. /api/cron/monthly-foreign-invoices?dry=1 - legge IMAP info@, NO forward SMTP
#
# Prereq: vercel link + vercel login gia eseguiti.
# Uso: .\scripts\smoke-cron-mail.ps1 -Secret '<il CRON_SECRET, dalla dashboard Vercel>'
#   oppure impostando $env:CRON_SECRET nella propria shell.
# Il valore NON va scritto qui: il repository e' pubblico.

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$base = 'https://cervellone-git-v19-email-subagent-raffaeles-projects-d3ea9cf9.vercel.app'

# Il segreto NON sta qui dentro.
#
# Fino al 6 settembre 2026 questo file conteneva il CRON_SECRET di PRODUZIONE
# in chiaro, come valore di ripiego. Il repository e' pubblico: e' rimasto
# leggibile a chiunque per 108 giorni, e al momento della scoperta era ancora
# quello vivo. Con quella chiave si potevano lanciare tutte le automazioni —
# mandare mail dagli indirizzi aziendali, e far girare il lavoro che CANCELLA
# le foto dei documenti d'identita' degli ospiti.
#
# Il segreto e' stato ruotato. Qui non torna: si passa con -Secret, oppure si
# mette nella variabile d'ambiente CRON_SECRET della propria shell. Senza, lo
# script si ferma — un ripiego comodo e' esattamente cio' che ha creato il buco.
if ($Secret) {
    $cronSecret = $Secret.Trim()
} elseif ($env:CRON_SECRET) {
    $cronSecret = $env:CRON_SECRET.Trim()
} else {
    Write-Host "CRON_SECRET non fornito. Passalo con -Secret '<valore>' oppure impostalo in `$env:CRON_SECRET." -ForegroundColor Red
    Write-Host "Il valore si legge dalla dashboard Vercel: non e' e non deve essere nel repository." -ForegroundColor Red
    exit 1
}
Write-Host "CRON_SECRET in uso: $($cronSecret.Length) caratteri." -ForegroundColor Green
Write-Host ""

# Bypass Vercel Deployment Protection: il preview URL e' privato.
# _vercel_share=<token> setta cookie session che il browser/PS porta nelle GET successive.
# Token generato via MCP get_access_to_vercel_url (scadenza ~23h).
# Anche questo era in chiaro nel repo pubblico. Scaduto da mesi (dura ~23h),
# quindi inerte — ma un gettone scritto in un file e' un gettone che qualcuno
# ricopia. Si passa con -Share, o lo script salta il bypass.
$shareToken = if ($Share) { $Share.Trim() } elseif ($env:VERCEL_SHARE_TOKEN) { $env:VERCEL_SHARE_TOKEN.Trim() } else { '' }
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
