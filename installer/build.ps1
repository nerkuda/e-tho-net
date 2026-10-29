<#
.SYNOPSIS
    Сборка установщика ETN (Inno Setup 6).

.DESCRIPTION
    Читает версию из server/package.json и вызывает ISCC с /DMyAppVersion.
    Payload установщика (Node, dist, migrations, prod-node_modules, служба,
    клиент) готовят задачи 8b1f5980 и 98ad5eec; пока каталогов нет, секции
    [Files] пропускаются с предупреждением компилятора, и .iss всё равно
    компилируется.

    Перед сборкой продуктового установщика payload проверяется на свежесть:
    обязательные файлы на месте, версия сервера совпадает с репозиторием,
    dist и шаблон службы совпадают по SHA-256, CLI умеет --check и --key-out.
    Устаревший payload — ошибка с указанием, что обновить (installer/
    fetch-payload.ps1 или -RefreshPayload), а не молчаливая сборка exe,
    падающего на etn init (дефект приёмки каркаса 9b310991: собранный exe
    падал на --key-out). В -TestMode проверка пропускается: тестовая
    поставка — фикстура, она заведомо не совпадает с репозиторием.

    Задача a1211915 (0.15.1); проверка свежести payload — 9b310991.

.PARAMETER Version
    Версия установщика. По умолчанию — version из server/package.json.

.PARAMETER PayloadRoot
    Каталог подготовленного payload. По умолчанию installer/payload.

.PARAMETER OutputDir
    Каталог результата. По умолчанию <repo>/release.

.PARAMETER BaseFilename
    Базовое имя exe; к нему добавляется -<версия>. По умолчанию ETN-Setup.

.PARAMETER RefreshPayload
    Обновить payload (installer/fetch-payload.ps1) перед проверкой свежести.

.PARAMETER IsccPath
    Путь к ISCC.exe. По умолчанию ищется в Program Files (x86), Program Files,
    %LOCALAPPDATA%\Programs и PATH.

.PARAMETER TestMode
    Тестовая сборка для installer/tests/silent-codes.ps1: изолированные
    каталоги и хуки /TESTELEVATED, /TESTSERVICE, /TESTHEALTH, без деинсталлятора.

.PARAMETER TestAppDir
    Каталог программы тестовой сборки (обязателен при -TestMode).

.PARAMETER TestDataDir
    Каталог данных тестовой сборки (обязателен при -TestMode).

.EXAMPLE
    pwsh -File installer/build.ps1

.EXAMPLE
    pwsh -File installer/build.ps1 -TestMode `
        -TestAppDir .tmp\it\app -TestDataDir .tmp\it\data `
        -PayloadRoot installer\tests\fixtures\payload -OutputDir .tmp\it
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$PayloadRoot,
    [string]$OutputDir,
    [string]$BaseFilename = 'ETN-Setup',
    [switch]$RefreshPayload,
    [string]$IsccPath,
    [switch]$TestMode,
    [string]$TestAppDir,
    [string]$TestDataDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

function Resolve-FullPath {
    param([string]$Path, [string]$Base)
    if ([System.IO.Path]::IsPathRooted($Path)) { return [System.IO.Path]::GetFullPath($Path) }
    return [System.IO.Path]::GetFullPath((Join-Path $Base $Path))
}

function Find-Iscc {
    param([string]$Explicit)
    if ($Explicit) {
        $full = Resolve-FullPath -Path $Explicit -Base $repoRoot
        if (-not (Test-Path -LiteralPath $full)) { throw "ISCC.exe не найден: $full" }
        return $full
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $pf = [Environment]::GetEnvironmentVariable('ProgramFiles')
    if ($pf86) { $candidates.Add((Join-Path $pf86 'Inno Setup 6\ISCC.exe')) }
    if ($pf) { $candidates.Add((Join-Path $pf 'Inno Setup 6\ISCC.exe')) }
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')) }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $cmd = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'ISCC.exe не найден. Установите Inno Setup 6: winget install --id JRSoftware.InnoSetup -e, либо передайте -IsccPath.'
}

function Get-ServerVersion {
    param([string]$Root)
    $pkgPath = Join-Path $Root 'server\package.json'
    if (-not (Test-Path -LiteralPath $pkgPath)) { throw "Не найден $pkgPath — версия установщика берётся из него." }
    $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $pkg.version) { throw "В $pkgPath нет поля version." }
    return [string]$pkg.version
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-PackageVersion {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    try {
        $pkg = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$pkg.version
    } catch {
        return ''
    }
}

# Свежесть продуктового payload: установщик вызывает etn init с --check и
# --key-out, подставляет плейсхолдеры шаблона службы и рассчитывает на файлы
# контракта. Устаревшая поставка (например, dist/cli.js без --key-out)
# собирается в exe, который падает уже на установке, — поэтому проверка до
# компиляции. Возвращает список проблем; пустой список — payload годен.
function Test-PayloadFreshness {
    param([string]$Root, [string]$RepoRoot)
    $problems = New-Object System.Collections.Generic.List[string]
    $required = @(
        'node\node.exe',
        'server\package.json',
        'server\dist\index.js',
        'server\dist\cli.js',
        'server\node_modules\better-sqlite3\package.json',
        'service\etn-service.exe',
        'service\etn-service.xml')
    if (-not (Test-Path -LiteralPath $Root)) {
        $problems.Add("каталог payload не найден: $Root")
        return $problems
    }
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative))) {
            $problems.Add("нет обязательного файла payload: $relative")
        }
    }
    if ($problems.Count -gt 0) { return $problems }

    # Версия серверной поставки — та же, что собирается из репозитория.
    $repoVersion = Read-PackageVersion -Path (Join-Path $RepoRoot 'server\package.json')
    $payloadVersion = Read-PackageVersion -Path (Join-Path $Root 'server\package.json')
    if ($repoVersion -and ($payloadVersion -ne $repoVersion)) {
        $problems.Add("payload собран из server $payloadVersion, в репозитории $repoVersion")
    }

    # Совпадение сборки и шаблона службы с репозиторием. Если dist в
    # репозитории ещё не собран, сравнивать не с чем — об этом предупреждаем.
    foreach ($item in @(
            @{ Relative = 'server\dist\cli.js'; Source = (Join-Path $RepoRoot 'server\dist\cli.js'); What = 'CLI сервера (server\dist\cli.js)' },
            @{ Relative = 'server\dist\index.js'; Source = (Join-Path $RepoRoot 'server\dist\index.js'); What = 'сервер (server\dist\index.js)' },
            @{ Relative = 'service\etn-service.xml'; Source = (Join-Path $PSScriptRoot 'service\etn-service.xml'); What = 'шаблон службы' })) {
        if (-not (Test-Path -LiteralPath $item.Source)) {
            Write-Warning "Нет $($item.Source) — свежесть payload по $($item.Relative) не проверена."
            continue
        }
        $payloadPath = Join-Path $Root $item.Relative
        if ((Get-FileSha256 -Path $item.Source) -ne (Get-FileSha256 -Path $payloadPath)) {
            $problems.Add("payload устарел: $($item.What) отличается от сборки репозитория")
        }
    }

    # Возможности CLI, на которые опирается установщик.
    $cliText = Get-Content -LiteralPath (Join-Path $Root 'server\dist\cli.js') -Raw
    foreach ($capability in @('--key-out', '--check')) {
        if (-not $cliText.Contains($capability)) {
            $problems.Add("в payload server\dist\cli.js нет поддержки $capability — это старая сборка")
        }
    }
    # Плейсхолдеры шаблона службы: без них InstallServiceConfig не подставит
    # значения (ADR db60302a).
    $templateText = Get-Content -LiteralPath (Join-Path $Root 'service\etn-service.xml') -Raw -Encoding UTF8
    foreach ($placeholder in @('{{DATA_DIR}}', '{{PORT}}', '{{HOST}}')) {
        if (-not $templateText.Contains($placeholder)) {
            $problems.Add("в payload service\etn-service.xml нет плейсхолдера $placeholder")
        }
    }
    return $problems
}

if (-not $Version) { $Version = Get-ServerVersion -Root $repoRoot }
if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
    throw "Версия '$Version' не похожа на semver (ожидается X.Y.Z)."
}

if (-not $PayloadRoot) { $PayloadRoot = Join-Path $repoRoot 'installer\payload' }
$PayloadRoot = Resolve-FullPath -Path $PayloadRoot -Base $repoRoot

if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot 'release' }
$OutputDir = Resolve-FullPath -Path $OutputDir -Base $repoRoot

if ($TestMode) {
    if (-not $TestAppDir) { throw 'При -TestMode обязателен -TestAppDir.' }
    if (-not $TestDataDir) { throw 'При -TestMode обязателен -TestDataDir.' }
    $TestAppDir = Resolve-FullPath -Path $TestAppDir -Base $repoRoot
    $TestDataDir = Resolve-FullPath -Path $TestDataDir -Base $repoRoot
} else {
    # Перед сборкой продуктового установщика payload обязан быть свежим: см.
    # Test-PayloadFreshness. -RefreshPayload обновляет его сам (нужны Node 22,
    # npm install и доступ к nodejs.org/github.com для первой загрузки).
    if ($RefreshPayload) {
        $fetchScript = Join-Path $PSScriptRoot 'fetch-payload.ps1'
        if (-not (Test-Path -LiteralPath $fetchScript)) { throw "Нет $fetchScript." }
        Write-Host 'Обновление payload: installer/fetch-payload.ps1'
        $psExe = (Get-Process -Id $PID).Path
        & $psExe -NoProfile -ExecutionPolicy Bypass -File $fetchScript -PayloadRoot $PayloadRoot
        if ($LASTEXITCODE -ne 0) { throw "fetch-payload.ps1 завершился с кодом $LASTEXITCODE." }
    }
    $payloadProblems = @(Test-PayloadFreshness -Root $PayloadRoot -RepoRoot $repoRoot)
    if ($payloadProblems.Count -gt 0) {
        $details = ($payloadProblems | ForEach-Object { "  - $_" }) -join [Environment]::NewLine
        throw ("Payload установщика отсутствует или устарел: $PayloadRoot" + [Environment]::NewLine +
            $details + [Environment]::NewLine +
            'Обновите payload: pwsh -File installer/fetch-payload.ps1 ' +
            '(или запустите build.ps1 с -RefreshPayload).')
    }
    Write-Host 'Payload свежий: файлы контракта, версия, dist и шаблон службы совпадают с репозиторием.'
}

$iscc = Find-Iscc -Explicit $IsccPath
$issPath = Join-Path $PSScriptRoot 'etn.iss'

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$defines = @("/DMyAppVersion=$Version", "/DPayloadRoot=$PayloadRoot")
if ($TestMode) {
    $defines += '/DTestMode=1'
    $defines += "/DTestAppDir=$TestAppDir"
    $defines += "/DTestDataDir=$TestDataDir"
}

$outputName = "$BaseFilename-$Version"
if ($TestMode) { $outputName = "$BaseFilename-test-$Version" }

Write-Host "ETN installer: версия $Version"
Write-Host "  ISCC:      $iscc"
Write-Host "  скрипт:    $issPath"
Write-Host "  payload:   $PayloadRoot"
Write-Host "  результат: $OutputDir\$outputName.exe"

$isccArgs = @($defines) + @("/O$OutputDir", "/F$outputName", $issPath)
& $iscc @isccArgs
if ($LASTEXITCODE -ne 0) { throw "ISCC завершился с кодом $LASTEXITCODE." }

$result = Join-Path $OutputDir "$outputName.exe"
if (-not (Test-Path -LiteralPath $result)) { throw "Сборка прошла, но файл не найден: $result" }

Write-Host "OK: $result"
exit 0
