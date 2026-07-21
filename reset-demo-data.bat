@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\scripts\reset-demo-data.ps1"
pause
