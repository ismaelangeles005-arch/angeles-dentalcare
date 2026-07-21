@echo off
setlocal

cd /d "%~dp0"

echo Iniciando Angeles DentalCare...

docker info >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Esperando Docker Desktop...
  ) else (
    echo No se encontro Docker Desktop.
    pause
    exit /b 1
  )
)

set /a attempts=0
:wait_docker
docker info >nul 2>nul
if not errorlevel 1 goto docker_ready
set /a attempts+=1
if %attempts% GEQ 30 (
  echo Docker no estuvo listo a tiempo.
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait_docker

:docker_ready
docker compose up -d
if errorlevel 1 (
  echo No se pudieron iniciar PostgreSQL y Adminer.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'src/server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden }"
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 5500 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'scripts/frontend-server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden }"

timeout /t 3 /nobreak >nul

echo.
echo Aplicacion: http://127.0.0.1:5500
echo API:        http://127.0.0.1:3001/api/health
echo Base:       http://127.0.0.1:8080
echo.
start "" "http://127.0.0.1:5500"

endlocal
