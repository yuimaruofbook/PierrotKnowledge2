<#
  Repeat the loaded-corpus measurement so the headline numbers are not one
  sample. Restores both configs at the end.
#>
param(
    [int] $Trials = 3,
    [int] $Settle = 30,
    [string] $Bench = (Join-Path $env:TEMP "okf-bench")
)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $PSCommandPath
$bench  = $Bench
# Repo root, derived from this script's own location rather than hardcoded.
$repo   = Split-Path -Parent (Split-Path -Parent $here)
$obsCfg = "$env:APPDATA\obsidian\obsidian.json"
$session = "$env:APPDATA\PierrotKnowledge2\session.json"
$okfExe = (Get-ChildItem (Join-Path $repo "build") -Recurse -Filter launcher.exe | Select-Object -First 1).FullName
$obsExe = "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"

Copy-Item $obsCfg "$obsCfg.bench-backup" -Force
if (Test-Path $session) { Copy-Item $session "$session.bench-backup" -Force }

function Kill-All {
    Get-Process -Name Obsidian -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
    Get-Process | Where-Object { $_.ProcessName -eq 'bun' -and $_.MainWindowTitle -like '*OKF*' } |
        Stop-Process -Force -EA SilentlyContinue
    Start-Sleep -Seconds 4
}

function Run-Trial {
    param([string]$Exe, [string]$Match, [string]$Label, [string]$Owner)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Process $Exe | Out-Null
    $t = $null
    while ($sw.Elapsed.TotalSeconds -lt 60) {
        Start-Sleep -Milliseconds 200
        if (Get-Process -EA SilentlyContinue | Where-Object { $_.MainWindowTitle -like $Match -and $_.ProcessName -eq $Owner }) {
            $t = $sw.Elapsed.TotalSeconds; break
        }
    }
    Start-Sleep -Seconds $Settle
    $root = Get-Process | Where-Object { $_.MainWindowTitle -like $Match -and $_.ProcessName -eq $Owner } | Select-Object -First 1
    $m = & "$here\measure.ps1" -RootPid $root.Id -Label $Label
    [pscustomobject]@{
        App = $Label; Procs = $m.Processes; WS = $m.WorkingSet
        Priv = $m.PrivateBytes; Start = [math]::Round($t, 2)
    }
}

$results = @()
for ($i = 1; $i -le $Trials; $i++) {
    Kill-All
    @{ bundlePath = "$bench\bundle"; editorWidth = 100 } | ConvertTo-Json | Set-Content $session -Encoding UTF8
    $results += Run-Trial -Exe $okfExe -Match "PierrotKnowledge2*" -Label "PierrotKnowledge2" -Owner "bun"

    Kill-All
    $j = Get-Content $obsCfg -Raw | ConvertFrom-Json
    foreach ($k in $j.vaults.PSObject.Properties.Name) { $j.vaults.$k.open = $false }
    $j.vaults | Add-Member -NotePropertyName "benchvault000001" -NotePropertyValue ([pscustomobject]@{
        path = "$bench\vault"; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); open = $true }) -Force
    $j | ConvertTo-Json -Depth 8 | Set-Content $obsCfg -Encoding UTF8
    $results += Run-Trial -Exe $obsExe -Match "*Obsidian*" -Label "Obsidian" -Owner "Obsidian"
}

Kill-All
Copy-Item "$obsCfg.bench-backup" $obsCfg -Force; Remove-Item "$obsCfg.bench-backup" -Force
if (Test-Path "$session.bench-backup") { Copy-Item "$session.bench-backup" $session -Force; Remove-Item "$session.bench-backup" -Force }

"=== PER TRIAL ==="
$results | Format-Table -AutoSize | Out-String

"=== MEDIAN ==="
$results | Group-Object App | ForEach-Object {
    $ws = ($_.Group.WS | Sort-Object)[[int]($_.Count/2)]
    $pv = ($_.Group.Priv | Sort-Object)[[int]($_.Count/2)]
    $st = ($_.Group.Start | Sort-Object)[[int]($_.Count/2)]
    [pscustomobject]@{ App=$_.Name; Procs=$_.Group[0].Procs; WS_MB=$ws; Priv_MB=$pv; Start_s=$st }
} | Format-Table -AutoSize | Out-String
