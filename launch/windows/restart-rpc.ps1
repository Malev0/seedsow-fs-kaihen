# Stop the bridge + console RPC loop, re-upload/reload the shim, restart the bridge.
# Usage: powershell -ExecutionPolicy Bypass -File .\launch\windows\restart-rpc.ps1 [-Slow]
param([switch]$Slow)
# The repository root is two levels above this file (launch/windows).
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ErrorActionPreference = 'Continue'
Set-Location $ROOT

$env:NS2_FAST = if ($Slow) { '0' } else { '1' }
$TOOLS = Join-Path $ROOT 'tools'
$CONSOLE = Join-Path $ROOT 'console'

Write-Output '=== stop bridge + console serve loop ==='
node (Join-Path $TOOLS 'rpc-tool.cjs') stop-all 2>&1 | Out-String | Write-Output
Start-Sleep -Milliseconds 800

Write-Output '=== upload/reload shim ==='
node (Join-Path $TOOLS 'upload-save.cjs') (Join-Path $CONSOLE 'n2h_rpc.lua') 'n2h_rpc.lua'
node (Join-Path $TOOLS 'post-eval.cjs') (Join-Path $CONSOLE 'reload_rpc.lua')
if ($LASTEXITCODE -ne 0) { Write-Output 'shim reload failed'; exit 1 }

# Mount accessor/service addresses are per-boot: after ANY game relaunch this
# MUST run before the probe, or the mount clone dereferences stale pointers.
Write-Output '=== refresh mounts (per-boot addresses) ==='
node (Join-Path $TOOLS 'refresh-mounts.cjs')
if ($LASTEXITCODE -ne 0) { Write-Output 'refresh mounts failed'; exit 1 }

Write-Output '=== start bridge ==='
$bridgeScript = Join-Path $TOOLS 'seedsow-bridge.cjs'
$p = Start-Process -FilePath node -ArgumentList ('"' + $bridgeScript + '"') -WorkingDirectory $ROOT `
  -RedirectStandardOutput (Join-Path $ROOT 'bridge.log') `
  -RedirectStandardError (Join-Path $ROOT 'bridge.err') -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
Write-Output "bridge pid=$($p.Id) fast=$($env:NS2_FAST)"
Get-Content (Join-Path $ROOT 'bridge.log') -Tail 5 -ErrorAction SilentlyContinue
Get-Content (Join-Path $ROOT 'bridge.err') -Tail 5 -ErrorAction SilentlyContinue
node (Join-Path $TOOLS 'rpc-tool.cjs') status
