# install.ps1 — Windows counterpart of install.sh.
#
# Symlinks the deploy/.claude/ defaults into ~/.claude/ and creates the
# ~/AGENTS.md cross-tool alias, so `git pull` inside the pms repo updates the
# universal CLAUDE.md on this machine. Idempotent — re-runs are safe.
#
# SCOPE: this script intentionally links ONLY ~/.claude/. It does NOT touch
# ~/.config/opencode/ (Windows opencode config is managed separately to avoid
# clobbering a working local setup). The Linux install.sh links both.
#
# REQUIREMENT: Windows blocks symlink creation for non-admins unless
# Developer Mode is on (Settings -> Privacy & security -> For developers).
# Run from an elevated shell if Developer Mode is off.
#
# Usage:  pwsh -File deploy\install.ps1     (or)  powershell -File deploy\install.ps1

$ErrorActionPreference = 'Stop'

$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HomeDir   = $HOME
if (-not $HomeDir) { $HomeDir = $env:USERPROFILE }
if (-not $HomeDir) { Write-Error 'Cannot resolve home directory ($HOME / $env:USERPROFILE both empty).'; exit 1 }

# --- Symlink capability check -------------------------------------------------
$devMode = $false
try {
  $k = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction Stop
  $devMode = ($k.AllowDevelopmentWithoutDevLicense -eq 1)
} catch { $devMode = $false }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not ($devMode -or $isAdmin)) {
  Write-Warning 'Symlinks need Developer Mode (Settings -> Privacy & security -> For developers) or an elevated shell.'
  Write-Warning 'Neither detected. Enable Developer Mode or re-run as admin, then try again.'
}

function Link-Contents {
  param([string]$Src, [string]$Dest, [string]$Label)
  if (-not (Test-Path $Src)) { Write-Error "ERROR: $Src does not exist"; return }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Write-Host ''
  Write-Host "-- $Label --"
  Write-Host "  src:  $Src"
  Write-Host "  dest: $Dest"
  foreach ($f in Get-ChildItem -Force $Src) {
    $destFile = Join-Path $Dest $f.Name
    $existing = Get-Item -LiteralPath $destFile -Force -ErrorAction SilentlyContinue
    if ($existing -and -not $existing.LinkType) {
      $backup = "$destFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Write-Host "  backup: $($f.Name) -> $(Split-Path -Leaf $backup)"
      Move-Item -LiteralPath $destFile -Destination $backup
    } elseif ($existing -and $existing.LinkType) {
      Remove-Item -LiteralPath $destFile -Force
    }
    Write-Host "  link:   $($f.Name)"
    New-Item -ItemType SymbolicLink -Path $destFile -Target $f.FullName | Out-Null
  }
}

# 1. ~/.claude/ (universal wizard context)
Link-Contents (Join-Path $DeployDir '.claude') (Join-Path $HomeDir '.claude') '~/.claude/'

# 2. ~/AGENTS.md cross-tool alias -> ~/.claude/CLAUDE.md
$claudeMd = Join-Path $HomeDir '.claude\CLAUDE.md'
$agentsMd = Join-Path $HomeDir 'AGENTS.md'
if (Test-Path $claudeMd) {
  $ex = Get-Item -LiteralPath $agentsMd -Force -ErrorAction SilentlyContinue
  if ($ex -and -not $ex.LinkType) { Move-Item -LiteralPath $agentsMd -Destination "$agentsMd.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" }
  elseif ($ex -and $ex.LinkType) { Remove-Item -LiteralPath $agentsMd -Force }
  New-Item -ItemType SymbolicLink -Path $agentsMd -Target $claudeMd | Out-Null
  Write-Host ''
  Write-Host '-- ~/AGENTS.md --'
  Write-Host '  link: -> ~/.claude/CLAUDE.md  (cross-tool alias)'
}

Write-Host ''
Write-Host '==================================================================='
Write-Host ' Done. ~/.claude/ is symlinked to the oh-my-opencode-pms deploy dir.'
Write-Host ' Update:  cd ~/Code/oh-my-opencode-pms; git pull'
Write-Host ' Capture: cd ~/Code/oh-my-opencode-pms; git add -A; git commit; git push'
Write-Host '==================================================================='
