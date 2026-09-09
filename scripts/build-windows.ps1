param(
    [switch]$Debug,
    [switch]$NoBundle,
    [switch]$DiagnosticsSmoke
)

$ErrorActionPreference = "Stop"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"

if (Test-Path $vswhere) {
    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
} else {
    $installationPath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
}

$vcvars = Join-Path $installationPath "VC\Auxiliary\Build\vcvars64.bat"

if (-not (Test-Path $vcvars)) {
    throw "MSVC build tools were not found. Install Visual Studio Build Tools with the C++ workload."
}

$buildArgs = ""
if ($Debug) { $buildArgs += " --debug" }
if ($NoBundle) { $buildArgs += " --no-bundle" }
if ($DiagnosticsSmoke) {
    if (-not $Debug) { throw "Diagnostics smoke builds must use -Debug." }
    $buildArgs += " --config src-tauri/tauri.diagnostics-test.conf.json"
}
cmd.exe /c "call `"$vcvars`" && .\node_modules\.bin\tauri.exe build$buildArgs"
exit $LASTEXITCODE
