<#
.SYNOPSIS
  Recover the OpenCodeWebUI service when it's stuck (port wedged by an orphaned
  socket, or NSSM in a throttled/Paused restart loop). Run elevated (admin).

.DESCRIPTION
  Symptom: `opencode web` fails with "Failed to start server. Is port N in use?"
  even though no live process listens — a child process inherited a dead
  parent's listening-socket handle (common after reconfiguring/killing the
  service mid-flight on Windows).

  This stops the service, reaps the entire stale service-session (session 0)
  opencode/node tree to release inherited handles, waits for the port to clear,
  and only then restarts. If the port is STILL wedged (truly kernel-orphaned),
  it reports that a reboot (or a port change in opencode.json) is required —
  rather than leaving NSSM in a failing loop.
#>
param([int]$Port = 4096, [string]$Service = 'OpenCodeWebUI')
$ErrorActionPreference = 'Continue'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) { throw 'Run this from an elevated (Administrator) PowerShell.' }

# Honor the configured port from machine-local opencode.json.
try {
  $cfg = Get-Content (Join-Path $env:USERPROFILE '.config\opencode\opencode.json') -Raw -ErrorAction Stop | ConvertFrom-Json
  if ($cfg.server.port) { $Port = [int]$cfg.server.port }
} catch {}

Write-Host "1. stopping $Service ..."
Stop-Service $Service -Force -ErrorAction SilentlyContinue
sc.exe stop $Service | Out-Null   # ensure NSSM throttle/pause is cleared
Start-Sleep -Seconds 2

Write-Host "2. reaping session-0 opencode/node (service session only; interactive sessions untouched) ..."
Get-Process -Name opencode, node -ErrorAction SilentlyContinue |
  Where-Object { $_.SessionId -eq 0 } |
  ForEach-Object { Write-Host "   kill $($_.ProcessName) PID $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

Write-Host "3. testing whether port $Port is free ..."
$free = $false
try { $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port); $l.Start(); $l.Stop(); $free = $true } catch { $free = $false }

if (-not $free) {
  Write-Host ''
  Write-Host "PORT $Port IS STILL WEDGED (orphaned kernel socket)." -ForegroundColor Yellow
  Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Group-Object State | Select-Object Count, Name | Format-Table -AutoSize
  Write-Host "Resolution options:"
  Write-Host "  a) Reboot (clears the orphaned socket; service auto-starts clean on boot), OR"
  Write-Host "  b) Change the port: set server.port in ~/.config/opencode/opencode.json to a free"
  Write-Host "     port (e.g. 4097), then run install-webui-service.ps1 -Port 4097 and restart."
  Write-Host "Service left STOPPED to avoid a failing restart loop."
  exit 1
}

Write-Host "   port $Port is FREE."
Write-Host "4. starting $Service ..."
Start-Service $Service
Start-Sleep -Seconds 6
$st = (Get-Service $Service).Status
Write-Host "   $Service status: $st"
$owner = (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess
Write-Host "   port $Port listener PID: $owner"
if ($st -eq 'Running' -and $owner) { Write-Host "OK: webui is up on port $Port." } else { Write-Host "Service not fully up; check $env:LOCALAPPDATA\opencode-webui-stderr.log" }
