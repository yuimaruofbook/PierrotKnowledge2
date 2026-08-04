<#
.SYNOPSIS
  Measure the whole process tree of a running application.

.DESCRIPTION
  Walks the process tree from a root PID and sums memory across every
  descendant.

  Counting descendants is the whole point. Both applications under test are
  multi-process: Obsidian is Electron (main + renderer + GPU + utility), and the
  desktop build of PierrotKnowledge2 drove the OS WebView, which on Windows spawns
  msedgewebview2.exe
  children. Measuring only the process you launched would flatter whichever app
  pushes more work into children — which here would be ours.

  Reports both working set (resident) and private bytes (committed, not shared
  with other processes), because the two tell different stories: working set
  includes shared pages that would be resident anyway.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][int] $RootPid,
    [string] $Label = "app"
)

$ErrorActionPreference = 'Stop'

# One snapshot, then walk it in memory: the tree must not change underneath us.
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name

$tree = @{}
foreach ($p in $all) {
    if (-not $tree.ContainsKey([int]$p.ParentProcessId)) { $tree[[int]$p.ParentProcessId] = @() }
    $tree[[int]$p.ParentProcessId] += [int]$p.ProcessId
}

$byPid = @{}
foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }

# Breadth-first from the root, so grandchildren are included.
$members = New-Object System.Collections.Generic.List[int]
$queue = New-Object System.Collections.Generic.Queue[int]
$queue.Enqueue($RootPid)
while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if ($members.Contains($id)) { continue }
    $members.Add($id)
    if ($tree.ContainsKey($id)) { foreach ($child in $tree[$id]) { $queue.Enqueue($child) } }
}

$rows = @()
$working = 0L
$private = 0L

foreach ($id in $members) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $working += $proc.WorkingSet64
    $private += $proc.PrivateMemorySize64
    $rows += [pscustomobject]@{
        Name    = $byPid[$id].Name
        PID     = $id
        WS_MB   = [math]::Round($proc.WorkingSet64 / 1MB, 1)
        Priv_MB = [math]::Round($proc.PrivateMemorySize64 / 1MB, 1)
    }
}

[pscustomobject]@{
    Label       = $Label
    Processes   = $rows.Count
    WorkingSet  = [math]::Round($working / 1MB, 1)
    PrivateBytes = [math]::Round($private / 1MB, 1)
    Detail      = $rows | Sort-Object -Property Priv_MB -Descending
}
