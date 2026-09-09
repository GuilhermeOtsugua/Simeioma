$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$previousTarget = $env:CARGO_TARGET_DIR
$previousMode = $env:SIMEIOMA_DEBUG_SESSION
$previousSmoke = $env:SIMEIOMA_DEBUG_SMOKE_TEST
Push-Location $root
try {
    $env:CARGO_TARGET_DIR = Join-Path $root "src-tauri\target\diagnostics-test"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -Debug -NoBundle -DiagnosticsSmoke
    if ($LASTEXITCODE -ne 0) { throw "Diagnostic smoke build failed." }
    $env:SIMEIOMA_DEBUG_SESSION = "clean"
    $env:SIMEIOMA_DEBUG_SMOKE_TEST = "1"
    $output = Join-Path $root ".tmp\diagnostics-smoke"
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    $resultPath = Join-Path $env:LOCALAPPDATA "com.otsugua.simeioma.diagnosticstest\logs\diagnostics\smoke-result.json"
    if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath }
    $process = Start-Process -FilePath (Join-Path $env:CARGO_TARGET_DIR "debug\simeioma.exe") -PassThru `
        -RedirectStandardOutput (Join-Path $output "stdout.log") -RedirectStandardError (Join-Path $output "stderr.log")
    # Keep a process handle so PowerShell can retrieve ExitCode after native exit.
    $null = $process.Handle
    if (-not $process.WaitForExit(90000)) {
        # Only terminate the isolated fixture process created by this script.
        $process.Kill()
        throw "Diagnostic smoke test timed out. Inspect .tmp/diagnostics-smoke/stderr.log."
    }
    $process.WaitForExit()
    if ($null -eq $process.ExitCode -or $process.ExitCode -ne 0) { throw "Diagnostic smoke test failed. Inspect .tmp/diagnostics-smoke/stderr.log." }
    # Tauri/Windows can return zero even after app.exit(1). Require fresh fixture evidence too.
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Diagnostic smoke result was not produced." }
    $result = [System.IO.File]::ReadAllText($resultPath) | ConvertFrom-Json
    if ($result.passed -ne $true) { throw "Diagnostic smoke test failed: $($result.failure)" }
    Write-Host "Native diagnostics smoke test passed ($($result.checks.Count) checks)."
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    $env:SIMEIOMA_DEBUG_SESSION = $previousMode
    $env:SIMEIOMA_DEBUG_SMOKE_TEST = $previousSmoke
    Pop-Location
}
