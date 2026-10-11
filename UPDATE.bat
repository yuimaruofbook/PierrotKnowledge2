@echo off
rem ===========================================================================
rem  PierrotKnowledge2 - one-touch update for Windows.
rem  Double-click this file.
rem
rem  It checks for a newer release, verifies the download and shows the release
rem  notes, then asks once. Answer y and it installs the release and rebuilds
rem  the interface (and any binaries built here before); anything else leaves
rem  the install exactly as it was.
rem
rem  Your knowledge bundle is never touched, and replaced files are kept in a
rem  timestamped backup that "PierrotKnowledge2 Update --rollback" restores.
rem
rem  Close the app and any agent using it first: a running binary cannot be
rem  replaced, and that step is reported as failed rather than skipped quietly.
rem
rem  Runs the source with Bun rather than build\cli\okf.exe, because rebuilding
rem  that executable is part of the update and Windows locks a running .exe.
rem
rem  NOTE: ASCII-only on purpose. cmd.exe reads .bat files in the system OEM
rem  codepage (932 on Japanese Windows), so non-ASCII bytes here corrupt the
rem  script itself. Localised text comes from the CLI, whose encoding we own.
rem ===========================================================================

setlocal

rem Use UTF-8 for this console so the CLI's output renders.
chcp 65001 >nul 2>&1

rem Run from this file's own directory, so double-clicking works from anywhere.
cd /d "%~dp0"

rem A fresh Bun install is not on PATH until a new login, so look where its
rem installer puts it before giving up.
set "BUN=bun"
where bun >nul 2>&1
if not errorlevel 1 goto run
set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if exist "%BUN%" goto run
echo   Bun not found. Run SETUP.bat first.
echo.
pause
exit /b 1

:run
rem Everything from here to the end is ONE parenthesised block, which cmd.exe
rem reads in full before running any of it. The update replaces this very
rem file, and cmd otherwise re-reads a running batch file from disk after each
rem command, resuming at a byte offset into whatever is there now - verified
rem on this machine to skip the rest of the script. Delayed expansion, because
rem %ERRORLEVEL% inside a block is expanded once, before the update runs.
setlocal EnableDelayedExpansion
(
    "%BUN%" run src/bun/cli/main.ts update --confirm --rebuild %*
    set "EXITCODE=!ERRORLEVEL!"
    if not "!EXITCODE!"=="0" (
        echo.
        echo   Update reported code !EXITCODE!. See the messages above.
    )
    echo.
    pause
    exit /b !EXITCODE!
)
