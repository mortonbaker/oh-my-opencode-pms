<#
.SYNOPSIS
  Dereference the oh-my-opencode-pms plugin in opencode's plugin cache so it
  loads on Windows.

.DESCRIPTION
  WHY THIS EXISTS (opencode-on-Windows bug):
  opencode auto-installs the bare-name plugin "oh-my-opencode-pms" into
    ~/.cache/opencode/packages/oh-my-opencode-pms@latest/node_modules/oh-my-opencode-pms
  via a `file:` dependency on the local repo. On Windows, bun installs `file:`
  deps by SYMLINKING individual files (dist/index.js, package.json) back to the
  repo. opencode then resolves the plugin's server entry with realpathSync,
  which follows that symlink OUT of the plugin directory; its containment check
  (packages/opencode/src/util/filesystem.ts `contains()` over `path.relative`)
  sees the repo path as "outside plugin directory" and rejects the plugin with:
    "Plugin oh-my-opencode-pms resolved server entry outside plugin directory"
  On Linux the same `file:` install copies real files, so it passes.

  FIX: replace the symlinked cache copy with a real, dereferenced copy of the
  repo's published files so every path realpaths INSIDE the plugin directory.
  Idempotent: only rewrites when a symlinked entry is detected. Run on every
  webui launch (see opencode-webui-launch.ps1) so it survives opencode
  reinstalling the plugin.

.PARAMETER RepoDir
  Path to the oh-my-opencode-pms repo. Defaults to ~/Code/oh-my-opencode-pms.
#>
param([string]$RepoDir = (Join-Path $env:USERPROFILE 'Code\oh-my-opencode-pms'))
$ErrorActionPreference = 'Continue'

$cacheRoot = Join-Path $env:USERPROFILE '.cache\opencode\packages'
if (-not (Test-Path $cacheRoot)) { Write-Host 'fix-pms-cache: no opencode plugin cache yet; nothing to do.'; exit 0 }

# Find every cached oh-my-opencode-pms@<ver> install.
$targets = Get-ChildItem $cacheRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'oh-my-opencode-pms@*' }
if (-not $targets) { Write-Host 'fix-pms-cache: pms not in cache; nothing to do.'; exit 0 }

if (-not (Test-Path (Join-Path $RepoDir 'dist\index.js'))) {
  Write-Host "fix-pms-cache: repo dist not found at $RepoDir (run 'bun run build' there). Skipping."
  exit 0
}

foreach ($t in $targets) {
  $inner = Join-Path $t.FullName 'node_modules\oh-my-opencode-pms'
  if (-not (Test-Path $inner)) { continue }

  # Detect a symlinked entry: if dist/index.js is a reparse point (LinkType set)
  # or missing, the cache needs (re)populating with a real copy.
  $entry = Join-Path $inner 'dist\index.js'
  $isLink = $true
  if (Test-Path $entry) {
    $item = Get-Item $entry -Force -ErrorAction SilentlyContinue
    if ($item -and -not $item.LinkType) { $isLink = $false }
  }

  if (-not $isLink) { Write-Host "fix-pms-cache: $($t.Name) already real; ok."; continue }

  Write-Host "fix-pms-cache: dereferencing $($t.Name) ..."
  Remove-Item $inner -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $inner | Out-Null
  # Copy the published file set as REAL files (robocopy follows/derefs symlinks).
  robocopy $RepoDir $inner package.json oh-my-opencode-slim.schema.json LICENSE README.md /NJH /NJS /NFL /NDL /NP | Out-Null
  robocopy (Join-Path $RepoDir 'dist') (Join-Path $inner 'dist') /E /NJH /NJS /NFL /NDL /NP | Out-Null
  if (Test-Path (Join-Path $RepoDir 'src\skills')) {
    robocopy (Join-Path $RepoDir 'src\skills') (Join-Path $inner 'src\skills') /E /NJH /NJS /NFL /NDL /NP | Out-Null
  }
  Write-Host "fix-pms-cache: $($t.Name) dereferenced (real copy)."
}
exit 0
