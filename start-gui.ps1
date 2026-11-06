# Launch the manual Seedsow controller (small app window) and open it.
# Usage: powershell -ExecutionPolicy Bypass -File .\start-gui.ps1
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$port = 31338
$url = "http://127.0.0.1:$port"
$gui = Join-Path $PSScriptRoot 'gui'

function Test-Gui {
  $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
  return [bool]$ok
}

if (-not (Test-Gui)) {
  Start-Process -FilePath node -ArgumentList (Join-Path $gui 'ns2-gui.cjs') -WorkingDirectory $PSScriptRoot `
    -RedirectStandardOutput (Join-Path $gui 'gui.log') `
    -RedirectStandardError (Join-Path $gui 'gui.err') | Out-Null
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

# Prefer a chromeless app window (Edge, then Chrome), else the default browser.
$candidates = @(
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($browser) {
  # A dedicated profile guarantees a real chromeless app window instead of a tab
  # in the user's normal browser session.
  $profile = Join-Path $env:LOCALAPPDATA 'ns2jb-gui-profile'
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  Start-Process -FilePath $browser `
    -ArgumentList "--app=$url --window-size=1040,860 --user-data-dir=`"$profile`" --no-first-run --no-default-browser-check" | Out-Null
} else {
  Start-Process $url | Out-Null
}
Write-Output "controller: $url"
