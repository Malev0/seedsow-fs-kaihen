# Set up a freshly launched Seedsow boot: stop any old bridge/loop, upload and
# reload the console shim, refresh the per-boot mounts, start the bridge.
# Press Y in the game (HTTP server) before running this.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\resume.ps1 [-Slow]
param([switch]$Slow)
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$env:NS2_FAST = if ($Slow) { '0' } else { '1' }
$TOOLS = Join-Path $PSScriptRoot 'tools'
$CONSOLE = Join-Path $PSScriptRoot 'console'

Write-Output '=== stop any running bridge + console RPC loop ==='
node (Join-Path $TOOLS 'rpc-tool.cjs') stop-all 2>&1 | Out-String | Write-Output

# Right after stop-all the console's HTTP handler can reset or ignore the first
# request while the old serve loop unwinds. Retry instead of giving up.
function Invoke-Retries([scriptblock]$Action, [int]$Tries = 15, [int]$DelayMs = 1000, [string]$Label = '') {
  for ($i = 0; $i -lt $Tries; $i++) {
    & $Action
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($Label -and ($i % 10 -eq 9)) { Write-Output "  $Label still not answering ($([int](($i + 1) * $DelayMs / 1000)) s)" }
    Start-Sleep -Milliseconds $DelayMs
  }
  return $false
}

Start-Sleep -Milliseconds 800
Write-Output '=== console check ==='
$consoleOk = Invoke-Retries { python (Join-Path $TOOLS 'post_eval.py') (Join-Path $CONSOLE 'test_eval.lua') | Out-Null } 30 2000 '/eval'
if (-not $consoleOk) {
  Write-Output 'console not reachable: /eval never answered.'
  Write-Output 'If the game is running, its HTTP handler is wedged - close it, start it again and press Y.'
  exit 1
}
Write-Output 'console ok'

Write-Output '=== re-upload/reload shim ==='
if (-not (Invoke-Retries { python (Join-Path $TOOLS 'upload_save.py') (Join-Path $CONSOLE 'n2h_rpc.lua') 'n2h_rpc.lua' | Out-Null } 10 1000)) {
  Write-Output 'shim upload failed'; exit 1
}
if (-not (Invoke-Retries { python (Join-Path $TOOLS 'post_eval.py') (Join-Path $CONSOLE 'reload_rpc.lua') | Out-Null } 10 1000)) {
  Write-Output 'shim reload failed'; exit 1
}

Write-Output '=== refresh mounts (needs /eval, so before the RPC loop) ==='
if (-not (Invoke-Retries { python (Join-Path $TOOLS 'refresh_mounts.py') | Out-Null } 10 1000)) {
  Write-Output 'refresh mounts failed'; exit 1
}

Write-Output '=== restart bridge ==='
$conn = Get-NetTCPConnection -LocalPort 31337 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $conn | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}
$p = Start-Process -FilePath node -ArgumentList (Join-Path $TOOLS 'seedsow-bridge.cjs') -WorkingDirectory $PSScriptRoot `
  -RedirectStandardOutput (Join-Path $PSScriptRoot 'bridge.log') `
  -RedirectStandardError (Join-Path $PSScriptRoot 'bridge.err') -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
Write-Output "bridge pid=$($p.Id) fast=$($env:NS2_FAST)"
Get-Content (Join-Path $PSScriptRoot 'bridge.log') -ErrorAction SilentlyContinue
Get-Content (Join-Path $PSScriptRoot 'bridge.err') -ErrorAction SilentlyContinue

Write-Output '=== console RPC transport ==='
$ping = ''
for ($i = 0; $i -lt 20; $i++) {
  $ping = node (Join-Path $TOOLS 'rpc-tool.cjs') ping 2>&1 | Out-String
  if ($ping -match 'pong') { Write-Output $ping.Trim(); break }
  Start-Sleep -Milliseconds 500
}
if ($ping -notmatch 'pong') { Write-Output 'RPC listener did not come up; the bridge will use /eval' }
node (Join-Path $TOOLS 'rpc-tool.cjs') status 2>&1 | Out-String | Write-Output
