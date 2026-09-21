@echo off
rem Set CR_NODE to override automatic Node.js discovery.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if defined CR_NODE goto run
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined CR_NODE set "CR_NODE=%%N"
if not defined CR_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "CR_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined CR_NODE (
  echo Node.js was not found. Install Node.js or set CR_NODE to node.exe.
  exit /b 1
)
:run
"%CR_NODE%" server.js %*
exit /b %errorlevel%
