@echo off
rem ===========================================================================
rem  PierrotKnowledge2 - uninstall for Windows.
rem  Double-click this file.
rem
rem  It first shows a PLAN, then asks once. Nothing is deleted unless you
rem  answer y, because the question anyone uninstalling has is "will this
rem  take my notes with it" - and the answer has to be visible first.
rem
rem  Your knowledge bundle is never touched. It is ordinary Markdown in an
rem  ordinary folder outside this one, and the plan names it as a survivor.
rem
rem    UNINSTALL.bat                  show the plan, ask, then carry it out
rem    UNINSTALL.bat -Apply           carry it out without asking
rem    UNINSTALL.bat -PurgeSettings   also drop saved settings
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

rem Map the Windows-style switches onto the CLI's flags, so this file reads
rem like SETUP.bat while the CLI keeps one spelling.
rem
rem One command per line, dispatched by goto, rather than the shorter
rem `if COND set ... & shift & goto parse`. That shorter form does work - cmd
rem binds the whole &-chain to the if body, verified on this machine - but it
rem reads as though the chain runs unconditionally, which is the guess most
rem people make about it. Nothing here needs the reader to know the rule.
rem --confirm unless -Apply says not to ask: the plan, one question, done.
set "MODE= --confirm"
set "ARGS="

:parse
if "%~1"=="" goto run
if /i "%~1"=="-Apply" goto add_apply
if /i "%~1"=="-PurgeSettings" goto add_purge
echo   Unknown option: %~1
echo   Use: UNINSTALL.bat [-Apply] [-PurgeSettings]
echo.
pause
exit /b 2

:add_apply
set "MODE= --apply"
shift
goto parse

:add_purge
set "ARGS=%ARGS% --purge-settings"
shift
goto parse

:run
rem The source with Bun rather than the launcher: the launcher prefers
rem build\cli\okf.exe, which may be the Rust port or an older build that does
rem not know --confirm and would only print the plan. A fresh Bun install is
rem not on PATH until a new login, so look where its installer puts it too.
set "BUN=bun"
where bun >nul 2>&1
if not errorlevel 1 goto run_source
set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if exist "%BUN%" goto run_source
rem Without Bun only the compiled CLI is left, and it may not ask. Say so
rem rather than let a promised question silently become a plan and nothing.
if not "%MODE%"==" --apply" echo   Bun not found: showing the plan only. Re-run with -Apply to carry it out.
call "%~dp0PierrotKnowledge2.bat" Uninstall%MODE%%ARGS%
set "EXITCODE=%ERRORLEVEL%"
goto done

:run_source
"%BUN%" run src/bun/cli/main.ts uninstall%MODE%%ARGS%
set "EXITCODE=%ERRORLEVEL%"

:done

if not "%EXITCODE%"=="0" (
    echo.
    echo   Uninstall reported code %EXITCODE%. See the messages above.
)
echo.
pause
exit /b %EXITCODE%
