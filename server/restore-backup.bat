@echo off
setlocal
cd /d "%~dp0"
echo.
echo Arrastra o escribe la ruta del archivo .sql del backup:
set /p SQL_FILE=
echo.
echo Opcional: arrastra o escribe la ruta del ZIP de archivos clinicos, o deja vacio:
set /p FILES_ZIP=
echo.
if "%FILES_ZIP%"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore.ps1" -SqlFile "%SQL_FILE%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore.ps1" -SqlFile "%SQL_FILE%" -FilesZip "%FILES_ZIP%"
)
pause
