# Stop the Seedsow controller and the node processes it owns.
#
# Closing the browser tab does not stop the controller: the GUI is started
# detached and hidden, and a run spawns powershell -> hen -> pipeline as its
# children. Killing only the process that holds the listening socket misses
# those children, and misses everything once the socket is gone - that is why a
# plain netstat+taskkill sometimes left node.exe running. This stops the GUI
# tree by pid file, by command line and by port, waits for it to disappear, and
# then stops the bridge and the console loop.
#
# Usage: launch\windows\stop-gui.ps1   (or double-click stop-gui.bat)
param()
# The repository root is two levels above this file (launch/windows).
$ROOT = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ErrorActionPreference = 'Continue'
Set-Location $ROOT

$port = 31338
$parsed = 0
if ($env:NS2_GUI_PORT -and [int]::TryParse($env:NS2_GUI_PORT, [ref]$parsed)) { $port = $parsed }
$pidFile = Join-Path $ROOT 'gui\gui.pid'
$rpc = Join-Path $ROOT 'tools\rpc-tool.cjs'

function Get-GuiPids {
  $ids = New-Object System.Collections.Generic.List[int]

  # 1. The pid recorded by start-gui.ps1.
  if (Test-Path $pidFile) {
    $text = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    $value = 0
    if ($text -and [int]::TryParse($text.Trim(), [ref]$value)) { [void]$ids.Add($value) }
  }

  # 2. Any node running the controller, including a copy started from another
  #    folder (an older unzip) - the command line is the reliable identity, the
  #    pid file is not always there.
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine.IndexOf('ns2-gui.cjs', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }

  # 3. Whoever owns a socket on the port. Only the LOCAL address (field 2 of the
  #    netstat row) is compared, so a browser connected to the controller is
  #    never mistaken for it; PID 0 means "no owner" and is skipped.
  foreach ($line in (netstat -ano 2>$null | Select-String -Pattern (':{0}\s' -f $port))) {
    $fields = @(($line.ToString() -split '\s+') | Where-Object { $_ })
    if ($fields.Count -ge 5 -and $fields[1] -match (':{0}$' -f $port) -and
        $fields[-1] -match '^\d+$' -and $fields[-1] -ne '0') {
      [void]$ids.Add([int]$fields[-1])
    }
  }

  return @($ids | Sort-Object -Unique)
}

$targets = @(Get-GuiPids | Where-Object { $_ -gt 0 -and (Get-Process -Id $_ -ErrorAction SilentlyContinue) })

if (-not $targets.Count) {
  Write-Output 'No controller was running.'
} else {
  foreach ($processId in $targets) {
    # /T is the important part: a run's setup -> hen -> pipeline children die
    # with the controller instead of being orphaned.
    & taskkill /PID $processId /T /F 2>&1 | Out-Null
  }
  $deadline = (Get-Date).AddSeconds(5)
  $alive = @()
  do {
    $alive = @($targets | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if (-not $alive.Count) { break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  if ($alive.Count) {
    Write-Output ('Controller did not stop: still running pid ' + ($alive -join ', '))
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Output 'Controller stopped.'
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue

# The bridge and the console loop are node processes from this folder too, and
# they outlive the controller. rpc-tool validates the bridge pid before killing
# it and falls back to the bridge port, so this never kills an unrelated process.
if (Test-Path $rpc) {
  $output = & node $rpc stop-all 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Output 'Bridge/console loop did not stop cleanly:'
    Write-Output $output.Trim()
  } else {
    Write-Output 'Bridge and console loop stopped.'
  }
}
exit 0
