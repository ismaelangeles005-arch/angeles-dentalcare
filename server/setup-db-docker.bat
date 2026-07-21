@echo off
setlocal

cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker no esta instalado o no esta en el PATH.
  echo Instala Docker Desktop o configura PostgreSQL manualmente.
  pause
  exit /b 1
)

echo Levantando PostgreSQL con Docker...
docker compose up -d
if errorlevel 1 (
  echo No se pudo levantar PostgreSQL.
  pause
  exit /b 1
)

echo Esperando PostgreSQL...
timeout /t 5 /nobreak >nul

echo Creando tablas base...
docker compose exec -T postgres psql -U postgres -d dentalcare < database\schema.sql
if errorlevel 1 (
  echo No se pudieron crear las tablas base.
  pause
  exit /b 1
)

echo Aplicando migraciones...
for %%f in (database\migration_*.sql) do (
  echo - %%f
  docker compose exec -T postgres psql -U postgres -d dentalcare < %%f
  if errorlevel 1 (
    echo No se pudo aplicar %%f
    pause
    exit /b 1
  )
)

echo Base de datos lista.
echo Ahora ejecuta npm install si falta node_modules, luego npm run seed y start-all.bat.
pause

endlocal
