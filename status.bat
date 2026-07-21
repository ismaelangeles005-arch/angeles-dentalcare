@echo off
setlocal
cd /d "%~dp0server"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\scripts\status.ps1"
endlocal
