# Launch the manual Seedsow controller and open it in the default browser.
# Usage: launch\windows\start-gui.ps1   (or double-click start-gui.bat)
param()
# The repository root is two levels above this file (launch/windows).
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ErrorActionPreference = 'Continue'
Set-Location $ROOT

$port = 31338
$url = "http://127.0.0.1:$port"
$gui = Join-Path $ROOT 'gui'

# Node is the only runtime: the controller, the setup and the console helpers
# are all Node. Fail with a clear message instead of Start-Process's "cannot find
# the file specified".
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Output 'Node.js is not on PATH. Install Node.js 20+ from https://nodejs.org/ (tick "Add to PATH"), then open a new PowerShell window and run this again.'
  exit 1
}

function Test-Gui {
  $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
  return [bool]$ok
}

if (-not (Test-Gui)) {
  # -ArgumentList joins its elements with spaces and does not quote them, so a
  # path with spaces (C:\Users\...\seedsow-fs-kaihen-main (5)\...) would reach
  # node split into several arguments. Quote the script path explicitly.
  $script = Join-Path $gui 'ns2-gui.cjs'
  $started = Start-Process -FilePath $node.Source -ArgumentList ('"' + $script + '"') -WorkingDirectory $ROOT `
    -RedirectStandardOutput (Join-Path $gui 'gui.log') `
    -RedirectStandardError (Join-Path $gui 'gui.err') -WindowStyle Hidden -PassThru
  # Recorded so stop-gui.ps1 can find the controller even when it no longer owns
  # the listening socket. It also falls back to the command line and the port.
  if ($started) { Set-Content -Path (Join-Path $gui 'gui.pid') -Value $started.Id -NoNewline }
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Gui) { break }
    Start-Sleep -Milliseconds 300
  }
}

if (-not (Test-Gui)) {
  Write-Output 'controller did not start; see gui/gui.err'
  Get-Content (Join-Path $gui 'gui.err') -ErrorAction SilentlyContinue | Select-Object -Last 10
  exit 1
}

# One page and one server for the whole controller.
Start-Process $url | Out-Null
Write-Output "controller: $url"
