param(
  [Parameter(Mandatory = $true)]
  [string]$SqlFile,

  [string]$FilesZip = "",

  [switch]$Force
)

$ErrorActionPreference = "Stop"

$serverRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$storagePath = Join-Path $serverRoot "storage\patient-files"

if (-not (Test-Path -LiteralPath $SqlFile)) {
  throw "No existe el archivo SQL: $SqlFile"
}

if (-not $Force) {
  Write-Host "ADVERTENCIA: esta restauracion puede reemplazar datos actuales de la base dentalcare."
  $answer = Read-Host "Escribe RESTAURAR para continuar"

  if ($answer -ne "RESTAURAR") {
    Write-Host "Restauracion cancelada."
    exit 1
  }
}

Write-Host "Restaurando base de datos desde:"
Write-Host $SqlFile
Get-Content -LiteralPath $SqlFile -Raw | docker exec -i dentalcare-postgres psql -U postgres -d dentalcare

if (-not [string]::IsNullOrWhiteSpace($FilesZip)) {
  if (-not (Test-Path -LiteralPath $FilesZip)) {
    throw "No existe el ZIP de archivos clinicos: $FilesZip"
  }

  New-Item -ItemType Directory -Force -Path $storagePath | Out-Null
  Expand-Archive -LiteralPath $FilesZip -DestinationPath $storagePath -Force
  Write-Host "Archivos clinicos restaurados en:"
  Write-Host $storagePath
}

Write-Host "Restauracion completada."
