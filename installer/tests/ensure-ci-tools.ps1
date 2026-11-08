<#
.SYNOPSIS
    Ставит на ВМ-раннер инструменты шагов «Installer static tests» и
    «Installer payload freshness».

.DESCRIPTION
    Нужно Gitea CI (задача 00345091, подзадача П4): installer/tests/iss-static.ps1
    разбирает etn.iss/build.ps1, а installer/tests/payload-freshness.ps1
    собирает установщик из фикстур через installer/build.ps1 и требует:
      • Inno Setup 6 (ISCC.exe) — build.ps1 ищет его в Program Files (x86),
        Program Files и %LOCALAPPDATA%\Programs;
      • PowerShell 7 (pwsh) — скрипт рассчитан на pwsh: в Windows PowerShell 5.1
        stderr нативной команды при $ErrorActionPreference='Stop' становится
        terminating error и прогон обрывается на сторожe свежести payload.

    Официальные сборки Inno Setup с марта 2026 публикуются как immutable
    releases в GitHub (files.jrsoftware.org отдаёт только readme и .issig),
    поэтому версии зафиксированы и обновляются осознанно вместе с проектом.

.PARAMETER InnoVersion
    Версия Inno Setup 6 (по умолчанию 6.7.4 — проверена с installer/etn.iss).

.PARAMETER PwshVersion
    Версия PowerShell 7 (по умолчанию 7.6.9).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File installer/tests/ensure-ci-tools.ps1
#>
[CmdletBinding()]
param(
    [string]$InnoVersion = '6.7.4',
    [string]$PwshVersion = '7.6.9'
)

$ErrorActionPreference = 'Stop'

# GitHub в PowerShell 5.1 без явного TLS 1.2 файл не отдаёт.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

function Get-RemoteFile {
    param([string]$Url, [string]$Destination)
    Write-Host "Скачивание: $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    if (-not (Test-Path -LiteralPath $Destination)) { throw "файл не скачан: $Destination" }
}

# --- Inno Setup 6 ------------------------------------------------------------
$iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (Test-Path -LiteralPath $iscc) {
    Write-Host "ISCC уже установлен: $iscc"
} else {
    $tag = 'is-' + ($InnoVersion -replace '\.', '_')
    $url = "https://github.com/jrsoftware/issrc/releases/download/$tag/innosetup-$InnoVersion.exe"
    $dst = Join-Path $env:TEMP "innosetup-$InnoVersion.exe"
    Get-RemoteFile -Url $url -Destination $dst
    $proc = Start-Process -FilePath $dst -PassThru -Wait -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'
    )
    if ($proc.ExitCode -ne 0) { throw "Установка Inno Setup завершилась с кодом $($proc.ExitCode)." }
    if (-not (Test-Path -LiteralPath $iscc)) { throw "ISCC.exe не найден после установки: $iscc" }
    Write-Host "ISCC установлен: $iscc"
}

# --- PowerShell 7 ------------------------------------------------------------
# MSI кладёт pwsh в Program Files\PowerShell\7; в PATH службы раннера он может
# не появиться до перезапуска, поэтому шаг CI зовёт этот путь напрямую.
$pwsh = Join-Path ${env:ProgramFiles} 'PowerShell\7\pwsh.exe'
if (Test-Path -LiteralPath $pwsh) {
    Write-Host "pwsh уже установлен: $pwsh"
} else {
    $url = "https://github.com/PowerShell/PowerShell/releases/download/v$PwshVersion/PowerShell-$PwshVersion-win-x64.msi"
    $dst = Join-Path $env:TEMP "PowerShell-$PwshVersion-win-x64.msi"
    Get-RemoteFile -Url $url -Destination $dst
    $proc = Start-Process msiexec.exe -PassThru -Wait -ArgumentList @(
        '/i', "`"$dst`"", '/quiet', '/norestart', 'ADD_PATH=1'
    )
    if ($proc.ExitCode -ne 0) { throw "Установка PowerShell 7 завершилась с кодом $($proc.ExitCode)." }
    if (-not (Test-Path -LiteralPath $pwsh)) { throw "pwsh.exe не найден после установки: $pwsh" }
    Write-Host "pwsh установлен: $pwsh"
}

Write-Host 'Инструменты CI готовы.'
