# start.ps1 — one-shot launcher for the eCom Agent dashboard.
# Usage:
#   .\start.ps1                 # preflight, then launch the dashboard (opens browser)
#   .\start.ps1 -Port 9000      # dashboard on a different port
#   .\start.ps1 -NoOpen         # don't auto-open the browser
#   .\start.ps1 -Command login  # run any CLI command instead of the dashboard
#   .\start.ps1 -Command sync
param(
    [string]$Command = "dashboard",
    [int]$Port = 8765,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Die($m)  { Write-Host $m -ForegroundColor Red; exit 1 }

# 1. Node >= 22.5 (node:sqlite requirement)
try { $nodeVer = (node --version).TrimStart("v") }
catch { Die "Node.js not found on PATH. Install Node >= 22.5 from https://nodejs.org/" }

$parts = $nodeVer.Split(".")
$major = [int]$parts[0]; $minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
    Die "Node $nodeVer found, but >= 22.5 is required (node:sqlite). Please upgrade."
}
Ok "Node v$nodeVer"

# 2. Dependencies
if (-not (Test-Path "node_modules")) {
    Info "Installing dependencies (npm install)..."
    npm install
    if ($LASTEXITCODE -ne 0) { Die "npm install failed." }
}

# 3. Playwright Chromium browser
$pwCache = Join-Path $env:LOCALAPPDATA "ms-playwright"
if (-not (Test-Path (Join-Path $pwCache "chromium-*"))) {
    Info "Installing Playwright Chromium..."
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Die "Playwright browser install failed." }
}
Ok "Playwright Chromium ready"

# 4. .env / shexp68 credentials (warn only — JD uses QR login, no secret)
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Warn "Created .env from .env.example. Open it and fill in SHEXP68_USERNAME / SHEXP68_PASSWORD"
    Warn "  (your shexp68 account), then run this again. JD and Taobao use QR login, no password."
} elseif (-not (Select-String -Path ".env" -Pattern '^s*SHEXP68_USERNAMEs*=s*S' -Quiet)) {
    Warn ".env has no SHEXP68_USERNAME yet — declaring to shexp68 will fail until you fill it in."
} else {
    Ok ".env present"
}

# 5. Launch
if ($Command -eq "dashboard") {
    $cliArgs = @("dashboard", "--port", "$Port")
    if ($NoOpen) { $cliArgs += "--no-open" }
    Info "Starting dashboard on http://127.0.0.1:$Port  (Ctrl+C to stop)"
    node --disable-warning=ExperimentalWarning src/cli.js @cliArgs
} else {
    Info "Running: $Command"
    node --disable-warning=ExperimentalWarning src/cli.js $Command
}
