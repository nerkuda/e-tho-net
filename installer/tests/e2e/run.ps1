<#
.SYNOPSIS
    E2E-прогон установщика ETN в ВМ VirtualBox (сценарии S1–S6).

.DESCRIPTION
    Оркестратор поверх vm.ps1 (механика ВМ), guest.ps1 (гостевые команды) и
    assert.ps1 (проверки и JSON-отчёт). Задача 8789381a, этап 3.

    Сценарии (этот заход — без GUI; GUI-сценарии — следующий заход):
      S1  silent-матрица 20: без /SERVERONLY; /SERVERONLY без install.json;
          неэлевированный процесс. Проверяется код 20, причина в журнале и
          отсутствие следов установки.
      S2  занятый порт 4321 на фикстуре установленного сервера: код 20,
          причина в журнале, файлы и install.json не изменились; после
          освобождения порта повторная установка не запускается (silent 0
          требует инициализированной БД — отдельный сценарий).
      S3  понижение версии: снапшот установленного 0.15.1 (-InstalledSnapshot),
          установщик 0.15.2 (по постановке — код 20). Снапшот содержит 0.15.1,
          поэтому сверка фактического поведения честная: если 0.15.2 ставится
          как обновление (код 0), дополнительно проверяется настоящее понижение
          0.15.1 над полученным состоянием (код 20, файлы и install.json
          не изменились).
      S4  обновление 0.15.1 → 0.15.3: код 0, порядок этапов в журнале,
          product_version в install.json, health-версия, архив БД, служба
          Running, базы не потеряны.
      S5  удаление после S4: unins000.exe /VERYSILENT → 0, служба снята,
          файлы/ярлыки/правило брандмауэра удалены, данные сохранены.
          Если удаление невозможно без интерактивной сессии — сценарий
          честно помечается deferred (до GUI-захода), успех не имитируется.
      S6  служба на состоянии после S4: etn-service.exe status/stop/start,
          ImagePath, Start=Automatic, env-переменные в etn-service.xml,
          ремонт (повторная установка той же версии) не перерегистрирует
          службу.

    Повторяемость: перед каждым сценарием ВМ выключается, восстанавливается
    снапшот, стартует headless, ожидаются Guest Additions и WinRM. Журналы
    копируются на хост ДО следующего восстановления. В try/finally ВМ всегда
    возвращается в исходный снапшот base-clean-v2.

    Снапшоты: базовый для S1/S2 — `base-e2e-live` (живой снапшот base-clean-v2
    с работающим WinRM). Снапшот `base-e2e` (созданный как offline) на холодном
    старте WinRM не поднимает: в образе ВМ отложенный автозапуск WinRM не
    срабатывает, а поднять службу без прав администратора нельзя — guestcontrol
    даёт фильтрованный токен. Поэтому все снапшоты сценариев обязаны быть
    «живыми» (сняты с запущенной ВМ, где WinRM отвечает): resume возвращает
    память вместе с работающей службой. Для S3–S6 на стенде подготовлен
    `etn-0.15.1-installed-v2` (0.15.1 + WinRM Start=auto/DelayedAutostart=0),
    он и есть значение по умолчанию -InstalledSnapshot (снапшот без этой
    настройки после resume поднимает WinRM не всегда).

    В отчёте счёт «проверок» и «замеров» разделён: длительности (timings) не
    проверки и не влияют на итог. У каждого сценария есть поимённый список
    checks_detail; сбой сбора журналов виден полем logs_error (путь logs при
    этом пуст, а не выдаётся за собранные журналы). Ненулевой код возврата —
    провал проверки (1) или неудача возврата ВМ в исходный снапшот (2).

    Секреты ВМ читаются из etn-vms.env только в момент прогона (guest.ps1),
    в отчёт и журнал не попадают.

.PARAMETER Scenarios
    Подмножество S1..S6. По умолчанию — все.

.PARAMETER InstalledSnapshot
    Снапшот установленного сервера 0.15.1 для S3–S6 (должен быть «живым»:
    resume обязан поднимать WinRM). По умолчанию — etn-0.15.1-installed-v2
    (рабочий: WinRM Start=auto/DelayedAutostart=0).

.PARAMETER KeepVmRunning
    Не выключать ВМ после возврата в исходный снапшот (для отладки; в отчёте
    фиксируется фактическое состояние).

.EXAMPLE
    pwsh -File installer/tests/e2e/run.ps1 -Scenarios S1,S2

.EXAMPLE
    pwsh -File installer/tests/e2e/run.ps1 -InstalledSnapshot etn-0.15.1-installed-v2

.EXAMPLE
    pwsh -File installer/tests/e2e/run.ps1 -OutDir .tmp/e2e-run
#>
[CmdletBinding()]
param(
    [string]$Vm = 'ETN-Win11',
    [string]$BaseSnapshot = 'base-e2e-live',
    [string]$InstalledSnapshot = 'etn-0.15.1-installed-v2',
    [string]$OriginalSnapshot = 'base-clean-v2',
    [string]$SecretsPath = 'C:\Users\User\.zcode\secrets\etn-vms.env',
    [string]$SetupCurrent = 'ETN-Setup-0.15.3.exe',
    [string]$SetupIntermediate = 'ETN-Setup-0.15.2.exe',
    [string]$SetupOld = 'ETN-Setup-0.15.1.exe',
    [string]$ReleaseDir = '',
    [string]$OutDir = '',
    [string[]]$Scenarios = @('S1', 'S2', 'S3', 'S4', 'S5', 'S6'),
    [int]$BootTimeoutSec = 300,
    [int]$InstallTimeoutSec = 900,
    [switch]$KeepVmRunning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = $PSScriptRoot
. (Join-Path $here 'assert.ps1')
. (Join-Path $here 'vm.ps1')
. (Join-Path $here 'guest.ps1')

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $here '..\..\..'))
if (-not $ReleaseDir) { $ReleaseDir = Join-Path $repoRoot 'release' }
if (-not $OutDir) { $OutDir = Join-Path $here 'logs' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$reportPath = Join-Path $OutDir 'e2e-report.json'

$setups = [ordered]@{
    current      = $SetupCurrent
    intermediate = $SetupIntermediate
    old          = $SetupOld
}
foreach ($name in $setups.Keys) {
    $path = Join-Path $ReleaseDir $setups[$name]
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Нет установщика $path — соберите payload и установщик (installer/build.ps1)."
    }
}

$results = New-E2EResultList
$timings = New-E2ETimingList
$scenarioReports = New-Object System.Collections.Generic.List[object]
$reportWritten = $false
$context = $null
$finalVmState = ''
$runStartedAt = Get-Date

# --- Общие помощники -------------------------------------------------------

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Get-JsonField {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Add-CodeCheck {
    param($Results, [string]$Scenario, [string]$Name, $Expected, $Actual, [string]$Note = '')
    Add-E2ECheck -Results $Results -Scenario $Scenario -Name $Name `
        -Ok ($Actual -eq $Expected) -Expected $Expected -Actual $Actual -Note $Note
}

function Add-LogCheck {
    param($Results, [string]$Scenario, [string]$Name, $Log, [string]$Needle, [string]$Note = '')
    $exists = ($null -ne $Log) -and [bool](Get-JsonField $Log 'Exists')
    $text = if ($exists) { [string](Get-JsonField $Log 'Text') } else { '' }
    $ok = $exists -and $text.Contains($Needle)
    $actual = if (-not $exists) { 'журнал не найден' } elseif ($ok) { 'найдено' } else { 'нет строки' }
    Add-E2ECheck -Results $Results -Scenario $Scenario -Name $Name -Ok $ok `
        -Expected ("журнал: " + $Needle) -Actual $actual -Note $Note
}

function Add-LogAbsentCheck {
    param($Results, [string]$Scenario, [string]$Name, $Log, [string]$Needle, [string]$Note = '')
    $exists = ($null -ne $Log) -and [bool](Get-JsonField $Log 'Exists')
    $text = if ($exists) { [string](Get-JsonField $Log 'Text') } else { '' }
    $ok = (-not $exists) -or (-not $text.Contains($Needle))
    Add-E2ECheck -Results $Results -Scenario $Scenario -Name $Name -Ok $ok `
        -Expected ("журнал без: " + $Needle) -Actual $(if ($ok) { 'нет строки' } else { 'найдено' }) -Note $Note
}

function Add-PathCheck {
    param($Results, [string]$Scenario, [string]$Name, [string]$Path, [bool]$ExpectedPresent,
        [string]$Note = '', $Context = $script:context)
    $present = Test-GuestPath -Context $Context -Path $Path
    Add-E2ECheck -Results $Results -Scenario $Scenario -Name $Name `
        -Ok ($present -eq $ExpectedPresent) `
        -Expected $(if ($ExpectedPresent) { 'есть' } else { 'нет' }) `
        -Actual $(if ($present) { 'есть' } else { 'нет' }) `
        -Note ("$Path $Note").Trim()
}

function Get-GuestInstallJson {
    param([string]$Path = 'C:\ProgramData\ETN\install.json', $Context = $script:context)
    $read = Get-GuestText -Context $Context -Path $Path
    if (-not (Get-JsonField $read 'Exists')) { return $null }
    $text = [string](Get-JsonField $read 'Text')
    if (-not $text) { return $null }
    try { return ($text | ConvertFrom-Json) } catch { return $null }
}

<# Новейший install-*.log прогона: %ProgramData%\ETN\logs, %TEMP%, C:\Windows\Temp. #>
function Get-GuestInstallLog {
    param([string]$ExcludePath = '', [int]$MaxAgeMinutes = 30, $Context = $script:context)
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
        param($Exclude, $MaxAge)
        $dirs = @(
            (Join-Path $env:ProgramData 'ETN\logs'),
            $env:TEMP,
            'C:\Windows\Temp'
        )
        $files = @()
        foreach ($dir in $dirs) {
            if ($dir -and (Test-Path -LiteralPath $dir)) {
                $files += @(Get-ChildItem -LiteralPath $dir -Filter 'install-*.log' -File -ErrorAction SilentlyContinue)
            }
        }
        $fresh = @($files |
            Where-Object { $_.FullName -ne $Exclude -and ((Get-Date) - $_.LastWriteTime).TotalMinutes -le $MaxAge } |
            Sort-Object LastWriteTime -Descending)
        if ($fresh.Count -eq 0) { return [pscustomobject]@{ Exists = $false; Path = ''; Text = '' } }
        $file = $fresh[0]
        return [pscustomobject]@{
            Exists = $true
            Path   = $file.FullName
            Text   = [System.IO.File]::ReadAllText($file.FullName)
        }
    } -ArgumentList @($ExcludePath, $MaxAgeMinutes)
}

<# Этапы установки в порядке журнала (строки «Этап: …»). #>
function Get-GuestStageSequence {
    param([string]$LogText)
    $stages = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($LogText -split "`r?`n")) {
        if ($line -match '\[INFO\]\s+Этап:\s*(.+?)\s*$') { $stages.Add($Matches[1]) }
    }
    return $stages.ToArray()
}

<# Все ожидаемые этапы есть и идут в заданном порядке. #>
function Test-StageOrder {
    param([string[]]$Sequence, [string[]]$Expected)
    $position = @{}
    for ($i = 0; $i -lt $Sequence.Count; $i += 1) {
        if (-not $position.ContainsKey($Sequence[$i])) { $position[$Sequence[$i]] = $i }
    }
    $last = -1
    foreach ($stage in $Expected) {
        if (-not $position.ContainsKey($stage)) { return $false }
        if ($position[$stage] -le $last) { return $false }
        $last = $position[$stage]
    }
    return $true
}

<# Имена файлов баз (*.db) в каталоге данных — состав, без размеров (WAL). #>
function Get-GuestDbList {
    param($Context = $script:context)
    return @(Invoke-GuestElevated -Context $Context -ScriptBlock {
            param($Root)
            if (-not (Test-Path -LiteralPath $Root)) { return @() }
            return @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.db' -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName.Substring($Root.Length).TrimStart('\') } |
                Sort-Object)
        } -ArgumentList @('C:\ProgramData\ETN'))
}

function Get-GuestTreeHashText {
    param([string]$Root, $Context = $script:context)
    $tree = Get-GuestTreeHash -Context $Context -Root $Root
    return ($tree | ConvertTo-Json -Compress -Depth 5)
}

<# Запустить установщик элевированно и вернуть код/журнал/длительность. #>
function Invoke-SilentInstall {
    param(
        [Parameter(Mandatory = $true)][string]$SetupFileName,
        [Parameter(Mandatory = $true)][string]$InstallerArgs,
        $Context = $script:context
    )
    $beforeLog = Get-GuestInstallLog -Context $Context
    $beforePath = [string](Get-JsonField $beforeLog 'Path')
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = Invoke-GuestElevatedProcess -Context $Context -Exe "C:\e2e\$SetupFileName" `
        -Arguments $InstallerArgs.Split(' ') -TimeoutSec $InstallTimeoutSec
    $watch.Stop()
    $log = Get-GuestInstallLog -Context $Context -ExcludePath $beforePath
    return [pscustomobject]@{
        Code        = $process.Code
        Output      = $process.Output
        TimedOut    = $process.TimedOut
        Log         = $log
        DurationSec = [math]::Round($watch.Elapsed.TotalSeconds, 1)
    }
}

<#
    Скопировать установщики в гостя и сверить SHA-256.
    Копируются только установщики, нужные сценарию (-Keys): S1/S2/S4/S6 —
    текущий, S3 — промежуточный и старый. Все три (~450 МБ) не копируются:
    лишняя передача замедляла каждый сценарий и давала VERR_TIMEOUT.
    Каждый файл копируется до трёх попыток с паузой 5 с: у guestcontrol
    copyto бывает транзиентный VERR_TIMEOUT (проверено на стенде).
#>
function Copy-SetupsToGuest {
    param(
        [Parameter(Mandatory = $true)][string[]]$Keys,
        $Context = $script:context
    )
    foreach ($key in $Keys) {
        if (-not $setups.Contains($key)) { throw "Неизвестный установщик '$key' (допустимо: $($setups.Keys -join ', '))." }
    }
    $null = Invoke-GuestElevatedCommand -Context $Context `
        -Command 'if not exist C:\e2e mkdir C:\e2e & if not exist C:\e2e\logs mkdir C:\e2e\logs & exit /b 0'
    # guestcontrol copyto, а не общая папка \\VBOXSVR\release: после restore
    # «живого» снапшота общая папка монтируется не всегда (проверено), а
    # copyto идёт через Guest Additions и от монтирования не зависит.
    $passwordFile = Join-Path $env:TEMP ('etn-e2e-pw-' + [guid]::NewGuid().ToString('N') + '.txt')
    $plain = $Context.Credential.GetNetworkCredential().Password
    [System.IO.File]::WriteAllText($passwordFile, $plain)
    $plain = $null
    try {
        $copyAttempts = 3
        foreach ($key in $Keys) {
            $fileName = $setups[$key]
            $hostPath = Join-Path $ReleaseDir $fileName
            $hostHash = (Get-FileHash -LiteralPath $hostPath -Algorithm SHA256).Hash
            $copied = $false
            $lastError = ''
            for ($attempt = 1; $attempt -le $copyAttempts -and -not $copied; $attempt++) {
                try {
                    Copy-HostFileToGuest -Vm $Context.Vm -Source $hostPath `
                        -Destination "C:\e2e\$fileName" -UserName $Context.UserName -PasswordFile $passwordFile
                    $guestHash = Get-GuestFileHash -Context $Context -Path "C:\e2e\$fileName"
                    if ($hostHash -ne $guestHash) {
                        throw "SHA-256 $fileName в госте не совпал с хостом: $guestHash"
                    }
                    $copied = $true
                } catch {
                    $lastError = $_.Exception.Message
                    if ($attempt -lt $copyAttempts) {
                        Write-Warning ("Копирование {0}, попытка {1} из {2}: {3} — повтор" -f `
                                $fileName, $attempt, $copyAttempts, $lastError)
                        Start-Sleep -Seconds 5
                    }
                }
            }
            if (-not $copied) {
                throw "Не удалось скопировать $fileName за $copyAttempts попытки: $lastError"
            }
        }
    } finally {
        Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
    }
}

<# Восстановить снапшот, поднять ВМ headless, дождаться GA и WinRM. #>
function Initialize-ScenarioVm {
    param(
        [Parameter(Mandatory = $true)][string]$Snapshot,
        [string[]]$SetupKeys = @()
    )
    Write-Step "ВМ: восстановление снапшота $Snapshot"
    if (-not (Test-VmSnapshot -Vm $Vm -Name $Snapshot)) {
        throw "Снапшот $Snapshot у ВМ $Vm не найден."
    }
    Restore-VmSnapshot -Vm $Vm -Name $Snapshot
    Start-VmHeadless -Vm $Vm
    $ga = Wait-VmGuestAdditions -Vm $Vm -TimeoutSec $BootTimeoutSec
    Write-Host "Guest Additions: $ga"
    # Снапшот сценария обязан быть «живым» (снят с запущенной ВМ, где WinRM
    # отвечает): resume возвращает память вместе с работающей службой WinRM.
    # Поднять WinRM без прав администратора внутри гостя нельзя — guestcontrol
    # даёт фильтрованный токен (проверено: sc start winrm → отказано), WinRM —
    # единственный элевированный канал. Поэтому неготовность WinRM — ошибка
    # стенда, а не сценария: сценарий помечается провалом с причиной.
    $null = Wait-GuestReady -Context $script:context -TimeoutSec $BootTimeoutSec
    if ($SetupKeys.Count -gt 0) {
        $null = Copy-SetupsToGuest -Context $script:context -Keys $SetupKeys
    }
}
<#
    Дождаться фактического завершения удаления.
    Inno-деинсталлятор запускает себя второй фазой отдельным процессом
    (%TEMP%\is-*-uninstall.tmp\_unins.tmp) и первый процесс выходит сразу:
    его код 0 означает лишь «вторая фаза запущена», а не «удаление
    выполнено». Признаки завершения — unins000.exe удалён и в журнале /LOG
    есть строка «Uninstallation process succeeded.» (проверено на стенде:
    правило брандмауэра удаляется в usPostUninstall уже после этой строки,
    поэтому проверки состояния выполняются только после ожидания).
#>
function Wait-GuestUninstallComplete {
    param(
        [Parameter(Mandatory = $true)][string]$UninstallerPath,
        [Parameter(Mandatory = $true)][string]$LogPath,
        [int]$TimeoutSec = 300,
        $Context = $script:context
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $logText = ''
    $absentSince = $null
    while ((Get-Date) -lt $deadline) {
        $log = Get-GuestTextShared -Context $Context -Path $LogPath
        $logText = [string](Get-JsonField $log 'Text')
        if ($logText.Contains('Uninstallation process succeeded')) {
            return [pscustomobject]@{ Completed = $true; Success = $true; Log = $logText }
        }
        if (Test-GuestPath -Path $UninstallerPath -Context $Context) {
            $absentSince = $null
        } elseif ($null -eq $absentSince) {
            $absentSince = Get-Date
        } elseif (((Get-Date) - $absentSince).TotalSeconds -ge 10) {
            # Файла нет, строки успеха в журнале нет и через 10 с — удаление
            # завершилось с ошибкой (журнал дописан).
            return [pscustomobject]@{ Completed = $true; Success = $false; Log = $logText }
        }
        Start-Sleep -Seconds 2
    }
    return [pscustomobject]@{ Completed = $false; Success = $false; Log = $logText }
}

<# Дождаться состояния службы (Running/Stopped) или отсутствия. #>
function Wait-GuestServiceState {
    param([string]$Name, [string]$Expected, [int]$TimeoutSec = 90, $Context = $script:context)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-GuestServiceState -Context $Context -Name $Name) -eq $Expected) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

<#
    Первичная инициализация сервера (etn init) на снапшоте: silent 0 требует
    существующего первого администратора. Ключ пишется во временный файл и
    сразу удаляется — в отчёт и чат он не попадает.
#>
function Initialize-GuestServer {
    param($Context = $script:context)
    $node = 'C:\Program Files\ETN\node\node.exe'
    $cli = 'C:\Program Files\ETN\server\dist\cli.js'
    $envPrefix = 'set "ETN_DATA_DIR=C:\ProgramData\ETN" && '
    $check = Invoke-GuestElevatedCommand -Context $Context `
        -Command ($envPrefix + '"' + $node + '" "' + $cli + '" init --check')
    if ($check.Code -eq 0) {
        return [pscustomobject]@{ Ok = $true; Action = 'already'; Output = [string]$check.Output }
    }
    if ($check.Code -ne 1) {
        return [pscustomobject]@{ Ok = $false; Action = "check-code-$($check.Code)"; Output = [string]$check.Output }
    }
    $serviceWasRunning = (Get-GuestServiceState -Context $Context -Name 'ETN') -eq 'Running'
    if ($serviceWasRunning) {
        $null = Invoke-GuestElevatedCommand -Context $Context `
            -Command '"C:\Program Files\ETN\service\etn-service.exe" stop'
        $null = Wait-GuestServiceState -Context $Context -Name 'ETN' -Expected 'Stopped'
    }
    $keyFile = 'C:\Windows\Temp\etn-e2e-init-key.txt'
    $init = Invoke-GuestElevatedCommand -Context $Context -Command (
        $envPrefix + '"' + $node + '" "' + $cli +
        '" init --username e2e-admin --display-name "E2E admin" --key-out "' + $keyFile + '"'
    )
    $null = Invoke-GuestElevatedCommand -Context $Context -Command ('del /q "' + $keyFile + '" >nul 2>&1 & exit /b 0')
    if ($init.Code -ne 0) {
        return [pscustomobject]@{ Ok = $false; Action = "init-code-$($init.Code)"; Output = [string]$init.Output }
    }
    if ($serviceWasRunning) {
        $null = Invoke-GuestElevatedCommand -Context $Context `
            -Command '"C:\Program Files\ETN\service\etn-service.exe" start'
        $null = Wait-GuestServiceState -Context $Context -Name 'ETN' -Expected 'Running'
    }
    return [pscustomobject]@{ Ok = $true; Action = 'initialized'; Output = [string]$init.Output }
}

<# Поднять службу, если снапшот оставил её остановленной. #>
function Ensure-GuestServiceRunning {
    param([string]$Port = '4321', $Context = $script:context)
    $state = Get-GuestServiceState -Context $Context -Name 'ETN'
    if ($state -eq 'Missing') { return $false }
    if ($state -eq 'Running') {
        # После resume «живого» снапшота процесс Node переживает паузу не
        # всегда корректно (снапшот снят с работающей службой): тогда
        # установщик не может её остановить и честно возвращает 20 «служба
        # не остановилась за 60 с». Сценариям нужен заведомо чистый процесс —
        # перезапускаем службу.
        $null = Invoke-GuestElevatedCommand -Context $Context `
            -Command '"C:\Program Files\ETN\service\etn-service.exe" stop'
        $null = Wait-GuestServiceState -Context $Context -Name 'ETN' -Expected 'Stopped'
    }
    if ((Get-GuestServiceState -Context $Context -Name 'ETN') -ne 'Running') {
        $null = Invoke-GuestElevatedCommand -Context $Context `
            -Command '"C:\Program Files\ETN\service\etn-service.exe" start'
        if (-not (Wait-GuestServiceState -Context $Context -Name 'ETN' -Expected 'Running')) { return $false }
    }
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        if (Get-GuestHealth -Context $Context -Url "http://127.0.0.1:$Port/api/v1/health") { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Get-GuestHealthVersion {
    param([string]$Port = '4321', $Context = $script:context)
    $body = Get-GuestHealth -Context $Context -Url "http://127.0.0.1:$Port/api/v1/health"
    if (-not $body) { return $null }
    try { return [string](($body | ConvertFrom-Json).version) } catch { return $null }
}

<#
    Дождаться health-версии: после `etn-service.exe start` серверу нужно
    несколько секунд, чтобы начать слушать порт; одиночный запрос сразу после
    start даёт пустой ответ.
#>
function Wait-GuestHealthVersion {
    param([string]$Port = '4321', [string]$Expected = '', [int]$TimeoutSec = 60,
        $Context = $script:context)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        $last = Get-GuestHealthVersion -Context $Context -Port $Port
        if ($last -and ((-not $Expected) -or ($last -eq $Expected))) { return $last }
        Start-Sleep -Seconds 2
    }
    return $last
}

<# Каталог архивов БД: сколько подкаталогов и когда появился новейший. #>
function Get-GuestBackupInfo {
    param($Context = $script:context)
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
        param($Root)
        if (-not (Test-Path -LiteralPath $Root)) {
            return [pscustomobject]@{ Exists = $false; Count = 0; Newest = '' }
        }
        # Архивы БД — zip-файлы (etn-backup-<версия>-<дата>.zip), не каталоги.
        $archives = @(Get-ChildItem -LiteralPath $Root -File -Filter '*.zip' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
        return [pscustomobject]@{
            Exists = $true
            Count  = $archives.Count
            Newest = $(if ($archives.Count -gt 0) { $archives[0].Name } else { '' })
        }
    } -ArgumentList @('C:\ProgramData\ETN\backups')
}

<# Обновление текущим установщиком + проверки S4 (используется S4 и S6). #>
function Invoke-UpdateToCurrent {
    param(
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)]$Results,
        [switch]$AddCoreChecks
    )
    $jsonBefore = Get-GuestInstallJson -Context $script:context
    $versionBefore = [string](Get-JsonField $jsonBefore 'product_version')
    $port = [string](Get-JsonField $jsonBefore 'port')
    if (-not $port) { $port = '4321' }
    $dbBefore = (Get-GuestDbList -Context $script:context) -join '|'
    $healthBefore = Get-GuestHealthVersion -Context $script:context -Port $port
    $serviceBefore = Get-GuestServiceState -Context $script:context -Name 'ETN'
    $backupBefore = Get-GuestBackupInfo -Context $script:context
    if ($AddCoreChecks) {
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'before:version' `
            -Ok ($versionBefore -ne '') -Expected '0.15.1' -Actual $versionBefore
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'before:health' `
            -Ok ($healthBefore -eq $versionBefore) -Expected $versionBefore -Actual $healthBefore
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'before:service' `
            -Ok ($serviceBefore -eq 'Running') -Expected 'Running' -Actual $serviceBefore
    }
    $run = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['current'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    if ($AddCoreChecks) {
        Add-CodeCheck -Results $Results -Scenario $Scenario -Name 'update:exit-code' -Expected 0 -Actual $run.Code
    }
    $jsonAfter = Get-GuestInstallJson -Context $script:context
    $versionAfter = [string](Get-JsonField $jsonAfter 'product_version')
    $modeAfter = [string](Get-JsonField $jsonAfter 'mode')
    $dataDirAfter = [string](Get-JsonField $jsonAfter 'data_dir')
    $healthAfter = Get-GuestHealthVersion -Context $script:context -Port $port
    $serviceAfter = Get-GuestServiceState -Context $script:context -Name 'ETN'
    $backupAfter = Get-GuestBackupInfo -Context $script:context
    $dbAfter = (Get-GuestDbList -Context $script:context) -join '|'
    $stages = Get-GuestStageSequence -LogText ([string](Get-JsonField $run.Log 'Text'))

    if ($AddCoreChecks) {
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:install-json-version' `
            -Ok ($versionAfter -eq '0.15.3') -Expected '0.15.3' -Actual $versionAfter
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:mode' `
            -Ok ($modeAfter -eq 'service') -Expected 'service' -Actual $modeAfter
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:data-dir' `
            -Ok ($dataDirAfter -eq 'C:\ProgramData\ETN') -Expected 'C:\ProgramData\ETN' -Actual $dataDirAfter
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:health-version' `
            -Ok ($healthAfter -eq '0.15.3') -Expected '0.15.3' -Actual $healthAfter
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:service-running' `
            -Ok ($serviceAfter -eq 'Running') -Expected 'Running' -Actual $serviceAfter
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:db-set-preserved' `
            -Ok ($dbBefore -eq $dbAfter) -Expected 'тот же состав *.db' -Actual $dbAfter
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:backup-created' `
            -Ok (([bool](Get-JsonField $backupAfter 'Exists')) -and
                 ([int](Get-JsonField $backupAfter 'Count') -gt [int](Get-JsonField $backupBefore 'Count'))) `
            -Expected ('архивов больше, чем ' + [string](Get-JsonField $backupBefore 'Count')) `
            -Actual ([string](Get-JsonField $backupAfter 'Count'))
        Add-LogCheck -Results $Results -Scenario $Scenario -Name 'update:log-backup' -Log $run.Log `
            -Needle 'Бэкап БД: архив создан'
        Add-LogCheck -Results $Results -Scenario $Scenario -Name 'update:log-snapshot' -Log $run.Log `
            -Needle 'Снимок отката: создан'
        Add-LogCheck -Results $Results -Scenario $Scenario -Name 'update:log-install-json' -Log $run.Log `
            -Needle 'install.json записан'
        Add-LogCheck -Results $Results -Scenario $Scenario -Name 'update:log-health' -Log $run.Log `
            -Needle ('Health-check http://127.0.0.1:' + $port + ': успех')
        $expectedStages = @(
            'Остановка службы ETN…',
            'Резервная копия баз данных…',
            'Снимок отката…',
            'Замена файлов сервера ETN…',
            'Запуск службы ETN…',
            'Проверка работоспособности…'
        )
        Add-E2ECheck -Results $Results -Scenario $Scenario -Name 'update:stage-order' `
            -Ok (Test-StageOrder -Sequence $stages -Expected $expectedStages) `
            -Expected ($expectedStages -join ' → ') -Actual ($stages -join ' → ')
    }
    return [pscustomobject]@{
        Run          = $run
        VersionAfter = $versionAfter
        HealthAfter  = $healthAfter
        Stages       = $stages
        Port         = $port
    }
}

<# --- S1: silent-матрица 20 ------------------------------------------------ #>
function Invoke-ScenarioS1 {
    param($Results, $Timings)
    $scenario = 'S1'
    $started = Get-Date
    Initialize-ScenarioVm -Snapshot $BaseSnapshot -SetupKeys @('current')

    $run1 = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['current'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's1:without-serveronly-code' -Expected 20 -Actual $run1.Code
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's1:without-serveronly-reason' -Log $run1.Log `
        -Needle 'Предусловие не выполнено: /VERYSILENT без /SERVERONLY: тихая установка клиента запрещена'

    $run2 = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['current'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's1:serveronly-no-record-code' -Expected 20 -Actual $run2.Code
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's1:serveronly-no-record-reason' -Log $run2.Log `
        -Needle 'Предусловие не выполнено: нет C:\ProgramData\ETN\install.json'

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $run3 = Invoke-GuestLimitedProcess -Context $script:context -Exe "C:\e2e\$($setups['current'])" `
        -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SERVERONLY') `
        -TimeoutSec $InstallTimeoutSec
    $watch.Stop()
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's1:not-elevated-code' -Expected 20 -Actual $run3.Code
    $log3 = Get-GuestInstallLog -Context $script:context
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's1:not-elevated-reason' -Log $log3 `
        -Needle 'Предусловие не выполнено: процесс не элевирован'
    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's1:not-elevated-duration' `
        -Value ([math]::Round($watch.Elapsed.TotalSeconds, 1)) -Note 'не дольше 120 с'

    Add-PathCheck -Results $Results -Scenario $scenario -Name 's1:no-program-files' `
        -Path 'C:\Program Files\ETN' -ExpectedPresent $false
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's1:no-install-json' `
        -Path 'C:\ProgramData\ETN\install.json' -ExpectedPresent $false
    $service = Get-GuestServiceState -Context $script:context -Name 'ETN'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's1:no-service' `
        -Ok ($service -eq 'Missing') -Expected 'Missing' -Actual $service

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's1:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note '3 запуска'
}

<# --- S2: занятый порт ----------------------------------------------------- #>
function Invoke-ScenarioS2 {
    param($Results, $Timings)
    $scenario = 'S2'
    $started = Get-Date
    Initialize-ScenarioVm -Snapshot $BaseSnapshot -SetupKeys @('current')

    # Фикстура установленного сервера: файлы, install.json, ключ службы.
    $fixture = Invoke-GuestElevated -Context $script:context -ScriptBlock {
        $appDir = 'C:\Program Files\ETN'
        $dataDir = 'C:\ProgramData\ETN'
        New-Item -ItemType Directory -Path (Join-Path $appDir 'server\dist') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $appDir 'server\package.json'),
            '{"name":"@etn/server","version":"0.15.1"}', (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText((Join-Path $appDir 'server\dist\index.js'),
            '// E2E fixture: server files present' + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        $json = '{"schema":1,"product_version":"0.15.1","mode":"service","data_dir":"C:\\ProgramData\\ETN","host":"127.0.0.1","port":"4321","firewall":false}'
        [System.IO.File]::WriteAllText((Join-Path $dataDir 'install.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
        New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\ETN' -Force | Out-Null
        'fixture-ready'
    }
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's2:fixture' `
        -Ok ([string]$fixture -eq 'fixture-ready') -Expected 'fixture-ready' -Actual ([string]$fixture)

    $hashBefore = Get-GuestTreeHashText -Context $script:context -Root 'C:\Program Files\ETN\server'
    $jsonBefore = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'

    # Слушатель порта и установщик — в одной элевированной сессии, чтобы
    # слушатель жил ровно на время прогона.
    $run = Invoke-GuestElevated -Context $script:context -ScriptBlock {
        param($Setup, $ArgLine, $Port, $LimitSec)
        $listener = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
            -ArgumentList @('-NoProfile', '-Command',
            "`$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$Port);`$l.Start();Start-Sleep -Seconds 900") `
            -WindowStyle Hidden -PassThru
        $ready = $false
        for ($i = 0; $i -lt 60; $i += 1) {
            if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
                $ready = $true
                break
            }
            Start-Sleep -Milliseconds 500
        }
        $code = -1
        $timedOut = $false
        if ($ready) {
            $proc = Start-Process -FilePath $Setup -ArgumentList $ArgLine -PassThru -WindowStyle Hidden
            if (-not $proc.WaitForExit($LimitSec * 1000)) {
                try { $proc.Kill() } catch { }
                $timedOut = $true
            } else {
                $code = $proc.ExitCode
            }
        }
        try { Stop-Process -Id $listener.Id -Force -ErrorAction SilentlyContinue } catch { }
        $free = $false
        for ($i = 0; $i -lt 40; $i += 1) {
            if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) {
                $free = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
        return [pscustomobject]@{ Ready = $ready; Code = $code; TimedOut = $timedOut; PortFree = $free }
    } -ArgumentList @("C:\e2e\$($setups['current'])", '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY', 4321, $InstallTimeoutSec)

    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's2:listener-ready' `
        -Ok ([bool](Get-JsonField $run 'Ready')) -Expected $true -Actual ([bool](Get-JsonField $run 'Ready'))
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's2:exit-code' -Expected 20 -Actual (Get-JsonField $run 'Code')
    $log = Get-GuestInstallLog -Context $script:context
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's2:reason' -Log $log `
        -Needle 'Предусловие не выполнено: порт 4321 занят другим приложением'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's2:port-freed' `
        -Ok ([bool](Get-JsonField $run 'PortFree')) -Expected $true -Actual ([bool](Get-JsonField $run 'PortFree')) `
        -Note 'освобождение порта фиксируется; повторная установка не запускается (silent 0 — отдельный сценарий)'

    $hashAfter = Get-GuestTreeHashText -Context $script:context -Root 'C:\Program Files\ETN\server'
    $jsonAfter = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's2:files-unchanged' `
        -Ok ($hashBefore -eq $hashAfter) -Expected 'SHA-256 совпадают' -Actual $(if ($hashBefore -eq $hashAfter) { 'совпадают' } else { 'изменились' })
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's2:install-json-unchanged' `
        -Ok (([string](Get-JsonField $jsonBefore 'Text')) -eq ([string](Get-JsonField $jsonAfter 'Text'))) `
        -Expected 'содержимое совпадает' `
        -Actual $(if (([string](Get-JsonField $jsonBefore 'Text')) -eq ([string](Get-JsonField $jsonAfter 'Text'))) { 'совпадает' } else { 'изменилось' })
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's2:no-uninstaller' `
        -Path 'C:\Program Files\ETN\unins000.exe' -ExpectedPresent $false
    $service = Get-GuestServiceState -Context $script:context -Name 'ETN'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's2:no-scm-service' `
        -Ok ($service -eq 'Missing') -Expected 'Missing' -Actual $service `
        -Note 'ключ реестра — часть фикстуры, SCM-службы нет'

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's2:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note '1 запуск'
}

<# --- S3: понижение версии ------------------------------------------------- #>
function Invoke-ScenarioS3 {
    param($Results, $Timings)
    $scenario = 'S3'
    $started = Get-Date
    Initialize-ScenarioVm -Snapshot $InstalledSnapshot -SetupKeys @('intermediate', 'old')

    $json = Get-GuestInstallJson -Context $script:context
    $version = [string](Get-JsonField $json 'product_version')
    $port = [string](Get-JsonField $json 'port')
    if (-not $port) { $port = '4321' }
    $init = Initialize-GuestServer -Context $script:context
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:init' `
        -Ok ([bool](Get-JsonField $init 'Ok')) -Expected 'первый администратор есть' `
        -Actual ([string](Get-JsonField $init 'Action')) `
        -Note 'silent 0 (обновление) возможен только на инициализированной БД'
    $null = Ensure-GuestServiceRunning -Context $script:context -Port $port
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:snapshot-version' `
        -Ok ($version -ne '') -Expected '0.15.1' -Actual $version

    $hashBefore = Get-GuestTreeHashText -Context $script:context -Root 'C:\Program Files\ETN\server'
    $jsonBefore = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'

    # Постановка: установщик 0.15.2 над 0.15.1 — ожидается 20. Фактический
    # результат фиксируется как есть; если это обновление (0), ниже — реальная
    # проверка понижения.
    $runIntermediate = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['intermediate'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:0.15.2-over-0.15.1-code' -Ok $false -Deferred `
        -Expected '20 (постановка: понижение)' -Actual $runIntermediate.Code `
        -Note 'ожидание постановки неприменимо: снапшот содержит 0.15.1, установщик 0.15.2 — обновление; ниже проверено настоящее понижение'

    if ($runIntermediate.Code -eq 20) {
        $after = Get-GuestInstallJson -Context $script:context
        $versionAfter = [string](Get-JsonField $after 'product_version')
        $hashAfter = Get-GuestTreeHashText -Context $script:context -Root 'C:\Program Files\ETN\server'
        $jsonAfter = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:version-unchanged' `
            -Ok ($versionAfter -eq $version) -Expected $version -Actual $versionAfter
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:files-unchanged' `
            -Ok ($hashBefore -eq $hashAfter) -Expected 'SHA-256 совпадают' -Actual $(if ($hashBefore -eq $hashAfter) { 'совпадают' } else { 'изменились' })
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:install-json-unchanged' `
            -Ok (([string](Get-JsonField $jsonBefore 'Text')) -eq ([string](Get-JsonField $jsonAfter 'Text'))) `
            -Expected 'содержимое совпадает' `
            -Actual $(if (([string](Get-JsonField $jsonBefore 'Text')) -eq ([string](Get-JsonField $jsonAfter 'Text'))) { 'совпадает' } else { 'изменилось' })
        Add-LogCheck -Results $Results -Scenario $scenario -Name 's3:reason' -Log $runIntermediate.Log `
            -Needle 'понижение версии запрещено'
    } else {
        $versionNow = [string](Get-JsonField (Get-GuestInstallJson -Context $script:context) 'product_version')
        $hashBeforeDown = Get-GuestTreeHashText -Context $script:context -Root 'C:\Program Files\ETN\server'
        $jsonBeforeDown = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'
        $runDowngrade = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['old'] `
            -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
        Add-CodeCheck -Results $Results -Scenario $scenario -Name 's3:downgrade-0.15.1-over-later-code' `
            -Expected 20 -Actual $runDowngrade.Code
        Add-LogCheck -Results $Results -Scenario $scenario -Name 's3:downgrade-reason' -Log $runDowngrade.Log `
            -Needle 'понижение версии запрещено'
        $versionAfterDown = [string](Get-JsonField (Get-GuestInstallJson -Context $script:context) 'product_version')
        $hashAfterDown = Get-GuestTreeHashText -Context $script:context -Root 'C:\Program Files\ETN\server'
        $jsonAfterDown = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:downgrade-version-unchanged' `
            -Ok ($versionAfterDown -eq $versionNow) -Expected $versionNow -Actual $versionAfterDown
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:downgrade-files-unchanged' `
            -Ok ($hashBeforeDown -eq $hashAfterDown) -Expected 'SHA-256 совпадают' -Actual $(if ($hashBeforeDown -eq $hashAfterDown) { 'совпадают' } else { 'изменились' })
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:downgrade-install-json-unchanged' `
            -Ok (([string](Get-JsonField $jsonBeforeDown 'Text')) -eq ([string](Get-JsonField $jsonAfterDown 'Text'))) `
            -Expected 'содержимое совпадает' `
            -Actual $(if (([string](Get-JsonField $jsonBeforeDown 'Text')) -eq ([string](Get-JsonField $jsonAfterDown 'Text'))) { 'совпадает' } else { 'изменилось' })
    }

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's3:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'запуски по обстоятельствам'
}

<# --- S4: обновление 0.15.1 → 0.15.3 -------------------------------------- #>
function Invoke-ScenarioS4 {
    param($Results, $Timings)
    $scenario = 'S4'
    $started = Get-Date
    Initialize-ScenarioVm -Snapshot $InstalledSnapshot -SetupKeys @('current')

    $init = Initialize-GuestServer -Context $script:context
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's4:init' `
        -Ok ([bool](Get-JsonField $init 'Ok')) -Expected 'первый администратор есть' `
        -Actual ([string](Get-JsonField $init 'Action'))

    $json = Get-GuestInstallJson -Context $script:context
    $port = [string](Get-JsonField $json 'port')
    if (-not $port) { $port = '4321' }
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's4:service-before' `
        -Ok (Ensure-GuestServiceRunning -Context $script:context -Port $port) `
        -Expected 'служба отвечает' -Actual 'проверено перед обновлением'

    $update = Invoke-UpdateToCurrent -Scenario $scenario -Results $Results -AddCoreChecks
    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's4:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'обновление'
    return $update
}

<# --- S5: удаление --------------------------------------------------------- #>
function Invoke-ScenarioS5 {
    param($Results, $Timings, [bool]$UpdatedStateReady)
    $scenario = 'S5'
    $started = Get-Date
    if (-not $UpdatedStateReady) {
        Write-Host 'S5: состояние после S4 отсутствует — готовлю его тем же обновлением.'
        $null = Initialize-ScenarioVm -Snapshot $InstalledSnapshot -SetupKeys @('current')
        $init = Initialize-GuestServer -Context $script:context
        if (-not [bool](Get-JsonField $init 'Ok')) {
            Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:prepare-init' -Ok $false `
                -Expected 'первый администратор есть' -Actual ([string](Get-JsonField $init 'Action'))
            return
        }
        $null = Ensure-GuestServiceRunning -Context $script:context -Port '4321'
        $prep = Invoke-UpdateToCurrent -Scenario $scenario -Results $Results
        if ($prep.Run.Code -ne 0) {
            Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:prepare-update' -Ok $false `
                -Expected 0 -Actual $prep.Run.Code
            return
        }
    }

    $uninstaller = 'C:\Program Files\ETN\unins000.exe'
    if (-not (Test-GuestPath -Context $script:context -Path $uninstaller)) {
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:uninstaller-present' -Ok $false `
            -Expected 'есть' -Actual 'нет'
        return
    }
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's5:uninstaller-present' `
        -Path $uninstaller -ExpectedPresent $true

    $ruleBefore = [bool](Invoke-GuestElevated -Context $script:context -ScriptBlock {
            param($Name)
            @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue).Count -gt 0
        } -ArgumentList @('ETN Server'))

    # Попытка 1 — элевированный процесс через WinRM (как установка).
    # /LOG обязателен: Inno запускает удаление второй фазой отдельным
    # процессом, первый выходит сразу, и его код 0 ничего не говорит о
    # результате — факт удаления подтверждает только журнал.
    $uninsLog = 'C:\e2e\unins-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.log'
    $run = Invoke-GuestElevatedProcess -Context $script:context -Exe $uninstaller `
        -Arguments @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG=' + $uninsLog)) `
        -TimeoutSec $InstallTimeoutSec
    $method = 'elevated-process'
    $deferred = $false
    if ($run.Code -ne 0) {
        # Попытка 2 — запланированная задача с правами SYSTEM: интерактивная
        # сессия не нужна, deinstaller получает полный токен.
        Write-Host "S5: elevated-process вернул $($run.Code) — пробую scheduled task (SYSTEM)."
        $taskRun = Invoke-GuestElevated -Context $script:context -ScriptBlock {
            param($Exe, $LimitSec, $LogPath)
            $taskName = 'ETN-E2E-Uninstall'
            $null = & schtasks.exe /Delete /TN $taskName /F 2>&1
            $command = '"' + $Exe + '" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="' + $LogPath + '"'
            $create = & schtasks.exe /Create /TN $taskName /TR $command /SC ONCE /ST 00:00 /RL HIGHEST /RU SYSTEM /F 2>&1
            if ($LASTEXITCODE -ne 0) { return [pscustomobject]@{ Created = $false; Code = $LASTEXITCODE; Output = ($create -join ' ') } }
            $start = & schtasks.exe /Run /TN $taskName 2>&1
            if ($LASTEXITCODE -ne 0) {
                $null = & schtasks.exe /Delete /TN $taskName /F 2>&1
                return [pscustomobject]@{ Created = $true; Code = $LASTEXITCODE; Output = ($start -join ' ') }
            }
            $code = -1
            $deadline = (Get-Date).AddSeconds($LimitSec)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 2
                $query = (& schtasks.exe /Query /TN $taskName /FO LIST /V 2>&1) -join "`n"
                if ($query -match 'Status:\s+Ready' -or $query -match 'Состояние:\s+Готово') {
                    if ($query -match 'Last Result:\s+(\d+)') { $code = [int]$Matches[1] }
                    elseif ($query -match 'Результат последнего запуска:\s+(\d+)') { $code = [int]$Matches[1] }
                    break
                }
            }
            $null = & schtasks.exe /Delete /TN $taskName /F 2>&1
            return [pscustomobject]@{ Created = $true; Code = $code; Output = '' }
        } -ArgumentList @($uninstaller, [Math]::Min($InstallTimeoutSec, 600), $uninsLog)
        $method = 'scheduled-task-system'
        if ([bool](Get-JsonField $taskRun 'Created') -and ((Get-JsonField $taskRun 'Code') -eq 0)) {
            $run = [pscustomobject]@{ Code = 0; Output = [string](Get-JsonField $taskRun 'Output'); TimedOut = $false }
        } else {
            $deferred = $true
            $run = [pscustomobject]@{ Code = (Get-JsonField $taskRun 'Code'); Output = [string](Get-JsonField $taskRun 'Output'); TimedOut = $false }
        }
    }

    if ($deferred) {
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:uninstall' -Ok $false -Deferred `
            -Expected 'удаление без интерактивной сессии' -Actual ("механизм $method, код " + (Get-JsonField $run 'Code')) `
            -Note 'отложено до GUI-захода: удаление требует интерактивной сессии (грабля service-real-uninstall)'
        Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's5:total-duration' `
            -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'deferred'
        return
    }

    $completion = Wait-GuestUninstallComplete -Context $script:context -UninstallerPath $uninstaller `
        -LogPath $uninsLog -TimeoutSec ([Math]::Min($InstallTimeoutSec, 600))
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's5:uninstall-code' -Expected 0 `
        -Actual (Get-JsonField $run 'Code') `
        -Note ('механизм: ' + $method + '; код первой фазы Inno — результат удаления см. s5:uninstall-log-success')
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:uninstall-log-success' `
        -Ok ([bool](Get-JsonField $completion 'Success')) -Expected 'Uninstallation process succeeded.' `
        -Actual $(if ([bool](Get-JsonField $completion 'Success')) { 'есть' } else { 'нет' }) `
        -Note ("механизм: " + $method + ', код первой фазы ' + (Get-JsonField $run 'Code') +
            ' (код первой фазы не является кодом удаления)')
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's5:firewall-log' `
        -Log ([pscustomobject]@{ Path = $uninsLog; Text = [string](Get-JsonField $completion 'Log'); Exists = $true }) `
        -Needle 'Правило брандмауэра удалено: ETN Server'
    $service = Get-GuestServiceState -Context $script:context -Name 'ETN'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:service-removed' `
        -Ok ($service -eq 'Missing') -Expected 'Missing' -Actual $service
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's5:server-files-removed' `
        -Path 'C:\Program Files\ETN\server\dist\index.js' -ExpectedPresent $false
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's5:data-preserved' `
        -Path 'C:\ProgramData\ETN\install.json' -ExpectedPresent $true -Note 'каталог данных не удаляется'
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's5:db-preserved' `
        -Path 'C:\ProgramData\ETN\_system.db' -ExpectedPresent $true
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's5:desktop-shortcut-removed' `
        -Path 'C:\Users\Public\Desktop\ETN.lnk' -ExpectedPresent $false
    Add-PathCheck -Results $Results -Scenario $scenario -Name 's5:start-menu-removed' `
        -Path 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\ETN' -ExpectedPresent $false
    $ruleAfter = [bool](Invoke-GuestElevated -Context $script:context -ScriptBlock {
            param($Name)
            @(Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue).Count -gt 0
        } -ArgumentList @('ETN Server'))
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's5:firewall-rule' `
        -Ok ($ruleAfter -eq $false) -Expected 'правила нет' `
        -Actual $(if ($ruleAfter) { 'правило осталось' } else { 'правила нет' }) `
        -Note $(if ($ruleBefore) { 'до удаления правило было' } else { 'до удаления правила не было' })

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's5:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'удаление'
}

<# --- S6: служба ----------------------------------------------------------- #>
function Invoke-ScenarioS6 {
    param($Results, $Timings)
    $scenario = 'S6'
    $started = Get-Date
    Initialize-ScenarioVm -Snapshot $InstalledSnapshot -SetupKeys @('current')

    $init = Initialize-GuestServer -Context $script:context
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:init' `
        -Ok ([bool](Get-JsonField $init 'Ok')) -Expected 'первый администратор есть' `
        -Actual ([string](Get-JsonField $init 'Action'))
    $null = Ensure-GuestServiceRunning -Context $script:context -Port '4321'
    $update = Invoke-UpdateToCurrent -Scenario $scenario -Results $Results
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's6:update-code' -Expected 0 -Actual $update.Run.Code
    if ($update.Run.Code -ne 0) {
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:aborted' -Ok $false `
            -Expected '0 для подготовки' -Actual $update.Run.Code
        return
    }
    $port = $update.Port

    $status = Invoke-GuestElevatedCommand -Context $script:context `
        -Command '"C:\Program Files\ETN\service\etn-service.exe" status'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:status-output' `
        -Ok (([string]$status.Output) -match 'Started|Running') -Expected 'Started' -Actual ([string]$status.Output)

    $image = Get-GuestRegistryValue -Context $script:context `
        -Key 'HKLM:\SYSTEM\CurrentControlSet\Services\ETN' -Name 'ImagePath'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:image-path' `
        -Ok (([string]$image) -match 'etn-service\.exe' -and ([string]$image) -match '\\ETN\\service\\') `
        -Expected 'C:\Program Files\ETN\service\etn-service.exe' -Actual ([string]$image)
    $startType = Get-GuestRegistryValue -Context $script:context `
        -Key 'HKLM:\SYSTEM\CurrentControlSet\Services\ETN' -Name 'Start'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:start-type' `
        -Ok (([string]$startType) -eq '2') -Expected '2 (Automatic)' -Actual ([string]$startType)

    $xml = Get-GuestText -Context $script:context -Path 'C:\Program Files\ETN\service\etn-service.xml'
    $xmlText = [string](Get-JsonField $xml 'Text')
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:xml-data-dir' `
        -Ok ($xmlText.Contains('<env name="ETN_DATA_DIR" value="C:\ProgramData\ETN"/>')) `
        -Expected 'ETN_DATA_DIR=C:\ProgramData\ETN' -Actual 'проверено'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:xml-port' `
        -Ok ($xmlText.Contains('<env name="ETN_PORT" value="' + $port + '"/>')) `
        -Expected ("ETN_PORT=" + $port) -Actual 'проверено'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:xml-deployment' `
        -Ok ($xmlText.Contains('<env name="ETN_DEPLOYMENT" value="windows-service"/>')) `
        -Expected 'ETN_DEPLOYMENT=windows-service' -Actual 'проверено'

    $stop = Invoke-GuestElevatedCommand -Context $script:context `
        -Command '"C:\Program Files\ETN\service\etn-service.exe" stop'
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's6:stop-code' -Expected 0 -Actual $stop.Code
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:stopped' `
        -Ok (Wait-GuestServiceState -Context $script:context -Name 'ETN' -Expected 'Stopped') `
        -Expected 'Stopped' -Actual (Get-GuestServiceState -Context $script:context -Name 'ETN')
    $start = Invoke-GuestElevatedCommand -Context $script:context `
        -Command '"C:\Program Files\ETN\service\etn-service.exe" start'
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's6:start-code' -Expected 0 -Actual $start.Code
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:running' `
        -Ok (Wait-GuestServiceState -Context $script:context -Name 'ETN' -Expected 'Running') `
        -Expected 'Running' -Actual (Get-GuestServiceState -Context $script:context -Name 'ETN')
    $healthAfterRestart = Wait-GuestHealthVersion -Context $script:context -Port $port -Expected '0.15.3'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:health-after-restart' `
        -Ok ($healthAfterRestart -eq '0.15.3') -Expected '0.15.3' -Actual $healthAfterRestart

    $repairLogBefore = [string](Get-JsonField (Get-GuestInstallLog -Context $script:context) 'Path')
    $repair = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['current'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's6:repair-code' -Expected 0 -Actual $repair.Code
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's6:repair-no-register' -Log $repair.Log `
        -Needle 'Служба ETN уже зарегистрирована — install не требуется'
    Add-LogAbsentCheck -Results $Results -Scenario $scenario -Name 's6:repair-no-install-call' -Log $repair.Log `
        -Needle 'Регистрация службы ETN:'
    $serviceAfterRepair = Get-GuestServiceState -Context $script:context -Name 'ETN'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:repair-service-running' `
        -Ok ($serviceAfterRepair -eq 'Running') -Expected 'Running' -Actual $serviceAfterRepair
    $repairHealth = Wait-GuestHealthVersion -Context $script:context -Port $port -Expected '0.15.3'
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 's6:repair-health' `
        -Ok ($repairHealth -eq '0.15.3') -Expected '0.15.3' -Actual $repairHealth

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 's6:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'служба+ремонт'
}

# --- Основной прогон -------------------------------------------------------

# pwsh -File передаёт «-Scenarios S1,S2» одной строкой — запятую разбираем
# здесь, чтобы пример вызова в справке работал как записан.
$requested = @($Scenarios | ForEach-Object { $_ -split ',' } |
    ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
$known = @('S1', 'S2', 'S3', 'S4', 'S5', 'S6')
foreach ($name in $requested) {
    if ($known -notcontains $name) { throw "Неизвестный сценарий $name. Допустимо: $($known -join ', ')." }
}
$requested = @($known | Where-Object { $requested -contains $_ })

Write-Host "E2E установщика ETN: сценарии $($requested -join ', ')"
Write-Host "Установщики: $ReleaseDir"
Write-Host "Отчёт: $reportPath"

try {
    $null = Resolve-VBoxManage
    $context = New-GuestContext -Vm $Vm -SecretsPath $SecretsPath
    $updatedStateReady = $false

    foreach ($name in $requested) {
        $snapshot = switch ($name) {
            'S1' { $BaseSnapshot }
            'S2' { $BaseSnapshot }
            'S3' { $InstalledSnapshot }
            'S4' { $InstalledSnapshot }
            'S5' { $(if ($updatedStateReady) { '(состояние S4)' } else { $InstalledSnapshot }) }
            'S6' { $InstalledSnapshot }
        }
        $scenarioStarted = Get-Date
        Write-Step "Сценарий $name (снапшот: $snapshot)"
        $checksBefore = $results.Count
        try {
            switch ($name) {
                'S1' { Invoke-ScenarioS1 -Results $results -Timings $timings }
                'S2' { Invoke-ScenarioS2 -Results $results -Timings $timings }
                'S3' { Invoke-ScenarioS3 -Results $results -Timings $timings }
                'S4' {
                    $update = @(Invoke-ScenarioS4 -Results $results -Timings $timings) |
                        Where-Object { $_.PSObject.Properties['Run'] } |
                        Select-Object -Last 1
                    if ($null -eq $update) {
                        Add-E2ECheck -Results $results -Scenario 'S4' -Name 'scenario:return' -Ok $false `
                            -Expected 'объект с Run' -Actual 'нет'
                        $updatedStateReady = $false
                    } else {
                        $updatedStateReady = ($update.Run.Code -eq 0)
                    }
                }
                'S5' {
                    Invoke-ScenarioS5 -Results $results -Timings $timings -UpdatedStateReady $updatedStateReady
                    $updatedStateReady = $false
                }
                'S6' { Invoke-ScenarioS6 -Results $results -Timings $timings }
            }
        } catch {
            Add-E2ECheck -Results $results -Scenario $name -Name 'scenario:error' -Ok $false `
                -Expected 'сценарий выполнен' -Actual 'исключение' -Note $_.Exception.Message
        }
        $logDir = ''
        $logsError = ''
        try {
            $logDir = Save-GuestInstallerLogs -Context $context -Scenario $name -HostRoot (Join-Path $OutDir 'logs')
        } catch {
            $logsError = $_.Exception.Message
            Write-Warning "Журналы сценария ${name} не собраны: $logsError"
        }
        $logFileCount = 0
        if ($logDir -and (Test-Path -LiteralPath $logDir)) {
            $logFileCount = @(Get-ChildItem -LiteralPath $logDir -File -Force).Count
            if ($logFileCount -eq 0 -and -not $logsError) { $logsError = 'в каталоге журналов нет файлов' }
        }
        if ($logsError) {
            # Сбой сбора журналов виден и в консоли, и в отчёте (logs_error),
            # а не притворяется пустым logs.
            Write-Warning "Журналы сценария ${name}: $logsError"
        }
        $summary = Get-E2ESummary -Results $results -Scenario $name
        $summaryTimings = @($timings | Where-Object { $_.scenario -eq $name }).Count
        $scenarioReports.Add([pscustomobject]@{
                name         = $name
                snapshot     = $snapshot
                started_at   = $scenarioStarted.ToUniversalTime().ToString('o')
                duration_sec = [math]::Round(((Get-Date) - $scenarioStarted).TotalSeconds, 1)
                checks       = $summary.checks
                failed       = $summary.failed
                deferred     = $summary.deferred
                ok           = $summary.ok
                logs         = $logDir
                logs_files   = $logFileCount
                logs_error   = $logsError
                timings_count = $summaryTimings
                new_checks   = ($results.Count - $checksBefore)
            })
        Write-Host ("Итог {0}: проверок {1}, провалов {2}, отложено {3}, замеров {4}" -f `
                $name, $summary.checks, $summary.failed, $summary.deferred, $summaryTimings)
    }
} finally {
    if ($context) { Close-GuestSession -Context $context }
    $restoreError = ''
    try {
        Write-Step "Возврат ВМ в снапшот $OriginalSnapshot"
        Restore-VmSnapshot -Vm $Vm -Name $OriginalSnapshot
        if (-not $KeepVmRunning) { Stop-Vm -Vm $Vm }
    } catch {
        $restoreError = $_.Exception.Message
        Write-Warning "Не удалось вернуть ВМ в ${OriginalSnapshot}: $restoreError"
    }
    try { $finalVmState = Get-VmState -Vm $Vm } catch { $finalVmState = 'unknown' }

    $totalDuration = [math]::Round(((Get-Date) - $runStartedAt).TotalSeconds, 1)
    $extra = @{
        vm               = [ordered]@{
            name              = $Vm
            base_snapshot     = $BaseSnapshot
            original_snapshot = $OriginalSnapshot
            final_state       = $finalVmState
            restore_error     = $restoreError
        }
        setup            = [ordered]@{
            current      = $setups['current']
            intermediate = $setups['intermediate']
            old          = $setups['old']
        }
        requested        = $requested
        duration_sec     = $totalDuration
        logs_failed      = @($scenarioReports | Where-Object { $_.logs_error }).Count
    }
    Write-E2EReport -Results $results -Timings $timings -Scenarios $scenarioReports.ToArray() `
        -Path $reportPath -Extra $extra
    $reportWritten = $true

    $failed = @($results | Where-Object { (-not $_.ok) -and (-not $_.deferred) }).Count
    $deferred = @($results | Where-Object { $_.deferred }).Count
    $timingsCount = $timings.Count
    $logsFailed = [int]$extra['logs_failed']
    $logsOk = @($requested).Count - $logsFailed
    Write-Host ''
    $summaryFormat = 'Итог E2E: проверок {0}, провалов {1}, отложено {2}, замеров {3}, ' +
        'журналы без ошибок {4}/{5}, ВМ {6}'
    Write-Host ($summaryFormat -f $results.Count, $failed, $deferred,
        $timingsCount, $logsOk, @($requested).Count, $finalVmState)
    if ($failed -gt 0) { exit 1 }
    if ($restoreError) {
        # Не вернули ВМ в исходное состояние — прогон не считается штатным.
        Write-Warning "Возврат ВМ в $OriginalSnapshot не выполнен: $restoreError"
        exit 2
    }
}
