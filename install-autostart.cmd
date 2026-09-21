@echo off
rem Register a scheduled task that starts the gateway in background at logon (uses built-in schtasks)
rem Running again overwrites the old task. Uninstall: schtasks /delete /tn codex-remote /f
setlocal
set "CR_ROOT=%~dp0"
schtasks /create /f /tn codex-remote /sc onlogon /rl highest /tr "wscript.exe \"%CR_ROOT%start-hidden.vbs\""
if errorlevel 1 (
  echo Failed to create scheduled task. Run this file as Administrator.
  pause
  exit /b 1
)
echo Scheduled task codex-remote registered (starts hidden at logon). Starting it now:
schtasks /run /tn codex-remote
pause
endlocal
