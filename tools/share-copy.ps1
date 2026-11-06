<#
.SYNOPSIS
  Make a shareable copy of this tree without the large game dumps and per-run
  binary captures.

.DESCRIPTION
  Copies every file under the repository root to a new folder, skipping:

    - the copyrighted demo dump: research/*.nsp and
      "research/Seedsow Lullaby Demo .../" (unless -IncludeGameDumps)
    - key material (*.keys)
    - per-run binary captures: **/*.bin
    - generated event logs: *.jsonl, *.log, *.err
    - per-run reports: memory/reserved-gap-*.json,
      retained/seedsow-metadata-*.json, ro/seedsow-*.json, ro/seedsow-code-*/
    - runs/, dumps/, node_modules/, .git/, docs/history/
    - any single file larger than -MaxFileMB (default 8 MB)

  The copy is verified by file count and total size, and a SHARE-MANIFEST.txt
  records what was left behind and the source git commit.

.PARAMETER Destination
  Target folder. Defaults to a sibling of this repository named
  seedsow-fs-exploit-share-<timestamp>. It must not exist with content.

.PARAMETER IncludeGameDumps
  Copy the .nsp and the extracted demo as well. Only use this when the
  recipient is allowed to receive the copyrighted game data.

.PARAMETER ExcludeResearch
  Skip the whole research/ folder (the README's minimal package). The small
  analysis scripts and research/references/ are normally kept.

.PARAMETER MaxFileMB
  Hard per-file cap. 0 disables the cap. Default 8 MB.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\share-copy.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\share-copy.ps1 -Destination D:\share\ns2jb -ExcludeResearch
#>
[CmdletBinding()]
param(
  [string]$Destination,
  [switch]$IncludeGameDumps,
  [switch]$ExcludeResearch,
  [int]$MaxFileMB = 8
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Destination) {
  $Destination = Join-Path (Split-Path $root -Parent) ('seedsow-fs-exploit-share-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$Destination = [IO.Path]::GetFullPath($Destination)
$rootFull = [IO.Path]::GetFullPath($root)
if ($Destination.TrimEnd('\') -eq $rootFull.TrimEnd('\')) {
  throw 'Destination must differ from the source tree.'
}
if (Test-Path -LiteralPath $Destination) {
  if ((Get-ChildItem -LiteralPath $Destination -Force | Measure-Object).Count -gt 0) {
    throw "Destination is not empty: $Destination"
  }
} else {
  New-Item -ItemType Directory -Path $Destination | Out-Null
}

# Relative paths use backslashes and never start with one.
function Test-Excluded([string]$rel) {
  $r = $rel -replace '/', '\'

  if ($r -match '^(\.git|node_modules|runs|dumps|docs\\history)(\\|$)') { return 'vcs/generated folder' }
  if ($r -match '\\node_modules(\\|$)') { return 'dependency folder' }
  if ($ExcludeResearch -and $r -match '^research(\\|$)') { return 'research excluded by flag' }

  if (-not $IncludeGameDumps) {
    if ($r -match '^research\\[^\\]+\.nsp$') { return 'game dump (.nsp)' }
    if ($r -match '^research\\Seedsow Lullaby Demo ') { return 'extracted game dump' }
    if ($r -match '\.(xci|nca)$') { return 'game dump' }
    if ($r -match '(^|\\)(prod|title)\.keys$' -or $r -match '\.keys$') { return 'key material' }
  }

  if ($r -match '\.bin$') { return 'binary capture' }
  if ($r -match '\.(jsonl|log|err)$') { return 'generated log' }
  if ($r -match '\\memory\\reserved-gap-[^\\]+\.json$') { return 'per-run report' }
  if ($r -match '\\retained\\seedsow-metadata-[^\\]+\.json$') { return 'per-run report' }
  if ($r -match '\\ro\\seedsow-[^\\]+\.json$') { return 'per-run report' }
  if ($r -match '\\ro\\seedsow-code-') { return 'per-run capture folder' }
  return $null
}

$copied = 0
$copiedBytes = [long]0
$excluded = New-Object System.Collections.Generic.List[string]
$excludedBytes = [long]0
$started = Get-Date

foreach ($file in Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force) {
  $rel = $file.FullName.Substring($rootFull.Length).TrimStart('\')
  $reason = Test-Excluded $rel
  if ($reason) {
    $excluded.Add(('{0}  [{1}]' -f $rel, $reason))
    $excludedBytes += $file.Length
    continue
  }
  if ($MaxFileMB -gt 0 -and $file.Length -gt $MaxFileMB * 1MB) {
    $excluded.Add(('{0}  [{1:N1} MB over the {2} MB cap]' -f $rel, ($file.Length / 1MB), $MaxFileMB))
    $excludedBytes += $file.Length
    continue
  }
  $target = Join-Path $Destination $rel
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  $copied++
  $copiedBytes += $file.Length
}

$commit = ''
try { $commit = (git -C $rootFull rev-parse --short HEAD 2>$null | Out-String).Trim() } catch { }
$manifest = New-Object System.Collections.Generic.List[string]
$manifest.Add('ns2jb share copy')
$manifest.Add('source:    ' + $rootFull)
$manifest.Add('created:   ' + $started.ToString('o'))
$manifest.Add('git:       ' + ($(if ($commit) { $commit } else { 'not a git checkout' })))
$manifest.Add(('options:   IncludeGameDumps={0} ExcludeResearch={1} MaxFileMB={2}' -f [bool]$IncludeGameDumps, [bool]$ExcludeResearch, $MaxFileMB))
$manifest.Add(('copied:    {0} files, {1:N1} MB' -f $copied, ($copiedBytes / 1MB)))
$manifest.Add(('excluded:  {0} files, {1:N1} MB' -f $excluded.Count, ($excludedBytes / 1MB)))
$manifest.Add('')
$manifest.Add('Excluded files (relative to the source root):')
$shown = [Math]::Min(500, $excluded.Count)
for ($i = 0; $i -lt $shown; $i++) { $manifest.Add($excluded[$i]) }
if ($excluded.Count -gt $shown) {
  $manifest.Add(('... and {0} more files' -f ($excluded.Count - $shown)))
}
[IO.File]::WriteAllLines((Join-Path $Destination 'SHARE-MANIFEST.txt'), $manifest)

"Copied $copied files ($([math]::Round($copiedBytes / 1MB, 1)) MB) to $Destination"
"Excluded $($excluded.Count) files; see SHARE-MANIFEST.txt"
