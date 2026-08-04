# ===========================================================================
#  Bundle-location tests for scripts\setup.ps1.
#
#  Driven by test\setup-bundle.test.ts, which runs this under every PowerShell
#  host on the machine -- SETUP.bat uses Windows PowerShell 5.1, so 7-only
#  behaviour passing is not enough.
#
#  ASCII-only on purpose. Windows PowerShell reads a .ps1 without a BOM in the
#  system ANSI codepage, so Japanese literals in a test file are a coin flip
#  that has nothing to do with what is being tested. setup.ps1 itself carries a
#  BOM and is read correctly; assertions here match on paths, not on messages.
#
#  Emits one tab-separated RESULT line per case, and exits non-zero on failure.
# ===========================================================================

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- harness ---------------------------------------------------------------

$script:pass = 0
$script:fail = 0

function Check {
    param([string] $Name, $Expected, $Actual)

    if ($Expected -eq $Actual) {
        $script:pass++
        Write-Output "RESULT`tPASS`t$Name`t"
    } else {
        $script:fail++
        Write-Output "RESULT`tFAIL`t$Name`texpected [$Expected], got [$Actual]"
    }
}

<#
  Delete a tree that contains junctions.

  Windows PowerShell 5.1's `Remove-Item -Recurse` walks *through* a junction
  and deletes the target's contents. Every junction is unlinked first, with
  rmdir, which removes the link only.
#>
function Remove-Tree {
    param([Parameter(Mandatory)][string] $Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    $links = @(
        Get-ChildItem -LiteralPath $Path -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
    )
    foreach ($link in $links) { cmd /c rmdir "$($link.FullName)" 2>&1 | Out-Null }

    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
}

function New-Junction {
    param([Parameter(Mandatory)][string] $Link, [Parameter(Mandatory)][string] $Target)
    cmd /c mklink /J "$Link" "$Target" 2>&1 | Out-Null
}

# --- load the code under test ----------------------------------------------

$setup = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\setup.ps1'
if (-not (Test-Path -LiteralPath $setup)) { throw "setup.ps1 not found at $setup" }

# Dot-sourcing setup.ps1 would run the build. Lift out just the functions.
$ast = [System.Management.Automation.Language.Parser]::ParseFile($setup, [ref]$null, [ref]$null)
$wanted = 'Test-BundleLocation', 'Get-PathFault', 'Resolve-BundlePath', 'Get-LaunchMode'
$found = @()
foreach ($def in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($wanted -notcontains $def.Name) { continue }
    . ([scriptblock]::Create($def.Extent.Text))
    $found += $def.Name
}
foreach ($name in $wanted) {
    if ($found -notcontains $name) { throw "setup.ps1 no longer defines $name" }
}

# Progress chatter from the functions under test is noise here. RESULT lines
# stay identifiable regardless, since the caller filters on the prefix.
function Write-Step { param([string] $Message) }
function Write-Ok   { param([string] $Message) }
function Write-Note { param([string] $Message) }
function Write-Warn { param([string] $Message) }

$root = Join-Path ([IO.Path]::GetTempPath()) "okf-bundle-tests-$PID"
Remove-Tree -Path $root
New-Item -ItemType Directory -Force -Path $root | Out-Null

try {
    # --- a plain, writable location ----------------------------------------

    $plain = Join-Path $root 'plain\PierrotKnowledge2'
    $why = ''
    Check 'plain folder is usable' $true (Test-BundleLocation -Path $plain -Reason ([ref]$why))
    Check 'plain folder was created' $true (Test-Path -LiteralPath $plain)
    Check 'write probe was cleaned up' $false (Test-Path -LiteralPath (Join-Path $plain '.okf-write-test'))

    # --- every mechanism that produces the reported error -------------------
    #
    # "Could not find a part of the path '...\.okf-write-test'" was reported
    # from a machine with no cloud sync installed. Four unrelated conditions
    # produce that exact message, and all four pass Test-Path, so each one is
    # pinned here. Every case must be rejected, and named.

    # (a) Documents is a link whose target was removed. A cloud tool's folder
    #     redirection does this, and so does a hand-made junction to a second
    #     drive that later went away.
    $kfm = Join-Path $root 'link-dead'
    $away = Join-Path $kfm 'moved-away'
    $docsTarget = Join-Path $away 'Documents'
    New-Item -ItemType Directory -Force -Path $docsTarget | Out-Null
    $docs = Join-Path $kfm 'Documents'
    New-Junction -Link $docs -Target $docsTarget
    Remove-Item -LiteralPath $away -Recurse -Force

    Check 'dead link still passes Test-Path' $true (Test-Path -LiteralPath $docs)

    $dangling = Join-Path $docs 'PierrotKnowledge2'
    $why = ''
    Check 'dead link is rejected' $false (Test-BundleLocation -Path $dangling -Reason ([ref]$why))
    Check 'rejection carries a reason' $true ([bool]$why)

    $fault = Get-PathFault -Path $dangling
    Check 'dead link fault is classified' 'link' $(if ($fault) { $fault.Kind } else { '(none)' })
    Check 'dead link fault names the component' $true ($fault -and $fault.Message.Contains($docs))
    Check 'dead link fault names the target' $true ($fault -and $fault.Message.Contains($docsTarget))

    # (b) The link target exists but is now a FILE. Checking that the target
    #     exists says this one is healthy; it is not.
    $swap = Join-Path $root 'link-to-file'
    New-Item -ItemType Directory -Force -Path $swap | Out-Null
    $swapTarget = Join-Path $swap 'target'
    New-Item -ItemType Directory -Force -Path $swapTarget | Out-Null
    $swapLink = Join-Path $swap 'Documents'
    New-Junction -Link $swapLink -Target $swapTarget
    Remove-Item -LiteralPath $swapTarget -Recurse -Force
    Set-Content -LiteralPath $swapTarget -Value 'not a folder any more'

    Check 'link-to-file target passes Test-Path' $true (Test-Path -LiteralPath $swapTarget)
    $why = ''
    Check 'link to a file is rejected' $false `
        (Test-BundleLocation -Path (Join-Path $swapLink 'PierrotKnowledge2') -Reason ([ref]$why))
    $fault = Get-PathFault -Path (Join-Path $swapLink 'PierrotKnowledge2')
    Check 'link to a file is classified' 'link' $(if ($fault) { $fault.Kind } else { '(none)' })

    # (c) Documents itself is a file. No link involved at all.
    $asFile = Join-Path $root 'docs-is-file'
    New-Item -ItemType Directory -Force -Path $asFile | Out-Null
    $docsFile = Join-Path $asFile 'Documents'
    Set-Content -LiteralPath $docsFile -Value 'x'
    $why = ''
    Check 'a file in the path is rejected' $false `
        (Test-BundleLocation -Path (Join-Path $docsFile 'PierrotKnowledge2') -Reason ([ref]$why))
    $fault = Get-PathFault -Path (Join-Path $docsFile 'PierrotKnowledge2')
    Check 'a file in the path is classified' 'file' $(if ($fault) { $fault.Kind } else { '(none)' })
    Check 'a file in the path is named' $true ($fault -and $fault.Message.Contains($docsFile))

    # (d) The bundle name itself is taken by a file. Test-Path says it exists,
    #     so the folder is never created and the write is the first complaint.
    $taken = Join-Path $root 'name-taken'
    New-Item -ItemType Directory -Force -Path $taken | Out-Null
    $takenPath = Join-Path $taken 'PierrotKnowledge2'
    Set-Content -LiteralPath $takenPath -Value 'x'
    Check 'occupied name passes Test-Path' $true (Test-Path -LiteralPath $takenPath)
    $why = ''
    Check 'occupied name is rejected' $false (Test-BundleLocation -Path $takenPath -Reason ([ref]$why))
    $fault = Get-PathFault -Path $takenPath
    Check 'occupied name is classified' 'file' $(if ($fault) { $fault.Kind } else { '(none)' })

    # --- a healthy link must still be accepted -----------------------------

    $live = Join-Path $root 'live'
    New-Item -ItemType Directory -Force -Path (Join-Path $live 'real') | Out-Null
    New-Junction -Link (Join-Path $live 'link') -Target (Join-Path $live 'real')
    $viaLink = Join-Path $live 'link\PierrotKnowledge2'
    $why = ''
    Check 'healthy link is usable' $true (Test-BundleLocation -Path $viaLink -Reason ([ref]$why))
    Check 'healthy link reports no fault' $true ($null -eq (Get-PathFault -Path $viaLink))

    # A folder with many entries must not be slow or misreported: the check
    # opens one entry, it does not enumerate.
    $busy = Join-Path $root 'busy'
    New-Item -ItemType Directory -Force -Path $busy | Out-Null
    1..250 | ForEach-Object { Set-Content -LiteralPath (Join-Path $busy "note-$_.md") -Value 'x' }
    Check 'a populated folder reports no fault' $true ($null -eq (Get-PathFault -Path (Join-Path $busy 'PierrotKnowledge2')))

    # --- re-running setup must not disturb an existing bundle --------------

    $existing = Join-Path $root 'existing'
    New-Item -ItemType Directory -Force -Path $existing | Out-Null
    Set-Content -LiteralPath (Join-Path $existing 'note.md') -Value 'keep me'
    $why = ''
    Check 'existing folder is usable' $true (Test-BundleLocation -Path $existing -Reason ([ref]$why))
    Check 'existing content is untouched' 'keep me' ((Get-Content -LiteralPath (Join-Path $existing 'note.md') -Raw).Trim())

    # --- resolution order --------------------------------------------------

    $profileRoot = Join-Path $root 'profile'
    $localAppData = Join-Path $profileRoot 'AppData\Local'
    New-Item -ItemType Directory -Force -Path $localAppData | Out-Null

    $savedProfile = $env:USERPROFILE
    $savedLocal = $env:LOCALAPPDATA
    $savedOneDrive = $env:OneDrive
    try {
        $env:USERPROFILE = $profileRoot
        $env:LOCALAPPDATA = $localAppData

        # The reported machine: Documents unusable, and no OneDrive at all.
        $env:OneDrive = ''
        $resolved = $null
        try {
            $resolved = Resolve-BundlePath -Requested '' -AppName 'PierrotKnowledge2' -DocumentsPath $docs
        } catch {
            $resolved = "threw: $($_.Exception.Message)"
        }
        Check 'falls back to the profile when Documents is broken and OneDrive absent' `
            (Join-Path $profileRoot 'PierrotKnowledge2') $resolved
        Check 'broken link target was not resurrected' $false (Test-Path -LiteralPath $docsTarget)

        # With OneDrive set but its folder missing, the candidate is skipped
        # rather than conjured into existence.
        $env:OneDrive = $away
        $resolved = $null
        try {
            $resolved = Resolve-BundlePath -Requested '' -AppName 'PierrotKnowledge2' -DocumentsPath $docs
        } catch {
            $resolved = "threw: $($_.Exception.Message)"
        }
        Check 'absent OneDrive candidate is skipped' (Join-Path $profileRoot 'PierrotKnowledge2') $resolved
        Check 'no phantom OneDrive folder was invented' $false (Test-Path -LiteralPath $away)
        $env:OneDrive = ''

        # An explicit path is the user's decision: honoured, or reported. Never
        # quietly moved somewhere else.
        $threw = $false
        try {
            Resolve-BundlePath -Requested (Join-Path $docs 'MyChoice') -AppName 'PierrotKnowledge2' | Out-Null
        } catch {
            $threw = $true
        }
        Check 'explicit unusable path fails instead of relocating' $true $threw
        Check 'explicit failure created nothing elsewhere' $false (Test-Path -LiteralPath (Join-Path $profileRoot 'MyChoice'))

        $explicitGood = Join-Path $root 'explicit\here'
        Check 'explicit good path is used verbatim' $explicitGood `
            (Resolve-BundlePath -Requested $explicitGood -AppName 'PierrotKnowledge2')

        # Healthy Documents wins when it works.
        $healthyDocs = Join-Path $root 'healthy-docs'
        New-Item -ItemType Directory -Force -Path $healthyDocs | Out-Null
        Check 'usable Documents is preferred' (Join-Path $healthyDocs 'PierrotKnowledge2') `
            (Resolve-BundlePath -Requested '' -AppName 'PierrotKnowledge2' -DocumentsPath $healthyDocs)
    } finally {
        $env:USERPROFILE = $savedProfile
        $env:LOCALAPPDATA = $savedLocal
        $env:OneDrive = $savedOneDrive
    }
    # --- what the Desktop shortcut starts ----------------------------------
    #
    # The interface is served to the user's own browser, and that is now the
    # only interface there is: the packaged window was removed at 0.5.0. The
    # one alternative is having no interface at all.

    Check 'the shortcut starts the served interface' 'web' (Get-LaunchMode)
    Check 'headless has nothing to start' 'none' (Get-LaunchMode -Headless)
} finally {
    Remove-Tree -Path $root
}

Write-Output "SUMMARY`t$script:pass`t$script:fail"
if ($script:fail -gt 0) { exit 1 }
