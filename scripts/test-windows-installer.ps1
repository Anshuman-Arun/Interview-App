param(
  [string]$Installer = "dist/windows/InterviewApp-Setup-0.1.0.exe"
)

$ErrorActionPreference = "Stop"
if ($env:CI -ne "true") {
  throw "This destructive silent install/uninstall check is CI-only. Use docs/WINDOWS_DESKTOP_RELEASE.md for manual release validation."
}

$installerPath = (Resolve-Path $Installer).Path
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Interview App"
$userData = Join-Path $env:APPDATA "Interview App"
$database = Join-Path $userData "data\interview-session.sqlite"
$modelMarker = Join-Path $userData "data\model-assets\packaging-preserve.marker"

Remove-Item -Recurse -Force $installRoot -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue

function Run-Installer {
  $process = Start-Process -FilePath $installerPath -ArgumentList "/S" -PassThru
  if (-not $process.WaitForExit(90000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "NSIS installer did not finish"
  }
  if ($process.ExitCode -ne 0) {
    throw "NSIS installer failed with exit code $($process.ExitCode)"
  }
}

try {
  Run-Installer
  $installedExe = Join-Path $installRoot "Interview App.exe"
  if (-not (Test-Path $installedExe)) {
    throw "Installed executable was not found in the per-user install directory"
  }

  $oldPython = $env:INTERVIEW_LOCAL_PYTHON
  try {
    $env:INTERVIEW_LOCAL_PYTHON = Join-Path $installRoot "missing-python.exe"
    $smoke = Start-Process -FilePath $installedExe -ArgumentList "--packaged-smoke-test" -PassThru
    if (-not $smoke.WaitForExit(60000)) {
      Stop-Process -Id $smoke.Id -Force -ErrorAction SilentlyContinue
      throw "Installed executable smoke timed out"
    }
    if ($smoke.ExitCode -ne 0) {
      throw "Installed executable smoke failed with exit code $($smoke.ExitCode)"
    }
  } finally {
    $env:INTERVIEW_LOCAL_PYTHON = $oldPython
  }

  if (-not (Test-Path $database)) {
    throw "Installed application did not create its durable SQLite database"
  }
  New-Item -ItemType Directory -Force (Split-Path $modelMarker) | Out-Null
  Set-Content -NoNewline -Path $modelMarker -Value "preserve-across-upgrade-and-uninstall"

  Run-Installer
  if (-not (Test-Path $database) -or -not (Test-Path $modelMarker)) {
    throw "Reinstall destroyed durable session/model-cache data"
  }

  $uninstaller = Get-ChildItem -Path $installRoot -Filter "Uninstall*.exe" | Select-Object -First 1
  if ($null -eq $uninstaller) {
    throw "NSIS uninstaller was not installed"
  }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru
  if (-not $uninstall.WaitForExit(90000)) {
    Stop-Process -Id $uninstall.Id -Force -ErrorAction SilentlyContinue
    throw "NSIS uninstaller did not finish"
  }
  if ($uninstall.ExitCode -ne 0) {
    throw "NSIS uninstaller failed with exit code $($uninstall.ExitCode)"
  }
  Start-Sleep -Seconds 2

  if (Test-Path $installedExe) {
    throw "Uninstall left application binaries installed"
  }
  if (-not (Test-Path $database) -or -not (Test-Path $modelMarker)) {
    throw "Default uninstall deleted interview history/model-cache data"
  }
  Write-Host "Silent install/reinstall/uninstall persistence smoke passed."
} finally {
  Remove-Item -Recurse -Force $installRoot -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue
}
