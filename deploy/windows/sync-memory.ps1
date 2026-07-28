<#
.SYNOPSIS
  Windows port of scripts/sync-memory.sh — git push of the agent-memory store.

.DESCRIPTION
  Pushes new entries in ~/.local/share/agent-memory/ to the private GitHub
  mirror so other tailnet machines see them on next pull. Run every 15 min via
  Task Scheduler (see register-tasks.ps1). Idempotent — no-op when clean.
  Always exits 0 (advisory; never break the scheduled task).
#>
$ErrorActionPreference = 'Continue'

$memDir = if ($env:AGENT_MEMORY_DIR) { $env:AGENT_MEMORY_DIR } else { Join-Path $env:USERPROFILE '.local\share\agent-memory' }
$log = Join-Path $env:TEMP 'agent-memory-sync.log'

function Write-Log($msg) { "[{0}] {1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $msg | Add-Content -LiteralPath $log }

if (-not (Test-Path (Join-Path $memDir '.git'))) {
  Write-Log "ERROR: $memDir is not a git repo - run deploy\install.ps1"
  exit 0
}

Push-Location $memDir
try {
  git pull --rebase --autostash 2>&1 | Out-Null
  git add -A 2>&1 | Out-Null
  $status = git status --porcelain
  if (-not $status) { Write-Log 'clean - no push'; exit 0 }

  $count = ($status | Measure-Object -Line).Lines
  $host = $env:COMPUTERNAME
  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $msg = "sync: $count changes from $host at $ts"

  git -c commit.gpgsign=false commit -m $msg 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Log 'ERROR: commit failed'; exit 0 }
  git push 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Log "OK: $msg" } else { Write-Log 'WARN: push failed (will retry next run)' }
} finally {
  Pop-Location
}
exit 0
