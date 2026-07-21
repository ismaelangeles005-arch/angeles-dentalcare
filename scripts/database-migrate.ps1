$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DatabaseDir = Join-Path $Root "server\database"
$Schema = Join-Path $DatabaseDir "schema.sql"
$Migrations = Get-ChildItem -LiteralPath $DatabaseDir -Filter "migration_*.sql" -File | Sort-Object Name

Write-Host "Angeles DentalCare - Migraciones de base de datos" -ForegroundColor Cyan
Write-Host "Este script no borra datos. Aplica schema/migraciones sobre la base configurada."

if (-not (Test-Path -LiteralPath $Schema)) {
    throw "No existe schema.sql en $DatabaseDir."
}

if ($env:DATABASE_URL -and (Get-Command psql -ErrorAction SilentlyContinue)) {
    Write-Host "Usando psql local con DATABASE_URL."
    psql $env:DATABASE_URL -f $Schema
    foreach ($Migration in $Migrations) {
        psql $env:DATABASE_URL -f $Migration.FullName
    }
    exit 0
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $ContainerName = "dentalcare-postgres"
    $Running = docker inspect -f "{{.State.Running}}" $ContainerName 2>$null
    if ($LASTEXITCODE -eq 0 -and $Running -eq "true") {
        Write-Host "Usando contenedor Docker de desarrollo: $ContainerName"
        Get-Content -LiteralPath $Schema | docker exec -i $ContainerName psql -U postgres -d dentalcare
        foreach ($Migration in $Migrations) {
            Write-Host ("Aplicando {0}" -f $Migration.Name)
            Get-Content -LiteralPath $Migration.FullName | docker exec -i $ContainerName psql -U postgres -d dentalcare
        }
        exit 0
    }
}

throw "No se encontro psql con DATABASE_URL ni el contenedor dentalcare-postgres activo."
