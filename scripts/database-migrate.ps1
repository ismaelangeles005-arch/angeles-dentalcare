$ErrorActionPreference = "Stop"
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DatabaseDir = Join-Path $Root "server\database"
$Schema = Join-Path $DatabaseDir "schema.sql"
$Manifest = Join-Path $DatabaseDir "migrations.json"
$Names = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$Available = @(Get-ChildItem -LiteralPath $DatabaseDir -Filter "migration_*.sql" -File)
if (($Names | Select-Object -Unique).Count -ne $Names.Count -or
    $Names.Count -ne $Available.Count) {
    throw "Manifest de migraciones incompleto o duplicado."
}
$Migrations = foreach ($Name in $Names) {
    if ($Name -notmatch '^migration_[a-z_]+\.sql$' -or $Name -notin $Available.Name) {
        throw "Migracion no valida en manifest: $Name"
    }
    Get-Item -LiteralPath (Join-Path $DatabaseDir $Name)
}

function Assert-SqlExit([int]$Code, [string]$File) {
    if ($Code -ne 0) { throw "Fallo SQL en $File (exit code $Code). No se continuara." }
}

Write-Host "Angeles DentalCare - Migraciones de base de datos" -ForegroundColor Cyan
Write-Host "Este script no borra datos. Aplica schema/migraciones sobre la base configurada."

if (-not (Test-Path -LiteralPath $Schema)) {
    throw "No existe schema.sql en $DatabaseDir."
}

if ($env:DATABASE_URL) {
    if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
        throw "DATABASE_URL esta definida pero psql no esta disponible. No se usara Docker como fallback."
    }
    Write-Host "Usando psql local con DATABASE_URL."
    Get-Content -LiteralPath $Schema -Encoding UTF8 | psql -X --set=ON_ERROR_STOP=1 $env:DATABASE_URL
    Assert-SqlExit $LASTEXITCODE "schema.sql"
    foreach ($Migration in $Migrations) {
        Get-Content -LiteralPath $Migration.FullName -Encoding UTF8 | psql -X --set=ON_ERROR_STOP=1 $env:DATABASE_URL
        Assert-SqlExit $LASTEXITCODE $Migration.Name
    }
    Write-Host "Schema y migraciones finalizados correctamente."
    exit 0
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $ContainerName = "dentalcare-postgres"
    $Running = docker inspect -f "{{.State.Running}}" $ContainerName 2>$null
    if ($LASTEXITCODE -eq 0 -and $Running -eq "true") {
        Write-Host "Usando contenedor Docker de desarrollo: $ContainerName"
        Get-Content -LiteralPath $Schema -Encoding UTF8 | docker exec -i $ContainerName psql -X --set=ON_ERROR_STOP=1 -U postgres -d dentalcare
        Assert-SqlExit $LASTEXITCODE "schema.sql"
        foreach ($Migration in $Migrations) {
            Write-Host ("Aplicando {0}" -f $Migration.Name)
            Get-Content -LiteralPath $Migration.FullName -Encoding UTF8 | docker exec -i $ContainerName psql -X --set=ON_ERROR_STOP=1 -U postgres -d dentalcare
            Assert-SqlExit $LASTEXITCODE $Migration.Name
        }
        Write-Host "Schema y migraciones finalizados correctamente."
        exit 0
    }
}

throw "No se encontro psql con DATABASE_URL ni el contenedor dentalcare-postgres activo."
