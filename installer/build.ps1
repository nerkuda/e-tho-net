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
    обязательные файлы на месте (включая клиент: client\ETN.exe,
    resources\app.asar и паспорт поставки server-manifest.json), версии
    сервера и клиента совпадают с репозиторием (client_version из манифеста —
    с client/package.json), хэши файлов client\ совпадают с манифестом, весь
    server\dist, все server\migrations и шаблон службы совпадают по SHA-256,
    CLI умеет --check и --key-out. Устаревший payload — ошибка с указанием,
    что обновить (installer/fetch-payload.ps1 или -RefreshPayload), а не
    молчаливая сборка exe, падающего на etn init (дефект приёмки каркаса
    9b310991: собранный exe падал на --key-out; расширение проверки на весь
    server/dist — задача 98ad5eec, дефект 0178253c; проверка версии и хэшей
    клиента — замечание приёмки 98ad5eec: после неудачной package:dir старый
    клиент проходил как свежий). В -TestMode проверка пропускается: тестовая
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

.PARAMETER CheckPayloadOnly
    Только проверить свежесть payload и выйти (код 0 — свежий, иначе —
    ошибка с перечнем причин). Компиляция exe не выполняется: нужно для
    быстрой проверки поставки на машине, где полная сборка недоступна
    (занятый dev-клиентом better_sqlite3.node, нет права симлинков).
    С -TestMode несовместим.

.PARAMETER TestUninstallMode
    Вместе с -TestMode: собрать тестовый установщик С деинсталлятором (проба
    настоящего удаления с моделью службы, приёмка 8b1f5980). У такой сборки
    отдельный AppId; после прогона запись установки в HKCU удаляется.

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
    [switch]$TestUninstallMode,
    [switch]$CheckPayloadOnly,
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
# компиляции. Сравниваются не отдельные файлы, а весь server/dist и все
# migrations (задача 98ad5eec): иначе пересборка модуля, не попавшая в
# payload, проходила проверку и поставка расходилась с репозиторием (дефект
# приёмки 0178253c). Возвращает объект { Problems; HashCompared }: пустой
# Problems — payload годен, HashCompared = false — сравнение SHA-256 с
# репозиторием пропущено (нет server/dist или шаблона в репозитории), о чём
# печатается предупреждение и отдельная итоговая формулировка.
function Get-TreeFileHashes {
    param([string]$Root)
    $map = @{}
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
        # Ключ — путь через '/', как в манифесте поставки (client.hashes):
        # хэш-карта из fetch-payload.ps1 и расчёт по дереву payload должны
        # совпадать без нормализаций на стороне вызывающего.
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
        $map[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}

# Сравнение каталога payload с каталогом репозитория: состав файлов и их
# SHA-256. Возвращает $true, если сравнение выполнено (каталог репозитория
# есть), и $false, если сравнивать не с чем — вызывающий считает проверку
# неполной. Проблемы пишутся в $Problems, а не возвращаются исключением:
# свежесть — это список причин, которые видит человек.
function Compare-PayloadTree {
    param(
        [string]$RepoTree,
        [string]$PayloadTree,
        [string]$Relative,
        [System.Collections.Generic.List[string]]$Problems
    )
    if (-not (Test-Path -LiteralPath $RepoTree)) {
        Write-Warning ("Свежесть payload по $Relative НЕ ПРОВЕРЕНА: в репозитории нет $RepoTree. " +
            'Соберите сервер (npm -w @etn/server run build) и обновите payload ' +
            '(pwsh -File installer/fetch-payload.ps1) — иначе exe может разойтись со сборкой.')
        return $false
    }
    if (-not (Test-Path -LiteralPath $PayloadTree)) {
        $Problems.Add("нет каталога payload: $Relative")
        return $true
    }
    $repo = Get-TreeFileHashes -Root $RepoTree
    $payload = Get-TreeFileHashes -Root $PayloadTree
    $missing = @($repo.Keys | Where-Object { -not $payload.ContainsKey($_) } | Sort-Object)
    $extra = @($payload.Keys | Where-Object { -not $repo.ContainsKey($_) } | Sort-Object)
    $changed = @($repo.Keys | Where-Object {
            $payload.ContainsKey($_) -and ($payload[$_] -ne $repo[$_])
        } | Sort-Object)
    $limit = 5
    if ($missing.Count -gt 0) {
        $shown = ($missing | Select-Object -First $limit) -join ', '
        $tail = if ($missing.Count -gt $limit) { " и ещё $($missing.Count - $limit)" } else { '' }
        $Problems.Add("payload устарел: в $Relative не хватает файлов: $shown$tail")
    }
    if ($extra.Count -gt 0) {
        $shown = ($extra | Select-Object -First $limit) -join ', '
        $tail = if ($extra.Count -gt $limit) { " и ещё $($extra.Count - $limit)" } else { '' }
        $Problems.Add("payload устарел: в $Relative лишние файлы, которых нет в репозитории: $shown$tail")
    }
    if ($changed.Count -gt 0) {
        $shown = ($changed | Select-Object -First $limit) -join ', '
        $tail = if ($changed.Count -gt $limit) { " и ещё $($changed.Count - $limit)" } else { '' }
        $Problems.Add("payload устарел: в $Relative отличаются от сборки репозитория: $shown$tail")
    }
    return $true
}

# Сверка дерева payload с хэш-картой из паспорта поставки (client.hashes,
# пишет fetch-payload.ps1): missing/extra/changed — как у Compare-PayloadTree.
# Нужна там, где сравнивать не с чем в репозитории: client/release/win-unpacked
# — артефакт сборки, его может не быть (gitignored, другая машина), а манифест
# едет вместе с payload и фиксирует ровно то, что скопировал fetch-payload.ps1.
function Compare-PayloadHashMap {
    param(
        [hashtable]$Expected,
        [string]$PayloadTree,
        [string]$Relative,
        [System.Collections.Generic.List[string]]$Problems
    )
    if (-not (Test-Path -LiteralPath $PayloadTree)) {
        $Problems.Add("нет каталога payload: $Relative")
        return
    }
    $actual = Get-TreeFileHashes -Root $PayloadTree
    $missing = @($Expected.Keys | Where-Object { -not $actual.ContainsKey($_) } | Sort-Object)
    $extra = @($actual.Keys | Where-Object { -not $Expected.ContainsKey($_) } | Sort-Object)
    $changed = @($Expected.Keys | Where-Object {
            $actual.ContainsKey($_) -and ($actual[$_] -ne $Expected[$_])
        } | Sort-Object)
    $limit = 5
    if ($missing.Count -gt 0) {
        $shown = ($missing | Select-Object -First $limit) -join ', '
        $tail = if ($missing.Count -gt $limit) { " и ещё $($missing.Count - $limit)" } else { '' }
        $Problems.Add("payload устарел: в $Relative не хватает файлов из манифеста: $shown$tail")
    }
    if ($extra.Count -gt 0) {
        $shown = ($extra | Select-Object -First $limit) -join ', '
        $tail = if ($extra.Count -gt $limit) { " и ещё $($extra.Count - $limit)" } else { '' }
        $Problems.Add("payload устарел: в $Relative лишние файлы, которых нет в манифесте: $shown$tail")
    }
    if ($changed.Count -gt 0) {
        $shown = ($changed | Select-Object -First $limit) -join ', '
        $tail = if ($changed.Count -gt $limit) { " и ещё $($changed.Count - $limit)" } else { '' }
        $Problems.Add("payload устарел: в $Relative отличаются от манифеста: $shown$tail")
    }
}

function Test-PayloadFreshness {
    param([string]$Root, [string]$RepoRoot)
    $problems = New-Object System.Collections.Generic.List[string]
    $result = [pscustomobject]@{ Problems = $problems; HashCompared = $false }
    $required = @(
        'node\node.exe',
        'server\package.json',
        'server\dist\index.js',
        'server\dist\cli.js',
        'server\migrations\system',
        'server\migrations\network',
        'server\node_modules\better-sqlite3\package.json',
        'service\etn-service.exe',
        'service\etn-service.xml',
        'client\ETN.exe',
        'client\resources\app.asar',
        'server-manifest.json')
    if (-not (Test-Path -LiteralPath $Root)) {
        $problems.Add("каталог payload не найден: $Root")
        return $result
    }
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative))) {
            $problems.Add("нет обязательного файла payload: $relative")
        }
    }
    if ($problems.Count -gt 0) { return $result }

    # Версия серверной поставки — та же, что собирается из репозитория.
    $repoVersion = Read-PackageVersion -Path (Join-Path $RepoRoot 'server\package.json')
    $payloadVersion = Read-PackageVersion -Path (Join-Path $Root 'server\package.json')
    if ($repoVersion -and ($payloadVersion -ne $repoVersion)) {
        $problems.Add("payload собран из server $payloadVersion, в репозитории $repoVersion")
    }

    # Клиент: версия из паспорта поставки (client_version) и хэши файлов
    # client\ (client.hashes). Раньше проверялось только наличие ETN.exe и
    # app.asar, а client_version нигде не читался: после неудачной package:dir
    # в payload оставался старый клиент и проходил проверку как свежий
    # (замечание приёмки 98ad5eec). Манифест пишется последним шагом
    # fetch-payload.ps1, поэтому его отсутствие — тоже признак недописанной
    # поставки.
    $hashTotal = 0
    $hashCompared = 0
    $hashTotal++
    $manifestPath = Join-Path $Root 'server-manifest.json'
    $repoClientVersion = Read-PackageVersion -Path (Join-Path $RepoRoot 'client\package.json')
    $manifest = $null
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $problems.Add("server-manifest.json не читается: $($_.Exception.Message)")
    }
    if (-not $manifest) {
        $problems.Add('server-manifest.json не прочитан — паспорт поставки недоступен')
    } else {
        $manifestClientVersion = ''
        if ($manifest.PSObject.Properties['client_version']) {
            $manifestClientVersion = [string]$manifest.client_version
        }
        if (-not $manifestClientVersion) {
            $problems.Add('в server-manifest.json нет client_version — поставка собрана старой версией fetch-payload.ps1, обновите payload')
        } elseif ($repoClientVersion -and ($manifestClientVersion -ne $repoClientVersion)) {
            $problems.Add("payload собран с клиентом $manifestClientVersion, в репозитории client $repoClientVersion — обновите payload")
        }
        $clientHashes = $null
        if ($manifest.PSObject.Properties['client'] -and
            $manifest.client.PSObject.Properties['hashes']) {
            $clientHashes = $manifest.client.hashes
        }
        if ($null -eq $clientHashes) {
            $problems.Add('в server-manifest.json нет client.hashes — файлы клиента не опознаны, обновите payload')
        } else {
            $expectedClient = @{}
            foreach ($prop in $clientHashes.PSObject.Properties) {
                $expectedClient[$prop.Name] = [string]$prop.Value
            }
            if ($expectedClient.Count -eq 0) {
                $problems.Add('в server-manifest.json пустой client.hashes — клиент не опознан')
            } else {
                Compare-PayloadHashMap -Expected $expectedClient `
                    -PayloadTree (Join-Path $Root 'client') -Relative 'client' `
                    -Problems $problems
                $hashCompared++
            }
        }
    }

    # Совпадение сборки сервера, миграций и шаблона службы с репозиторием.
    # Если dist в репозитории ещё не собран, сравнивать не с чем — об этом
    # предупреждаем.
    $hashTotal++
    $serviceSource = Join-Path $PSScriptRoot 'service\etn-service.xml'
    if (-not (Test-Path -LiteralPath $serviceSource)) {
        Write-Warning ("Свежесть payload по service\etn-service.xml НЕ ПРОВЕРЕНА: в репозитории нет $serviceSource. " +
            'Обновите payload (pwsh -File installer/fetch-payload.ps1) — иначе exe может разойтись со сборкой.')
    } else {
        $hashCompared++
        $payloadServiceTemplate = Join-Path $Root 'service\etn-service.xml'
        if ((Get-FileSha256 -Path $serviceSource) -ne (Get-FileSha256 -Path $payloadServiceTemplate)) {
            $problems.Add('payload устарел: шаблон службы (service\etn-service.xml) отличается от репозитория')
        }
    }
    foreach ($tree in @(
            @{ Relative = 'server\dist'; What = 'сборка сервера' },
            @{ Relative = 'server\migrations'; What = 'миграции сервера' })) {
        $hashTotal++
        $compared = Compare-PayloadTree `
            -RepoTree (Join-Path $RepoRoot $tree.Relative) `
            -PayloadTree (Join-Path $Root $tree.Relative) `
            -Relative $tree.Relative `
            -Problems $problems
        if ($compared) { $hashCompared++ }
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
    return [pscustomobject]@{ Problems = $problems; HashCompared = ($hashCompared -eq $hashTotal) }
}

if (-not $Version) { $Version = Get-ServerVersion -Root $repoRoot }
if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
    throw "Версия '$Version' не похожа на semver (ожидается X.Y.Z)."
}

if (-not $PayloadRoot) { $PayloadRoot = Join-Path $repoRoot 'installer\payload' }
$PayloadRoot = Resolve-FullPath -Path $PayloadRoot -Base $repoRoot

if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot 'release' }
$OutputDir = Resolve-FullPath -Path $OutputDir -Base $repoRoot

if ($TestUninstallMode) {
    if (-not $TestMode) { throw '-TestUninstallMode доступен только вместе с -TestMode.' }
}
if ($CheckPayloadOnly -and $TestMode) {
    throw '-CheckPayloadOnly несовместим с -TestMode: тестовая поставка — фикстура, свежесть в ней не проверяется.'
}
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
    $freshness = Test-PayloadFreshness -Root $PayloadRoot -RepoRoot $repoRoot
    $payloadProblems = @($freshness.Problems)
    if ($payloadProblems.Count -gt 0) {
        $details = ($payloadProblems | ForEach-Object { "  - $_" }) -join [Environment]::NewLine
        throw ("Payload установщика отсутствует или устарел: $PayloadRoot" + [Environment]::NewLine +
            $details + [Environment]::NewLine +
            'Обновите payload: pwsh -File installer/fetch-payload.ps1 ' +
            '(или запустите build.ps1 с -RefreshPayload).')
    }
    if ($freshness.HashCompared) {
        Write-Host 'Payload свежий: файлы контракта, версии сервера и клиента, хэши клиента, весь server/dist, migrations и шаблон службы совпадают с репозиторием.'
    } else {
        Write-Host ('Payload проверен частично (server/dist или migrations не сравнивались): файлы контракта и версии проверены. ' +
            'Соберите server/dist (npm -w @etn/server run build) и обновите payload для полной проверки.')
    }
    if ($CheckPayloadOnly) {
        # Проверка без компиляции: на машине, где полная сборка недоступна
        # (занятый dev-клиентом better_sqlite3.node, нет права симлинков),
        # можно убедиться, что payload свежий и годится для сборки.
        Write-Host "OK: payload свежий — $PayloadRoot (компиляция пропущена: -CheckPayloadOnly)"
        exit 0
    }
}

$iscc = Find-Iscc -Explicit $IsccPath
$issPath = Join-Path $PSScriptRoot 'etn.iss'

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$defines = @("/DMyAppVersion=$Version", "/DPayloadRoot=$PayloadRoot")
if ($TestMode) {
    $defines += '/DTestMode=1'
    $defines += "/DTestAppDir=$TestAppDir"
    $defines += "/DTestDataDir=$TestDataDir"
    if ($TestUninstallMode) { $defines += '/DTestUninstallable=1' }
}

$outputName = "$BaseFilename-$Version"
if ($TestMode) { $outputName = "$BaseFilename-test-$Version" }
if ($TestUninstallMode) { $outputName = "$BaseFilename-unins-test-$Version" }

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
