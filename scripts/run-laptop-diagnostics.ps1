param(
    [string]$AppDataRoot = "",
    [string]$ResourcesPath = "",
    [string]$Model = "gemini-3.8-flash-medium",
    [switch]$AllModels,
    [switch]$SkipRemote,
    [switch]$SkipContracts
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if (-not $corepack) {
        throw "Neither pnpm nor corepack is available on PATH."
    }
    & corepack enable | Out-Null
}

$argsList = @(
    "exec",
    "tsx",
    "scripts/run-local-diagnostics.ts",
    "--model",
    $Model
)

if ($AppDataRoot) {
    $argsList += @("--app-data", $AppDataRoot)
}
if ($ResourcesPath) {
    $argsList += @("--resources", $ResourcesPath)
}
if ($AllModels) {
    $argsList += "--all-models"
}
if ($SkipRemote) {
    $argsList += "--skip-remote"
}
if ($SkipContracts) {
    $argsList += "--skip-contracts"
}

Write-Host ""
Write-Host "Interview App laptop diagnostics"
Write-Host "Repository: $RepoRoot"
Write-Host "Model: $Model"
Write-Host ""

& pnpm @argsList
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "Diagnostics completed with no failing checks."
} else {
    Write-Host "Diagnostics completed with one or more failing checks."
}
Write-Host "Open the newest folder under:"
Write-Host "  $RepoRoot\diagnostics-output"
Write-Host "Send both report.txt and report.json for analysis."
exit $exitCode
