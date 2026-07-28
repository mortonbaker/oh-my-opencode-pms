<#
.SYNOPSIS
  Launch wrapper for the OpenCodeWebUI NSSM service.

.DESCRIPTION
  The NSSM service runs this instead of `opencode web` directly so that, on
  every (re)start, the service environment is correct on Windows:
    1. PATH includes the Python Scripts dir (so opencode-memsearch's `which
       memsearch` resolves) and bun/npm bins. A LocalSystem service does NOT
       inherit the interactive user PATH, so we set it explicitly here.
    2. The pms plugin cache is dereferenced (see fix-pms-cache.ps1) so the
       pantheon loads despite the opencode-on-Windows symlink/containment bug.
    3. Finally launches `opencode web`.

  Keep AppEnvironmentExtra on the service setting HOME/USERPROFILE/APPDATA to the
  real user profile (install-webui-service.ps1 does this) so the paths below
  resolve to the user's profile, not the system profile.
#>
$ErrorActionPreference = 'Continue'
$user = $env:USERPROFILE
$appdata = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $user 'AppData\Roaming' }

# --- 1. PATH augmentation ---------------------------------------------------
$extra = @()
# Python user-scripts (memsearch.exe) — match any Python3xx.
Get-ChildItem (Join-Path $appdata 'Python') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { $s = Join-Path $_.FullName 'Scripts'; if (Test-Path $s) { $extra += $s } }
$extra += (Join-Path $user '.bun\bin')
$extra += (Join-Path $appdata 'npm')
foreach ($p in $extra) { if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$env:PATH;$p" } }

# --- 2. Reap stale service-session opencode servers ------------------------
# opencode web can leave a detached server (and orphaned listening socket)
# after a service restart, causing "Failed to start server. Is port N in use?".
# The service runs in session 0; the operator's INTERACTIVE opencode sessions
# run in session 1+. So we reap only session-0 opencode processes — never the
# interactive ones. Running as LocalSystem, we have the rights to do so.
Get-Process -Name opencode -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq 0 } |
  ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }
Start-Sleep -Milliseconds 800

# --- 3. Dereference the pms plugin cache (idempotent) -----------------------
$fix = Join-Path $PSScriptRoot 'fix-pms-cache.ps1'
if (Test-Path $fix) { & $fix }

# --- 4. Launch opencode web -------------------------------------------------
$oc = Join-Path $appdata 'npm\node_modules\opencode-ai\bin\opencode.exe'
if (-not (Test-Path $oc)) {
  $cmd = Get-Command opencode -ErrorAction SilentlyContinue
  if ($cmd) { $oc = $cmd.Source }
}
if (-not (Test-Path $oc)) { Write-Error "opencode binary not found"; exit 1 }
& $oc web
