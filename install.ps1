# ReCode installer for Windows (native, no WSL needed).
#
#   irm https://raw.githubusercontent.com/saali2901/recode/main/install.ps1 | iex
#
# What it does:
#   1. installs Git and Node.js LTS with winget if they are missing
#   2. downloads ReCode, builds it and creates the "recode" command (%LOCALAPPDATA%\recode)
#   3. runs "recode setup", which installs the rest with winget/official downloads:
#      JDK 21, CMake, Ninja, MinGW-w64 (gcc), Ghidra (SHA-256 verified), Claude Code
#
# Windows may show administrator (UAC) prompts for some packages.
#
# Options (environment variables, because "irm | iex" cannot take parameters):
#   RECODE_WSL=1       use WSL2/Ubuntu instead of native Windows
#   RECODE_REF=<branch>  RECODE_REPO=<git url>   install a different branch/fork (default: main)
#   RECODE_NO_SETUP=1  skip step 3 (run "recode setup" later)
#
# NOTE: this script has not been tested on a real Windows machine yet. Please report problems.

$ErrorActionPreference = 'Stop'

$Repo = if ($env:RECODE_REPO) { $env:RECODE_REPO } else { 'https://github.com/saali2901/recode' }
$Ref = if ($env:RECODE_REF) { $env:RECODE_REF } else { 'main' }
$Root = Join-Path $env:LOCALAPPDATA 'recode'
$AppDir = Join-Path $Root 'app'
$BinDir = Join-Path $Root 'bin'

function Say($text) { Write-Host "==> $text" -ForegroundColor Cyan }

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Invoke-Checked([string]$what, [scriptblock]$block) {
    & $block
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

function Install-WithWinget([string]$id) {
    Say "Installing $id with winget"
    winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements
    # 0 = installed; -1978335189 (0x8A15002B) = already installed / no update applicable
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) { throw "winget could not install $id (exit code $LASTEXITCODE)." }
    Update-SessionPath
}

function Test-NodeVersion {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $v = [version](((& node -v) -replace '^v', '') -replace '-.*$', '')
    return ($v.Major -gt 20) -or ($v.Major -eq 20 -and $v.Minor -ge 11)
}

# ---------------------------------------------------------------------------------------------------
if ($env:RECODE_WSL -eq '1') {
    # Optional route through WSL2 (Linux installer inside Ubuntu).
    $Distro = 'Ubuntu'
    $InstallUrl = if ($env:RECODE_INSTALL_URL) { $env:RECODE_INSTALL_URL } else { "https://raw.githubusercontent.com/saali2901/recode/$Ref/install.sh" }
    $installed = (wsl.exe -l -q 2>$null | Out-String) -replace "`0", ''
    if ($installed -notmatch $Distro) {
        Say "Installing WSL2 with $Distro (needs administrator rights; a restart may be required)"
        wsl.exe --install -d $Distro
        Write-Host 'Finish the Ubuntu setup, restart Windows if asked, then run this installer again.' -ForegroundColor Yellow
        return
    }
    Say 'Running the ReCode installer inside WSL (Ubuntu)'
    # "pipefail" makes a failing curl fail the whole command instead of being hidden by the pipe.
    wsl.exe -d $Distro -- bash -lc "set -o pipefail; curl -fsSL '$InstallUrl' | RECODE_REF='$Ref' RECODE_REPO='$Repo' bash"
    if ($LASTEXITCODE -ne 0) { throw "The installer failed inside WSL (exit code $LASTEXITCODE)." }
    return
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget was not found. Install "App Installer" from the Microsoft Store (Windows 10 1809+ / Windows 11) and run this again.'
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Install-WithWinget 'Git.Git' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is installed but not yet available. Open a new PowerShell window and run the installer again.' }

if (-not (Test-NodeVersion)) { Install-WithWinget 'OpenJS.NodeJS.LTS' }
if (-not (Test-NodeVersion)) { throw 'Node.js is installed but not yet available. Open a new PowerShell window and run the installer again.' }

Say "Downloading ReCode ($Ref)"
New-Item -ItemType Directory -Force -Path $Root, $BinDir | Out-Null
if (Test-Path (Join-Path $AppDir '.git')) {
    Invoke-Checked 'git fetch' { git -C $AppDir fetch --depth 1 origin $Ref }
    Invoke-Checked 'git checkout' { git -C $AppDir checkout -q -f FETCH_HEAD }
} else {
    if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
    Invoke-Checked 'git clone' { git clone --depth 1 --branch $Ref $Repo $AppDir }
}

Say 'Building ReCode (this takes a minute)'
Push-Location $AppDir
try {
    Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }
    Invoke-Checked 'npm run build' { npm run build }
} finally { Pop-Location }

$nodeExe = (Get-Command node).Source
Set-Content -Path (Join-Path $BinDir 'recode.cmd') -Encoding ASCII -Value "@`"$nodeExe`" `"$AppDir\dist\index.js`" %*"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
}
$env:Path = "$env:Path;$BinDir"

if ($env:RECODE_NO_SETUP -ne '1') {
    Say 'Installing the remaining tools (JDK, CMake, Ninja, gcc, Ghidra, Claude Code)'
    & (Join-Path $BinDir 'recode.cmd') setup --yes
    if ($LASTEXITCODE -ne 0) { throw "recode setup failed (exit code $LASTEXITCODE). Fix the message above and run: recode setup" }
}

Say 'Done. Open a NEW PowerShell window and run:'
Write-Host '  claude          # once: log in with your Claude subscription'
Write-Host '  recode doctor   # every line should show OK'
Write-Host '  recode ui       # web interface'
