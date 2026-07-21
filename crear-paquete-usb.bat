@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\scripts\crear-paquete-usb.ps1"
pause
endlocal
