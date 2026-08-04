@echo off
rem PierrotKnowledge2 - this application's own command.
rem
rem Named after the app rather than "okf", which is a short generic word and
rem likely to collide with another tool on the same PATH. Everything after the
rem command name is passed straight through:
rem
rem   PierrotKnowledge2 Update
rem   PierrotKnowledge2 Update --apply
rem   PierrotKnowledge2 ui
rem
rem Kept to plain ASCII with no parenthesised blocks: cmd.exe parses this file
rem line by line in whatever code page the console happens to be in, and a
rem multi-byte character inside an if-block loses the closing paren.

setlocal
set "ROOT=%~dp0"

if exist "%ROOT%build\cli\okf.exe" goto :compiled

where bun >nul 2>&1
if errorlevel 1 goto :nobun

pushd "%ROOT%"
bun run src/bun/cli/main.ts %*
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%

:compiled
"%ROOT%build\cli\okf.exe" %*
exit /b %ERRORLEVEL%

:nobun
echo Bun not found. Install it from https://bun.sh
exit /b 1
