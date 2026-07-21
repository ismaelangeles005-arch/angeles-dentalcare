$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$envPath = Join-Path $root "server\.env"
if (-not (Test-Path -LiteralPath $envPath)) {
    throw "No se encontro server\.env"
}

Write-Host ""
Write-Host "Esto limpiara datos de demostracion:" -ForegroundColor Yellow
Write-Host "- pacientes"
Write-Host "- citas"
Write-Host "- presupuestos/facturas"
Write-Host "- notas clinicas"
Write-Host "- archivos clinicos subidos"
Write-Host "- notificaciones"
Write-Host "- auditoria"
Write-Host ""
Write-Host "Se conservaran usuarios, doctores, roles, procedimientos y precios." -ForegroundColor Cyan
Write-Host ""
$confirm = Read-Host "Escribe LIMPIAR para continuar"
if ($confirm -ne "LIMPIAR") {
    Write-Host "Operacion cancelada."
    exit 0
}

$backupBat = Join-Path $root "server\backup-now.bat"
if (Test-Path -LiteralPath $backupBat) {
    Write-Host "Creando backup antes de limpiar..." -ForegroundColor Cyan
    & $backupBat
}

$sql = @"
BEGIN;
TRUNCATE TABLE
  billing_estimate_items,
  billing_estimates,
  clinical_notes,
  patient_files,
  appointments,
  patients,
  notifications,
  audit_logs
RESTART IDENTITY CASCADE;
COMMIT;
"@

Write-Host "Limpiando base de datos..." -ForegroundColor Cyan
$sql | docker exec -i dentalcare-postgres psql -U postgres -d dentalcare

$uploads = Join-Path $root "server\uploads"
if (Test-Path -LiteralPath $uploads) {
    Write-Host "Limpiando archivos clinicos subidos..." -ForegroundColor Cyan
    Get-ChildItem -LiteralPath $uploads -Force | Remove-Item -Recurse -Force
}

Write-Host ""
Write-Host "Datos de demostracion limpiados. La app quedo lista para mostrar como nueva." -ForegroundColor Green
Write-Host "Usuarios, doctores, procedimientos y precios siguen intactos." -ForegroundColor Green
