param([int]$FailAt = 1, [switch]$DockerPath)
$ErrorActionPreference = 'Stop'
$env:DATABASE_URL = 'postgres://not-used.invalid/no-connection'
if ($DockerPath) { $env:DATABASE_URL = '' }
$script:Calls = 0
function psql {
    if ('--set=ON_ERROR_STOP=1' -notin $args -or '-X' -notin $args) { throw 'Missing fail-fast options' }
    $script:Calls++
    Write-Output "MOCK_SQL $script:Calls"
    $global:LASTEXITCODE = if ($script:Calls -eq $FailAt) { 3 } else { 0 }
}
function docker {
    if (-not $DockerPath) { throw 'Unexpected Docker path' }
    if ($args[0] -eq 'inspect') { $global:LASTEXITCODE = 0; return 'true' }
    if ($args[0] -ne 'exec' -or '--set=ON_ERROR_STOP=1' -notin $args -or '-X' -notin $args) {
        throw 'Unexpected Docker command or missing SQL fail-fast options'
    }
    $input | Out-Null
    $script:Calls++
    Write-Output "MOCK_SQL $script:Calls"
    $global:LASTEXITCODE = if ($script:Calls -eq $FailAt) { 3 } else { 0 }
}
$runner = Join-Path $PSScriptRoot '../../scripts/database-migrate.ps1'
& $runner
