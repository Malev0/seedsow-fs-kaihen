# Stop the bridge + console RPC loop, re-upload/reload the shim, restart the bridge.
# Usage: powershell -ExecutionPolicy Bypass -File .\restart-rpc.ps1 [-Slow]
param([switch]$Slow)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$env:NS2_FAST = if ($Slow) { '0' } else { '1' }
$TOOLS = Join-Path $PSScriptRoot 'tools'
$CONSOLE = Join-Path $PSScriptRoot 'console'

Write-Output '=== stop bridge + console serve loop ==='
node (Join-Path $TOOLS 'rpc-tool.cjs') stop-all 2>&1 | Out-String | Write-Output
Start-Sleep -Milliseconds 800

Write-Output '=== upload/reload shim ==='
python (Join-Path $TOOLS 'upload_save.py') (Join-Path $CONSOLE 'n2h_rpc.lua') 'n2h_rpc.lua'
python (Join-Path $TOOLS 'post_eval.py') (Join-Path $CONSOLE 'reload_rpc.lua')
if ($LASTEXITCODE -ne 0) { Write-Output 'shim reload failed'; exit 1 }

# Mount accessor/service addresses are per-boot: after ANY game relaunch this
# MUST run before the probe, or the mount clone dereferences stale pointers.
Write-Output '=== refresh mounts (per-boot addresses) ==='
python (Join-Path $TOOLS 'refresh_mounts.py')
if ($LASTEXITCODE -ne 0) { Write-Output 'refresh mounts failed'; exit 1 }

Write-Output '=== start bridge ==='
$p = Start-Process -FilePath node -ArgumentList (Join-Path $TOOLS 'seedsow-bridge.cjs') -WorkingDirectory $PSScriptRoot `
  -RedirectStandardOutput (Join-Path $PSScriptRoot 'bridge.log') `
  -RedirectStandardError (Join-Path $PSScriptRoot 'bridge.err') -PassThru
Start-Sleep -Seconds 3
Write-Output "bridge pid=$($p.Id) fast=$($env:NS2_FAST)"
Get-Content (Join-Path $PSScriptRoot 'bridge.log') -Tail 5 -ErrorAction SilentlyContinue
Get-Content (Join-Path $PSScriptRoot 'bridge.err') -Tail 5 -ErrorAction SilentlyContinue
node (Join-Path $TOOLS 'rpc-tool.cjs') status
