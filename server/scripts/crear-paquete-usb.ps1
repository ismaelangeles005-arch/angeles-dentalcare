param([string]$OutputRoot = "")
$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ServerRoot = Join-Path $ProjectRoot "server"
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $ProjectRoot "dist-usb" }
if (-not (Test-Path -LiteralPath $OutputRoot)) { New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null }
Get-ChildItem -LiteralPath $OutputRoot -Force -Filter "dentalcare-usb*" | Remove-Item -Recurse -Force
$PackageRoot = Join-Path $OutputRoot "dentalcare-usb"
$ZipPath = "$PackageRoot.zip"

$excludeDirs = @(".git", ".vs", "dist-usb", "node_modules", "apps\desktop\node_modules", "apps\desktop\dist", "installer\windows\dist", "server\node_modules", "server\backups", "server\storage\tmp")
$excludeFiles = @("server\.env", "images\Codex Installer.exe", "images\Microsoft.Services.Store.winmd")

function Test-IsExcluded($FullName) {
    $relative = $FullName.Substring($ProjectRoot.Path.Length).TrimStart("\", "/")
    foreach ($dir in $excludeDirs) {
        if ($relative -eq $dir -or $relative.StartsWith($dir + "\")) { return $true }
    }
    foreach ($file in $excludeFiles) {
        if ($relative -eq $file) { return $true }
    }
    return $false
}

if (Test-Path $PackageRoot) { Remove-Item -LiteralPath $PackageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null

Get-ChildItem -LiteralPath $ProjectRoot -Force | ForEach-Object {
    if (-not (Test-IsExcluded $_.FullName)) {
        $destination = Join-Path $PackageRoot $_.Name
        if ($_.PSIsContainer) { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
        else { Copy-Item -LiteralPath $_.FullName -Destination $destination -Force }
    }
}

foreach ($dir in $excludeDirs) {
    $target = Join-Path $PackageRoot $dir
    if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
foreach ($file in $excludeFiles) {
    $target = Join-Path $PackageRoot $file
    if (Test-Path $target) { Remove-Item -LiteralPath $target -Force }
}

$backupRoot = Join-Path $ServerRoot "backups"
$latestBackup = $null
if (Test-Path $backupRoot) { $latestBackup = Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
if ($latestBackup) {
    $destBackupRoot = Join-Path $PackageRoot "server\backups"
    New-Item -ItemType Directory -Path $destBackupRoot -Force | Out-Null
    Copy-Item -LiteralPath $latestBackup.FullName -Destination (Join-Path $destBackupRoot $latestBackup.Name) -Recurse -Force
}

$readme = @"
Angeles DentalCare - Paquete USB
Generado: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Este paquete NO incluye node_modules para ahorrar espacio.
En la otra PC instala Node.js y Docker Desktop, luego ejecuta:

Uso web local:
1. server\setup-db-docker.bat
2. Entra a server y ejecuta: npm install
3. server\restore-backup.bat si quieres restaurar los datos incluidos
4. server\start-all.bat
5. status.bat para verificar que todo este OK

Base desktop / instalador:
1. Entra a la carpeta principal dentalcare-usb
2. Ejecuta: npm install
3. Ejecuta: npm run desktop para abrir como app Windows
4. Ejecuta: npm run installer para ver la fase de instalador preparada
5. Mas adelante: npm run desktop:build generara el instalador en installer\windows\dist

App local: http://127.0.0.1:5500
API: http://127.0.0.1:3001/api/health
Adminer: http://127.0.0.1:8080
"@
Set-Content -LiteralPath (Join-Path $PackageRoot "LEEME-USB.txt") -Value $readme -Encoding UTF8

if (Test-Path $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Compress-Archive -LiteralPath $PackageRoot -DestinationPath $ZipPath -Force

$folderSize = (Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force | Measure-Object -Property Length -Sum).Sum
$zipSize = (Get-Item -LiteralPath $ZipPath).Length
Write-Host "Paquete creado:" -ForegroundColor Green
Write-Host $PackageRoot
Write-Host "ZIP:" -ForegroundColor Green
Write-Host $ZipPath
Write-Host ("Tamano carpeta: {0} MB" -f ([math]::Round($folderSize / 1MB, 2)))
Write-Host ("Tamano ZIP: {0} MB" -f ([math]::Round($zipSize / 1MB, 2)))
if ($latestBackup) { Write-Host ("Backup incluido: {0}" -f $latestBackup.Name) -ForegroundColor Green }
else { Write-Host "No se encontro backup para incluir." -ForegroundColor Yellow }




