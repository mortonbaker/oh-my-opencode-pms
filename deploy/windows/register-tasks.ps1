<#
.SYNOPSIS
  Register the Windows Task Scheduler jobs that mirror the Linux cron table
  (docs/HARNESS.md). Run from an elevated shell.

.DESCRIPTION
  Linux schedules these via cron:
    */15 * * * *  scripts/sync-memory.sh      -> push agent-memory
    daily         scripts/refresh-inventory.sh
    weekly (Sun)  scripts/weekly-review.sh
  On Windows we use Task Scheduler. This registers the 15-minute memory sync
  (the critical one for cross-machine memory parity) running as the current
  user. The daily/weekly jobs are registered too IF a .ps1 port exists in this
  directory (refresh-inventory.ps1 / weekly-review.ps1); otherwise they're
  skipped with a note.
#>
$ErrorActionPreference = 'Stop'
$psexe = (Get-Command powershell.exe).Source
$user  = "$env:USERDOMAIN\$env:USERNAME"

function Register-One {
  param([string]$Name, [string]$Script, [Microsoft.Management.Infrastructure.CimInstance]$Trigger, [string]$Desc)
  $full = Join-Path $PSScriptRoot $Script
  if (-not (Test-Path $full)) { Write-Host "  skip $Name (no $Script yet)"; return }
  $action   = New-ScheduledTaskAction -Execute $psexe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$full`""
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal= New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger -Settings $settings -Principal $principal -Description $Desc -Force | Out-Null
  Write-Host "  registered: $Name"
}

# 15-minute memory sync.
$every15 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-One -Name 'omopms-sync-memory' -Script 'sync-memory.ps1' -Trigger $every15 -Desc 'oh-my-opencode-pms: push agent-memory store every 15 min'

# Daily inventory (only if a port exists).
$daily = New-ScheduledTaskTrigger -Daily -At 6am
Register-One -Name 'omopms-refresh-inventory' -Script 'refresh-inventory.ps1' -Trigger $daily -Desc 'oh-my-opencode-pms: daily inventory refresh'

# Weekly review (Sundays 06:00).
$weekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 6am
Register-One -Name 'omopms-weekly-review' -Script 'weekly-review.ps1' -Trigger $weekly -Desc 'oh-my-opencode-pms: weekly review digest'

Write-Host ''
Write-Host 'Done. Inspect with:  Get-ScheduledTask -TaskName omopms-*'
