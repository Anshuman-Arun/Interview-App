param(
  [string]$Installer = "",
  [string]$PriorInstaller = ""
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
$priorInstallerPath = if ([string]::IsNullOrWhiteSpace($PriorInstaller)) {
  $installerPath
} else {
  (Resolve-Path $PriorInstaller).Path
}
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\Interview App"
$userData = Join-Path $env:APPDATA "Interview App"
$database = Join-Path $userData "data\interview-session.sqlite"
$modelMarker = Join-Path $userData "data\model-assets\packaging-preserve.marker"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Interview App.lnk"
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Interview App.lnk"
$smokeProof = Join-Path $env:RUNNER_TEMP "InterviewApp-Prior-Smoke-Proof.json"

Remove-Item -Recurse -Force $installRoot -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue
Remove-Item -Force $smokeProof -ErrorAction SilentlyContinue

function Run-Installer {
  param([string]$Path = $installerPath)
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -PassThru
  if (-not $process.WaitForExit(90000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "NSIS installer did not finish"
  }
  if ($process.ExitCode -ne 0) {
    throw "NSIS installer failed with exit code $($process.ExitCode)"
  }
}

try {
  Run-Installer -Path $priorInstallerPath
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
  $priorProductVersion = (Get-Item $installedExe).VersionInfo.ProductVersion

  $oldPython = $env:INTERVIEW_LOCAL_PYTHON
  $oldSmokeReport = $env:INTERVIEW_PACKAGED_SMOKE_REPORT
  $oldSmokeExpectation = $env:INTERVIEW_PACKAGED_SMOKE_EXPECT_REPORT
  try {
    $env:INTERVIEW_LOCAL_PYTHON = Join-Path $installRoot "missing-python.exe"
    $env:INTERVIEW_PACKAGED_SMOKE_REPORT = $smokeProof
    Remove-Item -Force Env:INTERVIEW_PACKAGED_SMOKE_EXPECT_REPORT -ErrorAction SilentlyContinue
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
    $env:INTERVIEW_PACKAGED_SMOKE_REPORT = $oldSmokeReport
    $env:INTERVIEW_PACKAGED_SMOKE_EXPECT_REPORT = $oldSmokeExpectation
  }

  if (-not (Test-Path $smokeProof)) {
    throw "Prior packaged smoke did not emit the upgrade proof"
  }
  if (-not (Test-Path $database)) {
    throw "Installed application did not create its durable SQLite database"
  }
  $databaseHashBefore = (Get-FileHash -Algorithm SHA256 $database).Hash
  New-Item -ItemType Directory -Force (Split-Path $modelMarker) | Out-Null
  Set-Content -NoNewline -Path $modelMarker -Value "preserve-across-upgrade-and-uninstall"
  $markerHashBefore = (Get-FileHash -Algorithm SHA256 $modelMarker).Hash

  Run-Installer -Path $installerPath
  if (-not (Test-Path $database) -or -not (Test-Path $modelMarker)) {
    throw "Upgrade/reinstall destroyed durable session/model-cache data"
  }
  if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $databaseHashBefore) {
    throw "Upgrade/reinstall modified the durable SQLite database"
  }
  if ((Get-FileHash -Algorithm SHA256 $modelMarker).Hash -ne $markerHashBefore) {
    throw "Upgrade/reinstall modified the model cache"
  }

  $currentProductVersion = (Get-Item $installedExe).VersionInfo.ProductVersion
  if (
    $priorInstallerPath -ne $installerPath
    -and $currentProductVersion -eq $priorProductVersion
  ) {
    throw "Versioned upgrade did not replace the installed application binary"
  }

  try {
    $env:INTERVIEW_LOCAL_PYTHON = Join-Path $installRoot "missing-python.exe"
    Remove-Item -Force Env:INTERVIEW_PACKAGED_SMOKE_REPORT -ErrorAction SilentlyContinue
    $env:INTERVIEW_PACKAGED_SMOKE_EXPECT_REPORT = $smokeProof
    $upgradedSmoke = Start-Process -FilePath $installedExe -ArgumentList "--packaged-smoke-test" -PassThru
    if (-not $upgradedSmoke.WaitForExit(60000)) {
      Stop-Process -Id $upgradedSmoke.Id -Force -ErrorAction SilentlyContinue
      throw "Upgraded executable smoke timed out"
    }
    if ($upgradedSmoke.ExitCode -ne 0) {
      throw "Upgraded executable smoke failed with exit code $($upgradedSmoke.ExitCode)"
    }
  } finally {
    $env:INTERVIEW_LOCAL_PYTHON = $oldPython
    $env:INTERVIEW_PACKAGED_SMOKE_REPORT = $oldSmokeReport
    $env:INTERVIEW_PACKAGED_SMOKE_EXPECT_REPORT = $oldSmokeExpectation
  }
  $databaseHashAfterUpgradeLaunch = (Get-FileHash -Algorithm SHA256 $database).Hash

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
  if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $databaseHashAfterUpgradeLaunch) {
    throw "Uninstall modified the durable SQLite database"
  }
  if ((Get-FileHash -Algorithm SHA256 $modelMarker).Hash -ne $markerHashBefore) {
    throw "Uninstall modified the model cache"
  }
  $leftoverProcesses = @(Get-Process -Name "Interview App" -ErrorAction SilentlyContinue)
  if ($leftoverProcesses.Count -gt 0) {
    throw "Uninstall left Interview App processes running"
  }
  Write-Host "Silent prior-install/upgrade/uninstall persistence and shortcut smoke passed."
} finally {
  Remove-Item -Recurse -Force $installRoot -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue
  Remove-Item -Force $smokeProof -ErrorAction SilentlyContinue
}
