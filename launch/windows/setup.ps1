# Set up a freshly launched Seedsow boot: stop any old bridge/loop, upload and
# reload the console shim, refresh the per-boot mounts, start the bridge.
# Press Y in the game (HTTP server) before running this.
#
# Usage: powershell -ExecutionPolicy Bypass -File .\launch\windows\setup.ps1 [-Slow]
param([switch]$Slow)
# The repository root is two levels above this file (launch/windows).
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ErrorActionPreference = 'Continue'
Set-Location $ROOT

$env:NS2_FAST = if ($Slow) { '0' } else { '1' }
$TOOLS = Join-Path $ROOT 'tools'
$CONSOLE = Join-Path $ROOT 'console'

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
$consoleOk = Invoke-Retries { node (Join-Path $TOOLS 'post-eval.cjs') (Join-Path $CONSOLE 'test_eval.lua') } 8 1500 '/eval'
if (-not $consoleOk) {
  Write-Output 'console not reachable: /eval never answered.'
  Write-Output 'If the game is running, its HTTP handler is wedged - close it, start it again and press Y.'
  exit 1
}
Write-Output 'console ok'

Write-Output '=== re-upload/reload shim ==='
# The save upload endpoint rejects bodies over 28672 bytes (http.lua REQ_CAP),
# and it is the only way to put these files on the console. Fail here instead
# of after three 6 s timeouts.
foreach ($name in 'n2h_rpc.lua', 'n2h_pump.lua') {
  $size = (Get-Item (Join-Path $CONSOLE $name)).Length
  if ($size -gt 28672) {
    Write-Output ("$name is $size bytes; the save upload limit is 28672. Split the file.")
    exit 1
  }
}
if (-not (Invoke-Retries { node (Join-Path $TOOLS 'upload-save.cjs') (Join-Path $CONSOLE 'n2h_rpc.lua') 'n2h_rpc.lua' } 3 1000)) {
  Write-Output 'shim upload failed'
  Write-Output 'If the console printed "[!] httpd: accept ...; server stopped", the launcher stopped its'
  Write-Output 'HTTP server: common/http.lua treats any accept error other than EAGAIN as fatal and'
  Write-Output 'never restarts it. That is per game process - relaunch Seedsow (Restart Game), do not'
  Write-Output 'power-cycle, and try again.'
  exit 1
}
if (-not (Invoke-Retries { node (Join-Path $TOOLS 'upload-save.cjs') (Join-Path $CONSOLE 'n2h_pump.lua') 'n2h_pump.lua' } 3 1000)) {
  Write-Output 'pump upload failed'; exit 1
}
if (-not (Invoke-Retries { node (Join-Path $TOOLS 'post-eval.cjs') (Join-Path $CONSOLE 'reload_rpc.lua') } 3 1000)) {
  Write-Output 'shim reload failed'; exit 1
}

Write-Output '=== refresh mounts (needs /eval, so before the RPC loop) ==='
if (-not (Invoke-Retries { node (Join-Path $TOOLS 'refresh-mounts.cjs') } 3 1000)) {
  Write-Output 'refresh mounts failed'; exit 1
}
# Do not trust the exit code alone: the file is what the exploit needs.
$mountsFile = [IO.Path]::Combine($ROOT, 'ns2jb-main', 'ns2jb-main', 'engine', 'switch2', 'app', 'mounts.json')
if (-not (Test-Path $mountsFile)) {
  Write-Output "refresh mounts produced no $mountsFile"; exit 1
}

Write-Output '=== restart bridge ==='
$conn = Get-NetTCPConnection -LocalPort 31337 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  $conn | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}
$bridgeScript = Join-Path $TOOLS 'seedsow-bridge.cjs'
$p = Start-Process -FilePath node -ArgumentList ('"' + $bridgeScript + '"') -WorkingDirectory $ROOT `
  -RedirectStandardOutput (Join-Path $ROOT 'bridge.log') `
  -RedirectStandardError (Join-Path $ROOT 'bridge.err') -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
Write-Output "bridge pid=$($p.Id) fast=$($env:NS2_FAST)"
Get-Content (Join-Path $ROOT 'bridge.log') -ErrorAction SilentlyContinue
Get-Content (Join-Path $ROOT 'bridge.err') -ErrorAction SilentlyContinue

Write-Output '=== console RPC transport ==='
$ping = ''
for ($i = 0; $i -lt 20; $i++) {
  $ping = node (Join-Path $TOOLS 'rpc-tool.cjs') ping 2>&1 | Out-String
  if ($ping -match 'pong') { Write-Output $ping.Trim(); break }
  Start-Sleep -Milliseconds 500
}
if ($ping -notmatch 'pong') { Write-Output 'RPC listener did not come up; the bridge will use /eval' }
node (Join-Path $TOOLS 'rpc-tool.cjs') status 2>&1 | Out-String | Write-Output
