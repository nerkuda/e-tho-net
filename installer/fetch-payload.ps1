<#
.SYNOPSIS
    Подготовка payload установщика ETN: Node 22, WinSW, сервер и клиент.

.DESCRIPTION
    Воспроизводимо готовит installer/payload для installer/build.ps1:

      payload/
        node/node.exe              Node 22 LTS (официальный win-x64 zip,
                                   версия и SHA-256 закреплены ниже);
        service/etn-service.exe    WinSW (закреплённая версия и SHA-256);
        service/etn-service.xml    шаблон службы из installer/service/;
        server/package.json        server/package.json без изменений;
        server/dist/               сборка @etn/server;
        server/migrations/         миграции system/ и network/;
        server/node_modules/       prod-зависимости (без dev), плюс
                                   собранные @etn/shared и @etn/markdown;
        client/                    распакованная сборка @etn/client
                                   (electron-builder --dir: ETN.exe,
                                   resources/app.asar, migrations,
                                   THIRD-PARTY-NOTICES.txt);
        server-manifest.json       паспорт поставки: версии и SHA-256 самого
                                   payload (Node, WinSW), resolved-версии
                                   зависимостей, версия клиента, Electron и
                                   хэши файлов client\; пишется последним
                                   шагом, а в начале прогона удаляется — по
                                   нему build.ps1 отличает свежую поставку от
                                   остатка неудачного прогона.

    Раскладка — контракт installer/etn.iss ([Files] и проверки payload при
    компиляции): программа ставится в {app}, где node\, server\, service\ и
    client\ лежат рядом. Точка запуска службы — `node.exe server\dist\index.js`
    (см. installer/service/etn-service.xml), клиента — `client\ETN.exe`
    (машинная установка) или `ETN.exe` в корне {app} («только для меня»).

    Шаги:
      1. скачать/взять из кэша и проверить SHA-256 Node и WinSW;
      2. разложить node.exe, winsw (etn-service.exe), шаблон службы;
      3. собрать @etn/shared, @etn/markdown и @etn/server;
      4. установить prod-зависимости сервера в staging-каталог и скопировать
         их в payload (workspace-пакеты @etn/* кладутся физически, без
         симлинков npm);
      5. скопировать package.json, dist и migrations сервера;
      6. собрать клиент (electron-builder --dir, цель dir — NSIS снят задачей
         98ad5eec) и скопировать release/win-unpacked в payload/client;
      7. проверить поставку: версия Node = 22, загрузка нативного
         better-sqlite3 под поставленный node.exe, импорт @etn/shared и
         @etn/markdown, наличие миграций, ETN.exe клиента и resources/app.asar;
         затем (если не указан -SkipSmokeTest) поднять сервер из payload на
         временном каталоге данных и свободном порту и проверить
         GET /api/v1/health.

    Кэш скачанных архивов — installer/.cache (gitignored), payload —
    installer/payload (gitignored). Повторный запуск идемпотентен: каталоги
    node/, service/, server/ и client/ пересоздаются.

    Внимание: electron-builder пересобирает better-sqlite3 клиента (11.10.0,
    Electron ABI) в корневом node_modules. Запущенный dev-клиент
    (node_modules\electron) держит better_sqlite3.node и ломает сборку
    (EBUSY/EPERM) — закройте его перед подготовкой payload.

    Требования: Node 22 (nvm use 22), выполненный npm install в корне
    репозитория (нужны dev-зависимости для сборки), доступ к nodejs.org и
    github.com для первой загрузки.

    Задачи 8b1f5980 и 98ad5eec (0.15.1). Лицензии поставки —
    installer/third-party/; описание контракта и плейсхолдеров службы —
    installer/README.md.

.PARAMETER CacheDir
    Каталог кэша загрузок. По умолчанию installer/.cache.

.PARAMETER PayloadRoot
    Каталог payload. По умолчанию installer/payload.

.PARAMETER SkipSmokeTest
    Не поднимать сервер из payload (оставить только статические проверки).

.EXAMPLE
    pwsh -File installer/fetch-payload.ps1

.EXAMPLE
    pwsh -File installer/fetch-payload.ps1 -SkipSmokeTest
#>
[CmdletBinding()]
param(
    [string]$CacheDir,
    [string]$PayloadRoot,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

# --- Закреплённые версии и контрольные суммы --------------------------------
# Node 22 LTS: версия обязана оставаться в линии 22 (ADR 01c38213, .nvmrc);
# better-sqlite3 11.1.2 собран под ABI Node 22 (NODE_MODULE_VERSION 127).
# SHA-256 — из https://nodejs.org/dist/v<версия>/SHASUMS256.txt.
$NodeVersion = '22.23.4'
$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeArchiveUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName"
$NodeArchiveSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'

# WinSW 2.12.0 (MIT, ADR db60302a): self-contained x64 сборка, .NET не нужен.
# Проект WinSW не публикует файлы контрольных сумм: SHA-256 закреплён по
# официальному артефакту релиза GitHub (WinSW-x64.exe, 18 243 033 байт).
$WinSwVersion = '2.12.0'
$WinSwAssetName = 'WinSW-x64.exe'
$WinSwUrl = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/$WinSwAssetName"
$WinSwSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

# Версия нативного модуля фиксирована: client/ ставит другую (11.10.0), их
# нельзя выравнивать (AGENTS.md).
$BetterSqlite3Version = '11.1.2'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

function Resolve-FullPath {
    param([string]$Path, [string]$Base)
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $Path))
}

if (-not $CacheDir) { $CacheDir = Join-Path $PSScriptRoot '.cache' }
$CacheDir = Resolve-FullPath -Path $CacheDir -Base $repoRoot

if (-not $PayloadRoot) { $PayloadRoot = Join-Path $PSScriptRoot 'payload' }
$PayloadRoot = Resolve-FullPath -Path $PayloadRoot -Base $repoRoot

# Паспорт поставки пишется в самом конце и удаляется в начале прогона: иначе
# неудачный прогон (например, package:dir упал на занятом better_sqlite3.node)
# оставлял бы в payload старый клиент и старый манифест, по которым build.ps1
# считал бы поставку свежей (замечание приёмки 98ad5eec).
$manifestPath = Join-Path $PayloadRoot 'server-manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
    Remove-Item -LiteralPath $manifestPath -Force
}

$payloadNode = Join-Path $PayloadRoot 'node'
$payloadService = Join-Path $PayloadRoot 'service'
$payloadServer = Join-Path $PayloadRoot 'server'
$payloadClient = Join-Path $PayloadRoot 'client'
$nodeExe = Join-Path $payloadNode 'node.exe'
$serviceTemplate = Join-Path $PSScriptRoot 'service\etn-service.xml'
$stagingDir = Join-Path $CacheDir 'server-prod'
$clientReleaseDir = Join-Path $repoRoot 'client\release\win-unpacked'

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction Stop }
$npmCmd = $npmCmd.Source

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Хэши файлов дерева для паспорта поставки: ключ — относительный путь через
# '/', значение — SHA-256. Сортировка делает манифест воспроизводимым. По этой
# карте build.ps1 проверяет, что payload\client — ровно та сборка, которую
# записал fetch-payload.ps1, а не остаток неудачного прогона (98ad5eec).
function Get-TreeHashes {
    param([string]$Root)
    $map = [ordered]@{}
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
        $map[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}

function Assert-FileHash {
    param([string]$Path, [string]$Expected, [string]$What)
    $actual = Get-FileSha256 -Path $Path
    if ($actual -ne $Expected) {
        throw "${What}: SHA-256 не совпал. Ожидалось $Expected, получено $actual ($Path). Файл повреждён или подменён — загрузка отклонена."
    }
    Write-Host "  SHA-256 OK: $What"
}

function Get-PinnedFile {
    param([string]$Url, [string]$FileName, [string]$Sha256)
    $target = Join-Path $CacheDir $FileName
    if (Test-Path -LiteralPath $target) {
        if ((Get-FileSha256 -Path $target) -eq $Sha256) {
            Write-Host "  из кэша: $target"
            return $target
        }
        Write-Warning "Кэш не совпал по SHA-256, скачиваю заново: $target"
        Remove-Item -LiteralPath $target -Force
    }
    $tmp = "$target.download"
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    Write-Host "  скачивание: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    Assert-FileHash -Path $tmp -Expected $Sha256 -What $FileName
    Move-Item -LiteralPath $tmp -Destination $target -Force
    return $target
}

function Invoke-Npm {
    param([string]$WorkingDirectory, [string[]]$Arguments)
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $npmCmd @Arguments
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        throw "npm $($Arguments -join ' ') в $WorkingDirectory завершился с кодом $code."
    }
}

function Copy-Directory {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source)) { throw "Нет каталога-источника: $Source" }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    # Коды robocopy < 8 — успех (1 = скопированы файлы).
    if ($LASTEXITCODE -ge 8) { throw "robocopy $Source -> $Destination завершился с кодом $LASTEXITCODE." }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Read-JsonFile {
    param([string]$Path)
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-InstalledVersion {
    param([string]$PackageName)
    $parts = $PackageName.Split('/')
    $pkgPath = Join-Path (Join-Path $payloadServer 'node_modules') ($parts -join [System.IO.Path]::DirectorySeparatorChar)
    $pkgPath = Join-Path $pkgPath 'package.json'
    if (-not (Test-Path -LiteralPath $pkgPath)) { throw "В поставке нет зависимости $PackageName ($pkgPath)." }
    return [string](Read-JsonFile -Path $pkgPath).version
}

# Версия зависимости, с которой проект установлен и протестирован: npm
# разрешает её из server/node_modules (конфликтующие версии вроде
# better-sqlite3) либо из корня репозитория (hoisting). Точная версия
# записывается в staging package.json — сборка payload не «плывёт» по
# диапазонам от запуска к запуску.
function Get-RepoInstalledVersion {
    param([string]$PackageName)
    $relative = ($PackageName.Split('/') -join [System.IO.Path]::DirectorySeparatorChar)
    $candidates = @(
        (Join-Path (Join-Path $repoRoot 'server\node_modules') (Join-Path $relative 'package.json')),
        (Join-Path (Join-Path $repoRoot 'node_modules') (Join-Path $relative 'package.json'))
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return [string](Read-JsonFile -Path $candidate).version }
    }
    throw "Зависимость $PackageName не установлена в репозитории — выполните npm install (Node 22) и повторите."
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

Write-Host "ETN payload: Node $NodeVersion, WinSW $WinSwVersion, better-sqlite3 $BetterSqlite3Version"
Write-Host "  кэш:     $CacheDir"
Write-Host "  payload: $PayloadRoot"

New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
New-Item -ItemType Directory -Path $PayloadRoot -Force | Out-Null

# --- 1. Node 22 --------------------------------------------------------------
Write-Step "1/7 Node $NodeVersion"
$nodeZip = Get-PinnedFile -Url $NodeArchiveUrl -FileName $NodeArchiveName -Sha256 $NodeArchiveSha256
$nodeExtract = Join-Path $CacheDir "node-v$NodeVersion"
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
$extractedNodeExe = Join-Path $nodeExtract "node-v$NodeVersion-win-x64\node.exe"
if (-not (Test-Path -LiteralPath $extractedNodeExe)) { throw "В архиве Node нет node.exe: $extractedNodeExe" }
New-Item -ItemType Directory -Path $payloadNode -Force | Out-Null
Copy-Item -LiteralPath $extractedNodeExe -Destination $nodeExe -Force

$nodeReportedVersion = (& $nodeExe -v).Trim()
if ($nodeReportedVersion -ne "v$NodeVersion") {
    throw "Поставленный node.exe сообщил версию $nodeReportedVersion, ожидалась v$NodeVersion."
}
if ($nodeReportedVersion -notmatch '^v22\.') {
    throw "Node в поставке должен быть линии 22 (ADR 01c38213), получено $nodeReportedVersion."
}
Write-Host "  node.exe: $nodeReportedVersion"

# --- 2. WinSW и шаблон службы ------------------------------------------------
Write-Step "2/7 WinSW $WinSwVersion"
$winSwExe = Get-PinnedFile -Url $WinSwUrl -FileName $WinSwAssetName -Sha256 $WinSwSha256
if (-not (Test-Path -LiteralPath $serviceTemplate)) { throw "Нет шаблона службы: $serviceTemplate" }
$templateText = Get-Content -LiteralPath $serviceTemplate -Raw -Encoding UTF8
foreach ($placeholder in @('{{DATA_DIR}}', '{{PORT}}', '{{HOST}}')) {
    if (-not $templateText.Contains($placeholder)) { throw "В шаблоне службы нет плейсхолдера $placeholder ($serviceTemplate)." }
}
# Шаблон обязан быть well-formed XML: WinSW читает его XmlDocument.
try {
    $null = [xml]$templateText
} catch {
    throw "Шаблон службы не является корректным XML: $serviceTemplate — $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $payloadService) { Remove-Item -LiteralPath $payloadService -Recurse -Force }
New-Item -ItemType Directory -Path $payloadService -Force | Out-Null
Copy-Item -LiteralPath $winSwExe -Destination (Join-Path $payloadService 'etn-service.exe') -Force
Copy-Item -LiteralPath $serviceTemplate -Destination (Join-Path $payloadService 'etn-service.xml') -Force
Write-Host '  service/etn-service.exe + etn-service.xml'

# --- 3. Сборка workspace-пакетов -------------------------------------------
Write-Step '3/7 Сборка @etn/shared, @etn/markdown, @etn/server'
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
    throw "Нет node_modules в $repoRoot — выполните npm install (Node 22) перед сборкой payload."
}
Invoke-Npm -WorkingDirectory $repoRoot -Arguments @('run', 'build:shared')
Invoke-Npm -WorkingDirectory $repoRoot -Arguments @('-w', '@etn/server', 'run', 'build')

$serverDir = Join-Path $repoRoot 'server'
$sharedDir = Join-Path $repoRoot 'shared'
$markdownDir = Join-Path $repoRoot 'markdown'
foreach ($artifact in @(
        (Join-Path $serverDir 'dist\index.js'),
        (Join-Path $serverDir 'dist\cli.js'),
        (Join-Path $serverDir 'dist\db\db-backup.js'),
        (Join-Path $sharedDir 'dist\index.js'),
        (Join-Path $markdownDir 'dist\index.js'))) {
    if (-not (Test-Path -LiteralPath $artifact)) { throw "Сборка не создала $artifact." }
}
Write-Host '  сборка на месте: server/dist, shared/dist, markdown/dist'

# --- 4. Prod-зависимости сервера --------------------------------------------
Write-Step '4/7 Prod-зависимости сервера'
$serverPkg = Read-JsonFile -Path (Join-Path $serverDir 'package.json')
$markdownPkg = Read-JsonFile -Path (Join-Path $markdownDir 'package.json')

# Staging package.json: prod-зависимости сервера плюс зависимости
# @etn/markdown (он ставится вместе с сервером, его dist импортирует их).
# Workspace-пакеты @etn/* в npm не публикуются — их кладём физически после
# установки. Если markdown получит новую зависимость, она попадёт сюда
# автоматически: список читается из его package.json, а не дублируется.
# Версии — точные, из установленного дерева репозитория (см.
# Get-RepoInstalledVersion), чтобы состав поставки не менялся от запуска
# к запуску вместе с диапазонами ^x.y.z.
$stagingDependencies = [ordered]@{}
foreach ($dep in $serverPkg.dependencies.PSObject.Properties) {
    if ($dep.Name -like '@etn/*') { continue }
    $stagingDependencies[$dep.Name] = Get-RepoInstalledVersion -PackageName $dep.Name
}
foreach ($dep in $markdownPkg.dependencies.PSObject.Properties) {
    if ($dep.Name -like '@etn/*') { continue }
    if (-not $stagingDependencies.Contains($dep.Name)) {
        $stagingDependencies[$dep.Name] = Get-RepoInstalledVersion -PackageName $dep.Name
    }
}
if (-not $stagingDependencies.Contains('better-sqlite3')) {
    throw 'В зависимостях сервера нет better-sqlite3 — поставка невозможна.'
}
if (([string]$stagingDependencies['better-sqlite3']) -ne $BetterSqlite3Version) {
    throw "better-sqlite3 в server/package.json должен быть жёстко $BetterSqlite3Version, найдено $($stagingDependencies['better-sqlite3'])."
}

if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
$stagingPkg = [ordered]@{
    name         = 'etn-server-prod'
    private      = $true
    description  = 'Prod-зависимости ETN-сервера для установщика (задача 8b1f5980)'
    dependencies = $stagingDependencies
}
Write-Utf8NoBom -Path (Join-Path $stagingDir 'package.json') -Text ($stagingPkg | ConvertTo-Json -Depth 5)
Invoke-Npm -WorkingDirectory $stagingDir -Arguments @('install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error')

New-Item -ItemType Directory -Path $payloadServer -Force | Out-Null
Copy-Directory -Source (Join-Path $stagingDir 'node_modules') -Destination (Join-Path $payloadServer 'node_modules')

# Workspace-пакеты: физические копии package.json + dist (npm создаёт на
# file:-зависимости симлинки, а установщик должен упаковать реальные файлы).
foreach ($workspacePackage in @(
        @{ Name = 'shared'; Source = $sharedDir },
        @{ Name = 'markdown'; Source = $markdownDir })) {
    $dest = Join-Path (Join-Path $payloadServer 'node_modules') ('@etn' + [System.IO.Path]::DirectorySeparatorChar + $workspacePackage.Name)
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $workspacePackage.Source 'package.json') -Destination $dest -Force
    Copy-Directory -Source (Join-Path $workspacePackage.Source 'dist') -Destination (Join-Path $dest 'dist')
}
Write-Host "  prod node_modules: $((Get-ChildItem -LiteralPath (Join-Path $payloadServer 'node_modules') -Force).Count) записей"

# --- 5. Файлы сервера --------------------------------------------------------
Write-Step '5/7 package.json, dist и migrations сервера'
Copy-Item -LiteralPath (Join-Path $serverDir 'package.json') -Destination (Join-Path $payloadServer 'package.json') -Force
Copy-Directory -Source (Join-Path $serverDir 'dist') -Destination (Join-Path $payloadServer 'dist')
Copy-Directory -Source (Join-Path $serverDir 'migrations') -Destination (Join-Path $payloadServer 'migrations')
Write-Host "  server/package.json (версия $($serverPkg.version)), dist, migrations"

# --- 6. Клиент ---------------------------------------------------------------
Write-Step '6/7 Сборка клиента (electron-builder --dir)'
# electron-builder пересобирает нативный better-sqlite3 клиента в корневом
# node_modules. Запущенный dev-клиент держит этот файл и сборка падает на
# EBUSY/EPERM — предупреждаем заранее, а не показываем стек npm.
$devElectron = @(Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith((Join-Path $repoRoot 'node_modules\electron'), [System.StringComparison]::OrdinalIgnoreCase)
    })
if ($devElectron.Count -gt 0) {
    Write-Warning ("Запущен dev-клиент из репозитория (PID " + (($devElectron | ForEach-Object { $_.Id }) -join ', ') +
        "): electron-builder не сможет пересобрать better-sqlite3 (файл занят). " +
        'Закройте dev-клиент; сборка будет предпринята, но может завершиться EBUSY/EPERM.')
}
$clientPkg = Read-JsonFile -Path (Join-Path $repoRoot 'client\package.json')
Invoke-Npm -WorkingDirectory $repoRoot -Arguments @('-w', '@etn/client', 'run', 'package:dir')
$clientExe = Join-Path $clientReleaseDir 'ETN.exe'
if (-not (Test-Path -LiteralPath $clientExe)) {
    throw "electron-builder --dir не создал клиент: нет $clientExe. Проверьте client/electron-builder.yml (цель win: dir)."
}
Copy-Directory -Source $clientReleaseDir -Destination $payloadClient
foreach ($clientRequired in @(
        (Join-Path $payloadClient 'ETN.exe'),
        (Join-Path $payloadClient 'resources\app.asar'),
        (Join-Path $payloadClient 'resources\migrations'),
        (Join-Path $payloadClient 'resources\THIRD-PARTY-NOTICES.txt'))) {
    if (-not (Test-Path -LiteralPath $clientRequired)) {
        throw "В каталоге клиента нет обязательного файла: $clientRequired"
    }
}
$clientExeSize = [math]::Round(((Get-Item -LiteralPath (Join-Path $payloadClient 'ETN.exe')).Length / 1MB), 1)
Write-Host "  client/ETN.exe (версия $($clientPkg.version), Electron $($clientPkg.devDependencies.electron), $clientExeSize МБ), resources/app.asar, migrations, THIRD-PARTY-NOTICES.txt"

# --- 7. Проверки поставки ----------------------------------------------------
Write-Step '7/7 Проверки поставки'
Push-Location -LiteralPath $payloadServer
try {
    # Нативный модуль под поставленным Node: ABI 127, prebuilt под win32-x64.
    $sqliteProbe = & $nodeExe -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('CREATE TABLE t (x INTEGER)'); db.prepare('INSERT INTO t VALUES (?)').run(1); const n = db.prepare('SELECT COUNT(*) AS n FROM t').get().n; db.close(); console.log(n);"
    if ($LASTEXITCODE -ne 0) { throw "node.exe не смог загрузить better-sqlite3 из поставки (код $LASTEXITCODE): $sqliteProbe" }
    $sqliteVersion = Get-InstalledVersion -PackageName 'better-sqlite3'
    if ($sqliteVersion -ne $BetterSqlite3Version) {
        throw "В поставке better-sqlite3 $sqliteVersion, ожидалась $BetterSqlite3Version."
    }
    Write-Host "  better-sqlite3 ${sqliteVersion}: загрузка нативного модуля и SQL OK"

    # ESM-импорт runtime-зависимостей: bare-specifier @etn/* обязан разрешаться
    # из server/node_modules, а не из node_modules репозитория.
    $importProbe = Join-Path $payloadServer '.import-probe.mjs'
    Write-Utf8NoBom -Path $importProbe -Text @'
import { pathToFileURL } from 'node:url';
const shared = await import('@etn/shared');
const markdown = await import('@etn/markdown');
if (Object.keys(shared).length === 0) throw new Error('@etn/shared пуст');
console.log('shared+markdown ok', pathToFileURL(process.cwd()).href, Object.keys(markdown).length > 0);
'@
    try {
        $importOut = & $nodeExe $importProbe
        if ($LASTEXITCODE -ne 0) { throw "Импорт @etn/shared/@etn/markdown из поставки не работает (код $LASTEXITCODE): $importOut" }
    } finally {
        Remove-Item -LiteralPath $importProbe -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  импорт @etn/shared и @etn/markdown OK"
} finally {
    Pop-Location
}

foreach ($migrations in @('migrations\system', 'migrations\network')) {
    $migrationDir = Join-Path $payloadServer $migrations
    if (-not (Test-Path -LiteralPath $migrationDir)) { throw "В поставке нет $migrationDir." }
    $count = @(Get-ChildItem -LiteralPath $migrationDir -Filter '*.sql' -File).Count
    if ($count -lt 1) { throw "В $migrationDir нет ни одного .sql." }
    Write-Host "  ${migrations}: $count миграций"
}

# Обязательные файлы контракта etn.iss. Клиент обязателен: без ETN.exe
# установщик с выбранным клиентом ставил бы пустой каталог, а build.ps1
# отбраковал бы payload как неполный (задача 98ad5eec).
foreach ($required in @(
        (Join-Path $payloadServer 'package.json'),
        (Join-Path $payloadServer 'dist\index.js'),
        (Join-Path $payloadServer 'dist\cli.js'),
        (Join-Path $payloadNode 'node.exe'),
        (Join-Path $payloadService 'etn-service.exe'),
        (Join-Path $payloadService 'etn-service.xml'),
        (Join-Path $payloadClient 'ETN.exe'),
        (Join-Path $payloadClient 'resources\app.asar'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "В payload нет обязательного файла: $required" }
}

# --- Smoke-test: init и health-check на временном каталоге данных -----------
if (-not $SkipSmokeTest) {
    Write-Step '7б Smoke-test: etn init + GET /api/v1/health'
    $smokeData = Join-Path $CacheDir 'smoke-data'
    if (Test-Path -LiteralPath $smokeData) { Remove-Item -LiteralPath $smokeData -Recurse -Force }
    New-Item -ItemType Directory -Path $smokeData -Force | Out-Null
    $smokePort = Get-FreeTcpPort

    $previousEnv = @{
        ETN_DATA_DIR = $env:ETN_DATA_DIR
        ETN_PORT     = $env:ETN_PORT
        ETN_HOST     = $env:ETN_HOST
    }
    $serverProcess = $null
    $healthJson = $null
    try {
        $env:ETN_DATA_DIR = $smokeData
        $env:ETN_PORT = [string]$smokePort
        $env:ETN_HOST = '127.0.0.1'

        Push-Location -LiteralPath $payloadServer
        try {
            $initOutput = & $nodeExe 'dist/cli.js' 'init' '--username' 'admin' '--display-name' 'Smoke Test' 2>&1
            $initCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($initCode -ne 0) { throw "etn init в поставке завершился с кодом ${initCode}: $($initOutput | Out-String)" }
        if (-not (Test-Path -LiteralPath (Join-Path $smokeData '_system.db'))) {
            throw "etn init не создал $smokeData\_system.db — миграции не применились."
        }
        Write-Host "  etn init: _system.db создана (миграции найдены)"

        $stdoutLog = Join-Path $CacheDir 'smoke-server.out.log'
        $stderrLog = Join-Path $CacheDir 'smoke-server.err.log'
        $serverProcess = Start-Process -FilePath $nodeExe -ArgumentList 'dist/index.js' `
            -WorkingDirectory $payloadServer -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

        $deadline = (Get-Date).AddSeconds(60)
        $healthy = $false
        $lastError = ''
        while ((Get-Date) -lt $deadline) {
            if ($serverProcess.HasExited) {
                throw "Сервер из поставки завершился с кодом $($serverProcess.ExitCode) до health-check. stderr: $((Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue))"
            }
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$smokePort/api/v1/health" -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -eq 200) {
                    $healthJson = $response.Content
                    $healthy = $true
                    break
                }
            } catch {
                $lastError = $_.Exception.Message
                Start-Sleep -Milliseconds 500
            }
        }
        if (-not $healthy) {
            $tail = (Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue)
            throw "Health-check не прошёл за 60 с: $lastError. stderr: $tail"
        }
        $health = $healthJson | ConvertFrom-Json
        if ($health.status -ne 'ok') { throw "Health-check вернул status=$($health.status), ожидалось ok." }
        if ($health.version -ne [string]$serverPkg.version) {
            throw "Health-check вернул версию $($health.version), в поставке $($serverPkg.version)."
        }
        Write-Host "  GET /api/v1/health: 200, status=ok, version=$($health.version)"
    } finally {
        if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
            $null = $serverProcess.WaitForExit(10000)
        }
        if (Test-Path -LiteralPath (Join-Path $CacheDir 'smoke-data')) {
            # Данные smoke-теста не нужны; удаляем, чтобы повторный init был чистым.
            Remove-Item -LiteralPath (Join-Path $CacheDir 'smoke-data') -Recurse -Force -ErrorAction SilentlyContinue
        }
        $env:ETN_DATA_DIR = $previousEnv.ETN_DATA_DIR
        $env:ETN_PORT = $previousEnv.ETN_PORT
        $env:ETN_HOST = $previousEnv.ETN_HOST
    }
} else {
    Write-Host '  smoke-test пропущен (-SkipSmokeTest)'
}

# --- Манифест поставки -------------------------------------------------------
$dependencyVersions = [ordered]@{}
foreach ($depName in $stagingDependencies.Keys) {
    $dependencyVersions[$depName] = Get-InstalledVersion -PackageName $depName
}
$sharedPkgVersion = [string](Read-JsonFile -Path (Join-Path $payloadServer 'node_modules\@etn\shared\package.json')).version
$markdownPkgVersion = [string](Read-JsonFile -Path (Join-Path $payloadServer 'node_modules\@etn\markdown\package.json')).version
$dependencyVersions['@etn/shared'] = $sharedPkgVersion
$dependencyVersions['@etn/markdown'] = $markdownPkgVersion

# Хэши файлов клиента — часть паспорта поставки: build.ps1 сверяет по ним
# payload\client (версия клиента ловит смену релиза, хэши — подмену/недокопию
# файлов после успешного прогона).
$clientHashes = Get-TreeHashes -Root $payloadClient

$manifest = [ordered]@{
    generated_at    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    server_version  = [string]$serverPkg.version
    client_version  = [string]$clientPkg.version
    node            = [ordered]@{
        version    = $NodeVersion
        sha256     = $NodeArchiveSha256
        source     = $NodeArchiveUrl
        executable = 'node\node.exe'
    }
    winsw           = [ordered]@{
        version    = $WinSwVersion
        sha256     = $WinSwSha256
        source     = $WinSwUrl
        executable = 'service\etn-service.exe'
    }
    client          = [ordered]@{
        version    = [string]$clientPkg.version
        electron   = [string]$clientPkg.devDependencies.electron
        source     = 'client\release\win-unpacked (electron-builder --dir, цель dir)'
        executable = 'client\ETN.exe'
        files      = $clientHashes.Count
        hashes     = $clientHashes
    }
    service_template = 'service\etn-service.xml'
    dependencies    = $dependencyVersions
}
Write-Utf8NoBom -Path (Join-Path $PayloadRoot 'server-manifest.json') -Text ($manifest | ConvertTo-Json -Depth 6)

Write-Host ''
Write-Host "OK: payload готов — $PayloadRoot" -ForegroundColor Green
Write-Host "  манифест: $PayloadRoot\server-manifest.json"
exit 0
