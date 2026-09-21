@echo off
rem Stop codex-remote gateway (only kills node.exe running codex-remote\server.js; ChatGPT desktop is untouched)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*codex-remote*server.js*' } | ForEach-Object { Write-Host ('stopping pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
pause
