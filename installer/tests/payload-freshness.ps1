<#
.SYNOPSIS
    Сторож свежести payload установщика ETN (проверки build:*).

.DESCRIPTION
    Выделено из installer/tests/iss-static.ps1 (задача 8789381a, этап 6):
    эти проверки не статические — они собирают установщик из фикстур и
    поэтому требуют Inno Setup 6. Проверяют, что продуктовый build.ps1
    отказывается от неполного и устаревшего payload до компиляции: без
    клиента, с правкой server\dist или migrations после сборки, с
    разошедшейся версией клиента, с подменённым файлом client\ и без
    паспорта поставки. Свежий payload проверку проходит и собирается.

    Восемь проверок build:* — дефект 3 приёмки каркаса 9b310991 и задача
    98ad5eec (проверка версии и хэшей клиента). Запуск:

        pwsh installer/tests/payload-freshness.ps1

    Код возврата 0 — все проверки зелёные, иначе 1.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot,
    [string]$WorkRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$repoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$installerDir = Join-Path $repoRoot 'installer'
$buildScript = Join-Path $installerDir 'build.ps1'
if (-not (Test-Path -LiteralPath $buildScript)) { throw "Нет $buildScript." }
if (-not $WorkRoot) { $WorkRoot = Join-Path $repoRoot '.tmp\payload-freshness' }
$workRoot = [System.IO.Path]::GetFullPath($WorkRoot)
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

$results = New-Object System.Collections.Generic.List[object]

function Add-FreshnessResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $mark = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-32} {2}" -f $mark, $Name, $Note)
}

function Copy-Tree {
    param([string]$Source, [string]$Destination)
    & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $Source -> $Destination завершился с кодом $LASTEXITCODE." }
}

function New-FreshnessPayload {
    param([string]$Path, [switch]$WithoutClient, [switch]$WithoutMigrations,
        [string]$ClientVersion)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
    foreach ($dir in @('node', 'service', 'server\node_modules\better-sqlite3', 'client\resources')) {
        New-Item -ItemType Directory -Path (Join-Path $Path $dir) -Force | Out-Null
    }
    [System.IO.File]::WriteAllText((Join-Path $Path 'node\node.exe'), 'stub')
    [System.IO.File]::WriteAllText((Join-Path $Path 'service\etn-service.exe'), 'stub')
    $templateText = Get-Content -LiteralPath (Join-Path $installerDir 'service\etn-service.xml') -Raw -Encoding UTF8
    [System.IO.File]::WriteAllText((Join-Path $Path 'service\etn-service.xml'), $templateText,
        (New-Object System.Text.UTF8Encoding($false)))
    $serverPkg = Get-Content -LiteralPath (Join-Path $repoRoot 'server\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    [System.IO.File]::WriteAllText((Join-Path $Path 'server\package.json'),
        '{"name":"@etn/server","version":"' + $serverPkg.version + '"}')
    [System.IO.File]::WriteAllText((Join-Path $Path 'server\node_modules\better-sqlite3\package.json'),
        '{"name":"better-sqlite3","version":"11.1.2"}')
    if (-not $WithoutMigrations) {
        Copy-Tree -Source (Join-Path $repoRoot 'server\migrations') -Destination (Join-Path $Path 'server\migrations')
    }
    if (Test-Path -LiteralPath (Join-Path $repoRoot 'server\dist')) {
        Copy-Tree -Source (Join-Path $repoRoot 'server\dist') -Destination (Join-Path $Path 'server\dist')
    } else {
        New-Item -ItemType Directory -Path (Join-Path $Path 'server\dist') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $Path 'server\dist\index.js'), '// stub')
        [System.IO.File]::WriteAllText((Join-Path $Path 'server\dist\cli.js'), '// --key-out --check')
        New-Item -ItemType Directory -Path (Join-Path $Path 'server\dist\db') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $Path 'server\dist\db\db-backup.js'),
            '// backup --to restore --from --report-out')
    }
    if (-not $WithoutClient) {
        [System.IO.File]::WriteAllText((Join-Path $Path 'client\ETN.exe'), 'stub')
        [System.IO.File]::WriteAllText((Join-Path $Path 'client\resources\app.asar'), 'stub')
    }
    Write-FreshnessManifest -Path $Path -ClientVersion $ClientVersion
}

# Хэши дерева фикстуры — как в fetch-payload.ps1 (ключ — путь через '/'):
# build.ps1 сверяет client\ с картой client.hashes из паспорта поставки.
function Get-FixtureTreeHashes {
    param([string]$Root)
    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Root)) { return $map }
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
        $map[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}

# Паспорт поставки фикстуры: client_version и хэши client\ — без него
# продуктовый build.ps1 отказывается от payload как от недописанного.
function Write-FreshnessManifest {
    param([string]$Path, [string]$ClientVersion)
    $clientPkg = Get-Content -LiteralPath (Join-Path $repoRoot 'client\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $ClientVersion) { $ClientVersion = [string]$clientPkg.version }
    $hashes = Get-FixtureTreeHashes -Root (Join-Path $Path 'client')
    $manifest = [ordered]@{
        server_version = '0.0.0'
        client_version = $ClientVersion
        client         = [ordered]@{
            version = $ClientVersion
            files   = $hashes.Count
            hashes  = $hashes
        }
    }
    [System.IO.File]::WriteAllText((Join-Path $Path 'server-manifest.json'),
        ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-PayloadBuild {
    param([string]$Payload, [string]$OutputName)
    $out = & $psExeForBuild -NoProfile -ExecutionPolicy Bypass -File $buildScript `
        -PayloadRoot $Payload -OutputDir (Join-Path $workRoot $OutputName) 2>&1 | Out-String
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out }
}

$psExeForBuild = (Get-Process -Id $PID).Path

# A. Клиент обязателен: без client\ETN.exe сборка отказывается.
$noClientPayload = Join-Path $workRoot 'payload-no-client'
New-FreshnessPayload -Path $noClientPayload -WithoutClient
$noClientBuild = Invoke-PayloadBuild -Payload $noClientPayload -OutputName 'no-client-out'
Add-FreshnessResult -Name 'build:payload-requires-client' `
    -Ok (($noClientBuild.Code -ne 0) -and ($noClientBuild.Output -match 'client\\ETN\.exe')) `
    -Note 'без клиента в payload продуктовый установщик не собирается'

# B. Правка server\dist после сборки ловится сравнением всего каталога.
$staleDistPayload = Join-Path $workRoot 'payload-stale-dist'
New-FreshnessPayload -Path $staleDistPayload
[System.IO.File]::AppendAllText((Join-Path $staleDistPayload 'server\dist\index.js'),
    "`r`n// локальная правка после сборки`r`n")
$staleDistBuild = Invoke-PayloadBuild -Payload $staleDistPayload -OutputName 'stale-dist-out'
Add-FreshnessResult -Name 'build:stale-dist-detected' `
    -Ok (($staleDistBuild.Code -ne 0) -and ($staleDistBuild.Output -match 'server\\dist')) `
    -Note 'изменённый файл server\dist — payload устарел'
Add-FreshnessResult -Name 'build:stale-dist-message' `
    -Ok ($staleDistBuild.Output -match 'Обновите payload') `
    -Note 'сообщение указывает на fetch-payload.ps1'

# C. Правка migrations после сборки ловится так же.
$staleMigPayload = Join-Path $workRoot 'payload-stale-migrations'
New-FreshnessPayload -Path $staleMigPayload
$firstMigration = Get-ChildItem -LiteralPath (Join-Path $staleMigPayload 'server\migrations\system') `
    -Filter '*.sql' -File | Select-Object -First 1
if (-not $firstMigration) { throw 'В репозитории нет миграций system\*.sql для проверки свежести.' }
[System.IO.File]::AppendAllText($firstMigration.FullName, "`r`n-- локальная правка`r`n")
$staleMigBuild = Invoke-PayloadBuild -Payload $staleMigPayload -OutputName 'stale-migrations-out'
Add-FreshnessResult -Name 'build:stale-migrations-detected' `
    -Ok (($staleMigBuild.Code -ne 0) -and ($staleMigBuild.Output -match 'server\\migrations')) `
    -Note 'изменённый файл migrations — payload устарел'

# D. Свежий payload проверку проходит (нет ложного отказа) и собирается.
$freshPayload = Join-Path $workRoot 'payload-fresh'
New-FreshnessPayload -Path $freshPayload
$freshBuild = Invoke-PayloadBuild -Payload $freshPayload -OutputName 'fresh-out'
Add-FreshnessResult -Name 'build:fresh-payload-accepted' `
    -Ok (($freshBuild.Code -eq 0) -and ($freshBuild.Output -match 'Payload свежий')) `
    -Note 'свежий payload: весь server/dist, migrations и клиент совпадают'

# E. Версия клиента из манифеста сверяется с client/package.json: подмена
# client_version — отказ. Раньше client_version писался, но не читался, и
# старый клиент после неудачной package:dir проходил как свежий.
$versionPayload = Join-Path $workRoot 'payload-client-version'
New-FreshnessPayload -Path $versionPayload -ClientVersion '0.0.0'
$versionBuild = Invoke-PayloadBuild -Payload $versionPayload -OutputName 'client-version-out'
$repoClientVersion = [string](Get-Content -LiteralPath (Join-Path $repoRoot 'client\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Add-FreshnessResult -Name 'build:client-version-mismatch' `
    -Ok (($versionBuild.Code -ne 0) -and
         ($versionBuild.Output -match 'клиентом 0\.0\.0') -and
         ($versionBuild.Output -match [regex]::Escape("client $repoClientVersion"))) `
    -Note 'client_version в манифесте разошёлся с client/package.json — сборка не начинается'

# F. Хэши файлов client\ сверяются с манифестом: правка после записи паспорта
# (недокопия/подмена) — отказ.
$clientHashPayload = Join-Path $workRoot 'payload-client-hash'
New-FreshnessPayload -Path $clientHashPayload
[System.IO.File]::AppendAllText((Join-Path $clientHashPayload 'client\resources\app.asar'),
    "`r`n// правка после записи манифеста`r`n")
$clientHashBuild = Invoke-PayloadBuild -Payload $clientHashPayload -OutputName 'client-hash-out'
Add-FreshnessResult -Name 'build:client-hash-mismatch' `
    -Ok (($clientHashBuild.Code -ne 0) -and
         ($clientHashBuild.Output -match 'client') -and
         ($clientHashBuild.Output -match 'отличаются от манифеста')) `
    -Note 'файл client разошёлся с client.hashes — payload устарел'

# G. Паспорта поставки нет (fetch-payload.ps1 не дошёл до конца) — отказ, а не
# молчаливая сборка со старым клиентом.
$noManifestPayload = Join-Path $workRoot 'payload-no-manifest'
New-FreshnessPayload -Path $noManifestPayload
Remove-Item -LiteralPath (Join-Path $noManifestPayload 'server-manifest.json') -Force
$noManifestBuild = Invoke-PayloadBuild -Payload $noManifestPayload -OutputName 'no-manifest-out'
Add-FreshnessResult -Name 'build:manifest-required' `
    -Ok (($noManifestBuild.Code -ne 0) -and ($noManifestBuild.Output -match 'server-manifest\.json')) `
    -Note 'без паспорта поставки сборка не начинается'

$failed = @($results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("Свежесть payload: {0} проверок, провалов {1}" -f $results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    foreach ($item in $failed) { Write-Host ("FAIL  {0}" -f $item.Scenario) }
    exit 1
}
exit 0
