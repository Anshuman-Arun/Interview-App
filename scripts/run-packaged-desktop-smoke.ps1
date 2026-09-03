param(
  [string]$PackageRoot = "dist/windows/win-unpacked"
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path $PackageRoot).Path
$smokeRoot = Join-Path $env:RUNNER_TEMP "Interview App Ω Packaged Smoke"
if (Test-Path $smokeRoot) {
  Remove-Item -Recurse -Force $smokeRoot
}
Copy-Item -Recurse -Force $source $smokeRoot
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

$beforeWorkers = @(Get-WorkerPids)
$oldPython = $env:INTERVIEW_LOCAL_PYTHON
try {
  $env:INTERVIEW_LOCAL_PYTHON = Join-Path $smokeRoot "missing-python.exe"
  $smoke = Start-Process -FilePath $exe -ArgumentList "--packaged-smoke-test" -PassThru
  if (-not $smoke.WaitForExit(60000)) {
    Stop-Process -Id $smoke.Id -Force -ErrorAction SilentlyContinue
    throw "Packaged smoke executable did not exit within 60 seconds"
  }
  if ($smoke.ExitCode -ne 0) {
    throw "Packaged smoke executable failed with exit code $($smoke.ExitCode)"
  }

  $host = Start-Process -FilePath $exe -ArgumentList "--packaged-single-instance-smoke-host" -PassThru
  Start-Sleep -Seconds 5
  if ($host.HasExited) {
    throw "Single-instance smoke host exited before the probe"
  }
  $probe = Start-Process -FilePath $exe -ArgumentList "--packaged-single-instance-smoke-probe" -PassThru
  if (-not $probe.WaitForExit(15000)) {
    Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $host.Id -Force -ErrorAction SilentlyContinue
    throw "Second packaged instance did not yield the single-instance lock"
  }
  if (-not $host.WaitForExit(30000)) {
    Stop-Process -Id $host.Id -Force -ErrorAction SilentlyContinue
    throw "Single-instance host did not shut down cleanly after the probe"
  }
  if ($host.ExitCode -ne 0 -or $probe.ExitCode -ne 0) {
    throw "Single-instance smoke process failed"
  }
} finally {
  $env:INTERVIEW_LOCAL_PYTHON = $oldPython
}

Start-Sleep -Milliseconds 750
$afterWorkers = @(Get-WorkerPids | Where-Object { $beforeWorkers -notcontains $_ })
if ($afterWorkers.Count -gt 0) {
  throw "Packaged shutdown left local-model worker processes: $($afterWorkers -join ', ')"
}

Write-Host "Packaged executable smoke passed from path with spaces and Unicode."
