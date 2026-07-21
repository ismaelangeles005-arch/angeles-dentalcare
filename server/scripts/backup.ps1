param(
  [string]$BackupRoot = ""
)

$ErrorActionPreference = "Stop"

$serverRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$projectRoot = Split-Path -Parent $serverRoot

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  $BackupRoot = Join-Path $serverRoot "backups"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $BackupRoot "backup-$timestamp"
$dbFile = Join-Path $backupDir "dentalcare-$timestamp.sql"
$filesZip = Join-Path $backupDir "patient-files-$timestamp.zip"
$manifestFile = Join-Path $backupDir "manifest.json"
$storagePath = Join-Path $serverRoot "storage\patient-files"

New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

Write-Host "Creando backup de PostgreSQL..."
docker exec dentalcare-postgres pg_dump `
  -U postgres `
  -d dentalcare `
  --clean `
  --if-exists `
  --no-owner `
  --no-privileges `
  --format=plain | Out-File -LiteralPath $dbFile -Encoding utf8

if (-not (Test-Path -LiteralPath $dbFile) -or ((Get-Item -LiteralPath $dbFile).Length -le 0)) {
  throw "No se pudo crear el backup SQL."
}

Write-Host "Creando backup de archivos clinicos..."
if (Test-Path -LiteralPath $storagePath) {
  $items = Get-ChildItem -LiteralPath $storagePath -Force

  if ($items.Count -gt 0) {
    Compress-Archive -Path (Join-Path $storagePath "*") -DestinationPath $filesZip -Force
  }
  else {
    "La carpeta de archivos clinicos estaba vacia." | Out-File -LiteralPath (Join-Path $backupDir "patient-files-empty.txt") -Encoding utf8
  }
}
else {
  "No existe la carpeta storage\patient-files." | Out-File -LiteralPath (Join-Path $backupDir "patient-files-missing.txt") -Encoding utf8
}

$manifest = [ordered]@{
  app = "Angeles DentalCare"
  createdAt = (Get-Date).ToString("o")
  database = "dentalcare"
  postgresContainer = "dentalcare-postgres"
  dbBackup = (Split-Path -Leaf $dbFile)
  dbBackupBytes = (Get-Item -LiteralPath $dbFile).Length
  filesBackup = if (Test-Path -LiteralPath $filesZip) { Split-Path -Leaf $filesZip } else { $null }
  filesBackupBytes = if (Test-Path -LiteralPath $filesZip) { (Get-Item -LiteralPath $filesZip).Length } else { 0 }
  sourceProject = $projectRoot
}

$manifest | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $manifestFile -Encoding utf8

Write-Host ""
Write-Host "Backup completado:"
Write-Host $backupDir
Write-Host ""
Write-Host "Guarda una copia fuera de esta PC, por ejemplo en disco externo o nube privada."
