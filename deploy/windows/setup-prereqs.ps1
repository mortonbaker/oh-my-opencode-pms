<#
.SYNOPSIS
  Install/verify Windows runtime prerequisites for the oh-my-opencode-pms harness.

.DESCRIPTION
  Idempotent. Run once per machine (no elevation required for the user-scope
  steps). Covers the Windows-specific gaps that the Linux box gets "for free":
    - memsearch Python backend (the opencode-memsearch plugin shells out to it)
    - Python user-scripts dir on PATH (so `which memsearch` resolves)
    - bun global cache health (the rename-into-cache ENOTEMPTY bug on Windows)
    - presence checks for bun / gh / nssm / opencode (warn, don't fail)
#>
$ErrorActionPreference = 'Continue'

function Have($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host '== presence checks =='
foreach ($t in 'node','npm','python','git','gh','bun','nssm','opencode') {
  $c = Get-Command $t -ErrorAction SilentlyContinue
  if ($c) { Write-Host ("  ok   {0,-9} {1}" -f $t, $c.Source) }
  else    { Write-Host ("  MISS {0,-9} (install required for full functionality)" -f $t) }
}

Write-Host ''
Write-Host '== memsearch (opencode-memsearch backend) =='
if (Have 'memsearch') {
  Write-Host "  memsearch present: $((Get-Command memsearch).Source)"
} else {
  Write-Host '  installing memsearch[onnx] via pip --user ...'
  python -m pip install --user 'memsearch[onnx]' 2>&1 | Select-Object -Last 2 | ForEach-Object { "    $_" }
}

# Ensure the Python user-scripts dir is on the User PATH (memsearch.exe lives there).
$scripts = Get-ChildItem (Join-Path $env:APPDATA 'Python') -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'Scripts' } | Where-Object { Test-Path (Join-Path $_ 'memsearch.exe') } | Select-Object -First 1
if ($scripts) {
  $cur = [Environment]::GetEnvironmentVariable('PATH','User')
  if ($cur -notlike "*$scripts*") {
    [Environment]::SetEnvironmentVariable('PATH', ($cur.TrimEnd(';') + ';' + $scripts), 'User')
    Write-Host "  added to User PATH: $scripts"
  } else { Write-Host "  already on User PATH: $scripts" }
  $env:PATH = "$env:PATH;$scripts"
}

Write-Host ''
Write-Host '== bun global cache health =='
# The Windows rename-into-cache bug (ENOTEMPTY / locked files) can corrupt the
# default cache and break `bun install`. If the default cache looks wedged,
# redirect bun to a fresh cache dir (user-scope, persistent).
$bunCache = Join-Path $env:USERPROFILE '.bun\install\cache'
if ((Have 'bun') -or (Test-Path (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'))) {
  $redirect = [Environment]::GetEnvironmentVariable('BUN_INSTALL_CACHE_DIR','User')
  if (-not $redirect) {
    $fresh = Join-Path $env:USERPROFILE '.bun\install\cache-v2'
    New-Item -ItemType Directory -Force -Path $fresh | Out-Null
    [Environment]::SetEnvironmentVariable('BUN_INSTALL_CACHE_DIR', $fresh, 'User')
    Write-Host "  set BUN_INSTALL_CACHE_DIR -> $fresh (avoids corrupted default cache)"
    Write-Host "  NOTE: if 'bun install' still fails with ENOTEMPTY, add a Windows Defender"
    Write-Host "        exclusion for ~/.bun and clear the old cache from an elevated shell."
  } else { Write-Host "  BUN_INSTALL_CACHE_DIR already set -> $redirect" }
}

Write-Host ''
Write-Host 'Prereq setup complete. Open a NEW shell to pick up PATH changes.'
