param(
  [string]$DataDir = ".agentis-demo"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$target = Join-Path $root $DataDir
$resolvedRoot = [System.IO.Path]::GetFullPath($root)
$resolvedTarget = [System.IO.Path]::GetFullPath($target)

if (-not $resolvedTarget.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove a path outside the repository: $resolvedTarget"
}

if (Test-Path -LiteralPath $resolvedTarget) {
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
  Write-Host "Removed $resolvedTarget"
}
else {
  Write-Host "No demo data dir found at $resolvedTarget"
}

