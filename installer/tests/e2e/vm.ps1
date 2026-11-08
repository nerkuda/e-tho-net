<#
.SYNOPSIS
    Операции с ВМ VirtualBox для E2E-тестов установщика ETN.

.DESCRIPTION
    Тонкая обёртка над VBoxManage: состояние ВМ, снапшоты, headless-запуск,
    ожидание Guest Additions, копирование файлов через guestcontrol. Никаких
    решений о сценариях здесь нет — только механика ВМ.

    Снапшоты аддитивны: создание `base-e2e` не удаляет и не меняет прежние;
    восстановление возвращает ВМ к выбранному состоянию. Скрипт оркестратора
    обязан в try/finally вернуть ВМ в исходный снапшот `base-clean-v2`.

    Пароль гостя в этот файл не попадает: guestcontrol получает временный
    passwordfile, который удаляется сразу после вызова (см. guest.ps1).

    Задача 8789381a (0.15.3).
#>

$script:VBoxManage = $null

<# Найти VBoxManage: явный путь, Program Files, PATH. #>
function Resolve-VBoxManage {
    [CmdletBinding()]
    param([string]$Explicit = '')
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "VBoxManage.exe не найден: $Explicit" }
        $script:VBoxManage = (Resolve-Path -LiteralPath $Explicit).Path
        return $script:VBoxManage
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Oracle\VirtualBox\VBoxManage.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $script:VBoxManage = $candidate
            return $script:VBoxManage
        }
    }
    $fromPath = Get-Command VBoxManage.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        $script:VBoxManage = $fromPath.Source
        return $script:VBoxManage
    }
    throw 'VBoxManage.exe не найден: укажите -VBoxManage или установите VirtualBox.'
}

function Get-VBoxManage {
    if (-not $script:VBoxManage) { return (Resolve-VBoxManage) }
    return $script:VBoxManage
}

<# Выполнить VBoxManage; ненулевой код — исключение с хвостом вывода. #>
function Invoke-VBox {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $vbm = Get-VBoxManage
    $output = & $vbm @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        throw "VBoxManage $($Arguments -join ' ') завершился с кодом $code`n$($output -join "`n")"
    }
    return @($output)
}

<# Состояние ВМ: poweroff, running, saved и т.п. #>
function Get-VmState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Vm)
    $lines = Invoke-VBox @('showvminfo', $Vm, '--machinereadable')
    foreach ($line in $lines) {
        if ($line -match '^VMState="([^"]+)"$') { return $Matches[1] }
    }
    throw "Не удалось прочитать состояние ВМ $Vm."
}

<# Имена снапшотов ВМ (в порядке дерева). #>
function Get-VmSnapshots {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Vm)
    $lines = Invoke-VBox @('snapshot', $Vm, 'list')
    return @($lines | ForEach-Object {
            if ($_ -match '^\s*Name:\s*(.+?)\s+\(UUID:') { $Matches[1] }
        })
}

function Test-VmSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)][string]$Name
    )
    return ((Get-VmSnapshots -Vm $Vm) -contains $Name)
}

<#
    Отключить буфер обмена и drag&drop у ВМ.
    Нужно перед снятием «живого» снапшота: сохранённое состояние с активным
    VBoxSharedClipboard не восстанавливается, когда хост-буфер занят или
    недоступен процессу VirtualBox («Failed to load unit 'HGCM'
    (VERR_ACCESS_DENIED)», наблюдалось 2026-11-07 при заблокированном хосте).
    В E2E буфер обмена не используется: проба работает через UIAutomation и
    оконные сообщения. На работающей ВМ настройка задаётся controlvm, на
    выключенной — modifyvm (в состоянии saved недоступны обе).
#>
function Set-VmClipboardDisabled {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Vm)
    $state = Get-VmState -Vm $Vm
    if ($state -eq 'running') {
        try { $null = Invoke-VBox @('controlvm', $Vm, 'clipboard', 'mode', 'disabled') } catch { }
        try { $null = Invoke-VBox @('controlvm', $Vm, 'clipboard', 'filetransfers', 'off') } catch { }
        try { $null = Invoke-VBox @('controlvm', $Vm, 'draganddrop', 'disabled') } catch { }
    } elseif ($state -eq 'poweroff') {
        try {
            $null = Invoke-VBox @('modifyvm', $Vm, '--clipboard-mode', 'disabled', '--draganddrop', 'disabled')
        } catch { }
    }
}

<# Создать снапшот от текущего состояния (аддитивно, ничего не удаляя). #>
function New-VmSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)][string]$Name,
        [string]$Description = ''
    )
    if (Test-VmSnapshot -Vm $Vm -Name $Name) { return }
    # Снапшот снимается без буфера обмена: иначе resume зависит от состояния
    # хост-буфера (см. Set-VmClipboardDisabled).
    Set-VmClipboardDisabled -Vm $Vm
    $arguments = @('snapshot', $Vm, 'take', $Name)
    if ($Description) { $arguments += @('--description', $Description) }
    $null = Invoke-VBox $arguments
}

function Wait-VmPoweredOff {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [int]$TimeoutSec = 120
    )
    # После restore «живого» снапшота (с RAM) ВМ остаётся в состоянии saved —
    # это то же «готова к старту», что и poweroff; startvm продолжает снимок.
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $state = Get-VmState -Vm $Vm
        if ($state -eq 'poweroff' -or $state -eq 'saved') { return }
        if ($state -eq 'aborted' -or $state -eq 'aborted-saved') {
            # Сбой запуска (наблюдалось: Failed to load unit 'HGCM'
            # VERR_ACCESS_DENIED) оставляет гибридное состояние: снимок памяти
            # есть, сессия прервана. Для restore он не нужен — сбрасываем,
            # иначе ВМ не выключается и сценарий падает на ожидании.
            try { $null = Invoke-VBox @('discardstate', $Vm) } catch { }
        }
        Start-Sleep -Seconds 2
    }
    throw "ВМ $Vm не выключилась за $TimeoutSec с."
}

<#
    Выключить ВМ перед восстановлением снапшота.
    Штатное завершение гостя (ACPIBUTTON) здесь не используется осознанно:
    ВМ запущена из «живого» снапшота (с RAM), и после ACPI-выключения
    последующий restore+resume переставал поднимать WinRM (проверено на
    стенде). Снапшот всё равно заменяет диск и память целиком, поэтому
    жёсткое выключение безопасно и детерминировано.
#>
function Stop-Vm {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [int]$TimeoutSec = 90
    )
    $stopped = @('poweroff', 'saved')
    $state = Get-VmState -Vm $Vm
    if ($stopped -contains $state) { return }
    if ($state -eq 'aborted' -or $state -eq 'aborted-saved') {
        # Прерванная сессия с остатком памяти: сбрасываем и считаем выключенной.
        try { $null = Invoke-VBox @('discardstate', $Vm) } catch { }
        Wait-VmPoweredOff -Vm $Vm -TimeoutSec $TimeoutSec
        return
    }
    if ($state -eq 'running') {
        # Гонка: ВМ могла завершиться между проверкой и командой — «not
        # currently running» не ошибка, состояние перепроверяется ниже.
        try { $null = Invoke-VBox @('controlvm', $Vm, 'poweroff') } catch { }
    }
    Wait-VmPoweredOff -Vm $Vm -TimeoutSec $TimeoutSec
}

<# Восстановить снапшот; ВМ должна быть выключена. #>
function Restore-VmSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if (-not (Test-VmSnapshot -Vm $Vm -Name $Name)) {
        throw "Снапшот $Name у ВМ $Vm не найден. Создайте его до прогона (базовые снапшоты не удаляются)."
    }
    Stop-Vm -Vm $Vm
    # Переход из состояния saved сразу в restore другого снапшота в VirtualBox
    # 7 подвисает (VBoxSVC ждёт сессию); сначала сбрасываем сохранённую RAM
    # текущего состояния — она не нужна, снапшот восстанавливается целиком.
    if ((Get-VmState -Vm $Vm) -eq 'saved') {
        $null = Invoke-VBox @('discardstate', $Vm)
        Wait-VmPoweredOff -Vm $Vm -TimeoutSec 120
    }
    $null = Invoke-VBox @('snapshot', $Vm, 'restore', $Name)
    Wait-VmPoweredOff -Vm $Vm -TimeoutSec 120
}

<#
    Сбросить зависшие процессы VirtualBox, держащие сессию ВМ.
    Наблюдалось 2026-11-08: после сбоя resume (HGCM) и последующего
    snapshot/restore ВМ не стартовала ни из saved, ни из poweroff —
    «The VM session was closed before any attempt to power it on»; помогло
    только завершение оставшихся VBoxHeadless и VBoxSVC. Безопасно только
    когда ни одна ВМ не запущена: иначе VBoxSVC общий для всех.
#>
function Clear-VmStaleSession {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Vm)
    if ((Get-VmState -Vm $Vm) -eq 'running') { return }
    $running = @(Invoke-VBox @('list', 'runningvms'))
    if ($running.Count -gt 0) { return }
    $escaped = [regex]::Escape($Vm)
    $stale = @(Get-CimInstance Win32_Process -Filter "Name='VBoxHeadless.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match $escaped -or $_.CommandLine -match '--startvm') })
    foreach ($process in $stale) {
        try { $null = & taskkill.exe /PID $process.ProcessId /F 2>&1 } catch { }
    }
    # VBoxSVC перезапустится сам при следующей команде; его сессии — общие,
    # поэтому только когда запущенных ВМ нет (проверено выше).
    try { $null = & taskkill.exe /IM VBoxSVC.exe /F 2>&1 } catch { }
    Start-Sleep -Seconds 3
}

<# Запустить ВМ без окна: headless-режим. #>
function Start-VmHeadless {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [int]$Attempts = 3
    )
    if ((Get-VmState -Vm $Vm) -eq 'running') { return }
    # Гонка с процессом ВМ от прошлого прогона: он ещё держит общие папки и
    # буфер обмена, и startvm падает на «Failed to load unit 'HGCM'
    # (VERR_ACCESS_DENIED)». Наблюдалось 2026-11-07 сразу после Stop-Vm
    # предыдущего сценария; повтор через паузу проходит.
    $lastError = ''
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $null = Invoke-VBox @('startvm', $Vm, '--type', 'headless')
            return
        } catch {
            $lastError = $_.Exception.Message
            if ((Get-VmState -Vm $Vm) -eq 'running') { return }
            $state = Get-VmState -Vm $Vm
            if ($state -eq 'aborted' -or $state -eq 'aborted-saved') {
                # Неудачный старт оставил гибридное состояние — сбрасываем
                # остаток памяти, иначе следующая попытка упадёт так же.
                try { $null = Invoke-VBox @('discardstate', $Vm) } catch { }
            }
            if ($lastError -match 'VM session was closed') {
                Clear-VmStaleSession -Vm $Vm
            }
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
    throw "ВМ $Vm не запустилась за $Attempts попыток: $lastError"
}

<#
    Дождаться Guest Additions (runlevel >= 2 — службы GA работают).
    Версия GA и runlevel читаются из showvminfo --machinereadable.
#>
function Wait-VmGuestAdditions {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [int]$TimeoutSec = 300
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $lines = Invoke-VBox @('showvminfo', $Vm, '--machinereadable')
        $runlevel = 0
        $version = ''
        foreach ($line in $lines) {
            if ($line -match '^GuestAdditionsRunLevel=(\d+)$') { $runlevel = [int]$Matches[1] }
            if ($line -match '^GuestAdditionsVersion="([^"]*)"$') { $version = $Matches[1] }
        }
        if ($runlevel -ge 2 -and $version) { return $version }
        Start-Sleep -Seconds 5
    }
    throw "Guest Additions не поднялись за $TimeoutSec с у ВМ $Vm."
}

<#
    Копировать файл с хоста в гостя через guestcontrol.
    VBoxManage 7 принимает destination последним позиционным аргументом.
#>
function Copy-HostFileToGuest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$PasswordFile
    )
    $null = Invoke-VBox @(
        'guestcontrol', $Vm, 'copyto',
        "--username=$UserName", "--passwordfile=$PasswordFile",
        $Source, $Destination
    )
}

# Копировать файл/каталог из гостя на хост (для журналов установщика).
function Copy-GuestFileToHost {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$PasswordFile,
        [switch]$Recursive
    )
    $arguments = @(
        'guestcontrol', $Vm, 'copyfrom',
        "--username=$UserName", "--passwordfile=$PasswordFile"
    )
    if ($Recursive) { $arguments += '--recursive' }
    $arguments += @($Source, $Destination)
    $null = Invoke-VBox $arguments
}
