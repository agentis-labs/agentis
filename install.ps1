# Agentis installer - Windows PowerShell.
#
# Usage:
#   iwr -useb https://get.agentis.dev/install.ps1 | iex
#
# What it does:
#   1. Verifies Node >= 20.10 is on PATH (offers a hint if not).
#   2. Runs `npx @agentis-labs/cli@latest up`, which generates secrets, initialises
#      SQLite, seeds the operator user, and starts the server on :3737.

$ErrorActionPreference = 'Stop'
$RequiredMajor = 20
$RequiredMinor = 10

function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Err($msg)  { Write-Host $msg -ForegroundColor Red }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Err "Node.js is required but was not found on PATH."
    Write-Err "Install Node >= $RequiredMajor.$RequiredMinor from https://nodejs.org/ and re-run."
    exit 1
}

$nodeVersion = (& node -p 'process.versions.node').Trim()
$parts = $nodeVersion.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]

if ($major -lt $RequiredMajor -or ($major -eq $RequiredMajor -and $minor -lt $RequiredMinor)) {
    Write-Err "Node $nodeVersion is too old. Agentis requires >= $RequiredMajor.$RequiredMinor."
    exit 1
}

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    Write-Err "npx is required (it ships with npm). Reinstall Node from https://nodejs.org/."
    exit 1
}

Write-Info "Node $nodeVersion detected. Starting Agentis..."
& npx --yes @agentis-labs/cli@latest up @args
exit $LASTEXITCODE
