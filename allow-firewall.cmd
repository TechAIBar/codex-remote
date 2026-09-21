@echo off
rem Allow inbound TCP 8443 in Windows Firewall (run once, as Administrator)
rem Also removes any 'Block' rule Windows created for node.exe when the first-run prompt was dismissed
rem (a Block rule always wins over Allow, so the 8443 allow rule alone is not enough).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-firewall.ps1"
pause
