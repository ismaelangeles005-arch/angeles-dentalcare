$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackupScript = Join-Path $Root "server\scripts\backup.ps1"
if (-not (Test-Path -LiteralPath $BackupScript)) { throw "No se encontro $BackupScript" }
& $BackupScript
