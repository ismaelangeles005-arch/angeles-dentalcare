$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$RestoreScript = Join-Path $Root "server\scripts\restore.ps1"
if (-not (Test-Path -LiteralPath $RestoreScript)) { throw "No se encontro $RestoreScript" }
& $RestoreScript @args
