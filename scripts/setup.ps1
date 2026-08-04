<#
.SYNOPSIS
  One-touch setup for PierrotKnowledge2 on Windows.

.DESCRIPTION
  Installs Bun if missing, installs dependencies, generates the icon, builds the
  interface, creates a starter knowledge bundle, and puts a shortcut on the
  Desktop.

  The interface is served on 127.0.0.1 and opened in the browser you already
  use. There is no packaged window any more: it measured 633 MB resident
  against 135 MB for the identical interface in a tab, and its last exclusive
  capability — the folder dialog — is now opened straight from the OS.

  Safe to re-run: every step checks before it acts, and nothing already present
  is overwritten.

.PARAMETER BundlePath
  Where to create the starter bundle. Used exactly as given.

  Without it the location is Documents, then OneDrive\Documents, then the user
  profile, then LocalAppData — the first one that can genuinely be written to.
  Documents is the folder Windows redirects, and a Known Folder Move left
  half-done points it at a OneDrive folder that no longer exists, so the
  default cannot be a single path taken on trust.

.PARAMETER NoShortcut
  Skip creating the Desktop shortcut.

.PARAMETER Headless
  Build only the headless MCP server and skip the interface entirely.

  Headless is the mode to run when an agent is the only user: the same
  Workspace, without a page. Measured on 300 notes it settles around 85 MB,
  against 135 MB with the interface open.

  Implies -NoShortcut. Combine with -Connect to register it with your agents.

.PARAMETER Connect
  Register this bundle's MCP server with every agent runtime found on PATH:
  Claude Code, Codex, opencode and Hermes Agent.

  Each config file is copied to <file>.okf-backup-<timestamp> before a single
  entry is added or replaced. Nothing else in those files is touched.
  Without this switch the runtimes are only detected and reported.

  Ollama and llama.cpp are skipped deliberately: they are model servers, not
  MCP clients, so there is nothing on their side to configure. Drive those from
  the app's built-in agent instead (Skill -> ローカル実行).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

.EXAMPLE
  SETUP.bat -Connect
#>

[CmdletBinding()]
param(
    [string] $BundlePath,
    [switch] $NoShortcut,
    [switch] $Connect,
    [switch] $Headless,
    <#
      Anything PowerShell could not bind.

      A path written with a trailing backslash, which looks entirely
      reasonable, leaves a stray positional argument: the backslash escapes the
      closing quote when PowerShell is started with -File. Collecting the
      remainder here means that mistake produces a warning about the one thing
      that was wrong, rather than an error about parameter binding.
    #>
    [Parameter(ValueFromRemainingArguments = $true)] [string[]] $Unrecognised
)

# Defined before first use: the argument repair below reports through them, and
# `param()` has to be the first statement in the file.
function Write-Step { param([string] $Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string] $Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Note { param([string] $Message) Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Warn { param([string] $Message) Write-Host "    $Message" -ForegroundColor Yellow }

# An explicit choice is not second-guessed later; the default location is.
$BundlePathWasGiven = -not [string]::IsNullOrWhiteSpace($BundlePath)

# Headless has no interface, so a desktop shortcut would point at nothing.
if ($Headless) { $NoShortcut = [switch]::Present }

<#
  Undo the trailing-backslash quoting trap.

  `SETUP.bat -BundlePath "C:\notes\"` looks correct and is not: the backslash
  before the closing quote escapes it, so PowerShell receives one argument
  containing the path *and every switch after it*. The bundle then gets created
  somewhere absurd, or fails with a path nobody typed — and the switches are
  silently ignored, which is the part that wastes an afternoon.

  Recovering the path is easy. Recovering the switches is not, so their loss is
  reported rather than guessed at.
#>
if ($Unrecognised) {
    Write-Warn ("解釈できない指定がありました: " + ($Unrecognised -join " "))
    Write-Warn 'パスの末尾に \ を付けると閉じ引用符が打ち消されます。"C:\notes" のように指定してください。'
}

if ($BundlePath) {
    $original = $BundlePath
    if ($BundlePath -match '"') { $BundlePath = ($BundlePath -split '"')[0] }
    $BundlePath = $BundlePath.Trim().TrimEnd('\', '/')

    if ($BundlePath -ne $original.Trim()) {
        Write-Warn "パスの引用符を解釈し直しました: $BundlePath"
        Write-Warn '末尾の \ が閉じ引用符を打ち消しています。"C:\notes" のように \ 無しで指定してください。'
        $swallowed = ($original -split '"', 2)[1]
        if ($swallowed -and $swallowed.Trim()) {
            Write-Warn "次の指定は読み取れませんでした:$swallowed"
        }
    }
}

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The launcher sets the console to UTF-8; match it so Japanese output renders
# rather than turning into mojibake.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppName = 'PierrotKnowledge2'

Write-Host ''
Write-Host '  PierrotKnowledge2 — セットアップ' -ForegroundColor White
Write-Host '  ========================================' -ForegroundColor DarkGray
Write-Host '  Bun / 依存関係 / アイコン / ビルド / バンドル / デスクトップアイコン' -ForegroundColor DarkGray
Write-Host '  何度実行しても安全です（既存ファイルは上書きしません）' -ForegroundColor DarkGray

<#
  Fail with the exit code and the command to reproduce it.

  The previous form — `if ($LASTEXITCODE -ne 0) { throw 'X failed' }` — threw
  away the only useful information. A user hitting this on their own machine
  could report the step but not the reason, which is exactly what happened.
#>
function Assert-LastExit {
    param(
        [Parameter(Mandatory)] [string] $What,
        [string] $Retry = '',
        [string[]] $Hints = @()
    )
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host ''
    Write-Host "  $What に失敗しました (終了コード $LASTEXITCODE)" -ForegroundColor Red
    foreach ($h in $Hints) { Write-Host "    - $h" -ForegroundColor Yellow }
    if ($Retry) {
        Write-Host ''
        Write-Host '  同じ処理を手で実行すると、原因が表示されます:' -ForegroundColor DarkGray
        Write-Host "    $Retry" -ForegroundColor White
    }
    Write-Host ''
    throw "$What に失敗しました (終了コード $LASTEXITCODE)"
}

# --- Bun -------------------------------------------------------------------

function Get-BunPath {
    $command = Get-Command bun -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    # A fresh install lands here but is not on PATH until the shell restarts.
    $fallback = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    if (Test-Path $fallback) { return $fallback }

    return $null
}

Write-Step 'Checking for Bun'
$Bun = Get-BunPath

if (-not $Bun) {
    Write-Note 'Bun not found — installing from bun.sh'
    try {
        # Official installer. Requires network access.
        Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    } catch {
        throw "Failed to install Bun automatically: $($_.Exception.Message)`nInstall it manually from https://bun.sh and re-run this script."
    }

    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
    $Bun = Get-BunPath
    if (-not $Bun) { throw 'Bun installed but could not be located. Open a new terminal and re-run.' }
}

Write-Ok "Bun: $Bun ($(& $Bun --version))"

# --- what the shortcut will start --------------------------------------------

<#
.SYNOPSIS
  Decide what the Desktop shortcut should start.

.DESCRIPTION
  Two outcomes:

    web   the interface served on 127.0.0.1 and opened in the user's own
          browser. What the shortcut starts, in every case but one.
    none  headless, where there is no interface to start at all.

  There used to be four, two of which packaged a window. Kept as a function
  even at two, because the summary at the end reports what was chosen and the
  choice should be made once.
#>
function Get-LaunchMode {
    param([switch] $Headless)

    if ($Headless) { return 'none' }
    return 'web'
}

# --- dependencies ----------------------------------------------------------

Write-Step 'Installing dependencies'
Push-Location $ProjectRoot
try {
    & $Bun install
    Assert-LastExit -What '依存関係のインストール' -Retry 'bun install' -Hints @(
        'ネットワークに接続されているか',
        'ウイルス対策ソフトが node_modules への書き込みを止めていないか'
    )
    Write-Ok 'Dependencies installed'

    # --- icon --------------------------------------------------------------

    Write-Step 'Generating application icon'
    & $Bun run scripts/make-icon.ts
    Assert-LastExit -What 'アイコンの生成' -Retry 'bun run icon'
    Write-Ok 'assets/icon.ico'

    # --- build -------------------------------------------------------------

    $LaunchMode = Get-LaunchMode -Headless:$Headless

    if ($Headless) {
        Write-Step 'Building the headless MCP server only (-Headless)'
        & $Bun run build:headless
        Assert-LastExit -What 'ヘッドレス版のビルド' -Retry 'bun run build:headless'
    } else {
        # The view and nothing else: no runtime to package, no WebView to
        # embed. Seconds rather than the minutes packaging used to take.
        Write-Step 'Building the interface'
        & $Bun run build:view
        Assert-LastExit -What '画面のビルド' -Retry 'bun run build:view'
        Write-Ok 'Interface ready (127.0.0.1, opens in your browser)'

        <#
          -Connect means agents are about to be registered, and agents run the
          headless server — not the interface. Without this binary the entry
          written into their config falls back to `bun run …/standalone.ts`,
          which works only where the agent host's own environment has Bun on
          PATH. A GUI-launched host often does not.

          Not built unconditionally: it is 94 MB, and someone who never
          connects an agent has no use for it.
        #>
        if ($Connect) {
            Write-Step 'Building the headless MCP server (agents run this, not the interface)'
            & $Bun run build:headless
            if ($LASTEXITCODE -ne 0) {
                # Never fatal: a stale binary still serves, and the connection
                # entries below are written either way.
                Write-Warn 'ヘッドレス版をビルドできませんでした。エージェント設定は bun 経由の起動にフォールバックします。'
            } else {
                Write-Ok 'build\headless\okf-mcp.exe'
            }
        }
    }
} finally {
    Pop-Location
}

# --- starter bundle --------------------------------------------------------

<#
.SYNOPSIS
  Create a folder and prove that a file can actually be written into it.

.DESCRIPTION
  Neither Test-Path nor New-Item is enough on their own, and the reason is
  worth writing down because it costs an afternoon otherwise.

  Known Folder Move leaves `<profile>\Documents` behind as a junction pointing
  at `<profile>\OneDrive\Documents`. Move, rename or unlink that OneDrive folder
  and the junction dangles — and a dangling junction lies twice:

    Test-Path <junction>          -> True   (the reparse point is a real entry)
    New-Item -Force <junction>\x  -> "OK"   (and creates nothing whatsoever)
    Set-Content <junction>\x\file -> "Could not find a part of the path"

  Only the third call tells the truth, and it names a file the user never asked
  about. So the folder is created, its existence re-checked afterwards, and a
  real file written and removed. The reason for any failure comes back through
  $Reason rather than as an exception, because the caller has other locations
  to try.
#>
function Test-BundleLocation {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][ref] $Reason
    )

    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            New-Item -ItemType Directory -Force -Path $Path -ErrorAction Stop | Out-Null
        }
        if (-not (Test-Path -LiteralPath $Path)) {
            throw 'フォルダを作成できませんでした（作成は成功と報告されましたが、実際には存在しません）'
        }

        $probe = Join-Path $Path '.okf-write-test'
        Set-Content -LiteralPath $probe -Value 'ok' -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        $Reason.Value = $_.Exception.Message
        return $false
    }
}

<#
.SYNOPSIS
  Find the component of a path that is not what it claims to be.

.DESCRIPTION
  "Could not find a part of the path" does not say which part, or why, and the
  part it means usually does exist. Several unrelated conditions produce that
  one message, all of which pass Test-Path:

    Documents is a link whose target was moved, renamed or deleted
    Documents is a link whose target is now a file
    Documents, or the bundle folder, is a file rather than a folder
    Documents cannot be opened at all (permissions, a failing disk)

  Cloud sync tools cause the first of those by redirecting Documents and later
  losing the destination, but they are one cause among several — a folder moved
  to a second drive by hand does the same thing, and no cloud tool need be
  installed.

  Note what is NOT used here: whether the link target exists. A junction whose
  target has been replaced by a file passes that test and still cannot be
  written to. Opening the folder is the only check that covers every case, so
  each component is opened, one entry deep.

  Returns $null when nothing is wrong, otherwise Kind ('file', 'link' or
  'unreadable') and a Message naming the component.
#>
function Get-PathFault {
    param([Parameter(Mandatory)][string] $Path)

    # Every component, outermost first: the shallowest fault is the real one.
    $chain = @()
    $current = $Path
    while ($current) {
        $chain = @($current) + $chain
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent -eq $current) { break }
        $current = $parent
    }

    foreach ($component in $chain) {
        $item = Get-Item -LiteralPath $component -Force -ErrorAction SilentlyContinue
        # Not created yet. Normal, and not a fault.
        if (-not $item) { continue }

        if (($item.Attributes -band [IO.FileAttributes]::Directory) -eq 0) {
            return [pscustomobject]@{
                Kind    = 'file'
                Message = "$component はフォルダではなくファイルです"
            }
        }

        try {
            # One entry is enough to prove the folder opens, and costs nothing
            # on a Documents folder with thousands of files in it.
            Get-ChildItem -LiteralPath $component -Force -ErrorAction Stop |
                Select-Object -First 1 | Out-Null
            continue
        } catch {
            $opened = $_
        }

        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            # `Target` on 5.1, `LinkTarget` on 7+; neither is guaranteed, and
            # Set-StrictMode turns a missing property into a terminating error.
            $target = ''
            try { $target = (@($item.Target) -join ', ') } catch { }
            if (-not $target) { try { $target = $item.LinkTarget } catch { } }

            $where = if ($target) { " (リンク先: $target)" } else { '' }
            return [pscustomobject]@{
                Kind    = 'link'
                Message = "$component はリンクですが、たどれません$where"
            }
        }

        return [pscustomobject]@{
            Kind    = 'unreadable'
            Message = "$component を開けません: $($opened.Exception.Message)"
        }
    }

    return $null
}

<#
.SYNOPSIS
  Decide where the bundle goes, and prove the choice works.

.DESCRIPTION
  An explicit -BundlePath is used exactly as given: creating the bundle
  somewhere the user did not ask for is worse than stopping.

  Without one, the candidates are tried in order. Documents is the folder
  Windows lets anything redirect — a cloud sync tool, a move to a second drive,
  a roaming profile — so it is the one location that cannot be taken on trust,
  and a starter bundle is not worth failing the whole setup over when the
  profile folder next door works fine.
#>
function Resolve-BundlePath {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string] $Requested,
        [Parameter(Mandatory)][string] $AppName,
        # Injectable so the fallback order can be tested; GetFolderPath cannot
        # be pointed anywhere else.
        [string] $DocumentsPath = [Environment]::GetFolderPath('MyDocuments')
    )

    $candidates = @()
    if ($Requested) {
        $candidates += $Requested
    } else {
        $roots = @(
            $DocumentsPath
            if ($env:OneDrive) { Join-Path $env:OneDrive 'Documents' }
            $env:USERPROFILE
            $env:LOCALAPPDATA
        )
        foreach ($root in $roots) {
            if (-not $root) { continue }
            # Only the app folder is ours to create. Conjuring a missing
            # OneDrive\Documents would put the bundle somewhere OneDrive knows
            # nothing about, which is worse than moving on to the next
            # candidate.
            if (-not (Test-Path -LiteralPath $root)) { continue }
            $candidate = Join-Path $root $AppName
            if ($candidates -notcontains $candidate) { $candidates += $candidate }
        }
    }

    $attempts = @()
    foreach ($candidate in $candidates) {
        $reason = ''
        if (Test-BundleLocation -Path $candidate -Reason ([ref] $reason)) {
            if ($attempts.Count -gt 0) {
                Write-Warn '既定の場所が使えなかったため、別の場所に作成します'
            }
            return $candidate
        }

        $fault = Get-PathFault -Path $candidate
        $attempts += [pscustomobject]@{ Path = $candidate; Reason = $reason; Fault = $fault }
        Write-Warn "使えません: $candidate"
        Write-Note "  $reason"
        if ($fault) { Write-Note "  $($fault.Message)" }
    }

    Write-Host ''
    Write-Host '  バンドルのフォルダを作成/書き込みできません:' -ForegroundColor Red
    foreach ($attempt in $attempts) {
        Write-Host "    $($attempt.Path)" -ForegroundColor White
        Write-Host "      $($attempt.Reason)" -ForegroundColor DarkGray
        if ($attempt.Fault) { Write-Host "      $($attempt.Fault.Message)" -ForegroundColor DarkGray }
    }

    # Advice for the cause that was actually found, rather than for the one
    # that is most often to blame.
    $kinds = @($attempts | Where-Object { $_.Fault } | ForEach-Object { $_.Fault.Kind })

    Write-Host ''
    Write-Host '  次のいずれかを試してください:' -ForegroundColor Yellow
    Write-Host '    - 別の場所を指定する:  .\SETUP.bat -BundlePath "C:\okf-wiki"'
    if ($kinds -contains 'link') {
        Write-Host '    - 上記のフォルダはリンク（ジャンクション/シンボリックリンク）で、'
        Write-Host '      リンク先が無くなっています。クラウド同期のフォルダ移動、'
        Write-Host '      別ドライブへの移動、外付けドライブの取り外しなどが原因です。'
        Write-Host '      リンクを作り直すか、削除して実フォルダに戻してください'
    }
    if ($kinds -contains 'file') {
        Write-Host '    - 同じ名前のファイルがフォルダの場所を塞いでいます。'
        Write-Host '      名前を変更するか削除してください'
    }
    if ($kinds -contains 'unreadable') {
        Write-Host '    - フォルダを開けません。アクセス権、ランサムウェア保護'
        Write-Host '      （コントロールされたフォルダー アクセス）、ディスクの異常を'
        Write-Host '      確認してください'
    }
    Write-Host ''
    throw 'バンドルのフォルダを準備できませんでした'
}

Write-Step 'Preparing knowledge bundle'

$BundlePath = Resolve-BundlePath -Requested $(if ($BundlePathWasGiven) { $BundlePath } else { '' }) -AppName $AppName
Write-Ok "Bundle location: $BundlePath"

Push-Location $ProjectRoot
try {
    & $Bun run scripts/init-bundle.ts $BundlePath
    Assert-LastExit -What 'バンドルの初期化' `
        -Retry "bun run scripts/init-bundle.ts `"$BundlePath`"" `
        -Hints @(
            'node_modules が壊れている場合は bun install を実行し直してください',
            '別の場所に作るなら:  .\SETUP.bat -BundlePath "C:\okf-wiki"'
        )
} finally {
    Pop-Location
}

# --- desktop shortcut ------------------------------------------------------

if (-not $NoShortcut) {
    Write-Step 'Creating Desktop shortcut'

    <#
      Settled here rather than at build time: it needs the bundle path, and the
      bundle is only resolved once the folder has been proved writable.

      The bundle is baked into the arguments deliberately. Without it the CLI
      falls back to whatever the last session opened, which is empty on a first
      run — the icon would open the app onto nothing at all.
    #>
    $shortcutTarget = Join-Path $ProjectRoot "$AppName.bat"
    $shortcutArgs = "ui --bundle `"$BundlePath`""
    # The server lives for as long as this console does. Minimised keeps it out
    # of the way while still being closable, which is how the app is stopped.
    $windowStyle = 7
    # ASCII punctuation only: the shell stores this string through COM and an
    # em dash comes back as "?", which looks like corruption in the one place a
    # user hovers to find out what the icon does. Braces are required: a bare
    # `$AppName:` parses as a drive-qualified variable, which is a syntax
    # error, not a string.
    $description = "${AppName}: ブラウザで開きます（この黒い窓を閉じると終了）"

    $desktop = [Environment]::GetFolderPath('Desktop')
    $linkPath = Join-Path $desktop "$AppName.lnk"
    $iconPath = Join-Path $ProjectRoot 'assets\icon.ico'

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($linkPath)
    $shortcut.TargetPath = $shortcutTarget
    if ($shortcutArgs) { $shortcut.Arguments = $shortcutArgs }
    $shortcut.WorkingDirectory = $ProjectRoot
    $shortcut.WindowStyle = $windowStyle
    $shortcut.Description = $description
    if (Test-Path $iconPath) { $shortcut.IconLocation = $iconPath }
    $shortcut.Save()

    # Release the COM handle so the file is not held open.
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

    Write-Ok $linkPath
    Write-Note 'ダブルクリックすると既定のブラウザで開きます'
}

# --- MCP registration hint -------------------------------------------------

<#
  Asked for rather than written here.

  This file is what someone pastes into a tool this app has no target for, so
  it must name the same server the one-press connection writes. Hand-built here
  it did not: it hard-coded `bun run …/standalone.ts` and went on recommending
  that long after the compiled headless binary became the right answer. The CLI
  derives it from `serverSpecFor`, which is the one place that decides.
#>
$mcpPath = Join-Path $ProjectRoot 'mcp-config.json'
$mcpConfig = & $Bun run src/bun/cli/main.ts mcp-config --bundle "$BundlePath" 2>$null
if ($LASTEXITCODE -eq 0 -and $mcpConfig) {
    Set-Content -Path $mcpPath -Value ($mcpConfig -join "`n") -Encoding UTF8
} else {
    Write-Warn 'mcp-config.json を生成できませんでした（接続そのものには影響しません）'
}

# --- agent runtimes --------------------------------------------------------
#
# Detected always; written only with -Connect. Editing another tool's config
# file is not something an installer should do unasked, so the default is to
# report what was found and let the user decide -- here, or from the app's
# SkillSpace panel where the exact change can be previewed first.

$runtimes = @(
    @{ Name = 'Claude Code';  Probe = 'claude';       Id = 'claude-code'; Mcp = $true },
    @{ Name = 'Codex';        Probe = 'codex';        Id = 'codex';       Mcp = $true },
    @{ Name = 'opencode';     Probe = 'opencode';     Id = 'opencode';    Mcp = $true },
    @{ Name = 'Hermes Agent'; Probe = 'hermes';       Id = 'hermes';      Mcp = $true },
    # Model servers, not MCP clients -- nothing to configure on their side.
    @{ Name = 'Ollama';       Probe = 'ollama';       Id = 'ollama';      Mcp = $false },
    @{ Name = 'llama.cpp';    Probe = 'llama-server'; Id = 'llamacpp';    Mcp = $false }
)

$found = @()
$connectable = @()
foreach ($runtime in $runtimes) {
    if (Get-Command $runtime.Probe -ErrorAction SilentlyContinue) {
        $found += $runtime.Name
        if ($runtime.Mcp) { $connectable += $runtime }
    }
}

$connected = @()
if ($Connect) {
    Write-Step 'Connecting agent runtimes (-Connect)'

    if ($connectable.Count -eq 0) {
        Write-Warn 'No MCP-capable runtime found on PATH — nothing to connect.'
    }

    foreach ($runtime in $connectable) {
        try {
            # The merge logic lives in TypeScript and is unit-tested there;
            # duplicating it in PowerShell would mean two implementations of
            # "do not destroy the user's config" and only one of them tested.
            Push-Location $ProjectRoot
            try {
                $output = & $Bun run scripts/connect-agent.ts $runtime.Id $BundlePath 2>&1
                $ok = ($LASTEXITCODE -eq 0)
            } finally {
                Pop-Location
            }

            if ($ok) {
                Write-Ok "$($runtime.Name): $output"
                $connected += $runtime.Name
            } else {
                Write-Warn "$($runtime.Name): $output"
            }
        } catch {
            Write-Warn "$($runtime.Name): $($_.Exception.Message)"
        }
    }
}

Write-Step 'Done'
Write-Host ''
Write-Host "  Bundle    : $BundlePath" -ForegroundColor White
Write-Host "  Desktop   : $(if ($NoShortcut) { 'skipped' } else { "$AppName.lnk" })" -ForegroundColor White
$modeLabel = switch ($LaunchMode) {
    'web'   { 'web (ブラウザ／127.0.0.1)' }
    default { 'headless (no UI)' }
}
Write-Host "  Mode      : $modeLabel" -ForegroundColor White
Write-Host "  MCP config: $mcpPath" -ForegroundColor White
Write-Host "  SkillSpace: $(Join-Path $BundlePath 'skills')" -ForegroundColor White
if ($Headless) {
    $hl = Join-Path $ProjectRoot 'build\headless\okf-mcp.exe'
    Write-Host "  Headless  : $hl" -ForegroundColor White
    Write-Host "              (no window; agents spawn this themselves)" -ForegroundColor DarkGray
}
if ($found.Count -gt 0) {
    Write-Host "  Detected  : $($found -join ', ')" -ForegroundColor White
}
if ($connected.Count -gt 0) {
    Write-Host "  Connected : $($connected -join ', ')" -ForegroundColor White
}
Write-Host ''
if (-not $Connect -and $connectable.Count -gt 0) {
    Write-Host '  Re-run with -Connect to register this bundle with the detected' -ForegroundColor DarkGray
    Write-Host '  runtimes automatically:  SETUP.bat -Connect' -ForegroundColor DarkGray
    Write-Host '  Or open the app and press "Skill" -> agent connection, which lets' -ForegroundColor DarkGray
    Write-Host '  you preview the exact change first.' -ForegroundColor DarkGray
    Write-Host ''
}
Write-Host '  Agents should call read_agents_md first, then loop_start, then' -ForegroundColor DarkGray
Write-Host '  skill_find. One loop per file, closed with loop_end.' -ForegroundColor DarkGray
Write-Host ''
