<#
.SYNOPSIS
  Install/reconfigure the OpenCodeWebUI NSSM service (the Windows analog of
  deploy/systemd-user/* on Linux). REQUIRES an elevated (admin) shell.

.DESCRIPTION
  Runs `opencode web` as a Windows service via NSSM, through the launch wrapper
  (opencode-webui-launch.ps1) which fixes PATH + the pms plugin cache on each
  start. Idempotent: reconfigures the service if it already exists.

  The server password is a secret and is NOT stored in the repo. Pass it via
  -ServerPassword, or the script reuses the value already configured on an
  existing service.

.PARAMETER ServerPassword
  Value for OPENCODE_SERVER_PASSWORD (the webui access password).
.PARAMETER Port
  Webui port (default 4096). Also set the matching `server` block in the
  machine-local ~/.config/opencode/opencode.json.
.PARAMETER UserProfile
  The user profile the service should run "as" (env HOME/USERPROFILE). Defaults
  to the current user's profile.
#>
param(
  [string]$ServerPassword,
  [int]$Port = 4096,
  [string]$UserProfile = $env:USERPROFILE
)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { throw 'This script must be run from an elevated (Administrator) PowerShell.' }

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  $nssm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*win64*' } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $nssm) { throw 'nssm.exe not found. Install with: winget install NSSM.NSSM' }

$svc = 'OpenCodeWebUI'
$wrapper = Join-Path $PSScriptRoot 'opencode-webui-launch.ps1'
if (-not (Test-Path $wrapper)) { throw "launch wrapper not found: $wrapper" }
$psexe = (Get-Command powershell.exe).Source
$params = "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`""
$appdata = Join-Path $UserProfile 'AppData\Roaming'
$localapp = Join-Path $UserProfile 'AppData\Local'

$exists = Get-Service $svc -ErrorAction SilentlyContinue
if (-not $exists) {
  if (-not $ServerPassword) { throw 'New service: -ServerPassword is required.' }
  & $nssm install $svc $psexe $params | Out-Null
  Write-Host "installed service $svc"
} else {
  & $nssm set $svc Application $psexe | Out-Null
  & $nssm set $svc AppParameters $params | Out-Null
  Write-Host "reconfigured existing service $svc to use the launch wrapper"
  if (-not $ServerPassword) {
    # Reuse existing password from the service config.
    $existingEnv = (& $nssm get $svc AppEnvironmentExtra) -join "`n"
    $m = [regex]::Match($existingEnv, 'OPENCODE_SERVER_PASSWORD=([^\r\n]+)')
    if ($m.Success) { $ServerPassword = $m.Groups[1].Value }
  }
}

& $nssm set $svc AppDirectory $UserProfile | Out-Null
$envBlock = @(
  "HOME=$UserProfile"
  "USERPROFILE=$UserProfile"
  "APPDATA=$appdata"
  "LOCALAPPDATA=$localapp"
) + $(if ($ServerPassword) { @("OPENCODE_SERVER_PASSWORD=$ServerPassword") } else { @() })
# NSSM takes each KEY=VAL as a separate argument (array unrolls).
& $nssm set $svc AppEnvironmentExtra $envBlock | Out-Null
& $nssm set $svc AppStdout (Join-Path $localapp 'opencode-webui-stdout.log') | Out-Null
& $nssm set $svc AppStderr (Join-Path $localapp 'opencode-webui-stderr.log') | Out-Null
& $nssm set $svc Start SERVICE_AUTO_START | Out-Null

Write-Host "restarting $svc ..."
Restart-Service $svc -Force
Start-Sleep -Seconds 3
Get-Service $svc | Select-Object Name, Status
Write-Host "webui should be on http://localhost:$Port (also tailnet/LAN). Ensure opencode.json 'server.port' matches."
