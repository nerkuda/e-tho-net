<#
.SYNOPSIS
    Сборка установщика ETN (Inno Setup 6).

.DESCRIPTION
    Читает версию из server/package.json и вызывает ISCC с /DMyAppVersion.
    Payload установщика (Node, dist, migrations, prod-node_modules, служба,
    клиент) готовят задачи 8b1f5980 и 98ad5eec; пока каталогов нет, секции
    [Files] пропускаются с предупреждением компилятора, и .iss всё равно
    компилируется.

    Задача a1211915 (0.15.1).

.PARAMETER Version
    Версия установщика. По умолчанию — version из server/package.json.

.PARAMETER PayloadRoot
    Каталог подготовленного payload. По умолчанию installer/payload.

.PARAMETER OutputDir
    Каталог результата. По умолчанию <repo>/release.

.PARAMETER BaseFilename
    Базовое имя exe; к нему добавляется -<версия>. По умолчанию ETN-Setup.

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
