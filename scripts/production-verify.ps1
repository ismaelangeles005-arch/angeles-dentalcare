$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Config = Join-Path $Root "shared\config\product-config.json"
$BuilderConfig = Join-Path $Root "apps\desktop\electron-builder.json"
$Dist = Join-Path $Root "installer\windows\dist"

function Write-Check($Label, $Ok, $Detail = "") {
    $Color = if ($Ok) { "Green" } else { "Yellow" }
    $Status = if ($Ok) { "OK" } else { "REVISION" }
    Write-Host ("{0,-34} [{1}] {2}" -f $Label, $Status, $Detail) -ForegroundColor $Color
}

Write-Host "Angeles DentalCare - Verificacion de produccion" -ForegroundColor Cyan
Write-Host ("Proyecto: {0}" -f $Root)

Write-Check "Config producto" (Test-Path -LiteralPath $Config) $Config
Write-Check "Config electron-builder" (Test-Path -LiteralPath $BuilderConfig) $BuilderConfig
Write-Check "Icono Windows" (Test-Path -LiteralPath (Join-Path $Root "resources\icons\icon.ico")) "resources\icons\icon.ico"
Write-Check "Backend node_modules" (Test-Path -LiteralPath (Join-Path $Root "server\node_modules")) "incluido para cliente sin npm install"
Write-Check "Frontend index" (Test-Path -LiteralPath (Join-Path $Root "index.html")) "frontend empaquetable"
Write-Check "Schema SQL" (Test-Path -LiteralPath (Join-Path $Root "server\database\schema.sql")) "server\database\schema.sql"

$Installer = Get-ChildItem -LiteralPath $Dist -Filter "AngelesDentalCare-Setup-*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
Write-Check "Instalador generado" ($null -ne $Installer -and $Installer.Length -gt 0) $(if ($Installer) { $Installer.FullName } else { $Dist })

Write-Host ""
Write-Host "Rutas productivas previstas:"
Write-Host "Datos:      C:\ProgramData\AngelesDentalCare"
Write-Host "Logs:       C:\ProgramData\AngelesDentalCare\logs"
Write-Host "Backups:    C:\ProgramData\AngelesDentalCare\backups"
Write-Host "Documentos: C:\ProgramData\AngelesDentalCare\documents"
Write-Host "Media:      C:\ProgramData\AngelesDentalCare\media"
