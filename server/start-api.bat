@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en el PATH.
  echo Instala Node.js LTS desde https://nodejs.org/
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm no esta instalado o no esta en el PATH.
  echo Instala Node.js LTS desde https://nodejs.org/
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Se creo .env desde .env.example.
  echo Revisa DATABASE_URL y JWT_SECRET antes de usar en produccion real.
)

if not exist "node_modules" (
  echo Instalando dependencias...
  npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

echo Iniciando API en http://localhost:3001/api
echo Prueba: http://localhost:3001/api/health
npm run dev

endlocal
