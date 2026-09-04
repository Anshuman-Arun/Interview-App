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
$programsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs"))
$installRoot = $null
$userData = Join-Path $env:APPDATA "Interview App"
$database = Join-Path $userData "data\interview-session.sqlite"
$modelMarker = Join-Path $userData "data\model-assets\packaging-preserve.marker"
$preferenceMarker = Join-Path $userData "packaging-preference-preserve.marker"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Interview App.lnk"
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Interview App.lnk"
$smokeProof = Join-Path $env:RUNNER_TEMP "InterviewApp-Prior-Smoke-Proof.json"

Remove-Item -Force $desktopShortcut -ErrorAction SilentlyContinue
Remove-Item -Force $startMenuShortcut -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue
Remove-Item -Force $smokeProof -ErrorAction SilentlyContinue

function Resolve-InstalledExecutable {
  if (-not (Test-Path $desktopShortcut) -or -not (Test-Path $startMenuShortcut)) {
    throw "Installer did not create both desktop and Start Menu shortcuts"
  }

  $shell = New-Object -ComObject WScript.Shell
  $desktopLink = $null
  $startMenuLink = $null
  try {
    $desktopLink = $shell.CreateShortcut($desktopShortcut)
    $startMenuLink = $shell.CreateShortcut($startMenuShortcut)
    $desktopTarget = $desktopLink.TargetPath
    $startMenuTarget = $startMenuLink.TargetPath
  } finally {
    if ($null -ne $desktopLink) {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopLink) | Out-Null
    }
    if ($null -ne $startMenuLink) {
      [Runtime.InteropServices.Marshal]::FinalReleaseComObject($startMenuLink) | Out-Null
    }
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
  }

  if ([string]::IsNullOrWhiteSpace($desktopTarget) -or [string]::IsNullOrWhiteSpace($startMenuTarget)) {
    throw "Installer shortcut target is missing"
  }
  $desktopTarget = [IO.Path]::GetFullPath($desktopTarget)
  $startMenuTarget = [IO.Path]::GetFullPath($startMenuTarget)
  if (-not $desktopTarget.Equals($startMenuTarget, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Desktop and Start Menu shortcuts target different executables"
  }

  $programsPrefix = $programsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $desktopTarget.StartsWith($programsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installed executable escaped the per-user LOCALAPPDATA Programs directory"
  }
  if ([IO.Path]::GetFileName($desktopTarget) -ne "Interview App.exe" -or -not (Test-Path $desktopTarget)) {
    throw "Installed executable was not found at the shortcut target"
  }
  return $desktopTarget
}

function Wait-ForUninstallCleanup {
  param([int]$TimeoutMilliseconds = 15000)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    $binaryGone = -not (Test-Path $installedExe)
    $desktopGone = -not (Test-Path $desktopShortcut)
    $startMenuGone = -not (Test-Path $startMenuShortcut)
    if ($binaryGone -and $desktopGone -and $startMenuGone) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  $remaining = @()
  if (Test-Path $installedExe) { $remaining += "application executable" }
  if (Test-Path $desktopShortcut) { $remaining += "desktop shortcut" }
  if (Test-Path $startMenuShortcut) { $remaining += "Start Menu shortcut" }
  throw "Uninstall cleanup timed out; remaining: $($remaining -join ', ')"
}

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
  $installedExe = Resolve-InstalledExecutable
  $installRoot = Split-Path -Parent $installedExe
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
  Set-Content -NoNewline -Path $preferenceMarker -Value "preserve-user-preferences-across-upgrade-and-uninstall"
  $preferenceHashBefore = (Get-FileHash -Algorithm SHA256 $preferenceMarker).Hash

  Run-Installer -Path $installerPath
  $upgradedExe = Resolve-InstalledExecutable
  if (-not $upgradedExe.Equals($installedExe, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Versioned upgrade changed the stable per-user installation target"
  }
  if (
    -not (Test-Path $database)
    -or -not (Test-Path $modelMarker)
    -or -not (Test-Path $preferenceMarker)
  ) {
    throw "Upgrade/reinstall destroyed durable session/model-cache/preference data"
  }
  if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $databaseHashBefore) {
    throw "Upgrade/reinstall modified the durable SQLite database"
  }
  if ((Get-FileHash -Algorithm SHA256 $modelMarker).Hash -ne $markerHashBefore) {
    throw "Upgrade/reinstall modified the model cache"
  }

  if ((Get-FileHash -Algorithm SHA256 $preferenceMarker).Hash -ne $preferenceHashBefore) {
    throw "Upgrade/reinstall modified the per-user preference marker"
  }

  $currentProductVersion = (Get-Item $installedExe).VersionInfo.ProductVersion
  if ($priorInstallerPath -ne $installerPath -and $currentProductVersion -eq $priorProductVersion) {
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
  Wait-ForUninstallCleanup
  if (
    -not (Test-Path $database)
    -or -not (Test-Path $modelMarker)
    -or -not (Test-Path $preferenceMarker)
  ) {
    throw "Default uninstall deleted interview history/model-cache/preference data"
  }
  if ((Get-FileHash -Algorithm SHA256 $database).Hash -ne $databaseHashAfterUpgradeLaunch) {
    throw "Uninstall modified the durable SQLite database"
  }
  if ((Get-FileHash -Algorithm SHA256 $modelMarker).Hash -ne $markerHashBefore) {
    throw "Uninstall modified the model cache"
  }
  if ((Get-FileHash -Algorithm SHA256 $preferenceMarker).Hash -ne $preferenceHashBefore) {
    throw "Uninstall modified the per-user preference marker"
  }
  $leftoverProcesses = @(Get-Process -Name "Interview App" -ErrorAction SilentlyContinue)
  if ($leftoverProcesses.Count -gt 0) {
    throw "Uninstall left Interview App processes running"
  }
  Write-Host "Silent prior-install/upgrade/uninstall persistence and shortcut smoke passed."
} finally {
  if ($null -ne $installRoot -and (Test-Path $installRoot)) {
    Remove-Item -Recurse -Force $installRoot -ErrorAction SilentlyContinue
  }
  Remove-Item -Force $desktopShortcut -ErrorAction SilentlyContinue
  Remove-Item -Force $startMenuShortcut -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $userData -ErrorAction SilentlyContinue
  Remove-Item -Force $smokeProof -ErrorAction SilentlyContinue
}
