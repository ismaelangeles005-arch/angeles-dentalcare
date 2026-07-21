$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Dist = Join-Path $Root "installer\windows\dist"

Write-Host "Angeles DentalCare - Build de instalador Windows" -ForegroundColor Cyan
Write-Host ("Proyecto: {0}" -f $Root)

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm no esta disponible. En esta PC de desarrollo se necesita npm para compilar el instalador."
}

if (Test-Path -LiteralPath $Dist) {
    Write-Host "Limpiando salida anterior: $Dist"
    Remove-Item -LiteralPath $Dist -Recurse -Force
}

Push-Location $Root
try {
    npm.cmd run desktop:build
    if ($LASTEXITCODE -ne 0) {
        throw "electron-builder fallo con codigo $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$installer = Get-ChildItem -LiteralPath $Dist -Filter "AngelesDentalCare-Setup-*.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    throw "No se genero ningun instalador AngelesDentalCare-Setup-*.exe en $Dist."
}

if ($installer.Length -le 0) {
    throw "El instalador generado pesa 0 bytes."
}

Write-Host ""
Write-Host "Instalador generado correctamente:" -ForegroundColor Green
Write-Host $installer.FullName
Write-Host ("Tamano: {0:N2} MB" -f ($installer.Length / 1MB))
