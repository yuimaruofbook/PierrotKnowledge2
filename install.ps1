<#
.SYNOPSIS
  One-line install for PierrotKnowledge2 on Windows:

    irm https://raw.githubusercontent.com/yuimaruofbook/PierrotKnowledge2/main/install.ps1 | iex

.DESCRIPTION
  The whole application is one binary. This downloads the one for this machine
  from the latest release, checks it against the digest GitHub recorded, puts
  it in %LOCALAPPDATA%\PierrotKnowledge2 (OKF_INSTALL_DIR overrides) and runs
  `okf setup`. No Rust, no Bun, no build, nothing to unzip. Run it again later
  and it updates instead.

  Kept to what Windows PowerShell 5.1 has, and free of `param()` and `exit`,
  because it runs through Invoke-Expression in the caller's own session.
  ASCII-only: 5.1 reads a BOM-less script in the OEM code page.
#>

& {
    $ErrorActionPreference = 'Stop'
    # 5.1 on older Windows 10 still offers TLS 1.0 first, which GitHub refuses.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    # 5.1's progress bar slows the download itself several-fold.
    $ProgressPreference = 'SilentlyContinue'

    $repo = 'yuimaruofbook/PierrotKnowledge2'
    $dir = if ($env:OKF_INSTALL_DIR) { $env:OKF_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'PierrotKnowledge2' }
    $okf = Join-Path $dir 'okf.exe'

    # Already installed: this is an update.
    if (Test-Path -LiteralPath $okf) {
        & $okf update --confirm
        return
    }

    $release = Invoke-RestMethod -TimeoutSec 30 -Headers @{ Accept = 'application/vnd.github+json' } `
        -Uri "https://api.github.com/repos/$repo/releases/latest"

    # An x64 PowerShell on ARM reports AMD64 for itself and ARM64 here. A
    # release without an ARM build still runs there, emulated.
    $arm = "$env:PROCESSOR_ARCHITEW6432 $env:PROCESSOR_ARCHITECTURE" -match 'ARM64'
    $names = @('okf-windows-x64.exe')
    if ($arm) { $names = @('okf-windows-arm64.exe') + $names }
    $asset = $null
    foreach ($name in $names) {
        $asset = $release.assets | Where-Object { $_.name -eq $name -and $_.digest } | Select-Object -First 1
        if ($asset) { break }
    }
    if (-not $asset) { throw "The latest release has no $($names -join ' or ') with a digest to verify." }

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $staged = Join-Path $dir 'okf.download.exe'
    try {
        Write-Host "  Downloading: $($asset.browser_download_url)"
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $staged

        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $staged).Hash.ToLower()
        if ("sha256:$hash" -ne "$($asset.digest)".ToLower()) {
            throw 'Hash mismatch: the download is corrupt or was tampered with.'
        }

        # The digest proves it is the published file, not that it runs here.
        $savedBundle = $env:OKF_BUNDLE
        $env:OKF_BUNDLE = ''
        # Windows Defender holds a freshly written .exe while it scans it.
        foreach ($attempt in 1..5) {
            & cmd /c "`"$staged`" help >nul 2>nul"
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Seconds 1
        }
        $env:OKF_BUNDLE = $savedBundle
        if ($LASTEXITCODE -ne 0) { throw "$($asset.name) does not start on this machine." }

        Move-Item -LiteralPath $staged -Destination $okf -Force
    } finally {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    }

    Write-Host "  Installed to: $okf"
    & $okf setup
}
