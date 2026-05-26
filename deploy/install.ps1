<#
.SYNOPSIS
  Windows counterpart of install.sh — deploy ~/.claude/ defaults from the
  oh-my-opencode-pms repo so the universal CLAUDE.md is live on this machine.

.DESCRIPTION
  Prefers SYMLINKS (edit-once, `git pull` reflects instantly). If symlink
  creation isn't permitted (Developer Mode off AND not elevated), falls back
  to COPY mode automatically — in which case you must RE-RUN this script after
  each `git pull` to refresh ~/.claude/CLAUDE.md.

  SCOPE: deploys ONLY ~/.claude/ (and the ~/AGENTS.md alias). It does NOT
  touch ~/.config/opencode/ — Windows opencode config is managed separately.

.PARAMETER Copy
  Force copy mode even when symlinks are available.

.EXAMPLE
  powershell -File deploy\install.ps1
  powershell -File deploy\install.ps1 -Copy
#>
param([switch]$Copy)
$ErrorActionPreference = 'Stop'

$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HomeDir = if ($HOME) { $HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { throw 'Cannot resolve home directory.' }

# --- Symlink capability ------------------------------------------------------
$devMode = $false
try {
  $devMode = ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction Stop).AllowDevelopmentWithoutDevLicense -eq 1)
} catch { $devMode = $false }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
$canSymlink = (($devMode -or $isAdmin) -and -not $Copy)
$mode = if ($canSymlink) { 'symlink' } else { 'copy' }
Write-Host "Mode: $mode  (devMode=$devMode admin=$isAdmin forceCopy=$Copy)"

function Deploy-One {
  param([string]$Src, [string]$Dest)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $ex = Get-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
  if ($ex) {
    if ($ex.LinkType) { Remove-Item -LiteralPath $Dest -Force }
    else {
      Move-Item -LiteralPath $Dest -Destination "$Dest.bak-$stamp"
      Write-Host "  backup: $(Split-Path -Leaf $Dest) -> $(Split-Path -Leaf $Dest).bak-$stamp"
    }
  }
  if ($canSymlink) {
    New-Item -ItemType SymbolicLink -Path $Dest -Target $Src | Out-Null
    Write-Host "  link:   $Dest"
  } else {
    Copy-Item -LiteralPath $Src -Destination $Dest -Force
    Write-Host "  copy:   $Dest"
  }
}

# 1. ~/.claude/*  (universal wizard context)
$srcClaude  = Join-Path $DeployDir '.claude'
$destClaude = Join-Path $HomeDir '.claude'
if (-not (Test-Path $srcClaude)) { throw "ERROR: $srcClaude does not exist" }
New-Item -ItemType Directory -Force -Path $destClaude | Out-Null
Write-Host ''
Write-Host '-- ~/.claude/ --'
foreach ($f in Get-ChildItem -Force $srcClaude) {
  Deploy-One $f.FullName (Join-Path $destClaude $f.Name)
}

# 2. ~/AGENTS.md cross-tool alias -> CLAUDE.md
$claudeMd = Join-Path $destClaude 'CLAUDE.md'
$agentsMd = Join-Path $HomeDir 'AGENTS.md'
if (Test-Path $claudeMd) {
  Write-Host ''
  Write-Host '-- ~/AGENTS.md --'
  # symlink: point at the local ~/.claude/CLAUDE.md; copy: copy canonical content
  $agentsSrc = if ($canSymlink) { $claudeMd } else { (Join-Path $srcClaude 'CLAUDE.md') }
  Deploy-One $agentsSrc $agentsMd
}

Write-Host ''
Write-Host '==================================================================='
if ($mode -eq 'copy') {
  Write-Host ' COPY mode: ~/.claude/CLAUDE.md is a COPY of the repo file.'
  Write-Host ' Re-run this script after `git pull` to refresh:'
  Write-Host '   cd ~/Code/oh-my-opencode-pms; git pull; powershell -File deploy\install.ps1'
  Write-Host ' (Enable Developer Mode to upgrade to symlinks automatically.)'
} else {
  Write-Host ' SYMLINK mode: `git pull` in the repo updates ~/.claude/ instantly.'
}
Write-Host '==================================================================='
