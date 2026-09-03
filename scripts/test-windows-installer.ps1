param(
  [string]$Installer = ""
)

$ErrorActionPreference = "Stop"
if ($env:CI -ne "true") {
  throw "This destructive silent install/uninstall check is CI-only. Use docs/WINDOWS_DESKTOP_RELEASE.md for manual release validation."
}

if ([string]::IsNullOrWhiteSpace($Installer)) {
  $package = Get-Content -Raw "package.json" | ConvertFrom-Json
  $Installer = "dist/windows/InterviewApp-Setup-$($package.version).exe"
}
$installerPath = (Resolve-Path $Installer).Path
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Interview App"
$userData = Join-Path $env:APPDATA "Interview App"
$database = Join-Path $userData "data\interview-session.sqlite"
$modelMarker = Join-Path $userData "data\model-assets\packaging-preserve.marker"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Interview App.lnk"
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Interview App.lnk"

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
  if (-not (Test-Path $desktopShortcut)) {
    throw "Desktop shortcut was not created"
  }
  if (-not (Test-Path $startMenuShortcut)) {
    throw "Start Menu shortcut was not created"
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
  $databaseHashBefore = (Get-FileHash -Algorithm SHA256 $database).Hash
  New-Item -ItemType Directory -Force (Split-Path $modelMarker) | Out-Null
  Set-Content -NoNewline -Path $modelMarker -Value "preserve-across-upgrade-and-uninstall"
  $markerHashBefore = (Get-FileHash -Algorithm SHA256 $modelMarker).Hash

  Run-Installer
  if (-not (Test-Path $database) -or -not (Test-Path $modelMarker)) {
    throw "Reinstall destroyed durable session/model-cache data"
  }
  if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $databaseHashBefore) {
    throw "Reinstall modified the durable SQLite database"
  }
  if ((Get-FileHash -Algorithm SHA256 $modelMarker).Hash -ne $markerHashBefore) {
    throw "Reinstall modified the model cache"
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
  if ((Test-Path $desktopShortcut) -or (Test-Path $startMenuShortcut)) {
    throw "Uninstall left application shortcuts behind"
  }
  if (-not (Test-Path $database) -or -not (Test-Path $modelMarker)) {
    throw "Default uninstall deleted interview history/model-cache data"
  }
  if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $databaseHashBefore) {
    throw "Uninstall modified the durable SQLite database"
  }
  if ((Get-FileHash -Algorithm SHA256 $modelMarker).Hash -ne $markerHashBefore) {
    throw "Uninstall modified the model cache"
  }
  $leftoverProcesses = @(Get-Process -Name "Interview App" -ErrorAction SilentlyContinue)
  if ($leftoverProcesses.Count -gt 0) {
    throw "Uninstall left Interview App processes running"
  }
  Write-Host "Silent install/reinstall/uninstall persistence and shortcut smoke passed."
} finally {
  Remove-Item -Recurse -Force $installRoot -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue
}
