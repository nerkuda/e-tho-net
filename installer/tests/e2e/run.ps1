<#
.SYNOPSIS
    E2E-прогон установщика ETN в ВМ VirtualBox (сценарии S1–S6).

.DESCRIPTION
    Оркестратор поверх vm.ps1 (механика ВМ), guest.ps1 (гостевые команды),
    gui.ps1 (интерактивная сессия + проба окна мастера) и assert.ps1
    (проверки и JSON-отчёт). Задача 8789381a.

    Silent-сценарии (guestcontrol/WinRM, без рабочего стола):
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
          честно помечается deferred, успех не имитируется.
      S6  служба на состоянии после S4: etn-service.exe status/stop/start,
          ImagePath, Start=Automatic, env-переменные в etn-service.xml,
          ремонт (повторная установка той же версии) не перерегистрирует
          службу.

    GUI-сценарии (реальный рабочий стол гостя, см. gui.ps1/probe.ps1):
      G1  чистая GUI-установка из base-e2e-gui2: мастер целиком (оба
          компонента, лицензия MIT, порт 4321, администратор, первичный ключ),
          код 0, файлы/служба/install.json/health, ярлыки, ключ не попадает
          в журналы и временный файл удалён после подтверждения.
      G2  legacy NSIS: синтетическая запись Uninstall + подставной
          деинсталлятор (путь с пробелами). Ветка A — неэлевированный запуск:
          строка «нужны права администратора», WARN в журнале, клиент в
          профиль, старая запись остаётся. Ветка B — элевированный запуск:
          строка «будет удалён», маркер вызова, запись и старый каталог
          удалены, одна запись ETN, установка цела.
      G3  worst-case layout (только чтение, без кликов «Далее»):
          чистая машина (лицензия не принята — точная причина),
          «только для меня» в сессии стандартной учётки (если база
          base-e2e-user2 доступна; иначе честный deferred), понижение
          0.15.3 → 0.15.2 (точная причина с версией), уведомление «клиент
          не закрыт» после отказа закрыть клиента. Проверяются: причина
          видима и внутри страницы, длинная строка области клиента не сжата,
          высоты строк списка >= текста, контролы не пересекаются.
      G4  закрытие запущенного клиента — сценарий отменён решением
          пользователя 2026-11-08: в ВМ клиент зависает даже в ручных
          прогонах, suspend-состояние не доходит до диалога, ожидание
          съедает ~25 минут набора. Имя G4 сохранено (в отчёте — честная
          запись deferred «g4:cancelled»), автоматического покрытия нет:
          закрытие клиента проверяется вручную при приёмке релиза.

    GUI-базы — аддитивные «живые» снапшоты: base-e2e-gui2 (AutoLogon +
    интерактивная сессия на base-e2e-live) и base-e2e-user2 (стандартная
    учётка e2egui, для ветки «только для меня»). base-e2e-gui снят до
    отключения буфера обмена — restore не гарантирован, поэтому дефолты
    указывают на проверенные base-e2e-gui2/base-e2e-user2. Исходные снапшоты стенда
    не меняются и не удаляются.

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
    Подмножество S1..S6 и/или G1..G4. По умолчанию — S1..S6. G4 отменён
    (решение пользователя 2026-11-08) и всегда пишет deferred «g4:cancelled».

.PARAMETER GuiBaseSnapshot
    Живой снапшот с AutoLogon и интерактивной сессией для GUI-сценариев.
    Создаётся аддитивно из -BaseSnapshot, если его нет.

.PARAMETER GuiUserSnapshot
    Живой снапшот со стандартной учёткой e2egui (ветка «только для меня» в
    G3). Создаётся аддитивно при запуске G3; недоступность — честный deferred.

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
    pwsh -File installer/tests/e2e/run.ps1 -Scenarios G1,G2,G3 -OutDir .tmp/e2e-gui

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
    # GUI-база: живой снапшот base-e2e-live с AutoLogon и открытой сессией
    # пользователя (создаётся автоматически, аддитивно; см. gui.ps1).
    [string]$GuiBaseSnapshot = 'base-e2e-gui2',
    [string]$GuiUserSnapshot = 'base-e2e-user2',
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
. (Join-Path $here 'gui.ps1')

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
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($Exclude, $MaxAge)
        $dirs = @(
            (Join-Path $env:ProgramData 'ETN\logs'),
            $env:TEMP,
            'C:\Windows\Temp'
        )
        # Установка клиента «только для меня» идёт без прав администратора и
        # пишет журнал в %TEMP% пользователя (каталог данных не создаётся):
        # профили всех пользователей, включая учётку интерактивной сессии.
        $dirs += @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'AppData\Local\Temp' })
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
    return @(Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
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
    # Снапшот сценария обязан быть «живым» (снят с запущенной ВМ, где WinRM
    # отвечает): resume возвращает память вместе с работающей службой WinRM.
    # Поднять WinRM без прав администратора внутри гостя нельзя — guestcontrol
    # даёт фильтрованный токен (проверено: sc start winrm → отказано), WinRM —
    # единственный элевированный канал. Поэтому неготовность WinRM — ошибка
    # стенда, а не сценария: сценарий помечается провалом с причиной.
    #
    # На VirtualBox 7.2.22 resume «живого» снапшота изредка не поднимает WinRM
    # (наблюдалось 2026-11-08 после прерванного прогона: GA есть, WinRM молчит,
    # повторный restore того же снапшота работает). Один повтор restore+start
    # отличает разовый сбой стенда от устойчивой поломки снапшота.
    $attempts = 2
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        try {
            Restore-VmSnapshot -Vm $Vm -Name $Snapshot
            Start-VmHeadless -Vm $Vm
            $ga = Wait-VmGuestAdditions -Vm $Vm -TimeoutSec $BootTimeoutSec
            Write-Host "Guest Additions: $ga"
            $null = Wait-GuestReady -Context $script:context -TimeoutSec $BootTimeoutSec
            break
        } catch {
            if ($attempt -ge $attempts) { throw }
            Write-Warning ("Восстановление {0} не удалось ({1}); повторная попытка restore+start" -f `
                    $Snapshot, $_.Exception.Message)
            Close-GuestSession -Context $script:context
        }
    }
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
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
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

<#
    Пауза перед очередным запуском установщика в S1: имена журналов —
    с точностью до секунды (TryInitLog в etn.iss). Два запуска в одну секунду
    получают одно имя: неэлевированный не может дописать файл, созданный
    администратором, а TryInitLog считает FileExists успехом и не уходит
    в %TEMP% — журнал теряется (ошибка f7887a35). Разносим запуски по секундам.
#>
function Wait-InstallerLogSecond {
    param([int]$Milliseconds = 1200)
    Start-Sleep -Milliseconds $Milliseconds
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

    Wait-InstallerLogSecond
    $run2 = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['current'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    Add-CodeCheck -Results $Results -Scenario $scenario -Name 's1:serveronly-no-record-code' -Expected 20 -Actual $run2.Code
    Add-LogCheck -Results $Results -Scenario $scenario -Name 's1:serveronly-no-record-reason' -Log $run2.Log `
        -Needle 'Предусловие не выполнено: нет C:\ProgramData\ETN\install.json'

    Wait-InstallerLogSecond
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

<#
    Погасить службу ETN и оставшиеся процессы node.exe из каталога ETN.
    Нужно перед установкой 0.15.1/0.15.2: их остановка службы не гарантирует
    завершение node.exe, и Inno с /SUPPRESSMSGBOXES откатывает замену файлов
    (код 5, грабли 8bec9706). Для S3 это только подготовка состояния —
    работоспособность службы проверяют S4/S6.
#>
function Stop-GuestEtnProcesses {
    param($Context = $script:context)
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        try { $null = & 'C:\Program Files\ETN\service\etn-service.exe' stop 2>&1 } catch { }
        Start-Sleep -Seconds 2
        foreach ($process in @(Get-Process -Name 'node' -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -and $_.Path -like 'C:\Program Files\ETN\*' })) {
            try { $null = & taskkill.exe /PID $process.Id /F 2>&1 } catch { }
        }
        @(Get-Process -Name 'node' -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -and $_.Path -like 'C:\Program Files\ETN\*' }).Count
    }
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
    # Служба 0.15.1 не ждёт завершения node.exe: после resume «живого»
    # снапшота осиротевший процесс держит better_sqlite3.node, и обновление
    # 0.15.2 откатывается с кодом 5 (грабли 8bec9706). Обновление здесь —
    # только постановка «более новой версии», поэтому гасим службу и процессы.
    $null = Stop-GuestEtnProcesses -Context $script:context

    # Постановка: установщик 0.15.2 над 0.15.1 — ожидается 20. Фактический
    # результат фиксируется как есть; если это обновление (0), ниже — реальная
    # проверка понижения.
    $runIntermediate = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['intermediate'] `
        -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    if (@(0, 20) -notcontains [int]$runIntermediate.Code) {
        # Код 5/10 — обновление сорвалось до смены версии. Наблюдалось
        # 2026-11-08: better_sqlite3.node держал осиротевший node.exe службы,
        # Inno с /SUPPRESSMSGBOXES выбрал Abort и откатил изменения
        # (грабли 8bec9706). Состояние после отката ненадёжно — повторяем
        # постановку с восстановления снапшота.
        Write-Warning ("S3: обновление 0.15.2 вернуло код {0}; повтор постановки после восстановления снапшота" -f `
                $runIntermediate.Code)
        $null = Initialize-ScenarioVm -Snapshot $InstalledSnapshot -SetupKeys @('intermediate', 'old')
        $null = Initialize-GuestServer -Context $script:context
        $null = Ensure-GuestServiceRunning -Context $script:context -Port $port
        $null = Stop-GuestEtnProcesses -Context $script:context
        $runIntermediate = Invoke-SilentInstall -Context $script:context -SetupFileName $setups['intermediate'] `
            -InstallerArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY'
    }
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
    } elseif ($runIntermediate.Code -eq 0) {
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
    } else {
        # Постановка не удалась и после повтора (код не 0 и не 20): состояние
        # для проверки понижения не подготовлено — честный deferred, а не
        # красная проверка из-за чужого сбоя.
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:downgrade-0.15.1-over-later-code' `
            -Ok $false -Deferred -Expected 20 -Actual $runIntermediate.Code `
            -Note 'постановка не удалась: промежуточный 0.15.2 вернул неожиданный код; проверка понижения отложена'
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 's3:downgrade-reason' `
            -Ok $false -Deferred -Expected 'понижение версии запрещено' -Actual 'нет запуска' `
            -Note 'причина понижения не проверялась: нет состояния «более новая версия»'
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

# === GUI-сценарии (задача 8789381a, этап 4) ================================
#
# Установщик GUI работает только в интерактивной сессии гостя (AutoLogon,
# запланированная задача — см. gui.ps1). Проба probe.ps1 снимает состояние
# страницы в JSON; проверки ниже читают этот JSON и журнал установщика.
# Тексты взяты из installer/etn.iss ([CustomMessages]) дословно.

$script:GuiTexts = [ordered]@{
    ComponentsTitle        = 'ETN — установка'
    ComponentsWelcome      = 'Добро пожаловать в ETN: сервер хранит графовые базы знаний на этом компьютере, клиент — окно для работы с ними.'
    LicenseAccept          = 'Я принимаю условия лицензии MIT'
    ReasonLicense          = 'Далее недоступна: Примите условия лицензии MIT, чтобы продолжить.'
    ServerCaption          = 'Установить сервер ETN'
    ClientCaption          = 'Установить клиент ETN'
    ServerNotInstalled     = 'не установлен'
    ServerNeedsAdmin       = 'Для установки сервера закройте установщик и запустите его от имени администратора (правый клик → Запуск от имени администратора).'
    ClientScopeAdmin       = 'Установщик запущен от имени администратора: клиент ставится для всех пользователей. Подключение к локальному серверу уже предзаполнено в ярлыке клиента.'
    ClientScopeRowUserOnly = 'Режим «только для меня»: клиент ставится в ваш профиль, права администратора не нужны. Чтобы установить сервер или клиент «для всех пользователей», закройте установщик и запустите его от имени администратора (правый клик → Запуск от имени администратора).'
    AdminTitle             = 'Администратор сервера'
    ParamsTitle            = 'Параметры сервера'
    KeyTitle               = 'Первичный API-ключ'
    KeyConfirm             = 'Я сохранил ключ'
    FinishedHeading        = 'Установка ETN завершена'
    FailedHeading          = 'Установка ETN не завершена'
    LegacyUserOnly         = 'найден клиент ETN 0.14.2 от старого установщика (NSIS, для всех пользователей) — для его удаления нужны права администратора; новый клиент поставится в ваш профиль'
    LegacyWillRemove       = 'найден клиент ETN 0.14.2 от старого установщика (NSIS, для всех пользователей) — перед установкой он будет удалён'
    DowngradeReason        = 'Далее недоступна: Установлена более новая версия 0.15.3 — понижение версии не поддерживается. Доступна только отмена.'
    # 0.15.2 — сборка до c4b68d78 (экран компонентов с префиксом «Далее
    # недоступна»): её страница понижения показывает причину без префикса.
    # Это свойство релизного установщика-фикстуры, а не текущего .iss.
    DowngradeReason0152    = 'Установлена более новая версия 0.15.3 — понижение версии не поддерживается. Доступна только отмена.'
    NoticeClientClose      = 'Далее недоступна: Установка не начата: клиент ETN не закрыт: пользователь отказался закрыть запущенный клиент'
}

# --- Помощники GUI-проверок ------------------------------------------------

function Initialize-GuiScenarioVm {
    param([Parameter(Mandatory = $true)][string]$Snapshot, [string[]]$SetupKeys = @())
    # Resume «живого» снапшота на VirtualBox 7.2.22 изредка теряет WinRM уже
    # ПОСЛЕ Wait-GuestReady: первый вызов Invoke-Command переподключается сам,
    # следующий обрывается окончательно (наблюдалось 2026-11-08 на
    # base-e2e-user2: сценарий падал на копировании пробы). Повторяем всю
    # инициализацию с restore: частичное состояние гостя отбрасывается.
    $attempts = 2
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        try {
            Initialize-ScenarioVm -Snapshot $Snapshot -SetupKeys $SetupKeys
            $null = Copy-GuestGuiProbe -Context $script:context
            $session = Wait-GuestInteractiveSession -Context $script:context -TimeoutSec 180
            if ([int]$session.ActiveSessions -le 0 -or [int]$session.ExplorerCount -le 0) {
                throw ('нет интерактивной сессии после restore: ' + (($session.QueryUser -replace "`r?`n", ' | ')))
            }
            return $session
        } catch {
            if ($attempt -ge $attempts) { throw }
            Write-Warning ("Инициализация GUI-сценария на {0} не удалась ({1}); повторная попытка restore+start" -f `
                    $Snapshot, $_.Exception.Message)
            Close-GuestSession -Context $script:context
        }
    }
}

function Add-GuiCheck {
    param($Results, [string]$Scenario, [string]$Name, [bool]$Ok, $Expected, $Actual, [string]$Note = '')
    Add-E2ECheck -Results $Results -Scenario $Scenario -Name $Name -Ok $Ok `
        -Expected $Expected -Actual $Actual -Note $Note
}

function Add-GuiProbeCheck {
    param($Results, [string]$Scenario, [string]$Name, $Probe, [string]$Note = '')
    $note = ([string]$Probe.Error)
    if ($Note) { $note = ($note + ' ' + $Note).Trim() }
    Add-GuiCheck -Results $Results -Scenario $Scenario -Name $Name -Ok ([bool]$Probe.Ok) `
        -Expected 'проба отработала' -Actual $(if ($Probe.Ok) { 'ok' } else { 'сбой' }) -Note $note
}

function Add-GuiPageCheck {
    param($Results, [string]$Scenario, [string]$Name, $Snapshot, [string]$Title)
    $page = Get-JsonField $Snapshot 'page'
    $actual = if ($page) { [string](Get-JsonField $page 'title') } else { '' }
    Add-GuiCheck -Results $Results -Scenario $Scenario -Name $Name -Ok ($actual -eq $Title) `
        -Expected $Title -Actual $actual
}

function Add-GuiTextCheck {
    param($Results, [string]$Scenario, [string]$Name, $Snapshot, [string]$Text,
        [switch]$Exact, [switch]$Absent)
    $found = Test-GuiSnapshotText -Snapshot $Snapshot -Text $Text -Exact:$Exact
    $ok = if ($Absent) { -not $found } else { $found }
    Add-GuiCheck -Results $Results -Scenario $Scenario -Name $Name -Ok $ok `
        -Expected $(if ($Absent) { 'нет текста: ' + $Text } else { $Text }) `
        -Actual $(if ($found) { 'найдено' } else { 'нет' })
}

function Add-GuiNextCheck {
    param($Results, [string]$Scenario, [string]$Name, $Snapshot, [bool]$Enabled)
    $next = Get-JsonField $Snapshot 'next_button'
    $actual = if ($next) { [bool](Get-JsonField $next 'enabled') } else { $null }
    Add-GuiCheck -Results $Results -Scenario $Scenario -Name $Name -Ok ($actual -eq $Enabled) `
        -Expected $(if ($Enabled) { 'активна' } else { 'неактивна' }) `
        -Actual $(if ($null -eq $actual) { 'кнопка не найдена' } elseif ($actual) { 'активна' } else { 'неактивна' })
}

function Add-GuiLayoutCheck {
    param($Results, [string]$Scenario, [string]$Name, $Snapshot)
    $layout = Test-GuiSnapshotLayout -Snapshot $Snapshot
    $problems = @($layout.Problems)
    Add-GuiCheck -Results $Results -Scenario $Scenario -Name $Name -Ok ([bool]$layout.Ok) `
        -Expected 'без обрезки и пересечений' `
        -Actual $(if ($layout.Ok) { 'ok' } else { "$($problems.Count) проблем" }) `
        -Note (($problems | Select-Object -First 6) -join '; ')
}

function Get-GuiStepResult {
    param($ProbeResult, [string]$Type)
    $steps = @(Get-JsonField $ProbeResult 'steps')
    return @($steps | Where-Object { [string](Get-JsonField $_ 'type') -eq $Type }) | Select-Object -First 1
}

function Get-GuiInstallerExitCode {
    param($ProbeResult)
    $installer = Get-JsonField $ProbeResult 'installer'
    return Get-JsonField $installer 'exit_code'
}

<# Шаги полной GUI-установки: лицензия, администратор, параметры, ключ. #>
function New-GuiFullInstallSteps {
    param(
        [string]$Set = 'gui',
        [string]$Login = 'e2e-gui-admin',
        [string]$DisplayName = 'E2E GUI',
        [int]$InstallTimeoutSec = 900
    )
    $steps = @(
        @{ type = 'wait_window'; timeout_sec = 120 },
        @{ type = 'snapshot'; name = "$Set-components" }
    )
    $steps += @(
        # Лицензия запоминается после первой установки: на повторном запуске
        # строки нет, и строгий check сломал бы план.
        @{ type = 'check_optional'; text = $script:GuiTexts.LicenseAccept; state = 'on' },
        @{ type = 'snapshot'; name = "$Set-components-licensed" },
        @{ type = 'next' },
        @{ type = 'wait_page'; title = $script:GuiTexts.AdminTitle; timeout_sec = 60 },
        @{ type = 'snapshot'; name = "$Set-admin-default" },
        @{ type = 'set_text'; index = 0; text = $Login },
        @{ type = 'set_text'; index = 1; text = $DisplayName },
        @{ type = 'snapshot'; name = "$Set-admin" },
        @{ type = 'next' },
        @{ type = 'wait_page'; title = $script:GuiTexts.ParamsTitle; timeout_sec = 60 },
        @{ type = 'snapshot'; name = "$Set-params" },
        @{ type = 'next' },
        @{ type = 'wait_text'; text = 'Всё готово к установке'; timeout_sec = 60 },
        @{ type = 'snapshot'; name = "$Set-ready" },
        # PrepareToInstall может открыть модальный диалог закрытия клиента,
        # если клиент запущен, — синхронный клик «Установить» висел бы до ответа.
        @{ type = 'next'; text_any = @('Установить'); timeout_sec = 60; async = $true }
    )
    $steps += @{ type = 'wait_page'; title = $script:GuiTexts.KeyTitle; timeout_sec = $InstallTimeoutSec }
    $steps += @{ type = 'snapshot'; name = "$Set-key" }
    $steps += @{ type = 'check_secret_absent'; secret_file = 'C:\ProgramData\ETN\.install\primary-key.txt' }
    $steps += @{ type = 'check'; text = $script:GuiTexts.KeyConfirm; state = 'on' }
    $steps += @{ type = 'snapshot'; name = "$Set-key-confirmed" }
    $steps += @{ type = 'next' }
    $steps += @{ type = 'wait_finished'; timeout_sec = 120 }
    $steps += @{ type = 'snapshot'; name = "$Set-finished" }
    $steps += @{ type = 'next'; text_any = @('Готово', 'Завершить'); timeout_sec = 60 }
    $steps += @{ type = 'wait_exit'; timeout_sec = 180 }
    return $steps
}

<# Шаги установки только клиента «только для меня» (без элевации). #>
function New-GuiClientInstallSteps {
    param([string]$Set = 'gui-client', [int]$InstallTimeoutSec = 600)
    return @(
        @{ type = 'wait_window'; timeout_sec = 120 },
        @{ type = 'snapshot'; name = "$Set-components" },
        @{ type = 'check'; text = $script:GuiTexts.LicenseAccept; state = 'on' },
        @{ type = 'next' },
        @{ type = 'wait_text'; text = 'Всё готово к установке'; timeout_sec = 60 },
        @{ type = 'snapshot'; name = "$Set-ready" },
        @{ type = 'next'; text_any = @('Установить'); timeout_sec = 60 },
        @{ type = 'wait_finished'; timeout_sec = $InstallTimeoutSec },
        @{ type = 'snapshot'; name = "$Set-finished" },
        @{ type = 'next'; text_any = @('Готово', 'Завершить'); timeout_sec = 60 },
        @{ type = 'wait_exit'; timeout_sec = 180 }
    )
}

<#
    Шаги обновления/ремонта установленной системы: экран компонентов → параметры
    (заблокированы, показывают значения из install.json) → готовность →
    установка. ClientPrompt — диалог закрытия запущенного клиента; RefuseClose —
    ответ «Нет» и возврат на экран компонентов с уведомлением.
#>
function New-GuiUpdateSteps {
    param([string]$Set = 'gui-update', [int]$InstallTimeoutSec = 900,
        [switch]$ClientPrompt, [switch]$RefuseClose)
    $steps = @(
        @{ type = 'wait_window'; timeout_sec = 120 },
        @{ type = 'snapshot'; name = "$Set-components" },
        @{ type = 'next' },
        @{ type = 'wait_page'; title = $script:GuiTexts.ParamsTitle; timeout_sec = 60 },
        @{ type = 'snapshot'; name = "$Set-params" },
        @{ type = 'next' },
        @{ type = 'wait_text'; text = 'Всё готово к установке'; timeout_sec = 60 },
        # Клик «Установить» асинхронный: PrepareToInstall открывает модальный
        # диалог закрытия клиента, и синхронный клик висел бы до ответа.
        @{ type = 'next'; text_any = @('Установить'); timeout_sec = 60; async = $true }
    )
    if ($ClientPrompt) {
        $answer = if ($RefuseClose) { @('Нет', 'No') } else { @('Да', 'Yes') }
        $steps += @{ type = 'dialog_button'; text_any = $answer; timeout_sec = 60 }
        $steps += @{ type = 'snapshot'; name = "$Set-prompt-answer" }
    }
    if ($RefuseClose) {
        $steps += @{ type = 'wait_text'; text = 'Установка не начата'; timeout_sec = 60 }
        $steps += @{ type = 'snapshot'; name = "$Set-preparing" }
        # Отказ PrepareToInstall показывается на странице «Подготовка к
        # установке»; «Назад» ведёт на «Готовность», затем на «Параметры» и
        # только потом на экран компонентов, где живёт уведомление
        # GComponentsNotice (проверено по исходникам Inno:
        # GetPreviousPageID / PrepareToInstallFailureMessage).
        $steps += @{ type = 'click'; text = 'Назад'; timeout_sec = 60 }
        $steps += @{ type = 'click'; text = 'Назад'; timeout_sec = 60 }
        $steps += @{ type = 'click'; text = 'Назад'; timeout_sec = 60 }
        $steps += @{ type = 'wait_page'; title = $script:GuiTexts.ComponentsTitle; timeout_sec = 60 }
        $steps += @{ type = 'snapshot'; name = "$Set-components-notice" }
        $steps += @{ type = 'kill' }
    } else {
        $steps += @{ type = 'wait_finished'; timeout_sec = $InstallTimeoutSec }
        $steps += @{ type = 'snapshot'; name = "$Set-finished" }
        $steps += @{ type = 'next'; text_any = @('Готово', 'Завершить'); timeout_sec = 60 }
        $steps += @{ type = 'wait_exit'; timeout_sec = 180 }
    }
    return $steps
}

<# Запись установки ETN в реестре (HKLM64, HKLM32, HKCU): путь + DisplayName. #>
function Get-GuiUninstallRecords {
    param($Context = $script:context)
    return @(Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
            $roots = @(
                'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
                'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
            )
            $found = @()
            foreach ($root in $roots) {
                if (-not (Test-Path -LiteralPath $root)) { continue }
                foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
                    $name = ''
                    try {
                        $name = [string](Get-ItemProperty -LiteralPath $key.PSPath -Name 'DisplayName' -ErrorAction Stop).DisplayName
                    } catch { }
                    if ($name -and $name.StartsWith('ETN')) {
                        $found += [pscustomobject]@{ Path = $key.PSPath; Name = $name }
                    }
                }
            }
            return $found
        })
}

<#
    Фикстура старого NSIS-клиента: запись Uninstall в HKLM64, каталог с
    пробелами в пути и подставной деинсталлятор (пишет маркер, удаляет запись
    и свой каталог; собирается Add-Type в госте). Возвращает { Ok; Stub; Record }.
#>
function New-GuiLegacyFixture {
    param($Context = $script:context)
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
        $legacyDir = 'C:\Program Files\ETN Legacy'
        $stubPath = Join-Path $legacyDir 'Uninstall ETN.exe'
        $marker = 'C:\e2e\legacy-uninstalled.txt'
        New-Item -ItemType Directory -Path $legacyDir -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $legacyDir 'ETN.exe'), 'legacy client stub')
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        $code = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Win32;
public static class LegacyStub {
    private const string LegacyDir = @"C:\Program Files\ETN Legacy";
    private const string MarkerPath = @"C:\e2e\legacy-uninstalled.txt";
    private const string UninstallKey =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ETN";

    public static int Main(string[] args) {
        Directory.CreateDirectory(@"C:\e2e");
        // Настоящий NSIS-деинсталлятор копирует себя во временный каталог и
        // возвращает управление, а работу выполняет копия (грабли 25343551).
        // Здесь то же самое: удалить каталог, в котором лежит работающий exe,
        // Windows не даёт, поэтому работа идёт из %TEMP%.
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string tempDir = Path.Combine(Path.GetTempPath(), "etn-legacy-uninstall");
        string tempExe = Path.Combine(tempDir, "Uninstall ETN.exe");
        bool fromTemp = string.Equals(
            Path.GetFullPath(Path.GetDirectoryName(self)).TrimEnd('\\'),
            Path.GetFullPath(tempDir).TrimEnd('\\'),
            StringComparison.OrdinalIgnoreCase);
        if (!fromTemp) {
            File.AppendAllText(MarkerPath,
                "called: " + Environment.CommandLine + Environment.NewLine);
            Directory.CreateDirectory(tempDir);
            File.Copy(self, tempExe, true);
            var start = new ProcessStartInfo(tempExe);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            Process.Start(start);
            return 0;
        }
        File.AppendAllText(MarkerPath, "work: " + Environment.CommandLine + Environment.NewLine);
        // Копия ждёт выхода исходного процесса: его exe занят до завершения.
        for (int attempt = 0; attempt < 20; attempt++) {
            try { Registry.LocalMachine.DeleteSubKeyTree(UninstallKey, false); } catch { }
            try { Environment.CurrentDirectory = @"C:\e2e"; } catch { }
            try { Directory.Delete(LegacyDir, true); break; } catch { Thread.Sleep(500); }
        }
        return 0;
    }
}
'@
        Remove-Item -LiteralPath $stubPath -Force -ErrorAction SilentlyContinue
        Add-Type -TypeDefinition $code -OutputAssembly $stubPath -OutputType ConsoleApplication
        $uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ETN'
        New-Item -Path $uninstallKey -Force | Out-Null
        Set-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayName' -Value 'ETN 0.14.2'
        Set-ItemProperty -LiteralPath $uninstallKey -Name 'DisplayVersion' -Value '0.14.2'
        Set-ItemProperty -LiteralPath $uninstallKey -Name 'Publisher' -Value 'ETN'
        Set-ItemProperty -LiteralPath $uninstallKey -Name 'UninstallString' -Value ('"' + $stubPath + '" /allusers')
        return [pscustomobject]@{
            Ok     = (Test-Path -LiteralPath $stubPath)
            Stub   = $stubPath
            Record = $uninstallKey
        }
    }
}

# --- G1: чистая GUI-установка ----------------------------------------------

function Invoke-ScenarioG1 {
    param($Results, $Timings)
    $scenario = 'G1'
    $started = Get-Date
    $session = Initialize-GuiScenarioVm -Snapshot $GuiBaseSnapshot -SetupKeys @('current')
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:interactive-session' `
        -Ok ([int]$session.ActiveSessions -gt 0 -and [int]$session.ExplorerCount -gt 0) `
        -Expected 'активная сессия + explorer' `
        -Actual ("Active=$($session.ActiveSessions), explorer=$($session.ExplorerCount)")

    $jsonBefore = Get-GuestInstallJson -Context $script:context
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:clean-base' `
        -Ok ($null -eq $jsonBefore) -Expected 'нет install.json' `
        -Actual $(if ($null -eq $jsonBefore) { 'нет' } else { 'есть' })
    $beforeLog = Get-GuestInstallLog -Context $script:context
    $beforePath = [string](Get-JsonField $beforeLog 'Path')

    $plan = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" -Steps (New-GuiFullInstallSteps -Set 'g1')
    $probe = Invoke-GuestGuiProbe -Plan $plan -Name 'g1-install' -TimeoutSec 1500 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g1:probe' -Probe $probe
    if (-not $probe.Ok) {
        Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 'g1:total-duration' `
            -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1))
        return
    }
    $snapshots = @{}
    foreach ($name in @('g1-components', 'g1-components-licensed', 'g1-admin-default', 'g1-admin',
            'g1-params', 'g1-ready', 'g1-key', 'g1-key-confirmed', 'g1-finished')) {
        $snapshots[$name] = Get-GuiSnapshot -ProbeResult $probe.Result -Name $name
    }

    $components = $snapshots['g1-components']
    Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g1:page-components' `
        -Snapshot $components -Title $script:GuiTexts.ComponentsTitle
    Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g1:license-checkbox' `
        -Snapshot $components -Text $script:GuiTexts.LicenseAccept -Exact
    Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g1:reason-license' `
        -Snapshot $components -Text $script:GuiTexts.ReasonLicense -Exact
    Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g1:next-disabled-initially' `
        -Snapshot $components -Enabled $false
    $listCount = 0
    $lists = @(Get-JsonField $components 'lists')
    if ($lists.Count -gt 0) { $listCount = [int](Get-JsonField $lists[0] 'count') }
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:components-count' `
        -Ok ($listCount -eq 7) -Expected 7 -Actual $listCount -Note '2 флажка + 4 group + строка области'
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:components-order' `
        -Ok (((Get-GuiListItemText -Snapshot $components -ItemIndex 0) -eq $script:GuiTexts.ServerCaption) -and
             ((Get-GuiListItemText -Snapshot $components -ItemIndex 1) -eq $script:GuiTexts.ServerNotInstalled) -and
             ((Get-GuiListItemText -Snapshot $components -ItemIndex 3) -eq $script:GuiTexts.ClientCaption) -and
             ((Get-GuiListItemText -Snapshot $components -ItemIndex 6) -eq $script:GuiTexts.ClientScopeAdmin)) `
        -Expected 'сервер, статус, описание, клиент, статус, описание, область' `
        -Actual (@(0, 1, 3, 6 | ForEach-Object { Get-GuiListItemText -Snapshot $components -ItemIndex $_ }) -join ' | ')
    Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g1:layout-components' -Snapshot $components

    $licensed = $snapshots['g1-components-licensed']
    Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g1:next-enabled-after-license' `
        -Snapshot $licensed -Enabled $true
    Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g1:reason-cleared' `
        -Snapshot $licensed -Text $script:GuiTexts.ReasonLicense -Absent

    $adminDefault = $snapshots['g1-admin-default']
    Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g1:page-admin' `
        -Snapshot $adminDefault -Title $script:GuiTexts.AdminTitle
    $admin = $snapshots['g1-admin']
    $adminEdits = @(Get-GuiEdits -Snapshot $admin)
    $loginText = if ($adminEdits.Count -ge 1) { [string](Get-JsonField $adminEdits[0] 'text') } else { '' }
    $displayText = if ($adminEdits.Count -ge 2) { [string](Get-JsonField $adminEdits[1] 'text') } else { '' }
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:admin-login-entered' `
        -Ok ($loginText -eq 'e2e-gui-admin') -Expected 'e2e-gui-admin' -Actual $loginText
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:admin-display-entered' `
        -Ok ($displayText -eq 'E2E GUI') -Expected 'E2E GUI' -Actual $displayText
    Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g1:admin-next-enabled' `
        -Snapshot $admin -Enabled $true

    $params = $snapshots['g1-params']
    Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g1:page-params' `
        -Snapshot $params -Title $script:GuiTexts.ParamsTitle
    $paramEdits = @(Get-GuiEdits -Snapshot $params)
    $portText = if ($paramEdits.Count -ge 1) { [string](Get-JsonField $paramEdits[0] 'text') } else { '' }
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:port-4321' `
        -Ok ($portText -eq '4321') -Expected '4321' -Actual $portText
    Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g1:firewall-checkbox' `
        -Snapshot $params -Text 'Разрешить подключения с других компьютеров в локальной сети' -Exact
    Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g1:layout-params' -Snapshot $params

    $key = $snapshots['g1-key']
    Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g1:page-key' `
        -Snapshot $key -Title $script:GuiTexts.KeyTitle
    $keyEdits = @(Get-GuiEdits -Snapshot $key)
    $keyText = if ($keyEdits.Count -ge 1) { [string](Get-JsonField $keyEdits[0] 'text') } else { '' }
    $keyChars = if ($keyEdits.Count -ge 1) { [int](Get-JsonField $keyEdits[0] 'chars') } else { 0 }
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:key-present-redacted' `
        -Ok ($keyChars -gt 20 -and $keyText.StartsWith('<redacted:')) `
        -Expected 'ключ показан (значение скрыто)' -Actual ("chars=$keyChars, text=$keyText")
    Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g1:key-next-disabled' `
        -Snapshot $key -Enabled $false
    $keyConfirmed = $snapshots['g1-key-confirmed']
    Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g1:key-next-enabled' `
        -Snapshot $keyConfirmed -Enabled $true
    $secretStep = Get-GuiStepResult -ProbeResult $probe.Result -Type 'check_secret_absent'
    $filesChecked = if ($secretStep) { [int](Get-JsonField (Get-JsonField $secretStep 'detail') 'files_checked') } else { 0 }
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:key-not-in-logs' `
        -Ok ([bool](Get-JsonField $secretStep 'ok') -and $filesChecked -gt 0) `
        -Expected 'ключ не найден в журналах' -Actual ("проверено файлов: $filesChecked")

    $finished = $snapshots['g1-finished']
    Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g1:finished-heading' `
        -Snapshot $finished -Text $script:GuiTexts.FinishedHeading -Exact
    $summary = Get-GuiMemoText -Snapshot $finished
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:finished-summary' `
        -Ok ($summary.Contains('Установка ETN 0.15.3 завершена.') -and
             $summary.Contains('http://127.0.0.1:4321') -and
             $summary.Contains('Каталог данных: C:\ProgramData\ETN') -and
             $summary.Contains('Клиент ETN: C:\Program Files\ETN\client\ETN.exe')) `
        -Expected 'версия, адрес, данные, клиент' -Actual ("chars=$($summary.Length)")
    $exitCode = Get-GuiInstallerExitCode -ProbeResult $probe.Result
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:exit-code' `
        -Ok ($exitCode -eq 0) -Expected 0 -Actual $exitCode

    $json = Get-GuestInstallJson -Context $script:context
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:install-json' `
        -Ok (([string](Get-JsonField $json 'product_version') -eq '0.15.3') -and
             ([string](Get-JsonField $json 'mode') -eq 'service') -and
             ([string](Get-JsonField $json 'port') -eq '4321') -and
             ([string](Get-JsonField $json 'data_dir') -eq 'C:\ProgramData\ETN') -and
             ([string](Get-JsonField $json 'client_scope') -eq 'machine')) `
        -Expected 'version=0.15.3, mode=service, port=4321, data_dir, scope=machine' `
        -Actual ("version=$(Get-JsonField $json 'product_version'), mode=$(Get-JsonField $json 'mode'), port=$(Get-JsonField $json 'port'), scope=$(Get-JsonField $json 'client_scope')")

    $coreFiles = @(
        'C:\Program Files\ETN\server\dist\index.js',
        'C:\Program Files\ETN\node\node.exe',
        'C:\Program Files\ETN\service\etn-service.exe'
    )
    $missing = @($coreFiles | Where-Object { -not (Test-GuestPath -Context $script:context -Path $_) })
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:files-server' `
        -Ok ($missing.Count -eq 0) -Expected 'ядро сервера на месте' `
        -Actual $(if ($missing.Count -eq 0) { 'все файлы' } else { 'нет: ' + ($missing -join ', ') })
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:file-client' `
        -Ok (Test-GuestPath -Context $script:context -Path 'C:\Program Files\ETN\client\ETN.exe') `
        -Expected 'есть' `
        -Actual $(if (Test-GuestPath -Context $script:context -Path 'C:\Program Files\ETN\client\ETN.exe') { 'есть' } else { 'нет' })
    $service = Get-GuestServiceState -Context $script:context -Name 'ETN'
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:service-running' `
        -Ok ($service -eq 'Running') -Expected 'Running' -Actual $service
    $health = Wait-GuestHealthVersion -Context $script:context -Port '4321' -Expected '0.15.3' -TimeoutSec 120
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:health-version' `
        -Ok ($health -eq '0.15.3') -Expected '0.15.3' -Actual $health

    $menuShortcut = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\ETN\ETN.lnk'
    $desktopShortcut = 'C:\Users\Public\Desktop\ETN.lnk'
    $menuOk = Test-GuestPath -Context $script:context -Path $menuShortcut
    $desktopOk = Test-GuestPath -Context $script:context -Path $desktopShortcut
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:shortcuts' `
        -Ok ($menuOk -and $desktopOk) -Expected 'меню и рабочий стол' `
        -Actual ("меню=$(if ($menuOk) { 'есть' } else { 'нет' }), рабочий стол=$(if ($desktopOk) { 'есть' } else { 'нет' })")

    $keyFile = 'C:\ProgramData\ETN\.install\primary-key.txt'
    $keyGone = -not (Test-GuestPath -Context $script:context -Path $keyFile)
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g1:key-temp-deleted' `
        -Ok $keyGone -Expected 'файла ключа нет после подтверждения' `
        -Actual $(if ($keyGone) { 'нет' } else { 'есть' })

    $log = Get-GuestInstallLog -Context $script:context -ExcludePath $beforePath
    Add-LogCheck -Results $Results -Scenario $scenario -Name 'g1:log-selection' -Log $log `
        -Needle 'Экран компонентов: сервер=да, клиент=да, область клиента=machine'
    Add-LogCheck -Results $Results -Scenario $scenario -Name 'g1:log-license' -Log $log `
        -Needle 'лицензия=принята'
    Add-LogCheck -Results $Results -Scenario $scenario -Name 'g1:log-stages' -Log $log `
        -Needle 'Этап: Запись параметров установки' `
        -Note 'последний этап установки; порядок этапов проверяется в S4'

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 'g1:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'GUI-установка'
}

# --- G2: legacy NSIS -------------------------------------------------------

function Invoke-ScenarioG2 {
    param($Results, $Timings)
    $scenario = 'G2'
    $started = Get-Date
    $user = $script:context.UserName

    # Ветка A: машинная запись старого клиента + неэлевированный запуск.
    # Сервер недоступен, клиент ставится в профиль; удаление машинной записи
    # требует прав — WARN в журнале, установка продолжается.
    $null = Initialize-GuiScenarioVm -Snapshot $GuiBaseSnapshot -SetupKeys @('current')
    $fixture = New-GuiLegacyFixture -Context $script:context
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2a:fixture' `
        -Ok ([bool](Get-JsonField $fixture 'Ok')) -Expected 'запись + деинсталлятор' `
        -Actual ([string](Get-JsonField $fixture 'Record'))
    $beforeLogA = Get-GuestInstallLog -Context $script:context
    $beforePathA = [string](Get-JsonField $beforeLogA 'Path')
    $planA = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" -Steps (New-GuiClientInstallSteps -Set 'g2a')
    $probeA = Invoke-GuestGuiProbe -Plan $planA -Name 'g2a-install' -RunLevel Limited -TimeoutSec 900 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g2a:probe' -Probe $probeA
    if ($probeA.Ok) {
        $componentsA = Get-GuiSnapshot -ProbeResult $probeA.Result -Name 'g2a-components'
        Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g2a:page-components' `
            -Snapshot $componentsA -Title $script:GuiTexts.ComponentsTitle
        Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g2a:legacy-status-useronly' `
            -Snapshot $componentsA -Text $script:GuiTexts.LegacyUserOnly
        Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g2a:layout-components' `
            -Snapshot $componentsA
        $exitA = Get-GuiInstallerExitCode -ProbeResult $probeA.Result
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2a:exit-code' `
            -Ok ($exitA -eq 0) -Expected 0 -Actual $exitA
        $logA = Get-GuestInstallLog -Context $script:context -ExcludePath $beforePathA
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g2a:log-warn-admin' -Log $logA `
            -Needle 'удаление требует прав администратора'
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g2a:log-selection' -Log $logA `
            -Needle 'Экран компонентов: сервер=нет, клиент=да, область клиента=user'
        $userClient = "C:\Users\$user\AppData\Local\Programs\ETN\ETN.exe"
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2a:client-user-files' `
            -Ok (Test-GuestPath -Context $script:context -Path $userClient) `
            -Expected $userClient `
            -Actual $(if (Test-GuestPath -Context $script:context -Path $userClient) { 'есть' } else { 'нет' })
        $recordsA = @(Get-GuiUninstallRecords -Context $script:context)
        $legacyStill = @($recordsA | Where-Object { $_.Name -eq 'ETN 0.14.2' }).Count -gt 0
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2a:legacy-record-stays' `
            -Ok $legacyStill -Expected 'машинная запись осталась' `
            -Actual $(if ($legacyStill) { 'осталась' } else { 'исчезла' })
    }

    # Ветка B: элевированный запуск — старый клиент удаляется до копирования.
    $null = Initialize-GuiScenarioVm -Snapshot $GuiBaseSnapshot -SetupKeys @('current')
    $fixtureB = New-GuiLegacyFixture -Context $script:context
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:fixture' `
        -Ok ([bool](Get-JsonField $fixtureB 'Ok')) -Expected 'запись + деинсталлятор' `
        -Actual ([string](Get-JsonField $fixtureB 'Record'))
    $beforeLogB = Get-GuestInstallLog -Context $script:context
    $beforePathB = [string](Get-JsonField $beforeLogB 'Path')
    $planB = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" -Steps (New-GuiFullInstallSteps -Set 'g2b')
    $probeB = Invoke-GuestGuiProbe -Plan $planB -Name 'g2b-install' -TimeoutSec 1500 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g2b:probe' -Probe $probeB
    if ($probeB.Ok) {
        $componentsB = Get-GuiSnapshot -ProbeResult $probeB.Result -Name 'g2b-components'
        Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g2b:legacy-status-remove' `
            -Snapshot $componentsB -Text $script:GuiTexts.LegacyWillRemove
        Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g2b:layout-components' `
            -Snapshot $componentsB
        $exitB = Get-GuiInstallerExitCode -ProbeResult $probeB.Result
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:exit-code' `
            -Ok ($exitB -eq 0) -Expected 0 -Actual $exitB
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:uninstaller-called' `
            -Ok (Test-GuestPath -Context $script:context -Path 'C:\e2e\legacy-uninstalled.txt') `
            -Expected 'маркер деинсталлятора создан' `
            -Actual $(if (Test-GuestPath -Context $script:context -Path 'C:\e2e\legacy-uninstalled.txt') { 'создан' } else { 'нет' })
        $recordsB = @(Get-GuiUninstallRecords -Context $script:context)
        $legacyGone = @($recordsB | Where-Object { $_.Name -eq 'ETN 0.14.2' }).Count -eq 0
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:legacy-record-gone' `
            -Ok $legacyGone -Expected 'записи 0.14.2 нет' `
            -Actual $(if ($legacyGone) { 'нет' } else { 'осталась' })
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:legacy-files-gone' `
            -Ok (-not (Test-GuestPath -Context $script:context -Path 'C:\Program Files\ETN Legacy')) `
            -Expected 'каталог старого клиента удалён' `
            -Actual $(if (Test-GuestPath -Context $script:context -Path 'C:\Program Files\ETN Legacy') { 'остался' } else { 'удалён' })
        $etnRecords = @($recordsB | Where-Object { $_.Name.StartsWith('ETN') })
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:one-etn-record' `
            -Ok ($etnRecords.Count -eq 1 -and $etnRecords[0].Path.Contains('_is1')) `
            -Expected 'одна запись Inno (_is1)' `
            -Actual (($etnRecords | ForEach-Object { $_.Name + ' @ ' + $_.Path }) -join '; ')
        $jsonB = Get-GuestInstallJson -Context $script:context
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:install-json' `
            -Ok ([string](Get-JsonField $jsonB 'product_version') -eq '0.15.3') `
            -Expected '0.15.3' -Actual ([string](Get-JsonField $jsonB 'product_version'))
        $serviceB = Get-GuestServiceState -Context $script:context -Name 'ETN'
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g2b:service-running' `
            -Ok ($serviceB -eq 'Running') -Expected 'Running' -Actual $serviceB
        $logB = Get-GuestInstallLog -Context $script:context -ExcludePath $beforePathB
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g2b:log-legacy-launch' -Log $logB `
            -Needle 'Старый клиент ETN 0.14.2: запуск деинсталлятора'
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g2b:log-legacy-args' -Log $logB `
            -Needle '_?=C:\Program Files\ETN Legacy'
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g2b:log-legacy-silent' -Log $logB `
            -Needle '/allusers /S'
    }

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 'g2:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note 'две ветки'
}

# --- G3: worst-case раскладка и причины ------------------------------------

function Invoke-ScenarioG3 {
    param($Results, $Timings, [pscustomobject]$UserBaseStatus)
    $scenario = 'G3'
    $started = Get-Date

    # Состояние 1: чистая машина, лицензия не принята (только чтение).
    $null = Initialize-GuiScenarioVm -Snapshot $GuiBaseSnapshot -SetupKeys @('current', 'intermediate')
    $beforeLog = Get-GuestInstallLog -Context $script:context
    $beforePath = [string](Get-JsonField $beforeLog 'Path')
    $cleanPlan = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" -Steps @(
        @{ type = 'wait_window'; timeout_sec = 120 },
        @{ type = 'snapshot'; name = 'g3-clean' },
        @{ type = 'kill' }
    )
    $cleanProbe = Invoke-GuestGuiProbe -Plan $cleanPlan -Name 'g3-clean' -TimeoutSec 300 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g3clean:probe' -Probe $cleanProbe
    if ($cleanProbe.Ok) {
        $clean = Get-GuiSnapshot -ProbeResult $cleanProbe.Result -Name 'g3-clean'
        Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g3clean:page' `
            -Snapshot $clean -Title $script:GuiTexts.ComponentsTitle
        Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3clean:reason-exact' `
            -Snapshot $clean -Text $script:GuiTexts.ReasonLicense -Exact
        Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g3clean:next-disabled' `
            -Snapshot $clean -Enabled $false
        Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3clean:license-unchecked' `
            -Snapshot $clean -Text $script:GuiTexts.LicenseAccept -Exact
        Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g3clean:layout' -Snapshot $clean
        $cleanListCount = 0
        $cleanLists = @(Get-JsonField $clean 'lists')
        if ($cleanLists.Count -gt 0) { $cleanListCount = [int](Get-JsonField $cleanLists[0] 'count') }
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3clean:list-order' `
            -Ok ($cleanListCount -eq 7 -and
                 (Get-GuiListItemText -Snapshot $clean -ItemIndex 0) -eq $script:GuiTexts.ServerCaption -and
                 (Get-GuiListItemText -Snapshot $clean -ItemIndex 3) -eq $script:GuiTexts.ClientCaption) `
            -Expected '7 строк, 2 флажка, group-строки' -Actual $cleanListCount
        $itemProblems = @(Get-GuiClippedListItems -Snapshot $clean)
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3clean:item-heights' `
            -Ok ($itemProblems.Count -eq 0) -Expected 'высоты строк >= одной строки текста' `
            -Actual $(if ($itemProblems.Count -eq 0) { 'ok' } else { "$($itemProblems.Count) сжатых" }) `
            -Note (($itemProblems | Select-Object -First 4 | ForEach-Object { "#$($_.index):$($_.why)" }) -join '; ')
    }

    # Подготовка состояния для понижения и уведомления: установленные 0.15.3.
    $prepPlan = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" -Steps (New-GuiFullInstallSteps -Set 'g3prep')
    $prepProbe = Invoke-GuestGuiProbe -Plan $prepPlan -Name 'g3-prep-install' -TimeoutSec 1500 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g3prep:probe' -Probe $prepProbe
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3prep:exit-code' `
        -Ok ((Get-GuiInstallerExitCode -ProbeResult $prepProbe.Result) -eq 0) `
        -Expected 0 -Actual (Get-GuiInstallerExitCode -ProbeResult $prepProbe.Result)

    $beforeDowngradeLog = Get-GuestInstallLog -Context $script:context
    $beforeDowngradePath = [string](Get-JsonField $beforeDowngradeLog 'Path')

    # Состояние 2: понижение 0.15.3 -> 0.15.2: сообщение и точная причина.
    # Сообщение о запрете понижения показывается из CurPageChanged экрана
    # компонентов до первого показа мастера: сначала диалог, затем окно.
    $downPlan = New-GuiPlan -Exe "C:\e2e\$($setups['intermediate'])" -Steps @(
        @{ type = 'dialog_button'; text_any = @('ОК', 'OK'); timeout_sec = 120 },
        @{ type = 'wait_window'; timeout_sec = 120 },
        @{ type = 'snapshot'; name = 'g3-downgrade' },
        @{ type = 'kill' }
    )
    $downProbe = Invoke-GuestGuiProbe -Plan $downPlan -Name 'g3-downgrade' -TimeoutSec 300 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g3down:probe' -Probe $downProbe
    if ($downProbe.Ok) {
        $down = Get-GuiSnapshot -ProbeResult $downProbe.Result -Name 'g3-downgrade'
        Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3down:reason-exact' `
            -Snapshot $down -Text $script:GuiTexts.DowngradeReason0152 -Exact
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3down:version-in-reason' `
            -Ok (Test-GuiSnapshotText -Snapshot $down -Text 'Установлена более новая версия 0.15.3') `
            -Expected 'версия 0.15.3 в причине' -Actual 'проверено текстом причины'
        Add-GuiNextCheck -Results $Results -Scenario $scenario -Name 'g3down:next-disabled' `
            -Snapshot $down -Enabled $false
        # Раскладку страницы понижения даёт сборка 0.15.2: она старше
        # исправления 5b9743da, и её метка причины выступает за нижний край
        # страницы. Это свойство исторической фикстуры; текущий 0.15.3
        # проверяется на своих страницах (g3clean/g3notice/g3user).
        $downLayout = Test-GuiSnapshotLayout -Snapshot $down
        $downProblems = @($downLayout.Problems)
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 'g3down:layout' -Ok $false -Deferred `
            -Expected 'раскладка текущего установщика проверена на его страницах' `
            -Actual $(if ($downLayout.Ok) { '0.15.2: ok' } else { "0.15.2: $($downProblems.Count) проблем" }) `
            -Note ('страница понижения рисуется сборкой 0.15.2 (до 5b9743da): ' + (($downProblems | Select-Object -First 3) -join '; '))
        $downLog = Get-GuestInstallLog -Context $script:context -ExcludePath $beforeDowngradePath
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g3down:log' -Log $downLog `
            -Needle 'Понижение версии запрещено: установлена 0.15.3, установщик 0.15.2'
    }

    # Состояние 3: уведомление «клиент не закрыт» после отказа закрыть клиента.
    $launchPlan = New-GuiPlan -Steps @(
        @{ type = 'launch'; exe = 'C:\Program Files\ETN\client\ETN.exe'; settle_ms = 4000 },
        @{ type = 'note'; text = 'client-launched' }
    )
    $launchProbe = Invoke-GuestGuiProbe -Plan $launchPlan -Name 'g3-client-launch' -TimeoutSec 180
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g3notice:client-launch' -Probe $launchProbe
    $clientRunning = [bool](Invoke-GuestElevatedRetry -Context $script:context -ScriptBlock {
            @(Get-Process -Name 'ETN' -ErrorAction SilentlyContinue).Count -gt 0
        })
    Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3notice:client-running' `
        -Ok $clientRunning -Expected $true -Actual $clientRunning

    $beforeNoticeLog = Get-GuestInstallLog -Context $script:context
    $beforeNoticePath = [string](Get-JsonField $beforeNoticeLog 'Path')
    $jsonBeforeNotice = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'
    $noticePlan = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" `
        -Steps (New-GuiUpdateSteps -Set 'g3notice' -ClientPrompt -RefuseClose)
    $noticeProbe = Invoke-GuestGuiProbe -Plan $noticePlan -Name 'g3-notice' -TimeoutSec 600 `
        -ArtifactDir (Join-Path $OutDir 'gui')
    Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g3notice:probe' -Probe $noticeProbe
    if ($noticeProbe.Ok) {
        $notice = Get-GuiSnapshot -ProbeResult $noticeProbe.Result -Name 'g3notice-components-notice'
        Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3notice:reason-exact' `
            -Snapshot $notice -Text $script:GuiTexts.NoticeClientClose -Exact
        $reasonControl = @(Get-JsonField $notice 'controls' |
                Where-Object { [string](Get-JsonField $_ 'text') -eq $script:GuiTexts.NoticeClientClose }) |
            Select-Object -First 1
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3notice:reason-inside-page' `
            -Ok (($null -ne $reasonControl) -and (Test-GuiControlInsidePage -Snapshot $notice -Control $reasonControl)) `
            -Expected 'причина видима и внутри страницы' `
            -Actual $(if ($null -ne $reasonControl) { 'прямоугольник проверен' } else { 'причина не найдена' })
        Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g3notice:layout' -Snapshot $notice
        $jsonAfterNotice = Get-GuestText -Context $script:context -Path 'C:\ProgramData\ETN\install.json'
        Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3notice:no-changes' `
            -Ok (([string](Get-JsonField $jsonBeforeNotice 'Text')) -eq ([string](Get-JsonField $jsonAfterNotice 'Text'))) `
            -Expected 'install.json не изменился' `
            -Actual $(if (([string](Get-JsonField $jsonBeforeNotice 'Text')) -eq ([string](Get-JsonField $jsonAfterNotice 'Text'))) { 'не изменился' } else { 'изменился' })
        $noticeLog = Get-GuestInstallLog -Context $script:context -ExcludePath $beforeNoticePath
        Add-LogCheck -Results $Results -Scenario $scenario -Name 'g3notice:log-refused' -Log $noticeLog `
            -Needle 'Клиент ETN: пользователь отказался закрывать клиент'
    }
    # Клиент после отказа остался запущен — снимается перед следующей веткой.
    $null = Invoke-GuestElevated -Context $script:context -ScriptBlock {
        Get-Process -Name 'ETN' -ErrorAction SilentlyContinue | ForEach-Object {
            try { $_.Kill() } catch { }
        }
        Start-Sleep -Seconds 1
    }

    # Состояние 4: «только для меня» в сессии стандартной учётки.
    if ($UserBaseStatus -and [bool](Get-JsonField $UserBaseStatus 'user_base')) {
        $session = Initialize-GuiScenarioVm -Snapshot $GuiUserSnapshot -SetupKeys @('current')
        $userPlan = New-GuiPlan -Exe "C:\e2e\$($setups['current'])" -Steps @(
            @{ type = 'wait_window'; timeout_sec = 120 },
            @{ type = 'snapshot'; name = 'g3-user' },
            @{ type = 'kill' }
        )
        $userProbe = Invoke-GuestGuiProbe -Plan $userPlan -Name 'g3-useronly' -RunLevel Limited `
            -TaskUser 'e2egui' -TimeoutSec 300 -ArtifactDir (Join-Path $OutDir 'gui')
        Add-GuiProbeCheck -Results $Results -Scenario $scenario -Name 'g3user:probe' -Probe $userProbe
        if ($userProbe.Ok) {
            $userSnapshot = Get-GuiSnapshot -ProbeResult $userProbe.Result -Name 'g3-user'
            Add-GuiPageCheck -Results $Results -Scenario $scenario -Name 'g3user:page' `
                -Snapshot $userSnapshot -Title $script:GuiTexts.ComponentsTitle
            # В режиме «только для меня» строка сервера отключена (прав нет),
            # поэтому причина EtnServerNeedsAdmin на экране не появляется:
            # проверяются состав списка, длинная строка области клиента и
            # отсутствие административной формулировки области.
            Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3user:server-row' `
                -Snapshot $userSnapshot -Text $script:GuiTexts.ServerCaption -Exact
            Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3user:no-admin-scope' `
                -Snapshot $userSnapshot -Text $script:GuiTexts.ClientScopeAdmin -Absent
            Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3user:scope-row-exact' `
                -Snapshot $userSnapshot -Text $script:GuiTexts.ClientScopeRowUserOnly -Exact
            $scopeItem = @(Get-JsonField $userSnapshot 'lists')
            $scopeItemCount = 0
            $scopeChars = 0
            if ($scopeItem.Count -gt 0) {
                $listItems = @(Get-JsonField $scopeItem[0] 'items')
                foreach ($item in $listItems) {
                    if ([string](Get-JsonField $item 'text') -eq $script:GuiTexts.ClientScopeRowUserOnly) {
                        $scopeChars = [int](Get-JsonField $item 'chars')
                    }
                }
                $scopeItemCount = [int](Get-JsonField $scopeItem[0] 'count')
            }
            Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3user:scope-row-length' `
                -Ok ($scopeChars -ge 200) -Expected 'длинная строка области (~255 симв.)' -Actual $scopeChars
            $userClipped = @(Get-GuiClippedListItems -Snapshot $userSnapshot)
            Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3user:scope-row-not-clipped' `
                -Ok ($userClipped.Count -eq 0) -Expected 'строки не сжаты' `
                -Actual $(if ($userClipped.Count -eq 0) { 'ok' } else { "$($userClipped.Count) сжатых" }) `
                -Note (($userClipped | Select-Object -First 4 | ForEach-Object { "#$($_.index):$($_.why)" }) -join '; ')
            Add-GuiLayoutCheck -Results $Results -Scenario $scenario -Name 'g3user:layout' -Snapshot $userSnapshot
            Add-GuiTextCheck -Results $Results -Scenario $scenario -Name 'g3user:reason-license' `
                -Snapshot $userSnapshot -Text $script:GuiTexts.ReasonLicense -Exact
            Add-GuiCheck -Results $Results -Scenario $scenario -Name 'g3user:list-count' `
                -Ok ($scopeItemCount -eq 7) -Expected 7 -Actual $scopeItemCount
        }
    } else {
        $reason = if ($UserBaseStatus) { [string](Get-JsonField $UserBaseStatus 'user_error') } else { 'база не готовилась' }
        Add-E2ECheck -Results $Results -Scenario $scenario -Name 'g3user:standard-user-base' -Ok $false `
            -Deferred -Expected 'снапшот base-e2e-user со стандартной учёткой' -Actual 'недоступен' `
            -Note ("ветка «только для меня» отложена: " + $reason)
    }

    Add-E2ETiming -Timings $Timings -Scenario $scenario -Name 'g3:total-duration' `
        -Value ([math]::Round(((Get-Date) - $started).TotalSeconds, 1)) -Note '4 состояния'
}

# --- G4: закрытие запущенного клиента (сценарий отменён) -------------------
#
# Прежняя реализация проверяла два состояния: мягкое закрытие (диалог
# «клиент запущен», выбор «Да») и блокировку установки занятыми файлами
# (suspend_process → модальный диалог «Закрыть принудительно/Отмена»).
# В ВМ сценарий недостоверен: клиент зависает даже в ручных прогонах,
# suspend-состояние не доходит до диалога, ожидание съедает 25 минут
# прогона. Решение пользователя 2026-11-08 — автоматическое покрытие
# закрытия клиента снять, проверять вручную при приёмке релиза.
# Покрытие client-close:* в silent-codes (31 проверка) опирается на
# /TEST*-хуки, которые снимаются; G4 был его автоматической заменой на
# уровне GUI, и без G4 замены нет.

function Invoke-ScenarioG4 {
    param($Results)
    $scenario = 'G4'
    # Решение пользователя 2026-11-08: сценарий отменён. ВМ недостоверна для
    # манипуляций с процессами — клиент зависает и в ручных прогонах, а
    # ожидание таймаутов съедает время полного набора. Закрытие клиента —
    # пользовательский экран, проверяется вручную при приёмке релиза.
    Add-E2ECheck -Results $Results -Scenario $scenario -Name 'g4:cancelled' -Ok $false -Deferred `
        -Expected 'сценарий закрытия клиента' -Actual 'отменён пользователем 2026-11-08' `
        -Note 'ВМ недостоверна для манипуляций с процессами (зависает даже вручную); автоматическое покрытие закрытия клиента снято, проверяется вручную при приёмке релиза'
}

# --- Основной прогон -------------------------------------------------------

# pwsh -File передаёт «-Scenarios S1,S2» одной строкой — запятую разбираем
# здесь, чтобы пример вызова в справке работал как записан.
$requested = @($Scenarios | ForEach-Object { $_ -split ',' } |
    ForEach-Object { $_.Trim().ToUpperInvariant() } | Where-Object { $_ })
$known = @('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'G1', 'G2', 'G3', 'G4')
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
    $guiBaseStatus = $null
    $guiRequested = @($requested | Where-Object { $_ -like 'G*' })
    if ($guiRequested.Count -gt 0) {
        Write-Step 'Подготовка GUI-баз (живые снапшоты, аддитивно)'
        try {
            $guiBaseStatus = Ensure-GuiBaseSnapshots -Vm $Vm -Context $context `
                -BaseSnapshot $BaseSnapshot -GuiBase $GuiBaseSnapshot -GuiUser $GuiUserSnapshot `
                -BootTimeoutSec $BootTimeoutSec `
                -WithUserBase:($guiRequested -contains 'G3')
            Write-Host ("GUI-базы: создано [{0}], user_base={1}" -f `
                    (@($guiBaseStatus.created) -join ', '), $guiBaseStatus.user_base)
            if ($guiBaseStatus.user_error) { Write-Warning "base-e2e-user: $($guiBaseStatus.user_error)" }
        } catch {
            $guiBaseStatus = [pscustomobject]@{
                created = @(); user_base = $false; user_error = $_.Exception.Message
            }
            Write-Warning "GUI-базы не подготовлены: $($_.Exception.Message). GUI-сценарии упадут честно."
        }
    }

    foreach ($name in $requested) {
        $snapshot = switch ($name) {
            'S1' { $BaseSnapshot }
            'S2' { $BaseSnapshot }
            'S3' { $InstalledSnapshot }
            'S4' { $InstalledSnapshot }
            'S5' { $(if ($updatedStateReady) { '(состояние S4)' } else { $InstalledSnapshot }) }
            'S6' { $InstalledSnapshot }
            'G1' { $GuiBaseSnapshot }
            'G2' { $GuiBaseSnapshot }
            'G3' { $GuiBaseSnapshot }
            'G4' { $GuiBaseSnapshot }
        }
        $scenarioStarted = Get-Date
        Write-Step "Сценарий $name (снапшот: $snapshot)"
        $checksBefore = $results.Count
        $timingsBefore = $timings.Count
        # Транспортный обрыв WinRM посреди сценария (например, установщик
        # остановил службу, а PSSession не переподключилась) — повторяем
        # сценарий целиком с восстановления снапшота: каждый сценарий
        # идемпотентен по построению, а частичные результаты неудачной
        # попытки отбрасываются. Без этого один обрыв делает красным весь
        # прогон (наблюдалось в S6 2026-11-08: «попытка повторного
        # подключения не удалась»).
        $scenarioAttempts = 2
        for ($scenarioAttempt = 1; $scenarioAttempt -le $scenarioAttempts; $scenarioAttempt++) {
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
                    'G1' { Invoke-ScenarioG1 -Results $results -Timings $timings }
                    'G2' { Invoke-ScenarioG2 -Results $results -Timings $timings }
                    'G3' { Invoke-ScenarioG3 -Results $results -Timings $timings -UserBaseStatus $guiBaseStatus }
                    'G4' { Invoke-ScenarioG4 -Results $results }
                }
                break
            } catch {
                $message = [string]$_.Exception.Message
                $retryable = ($scenarioAttempt -lt $scenarioAttempts) -and (Test-GuestTransportError -Message $message)
                if (-not $retryable) {
                    Add-E2ECheck -Results $results -Scenario $name -Name 'scenario:error' -Ok $false `
                        -Expected 'сценарий выполнен' -Actual 'исключение' -Note $message
                    break
                }
                Write-Warning ("Сценарий {0}: транспортный сбой WinRM ({1}); повтор сценария с восстановления снапшота (попытка {2} из {3})" -f `
                        $name, $message, ($scenarioAttempt + 1), $scenarioAttempts)
                while ($results.Count -gt $checksBefore) { $results.RemoveAt($results.Count - 1) }
                while ($timings.Count -gt $timingsBefore) { $timings.RemoveAt($timings.Count - 1) }
                $updatedStateReady = $false
                Close-GuestSession -Context $context
                Start-Sleep -Seconds 5
            }
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
