$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Targets = @(
    (Join-Path $Root "installer\windows\dist"),
    (Join-Path $Root "apps\desktop\dist")
)

Write-Host "Angeles DentalCare - Limpieza de artefactos de paquete" -ForegroundColor Cyan

foreach ($Target in $Targets) {
    if (Test-Path -LiteralPath $Target) {
        Write-Host ("Eliminando {0}" -f $Target)
        Remove-Item -LiteralPath $Target -Recurse -Force
    }
    else {
        Write-Host ("No existe {0}" -f $Target)
    }
}

Write-Host "Limpieza completada. No se tocaron datos, backups, documentos ni base de datos." -ForegroundColor Green
