param(
  [string]$PackageRoot = "dist/windows/win-unpacked"
)

$ErrorActionPreference = "Stop"
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }
$source = (Resolve-Path $PackageRoot).Path
$smokeRoot = Join-Path $tempRoot "Interview App Ω Packaged Smoke"
$smokeUserData = Join-Path $tempRoot "Interview App Ω Smoke User Data"
foreach ($path in @($smokeRoot, $smokeUserData)) {
  if (Test-Path $path) {
    Remove-Item -Recurse -Force $path
  }
}
Copy-Item -Recurse -Force $source $smokeRoot
New-Item -ItemType Directory -Force $smokeUserData | Out-Null
$exe = Join-Path $smokeRoot "Interview App.exe"
if (-not (Test-Path $exe)) {
  throw "Packaged executable missing at $exe"
}

function Get-WorkerPids {
  try {
    return @(
      Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains("local_model_worker.py") } |
        ForEach-Object { [int]$_.ProcessId }
    )
  } catch {
    return @()
  }
}

function Stop-TrackedProcess {
  param([System.Diagnostics.Process]$Process)
  if ($null -eq $Process) {
    return
  }
  try {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
      $Process.WaitForExit(10000) | Out-Null
    }
  } catch {
    # Best-effort cleanup after the primary assertion has already failed.
  }
}

$beforeWorkers = @(Get-WorkerPids)
$oldPython = $env:INTERVIEW_LOCAL_PYTHON
$oldSmokeUserData = $env:INTERVIEW_PACKAGED_SMOKE_USER_DATA
$smoke = $null
$instanceHost = $null
$probe = $null
try {
  $env:INTERVIEW_LOCAL_PYTHON = Join-Path $smokeRoot "missing-python.exe"
  $env:INTERVIEW_PACKAGED_SMOKE_USER_DATA = $smokeUserData

  $smoke = Start-Process -FilePath $exe -ArgumentList "--packaged-smoke-test" -PassThru
  if (-not $smoke.WaitForExit(60000)) {
    throw "Packaged smoke executable did not exit within 60 seconds"
  }
  if ($smoke.ExitCode -ne 0) {
    throw "Packaged smoke executable failed with exit code $($smoke.ExitCode)"
  }

  $database = Join-Path $smokeUserData "data\interview-session.sqlite"
  if (-not (Test-Path $database)) {
    throw "Packaged smoke did not persist SQLite data under isolated Unicode userData"
  }

  $instanceHost = Start-Process -FilePath $exe -ArgumentList "--packaged-single-instance-smoke-host" -PassThru
  Start-Sleep -Seconds 5
  if ($instanceHost.HasExited) {
    throw "Single-instance smoke host exited before the probe"
  }

  $probe = Start-Process -FilePath $exe -ArgumentList "--packaged-single-instance-smoke-probe" -PassThru
  if (-not $probe.WaitForExit(15000)) {
    throw "Second packaged instance did not yield the single-instance lock"
  }
  if (-not $instanceHost.WaitForExit(30000)) {
    throw "Single-instance host did not shut down cleanly after the probe"
  }
  if ($instanceHost.ExitCode -ne 0 -or $probe.ExitCode -ne 0) {
    throw "Single-instance smoke process failed"
  }
} finally {
  Stop-TrackedProcess $probe
  Stop-TrackedProcess $instanceHost
  Stop-TrackedProcess $smoke
  $env:INTERVIEW_LOCAL_PYTHON = $oldPython
  $env:INTERVIEW_PACKAGED_SMOKE_USER_DATA = $oldSmokeUserData
}

Start-Sleep -Milliseconds 750
$afterWorkers = @(Get-WorkerPids | Where-Object { $beforeWorkers -notcontains $_ })
if ($afterWorkers.Count -gt 0) {
  throw "Packaged shutdown left local-model worker processes: $($afterWorkers -join ', ')"
}

Remove-Item -Recurse -Force $smokeRoot -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $smokeUserData -ErrorAction SilentlyContinue
Write-Host "Packaged executable smoke passed from Unicode install and user-data paths."
