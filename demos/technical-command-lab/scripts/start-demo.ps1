param(
  [string]$DataDir = ".agentis-demo"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
Push-Location $root
try {
  $env:AGENTIS_DATA_DIR = $DataDir
  pnpm dev:full
}
finally {
  Pop-Location
}

