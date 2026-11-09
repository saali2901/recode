# ReCode installer for Windows.
#
#   irm https://raw.githubusercontent.com/saali2901/recode/main/install.ps1 | iex
#
# ReCode runs on Linux and macOS. On Windows it runs inside WSL2 (Ubuntu), which this script sets up:
#   1. installs WSL2 + Ubuntu if missing (a restart may be required; run this script again afterwards)
#   2. runs the ReCode Linux installer inside Ubuntu
#   3. creates a "recode" command for PowerShell/cmd that forwards to WSL
#
# Test a branch:  $env:RECODE_REF='installer'; $env:RECODE_INSTALL_URL='https://raw.githubusercontent.com/saali2901/recode/installer/install.sh'
#
# NOTE: this script has not been tested on a real Windows machine yet. Please report problems.

$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu'
$InstallUrl = if ($env:RECODE_INSTALL_URL) { $env:RECODE_INSTALL_URL } else { 'https://raw.githubusercontent.com/saali2901/recode/main/install.sh' }

function Say($text) { Write-Host "==> $text" -ForegroundColor Cyan }

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'wsl.exe was not found. Use Windows 10 version 2004 or newer / Windows 11.'
}

$installed = (wsl.exe -l -q 2>$null | Out-String) -replace "`0", ''
if ($installed -notmatch $Distro) {
    Say "Installing WSL2 with $Distro (needs administrator rights; a restart may be required)"
    wsl.exe --install -d $Distro
    Write-Host ''
    Write-Host "Finish the Ubuntu setup (user name and password), restart Windows if asked, then run this installer again." -ForegroundColor Yellow
    return
}

Say 'Running the ReCode installer inside WSL (Ubuntu)'
# Optional overrides (e.g. to test a branch) are forwarded into WSL.
$envPrefix = ''
foreach ($name in 'RECODE_REF', 'RECODE_REPO') {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $envPrefix += "$name='$value' " }
}
wsl.exe -d $Distro -- bash -lc "curl -fsSL '$InstallUrl' | $envPrefix bash"
if ($LASTEXITCODE -ne 0) { throw "The installer failed inside WSL (exit code $LASTEXITCODE)." }

$binDir = Join-Path $env:LOCALAPPDATA 'recode\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Set-Content -Path (Join-Path $binDir 'recode.cmd') -Encoding ASCII -Value "@wsl.exe -d $Distro -- bash -lc `"`$HOME/.local/bin/recode %*`""

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
}

Say 'Done. Open a new terminal and run:  recode doctor'
Write-Host 'Log in to Claude Code once:  wsl -d Ubuntu -- claude'
Write-Host 'Web interface:               recode ui   (then open the printed address in your Windows browser)'
