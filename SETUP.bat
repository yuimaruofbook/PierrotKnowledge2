@echo off
rem ===========================================================================
rem  PierrotKnowledge2 - one-touch setup for Windows.
rem  Double-click this file. Everything else is automatic.
rem
rem    1. install Bun if missing      4. build the interface
rem    2. install dependencies        5. create a starter knowledge bundle
rem    3. generate the app icon       6. put an icon on the Desktop
rem
rem  Safe to run repeatedly: nothing already present is overwritten.
rem
rem  The Desktop icon opens the interface: served on 127.0.0.1 and shown in
rem  your usual browser. Closing the small console window it leaves behind is
rem  how you quit.
rem
rem  OPTIONS (all optional - plain double-click needs none of them):
rem
rem    SETUP.bat -Connect
rem        Also register this bundle with every agent runtime found on PATH
rem        (Claude Code, Codex, opencode, Hermes Agent). One entry is added to
rem        each tool's own config; the original is backed up first and nothing
rem        else in it is touched. Ollama and llama.cpp are skipped - they are
rem        model servers, not MCP clients, so there is nothing to configure.
rem
rem    SETUP.bat -BundlePath "D:\Knowledge"    where to create the bundle
rem    SETUP.bat -NoShortcut                   skip the Desktop icon
rem    SETUP.bat -Headless                     MCP server only, no interface
rem
rem  Switches can be combined:  SETUP.bat -Headless -Connect
rem
rem  NOTE: this file is deliberately ASCII-only. cmd.exe reads .bat files in the
rem  system OEM codepage (932 on Japanese Windows), so non-ASCII bytes here are
rem  misdecoded and corrupt the script itself. All localised text lives in
rem  scripts\setup.ps1, where the encoding is under our control.
rem ===========================================================================

setlocal

rem Use UTF-8 for this console so the PowerShell script's output renders.
chcp 65001 >nul 2>&1

rem Run from this file's own directory, so double-clicking works from anywhere.
cd /d "%~dp0"

rem  -File rather than -Command. Wrapping the arguments into one quoted string
rem  for -Command breaks as soon as a caller quotes a path of their own, which
rem  is most of the time. The one thing -File gets wrong is a path ending in a
rem  backslash, where the backslash escapes the closing quote; setup.ps1
rem  detects that and says so.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

rem Keep the window open when double-clicked, so the output stays readable.
if not "%EXITCODE%"=="0" (
    echo.
    echo   Setup failed with code %EXITCODE%. See the messages above.
)
echo.
pause
exit /b %EXITCODE%
