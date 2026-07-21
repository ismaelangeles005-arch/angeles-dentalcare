$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Dist = Join-Path $Root "installer\windows\dist"
$Installer = Get-ChildItem -LiteralPath $Dist -Filter "AngelesDentalCare-Setup-*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

Write-Host "Angeles DentalCare - Verificacion de instalador" -ForegroundColor Cyan

if (-not $Installer) {
    throw "No existe instalador en $Dist. Ejecuta npm run installer:build."
}

if ($Installer.Length -le 0) {
    throw "El instalador existe pero pesa 0 bytes: $($Installer.FullName)"
}

$RequiredFiles = @(
    "apps\desktop\electron-builder.json",
    "resources\icons\icon.ico",
    "shared\config\product-config.json",
    "server\src\server.js",
    "server\node_modules"
)

foreach ($Item in $RequiredFiles) {
    $Path = Join-Path $Root $Item
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Falta requisito para instalador: $Item"
    }
}

Write-Host ("Instalador: {0}" -f $Installer.FullName) -ForegroundColor Green
Write-Host ("Tamano: {0:N2} MB" -f ($Installer.Length / 1MB))
Write-Host "Verificacion estatica completada. La prueba de instalacion/desinstalacion debe hacerse manualmente o en VM."
