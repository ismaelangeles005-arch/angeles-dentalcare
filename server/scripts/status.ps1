param(
    [switch]$NoPause
)

$ErrorActionPreference = "SilentlyContinue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ServerRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ApiHealth = "http://127.0.0.1:3001/api/health"
$FrontendUrl = "http://127.0.0.1:5500"
$ContainerName = "dentalcare-postgres"

function Write-Title($Text) {
    Write-Host ""
    Write-Host "==== $Text ====" -ForegroundColor Cyan
}

function Write-Check($Label, $Ok, $Detail = "") {
    $status = if ($Ok) { "OK" } else { "REVISION" }
    $color = if ($Ok) { "Green" } else { "Yellow" }
    Write-Host ("{0,-28} [{1}] {2}" -f $Label, $status, $Detail) -ForegroundColor $color
}

function Test-CommandAvailable($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-VersionLine($Command, $Arguments) {
    try {
        $output = & $Command $Arguments 2>$null
        if ($LASTEXITCODE -eq 0 -and $output) { return ($output | Select-Object -First 1) }
    }
    catch {}
    return "No disponible"
}

function Test-Port($Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Invoke-Health($Url) {
    try {
        return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5
    }
    catch {
        return $null
    }
}

function Invoke-DbScalar($Sql) {
    if (-not (Test-CommandAvailable "docker")) { return $null }
    $result = docker exec $ContainerName psql -U postgres -d dentalcare -t -A -c $Sql 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($result | Select-Object -First 1).Trim()
}

Clear-Host
Write-Host "Angeles DentalCare - Estado local" -ForegroundColor Cyan
Write-Host ("Fecha: {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"))
Write-Host ("Proyecto: {0}" -f $Root)

Write-Title "Herramientas"
Write-Check "Node.js" (Test-CommandAvailable "node") (Get-VersionLine "node" "--version")
Write-Check "npm" (Test-CommandAvailable "npm") (Get-VersionLine "npm" "--version")
Write-Check "Docker" (Test-CommandAvailable "docker") (Get-VersionLine "docker" "--version")

Write-Title "Archivos del sistema"
Write-Check ".env backend" (Test-Path (Join-Path $ServerRoot ".env")) (Join-Path $ServerRoot ".env")
Write-Check "Dependencias backend" (Test-Path (Join-Path $ServerRoot "node_modules")) "server\node_modules"
Write-Check "Frontend principal" (Test-Path (Join-Path $Root "index.html")) "index.html"
Write-Check "API principal" (Test-Path (Join-Path $ServerRoot "src\server.js")) "server\src\server.js"

Write-Title "Docker y puertos"
$dockerRunning = $false
if (Test-CommandAvailable "docker") {
    docker info *> $null
    $dockerRunning = $LASTEXITCODE -eq 0
}
Write-Check "Docker Desktop" $dockerRunning

$containerRunning = $false
if ($dockerRunning) {
    $containerStatus = docker inspect -f "{{.State.Running}}" $ContainerName 2>$null
    $containerRunning = $containerStatus -eq "true"
}
Write-Check "Postgres container" $containerRunning $ContainerName
Write-Check "Puerto API 3001" (Test-Port 3001) "http://127.0.0.1:3001/api/health"
Write-Check "Puerto Frontend 5500" (Test-Port 5500) "http://127.0.0.1:5500"
Write-Check "Puerto Postgres 5433" (Test-Port 5433) "Base de datos local Docker"
Write-Check "Puerto Adminer 8080" (Test-Port 8080) "http://127.0.0.1:8080"

Write-Title "Servicios"
$health = Invoke-Health $ApiHealth
Write-Check "API health" ($null -ne $health -and $health.ok -eq $true) $(if ($health) { "DB: $($health.database)" } else { "Sin respuesta" })
$frontendOk = $false
$frontendDetail = "Sin respuesta"
try {
    $request = [System.Net.WebRequest]::Create($FrontendUrl)
    $request.Timeout = 5000
    $response = $request.GetResponse()
    $frontendDetail = "HTTP " + [int]$response.StatusCode
    $frontendOk = [int]$response.StatusCode -eq 200
    $response.Close()
}
catch {
    if (Test-Port 5500) {
        $frontendDetail = "Puerto abierto, HTTP sin respuesta"
    }
}
Write-Check "Frontend" $frontendOk $frontendDetail

Write-Title "Base de datos"
$dbOk = Invoke-DbScalar "SELECT 1;"
Write-Check "Conexion DB" ($dbOk -eq "1") "database dentalcare"
if ($dbOk -eq "1") {
    Write-Check "Usuarios" $true (Invoke-DbScalar "SELECT COUNT(*) FROM users WHERE deleted_at IS NULL;")
    Write-Check "Pacientes" $true (Invoke-DbScalar "SELECT COUNT(*) FROM patients WHERE deleted_at IS NULL;")
    Write-Check "Citas activas" $true (Invoke-DbScalar "SELECT COUNT(*) FROM appointments WHERE deleted_at IS NULL;")
    Write-Check "Archivos clinicos" $true (Invoke-DbScalar "SELECT COUNT(*) FROM patient_files WHERE deleted_at IS NULL;")
    Write-Check "Notificaciones sin leer" $true (Invoke-DbScalar "SELECT COUNT(*) FROM notifications WHERE read_at IS NULL;")
}

Write-Title "Backups"
$backupRoot = Join-Path $ServerRoot "backups"
if (Test-Path $backupRoot) {
    $latestBackup = Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Write-Check "Carpeta backups" $true $backupRoot
    Write-Check "Ultimo backup" ($null -ne $latestBackup) $(if ($latestBackup) { "$($latestBackup.Name) - $($latestBackup.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))" } else { "Sin backups" })
}
else {
    Write-Check "Carpeta backups" $false "No existe"
}

Write-Title "Accesos"
Write-Host "App:     http://127.0.0.1:5500"
Write-Host "API:     http://127.0.0.1:3001/api/health"
Write-Host "Adminer: http://127.0.0.1:8080"
Write-Host ""
Write-Host "Si algun punto sale en REVISION, ejecuta start-all.bat y vuelve a correr status.bat." -ForegroundColor Yellow

if (-not $NoPause) {
    Write-Host ""
    pause
}

