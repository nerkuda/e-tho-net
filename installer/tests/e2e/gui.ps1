<#
.SYNOPSIS
    GUI-инфраструктура E2E-тестов установщика ETN: интерактивная сессия гостя.

.DESCRIPTION
    Установщик GUI требует интерактивной сессии: `VBoxManage guestcontrol run`
    даёт фильтрованный токен и сессию без рабочего стола, поэтому окна мастера
    в ней не появляются. Здесь — единственный рабочий путь:

      1. AutoLogon учётки администратора в гостя (реестр Winlogon) и политики,
         запрещающие блокировку экрана и сон (стенд одноразовый, пароль живёт
         только в реестре гостя и в etn-vms.env);
      2. перезагрузка гостя и ожидание WinRM + интерактивной сессии;
      3. аддитивный «живой» снапшот base-e2e-gui (resume возвращает и WinRM,
         и открытую сессию пользователя);
      4. запуск установщика и пробы В ИНТЕРАКТИВНОЙ СЕССИИ через
         запланированную задачу (LogonType Interactive, RunLevel Highest или
         Limited): только там у установщика есть рабочий стол и живые окна.

    Проба — probe.ps1 (гостевая сторона): запускает установщик, выполняет шаги
    плана (ожидание окна/страницы, клики через UIA/Win32, ввод текста, ответ в
    диалоге) и снимает JSON состояния страницы (заголовки, тексты,
    прямоугольники, «Далее», чекбоксы, элементы TNewCheckListBox, измеренные
    высоты текста). Секреты в результат не попадают: текст полей длиннее
    16 символов заменяется на <redacted:N>.

    Пароль гостя в файлы и журналы не пишется. Запланированная задача
    регистрируется с Interactive-принципалом — пароль ей не нужен.

    Задача 8789381a (0.15.3), этап 4.
#>

$script:GuiProbeGuestPath = 'C:\e2e\gui\probe.ps1'
$script:GuiProbeCounter = 0

# run.ps1 dot-sources этот файл до объявления собственного Get-JsonField;
# определение-дубль безопасно (тело совпадает) и делает gui.ps1 пригодным
# отдельно от run.ps1.
if (-not (Get-Command Get-JsonField -ErrorAction SilentlyContinue)) {
    function Get-JsonField {
        param($Object, [string]$Name)
        if ($null -eq $Object) { return $null }
        $property = $Object.PSObject.Properties[$Name]
        if ($null -eq $property) { return $null }
        return $property.Value
    }
}

<#
    Настройка AutoLogon и политик стенда. Возвращает { Ok; User; Computer }.
    Пароль передаётся в скриптблок параметром и в результат не возвращается.
#>
function Set-GuestAutoLogon {
    [CmdletBinding()]
    param(
        $Context = (Get-GuestContext),
        [string]$UserName = '',
        [string]$Password = ''
    )
    if (-not $UserName) { $UserName = $Context.UserName }
    $plain = if ($Password) { $Password } else { $Context.Credential.GetNetworkCredential().Password }
    try {
        return Invoke-GuestElevated -Context $Context -ScriptBlock {
            param($UserName, $Password)
            $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
            if (-not (Test-Path -LiteralPath $winlogon)) { throw "Нет ключа $winlogon" }
            Set-ItemProperty -LiteralPath $winlogon -Name 'AutoAdminLogon' -Value '1' -Type String
            Set-ItemProperty -LiteralPath $winlogon -Name 'DefaultUserName' -Value $UserName -Type String
            Set-ItemProperty -LiteralPath $winlogon -Name 'DefaultPassword' -Value $Password -Type String
            Set-ItemProperty -LiteralPath $winlogon -Name 'DefaultDomainName' -Value $env:COMPUTERNAME -Type String
            Set-ItemProperty -LiteralPath $winlogon -Name 'ForceAutoLogon' -Value '1' -Type String
            Remove-ItemProperty -LiteralPath $winlogon -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
            # Замок и сон на стенде не нужны: заблокированный рабочий стол делает
            # GUI-пробу невидимой (окна живут на другом desktop).
            $personalization = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization'
            if (-not (Test-Path -LiteralPath $personalization)) {
                New-Item -Path $personalization -Force | Out-Null
            }
            Set-ItemProperty -LiteralPath $personalization -Name 'NoLockScreen' -Value 1 -Type DWord
            $systemPolicy = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
            Set-ItemProperty -LiteralPath $systemPolicy -Name 'InactivityTimeoutSecs' -Value 0 -Type DWord
            $null = & powercfg.exe /change monitor-timeout-ac 0 2>&1
            $null = & powercfg.exe /change standby-timeout-ac 0 2>&1
            $null = & powercfg.exe /change hibernate-timeout-ac 0 2>&1
            return [pscustomobject]@{
                Ok       = $true
                User     = $UserName
                Computer = $env:COMPUTERNAME
            }
        } -ArgumentList @($UserName, $plain)
    } finally {
        $plain = $null
    }
}

<#
    Создать (или обновить) стандартную локальную учётку для ветки «только для
    меня»: обычный пользователь, не администратор, с правом записи в каталог
    GUI-обмена. Пароль генерируется на прогон, живёт только в памяти
    оркестратора и в реестре гостя (AutoLogon) — в отчёт не попадает.
#>
function New-GuiStandardUser {
    [CmdletBinding()]
    param($Context = (Get-GuestContext), [string]$User = 'e2egui')
    $password = ([guid]::NewGuid().ToString('N').Substring(0, 16) + '!aA1')
    $result = Invoke-GuestElevated -Context $Context -ScriptBlock {
        param($UserName, $Password)
        $secure = ConvertTo-SecureString $Password -AsPlainText -Force
        $existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
        if ($null -eq $existing) {
            # Комментарий локальной учётки в SAM ограничен 48 символами:
            # длиннее — New-LocalUser отвергает аргумент (ParameterValidation).
            New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires `
                -Description 'E2E GUI: обычная учётка (не администратор)' | Out-Null
        } else {
            Set-LocalUser -Name $UserName -Password $secure
        }
        $adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
        Remove-LocalGroupMember -Group $adminGroup -Member $UserName -ErrorAction SilentlyContinue
        $usersGroup = Get-LocalGroup -SID 'S-1-5-32-545'
        Add-LocalGroupMember -Group $usersGroup -Member $UserName -ErrorAction SilentlyContinue
        $guiDir = 'C:\e2e\gui'
        if (Test-Path -LiteralPath $guiDir) {
            $null = & icacls.exe $guiDir /grant ($UserName + ':(OI)(CI)M') 2>&1
        }
        $isAdmin = $false
        try {
            $isAdmin = (Get-LocalGroupMember -Group $adminGroup -Member $UserName -ErrorAction Stop |
                Measure-Object).Count -gt 0
        } catch { $isAdmin = $false }
        return [pscustomobject]@{
            Ok       = (-not $isAdmin)
            User     = $UserName
            Password = $Password
            IsAdmin  = $isAdmin
        }
    } -ArgumentList @($User, $password)
    return $result
}

<#
    Сведения об интерактивной сессии гостя: сессии `query user`, процессы
    explorer и их SessionId. WinRM работает в сессии 0 — она не интерактивна.
#>
function Get-GuestInteractiveSession {
    [CmdletBinding()]
    param($Context = (Get-GuestContext))
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
        $query = ''
        try { $query = ((& query.exe user 2>&1) | Out-String).Trim() } catch { $query = '' }
        $explorers = @(Get-Process -Name explorer -ErrorAction SilentlyContinue |
            Sort-Object SessionId)
        $activeLines = @($query -split "`r?`n" | Where-Object { $_ -match '\sActive\s' })
        return [pscustomobject]@{
            QueryUser         = $query
            ActiveSessions    = $activeLines.Count
            ExplorerCount     = $explorers.Count
            ExplorerSessionIds = @($explorers | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
            CurrentSessionId  = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
            User              = $env:USERNAME
        }
    }
}

<# Дождаться активной интерактивной сессии (query user: Active + explorer). #>
function Wait-GuestInteractiveSession {
    [CmdletBinding()]
    param($Context = (Get-GuestContext), [int]$TimeoutSec = 300)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $last = Get-GuestInteractiveSession -Context $Context
        } catch {
            # Сессия WinRM могла оборваться перезагрузкой — переоткрыть.
            Close-GuestSession -Context $Context
            Start-Sleep -Seconds 5
            continue
        }
        if ([int]$last.ActiveSessions -gt 0 -and [int]$last.ExplorerCount -gt 0) { return $last }
        Start-Sleep -Seconds 5
    }
    return $last
}

<# Время последней загрузки гостя (UTC) — признак состоявшейся перезагрузки. #>
function Get-GuestBootTime {
    [CmdletBinding()]
    param($Context = (Get-GuestContext))
    $value = Invoke-GuestElevated -Context $Context -ScriptBlock {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        return [string]$os.LastBootUpTime.ToUniversalTime().ToString('o')
    }
    return [datetime]::Parse([string]$value, [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind)
}

<#
    Перезагрузить гостя и дождаться WinRM и интерактивной сессии.
    Готовность WinRM сама по себе не доказывает перезагрузку: NAT-проброс
    порта может отвечать ещё до фактического ухода машины в рестарт, и тогда
    «готовность» наступает до reboot, а следующая команда падает на оборванной
    сессии (наблюдалось 2026-11-07). Поэтому ждём смену LastBootUpTime.
#>
function Restart-GuestForGui {
    [CmdletBinding()]
    param($Context = (Get-GuestContext), [int]$TimeoutSec = 420)
    $bootBefore = $null
    try { $bootBefore = Get-GuestBootTime -Context $Context } catch { $bootBefore = $null }
    try {
        $null = Invoke-GuestElevatedCommand -Context $Context -Command 'shutdown /r /t 0 /f'
    } catch {
        # Машина может перезагрузиться раньше ответа: это ожидаемо.
    }
    Close-GuestSession -Context $Context
    Start-Sleep -Seconds 10
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Wait-GuestReady -Context $Context -TimeoutSec 30
            if ($null -ne $bootBefore) {
                $bootNow = Get-GuestBootTime -Context $Context
                if ($bootNow -le $bootBefore) {
                    # WinRM ответил, но перезагрузки ещё не было: shutdown
                    # задержался. Ждём дальше, не объявляя готовность.
                    Start-Sleep -Seconds 5
                    continue
                }
            }
            $ready = $true
            break
        } catch {
            Close-GuestSession -Context $Context
            Start-Sleep -Seconds 5
        }
    }
    if (-not $ready) { throw "Гость не вернулся после перезагрузки за $TimeoutSec с." }
    $session = Wait-GuestInteractiveSession -Context $Context -TimeoutSec $TimeoutSec
    if ([int]$session.ActiveSessions -le 0 -or [int]$session.ExplorerCount -le 0) {
        throw ('Интерактивной сессии нет после перезагрузки: ' + ($session.QueryUser -replace "`r?`n", ' | '))
    }
    return $session
}

<#
    Подготовить базу GUI-прогонов: AutoLogon, перезагрузка, проверка сессии,
    аддитивный живой снапшот (по умолчанию base-e2e-gui2). Исходный снапшот
    стенда не меняется: снапшот создаётся от текущего состояния аддитивно.
#>
function Initialize-GuestGuiBase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)]$Context,
        [string]$SnapshotName = 'base-e2e-gui2',
        [string]$AutoLogonUserName = '',
        [string]$AutoLogonPassword = '',
        [string]$TaskUser = '',
        [switch]$SkipSnapshot
    )
    $autoLogon = Set-GuestAutoLogon -Context $Context -UserName $AutoLogonUserName -Password $AutoLogonPassword
    if (-not [bool](Get-JsonField $autoLogon 'Ok')) {
        throw 'AutoLogon не настроен: GUI-сценарии невозможны.'
    }
    if (-not $TaskUser) { $TaskUser = [string](Get-JsonField $autoLogon 'User') }
    Write-Host ("AutoLogon: {0}\{1}" -f (Get-JsonField $autoLogon 'Computer'), (Get-JsonField $autoLogon 'User'))
    $session = Restart-GuestForGui -Context $Context
    Write-Host ("Интерактивная сессия: Active={0}, explorer={1}, session={2}" -f `
            $session.ActiveSessions, $session.ExplorerCount, ($session.ExplorerSessionIds -join ','))
    if (-not $SkipSnapshot) {
        $null = Copy-GuestGuiProbe -Context $Context
        $plan = New-GuiPlan -Steps @(@{ type = 'note'; text = 'gui-base-check' })
        $probe = Invoke-GuestGuiProbe -Context $Context -Plan $plan -Name 'gui-base-check' `
            -TaskUser $TaskUser -TimeoutSec 120
        if (-not $probe.Ok) {
            throw ('Проба в интерактивной сессии не отработала: ' + $probe.Error)
        }
        $info = Get-JsonField (Get-JsonField $probe.Result 'session') 'foreground'
        Write-Host ("Рабочий стол виден пробе: foreground={0}" -f $info)
        New-VmSnapshot -Vm $Vm -Name $SnapshotName `
            -Description 'E2E GUI: AutoLogon + интерактивная сессия; снят с работающей ВМ (8789381a, этап 4)'
        Write-Host ("Снапшот GUI-базы: {0}" -f $SnapshotName)
    }
    return [pscustomobject]@{ Session = $session; Snapshot = $SnapshotName }
}

<# Скопировать probe.ps1 в гостя (20 КБ, после каждого restore заново). #>
function Copy-GuestGuiProbe {
    [CmdletBinding()]
    param($Context = (Get-GuestContext))
    $null = Invoke-GuestElevatedCommand -Context $Context `
        -Command 'if not exist C:\e2e mkdir C:\e2e & if not exist C:\e2e\gui mkdir C:\e2e\gui & exit /b 0'
    $source = Join-Path $PSScriptRoot 'probe.ps1'
    if (-not (Test-Path -LiteralPath $source)) { throw "Нет файла пробы: $source" }
    $passwordFile = Join-Path $env:TEMP ('etn-e2e-pw-' + [guid]::NewGuid().ToString('N') + '.txt')
    $plain = $Context.Credential.GetNetworkCredential().Password
    [System.IO.File]::WriteAllText($passwordFile, $plain)
    $plain = $null
    try {
        Copy-HostFileToGuest -Vm $Context.Vm -Source $source -Destination $script:GuiProbeGuestPath `
            -UserName $Context.UserName -PasswordFile $passwordFile
    } finally {
        Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
    }
    return $script:GuiProbeGuestPath
}

<#
    План пробы. Exe/Arguments — запуск установщика; Steps — шаги probe.ps1.
    Хранится в JSON; секретов в плане нет.
#>
function New-GuiPlan {
    [CmdletBinding()]
    param(
        [string]$Exe = '',
        [string[]]$Arguments = @(),
        [object[]]$Steps = @(),
        [System.Collections.IDictionary]$Extra = @{}
    )
    $plan = [ordered]@{
        exe       = $Exe
        arguments = @($Arguments)
        steps     = @($Steps)
    }
    foreach ($key in $Extra.Keys) { $plan[$key] = $Extra[$key] }
    return $plan
}

<#
    Погасить оставшиеся процессы установщика ETN в гостя.
    Нужен после неудачной пробы: таймаут или сбой плана оставляет
    распакованный setup работать, и следующий шаг запускает второй
    установщик параллельно (наблюдалось 2026-11-08 в G3: 0.15.3 ещё
    копировал payload, а проверка понижения уже запустила 0.15.2).
#>
function Clear-GuestInstallerProcesses {
    param($Context = (Get-GuestContext))
    try {
        $count = Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
            $killed = 0
            foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.Name -like 'ETN-Setup*' -or $_.Name -eq 'setup.exe' -or
                        $_.Name -like 'setup.tmp'
                    })) {
                try {
                    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                    $killed++
                } catch {
                    Write-Warning ("процесс установщика {0} ({1}) не остановлен: {2}" -f `
                            $proc.Name, $proc.ProcessId, $_.Exception.Message)
                }
            }
            $killed
        }
        if ($count -gt 0) {
            Write-Host ("Установщик после неудачной пробы остановлен: процессов {0}" -f $count)
        }
    } catch {
        Write-Warning ("Процессы установщика не остановлены ({0})" -f $_.Exception.Message)
    }
}

<#
    Запустить пробу в интерактивной сессии и дождаться результата.
    RunLevel: Highest (административный режим установщика) или Limited
    (обычный запуск: клиент «только для меня», сервер недоступен).
    Возвращает { Ok; Result; Raw; TaskInfo; Error; PlanPath; ResultPath }.
#>
function Invoke-GuestGuiProbe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Plan,
        [string]$Name = 'gui',
        [ValidateSet('Highest', 'Limited')][string]$RunLevel = 'Highest',
        [string]$TaskUser = '',
        [int]$TimeoutSec = 600,
        [string]$ArtifactDir = '',
        $Context = (Get-GuestContext)
    )
    if (-not $TaskUser) { $TaskUser = $Context.UserName }
    $script:GuiProbeCounter += 1
    $safeName = ($Name -replace '[^A-Za-z0-9._-]', '_')
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + $script:GuiProbeCounter
    $planPath = "C:\e2e\gui\plan-$safeName-$stamp.json"
    $resultPath = "C:\e2e\gui\result-$safeName-$stamp.json"
    $taskName = if ($RunLevel -eq 'Limited') { 'ETN-E2E-GuiLimited' } else { 'ETN-E2E-Gui' }

    $planJson = $Plan | ConvertTo-Json -Depth 12
    $null = Set-GuestText -Context $Context -Path $planPath -Text $planJson
    # Остаток прошлого прогона с тем же именем не должен считаться готовым:
    # ожидание проверяет JSON с finished_at, но старый файл удаляется сразу.
    $null = Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($Path)
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    } -ArgumentList @($resultPath)

    $register = Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($TaskName, $ProbePath, $PlanPath, $OutPath, $User, $RunLevel, $LimitSec)
        $argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Plan "{1}" -Out "{2}"' -f `
            $ProbePath, $PlanPath, $OutPath
        $action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
            -Argument $argument -WorkingDirectory 'C:\e2e\gui'
        $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel $RunLevel
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Seconds $LimitSec) -MultipleInstances IgnoreNew -StartWhenAvailable
        Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal `
            -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        return [pscustomobject]@{
            Ok          = $true
            TaskName    = $TaskName
            State       = [string](Get-ScheduledTask -TaskName $TaskName).State
            LastRunTime = [string]$info.LastRunTime
        }
    } -ArgumentList @($taskName, $script:GuiProbeGuestPath, $planPath, $resultPath,
        $TaskUser, $RunLevel, ($TimeoutSec + 60))
    if (-not [bool](Get-JsonField $register 'Ok')) {
        return [pscustomobject]@{
            Ok = $false; Result = $null; Raw = ''; TaskInfo = $register
            Error = 'Запланированная задача пробы не зарегистрирована'; PlanPath = $planPath; ResultPath = $resultPath
        }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $raw = ''
    $parsed = $null
    while ((Get-Date) -lt $deadline) {
        try {
            $read = Get-GuestText -Context $Context -Path $resultPath
        } catch {
            $message = [string]$_.Exception.Message
            if (-not (Test-GuestTransportError -Message $message)) { throw }
            # Проба уже запущена в гостя запланированной задачей: транспортный
            # сбой WinRM не отменяет её. Переоткрываем сессию и продолжаем
            # ждать результат (чтение идемпотентно).
            Write-Warning ("WinRM гостя во время пробы: {0}; продолжаю ожидание" -f $message)
            Close-GuestSession -Context $Context
            try { $null = Wait-GuestReady -Context $Context -TimeoutSec 120 } catch { Start-Sleep -Seconds 5 }
            continue
        }
        if ([bool](Get-JsonField $read 'Exists')) {
            $text = [string](Get-JsonField $read 'Text')
            if ($text.Trim()) {
                try {
                    $candidate = $text | ConvertFrom-Json
                    if ((Get-JsonField $candidate 'finished_at')) {
                        $raw = $text
                        $parsed = $candidate
                        break
                    }
                } catch { }
            }
        }
        Start-Sleep -Seconds 2
    }

    $taskInfo = $null
    try {
        $taskInfo = Invoke-GuestElevated -Context $Context -ScriptBlock {
            param($TaskName)
            $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if (-not $task) { return $null }
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            return [pscustomobject]@{
                State          = [string]$task.State
                LastTaskResult = [int]$info.LastTaskResult
                LastRunTime    = [string]$info.LastRunTime
            }
        } -ArgumentList @($taskName)
    } catch { }

    $errorText = ''
    $ok = $false
    if ($null -eq $parsed) {
        $errorText = "Проба не записала результат за $TimeoutSec с."
        if ($taskInfo) { $errorText += (' Задача: state=' + $taskInfo.State + ', result=' + $taskInfo.LastTaskResult) }
    } else {
        $ok = [bool](Get-JsonField $parsed 'ok')
        if (-not $ok) { $errorText = [string](Get-JsonField $parsed 'error') }
    }

    if ($ArtifactDir -and $raw) {
        $dir = Join-Path $ArtifactDir $safeName
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText((Join-Path $dir ($safeName + '.json')), $raw,
            (New-Object System.Text.UTF8Encoding($false)))
    }

    # Неудачная проба могла оставить установщик живым: следующий шаг не
    # должен запускать второй параллельно (см. Clear-GuestInstallerProcesses).
    if (-not $ok) { Clear-GuestInstallerProcesses -Context $Context }

    return [pscustomobject]@{
        Ok         = $ok
        Result     = $parsed
        Raw        = $raw
        TaskInfo   = $taskInfo
        Error      = $errorText
        PlanPath   = $planPath
        ResultPath = $resultPath
    }
}

<#
    Создать GUI-базы, которых нет: аддитивные живые снапшоты поверх исходных.
    Ошибка подготовки не валит прогон целиком: результат по каждой базе
    возвращается, а сценарий, которому база нужна, честно падает/откладывает.
#>
function Ensure-GuiBaseSnapshots {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)]$Context,
        [string]$BaseSnapshot = 'base-e2e-live',
        [string]$GuiBase = 'base-e2e-gui2',
        [string]$GuiUser = 'base-e2e-user2',
        [string]$InstalledSnapshot = '',
        [int]$BootTimeoutSec = 300,
        [switch]$WithUserBase
    )
    $status = [ordered]@{ created = @(); user_base = $false; user_error = '' }
    if (-not (Test-VmSnapshot -Vm $Vm -Name $GuiBase)) {
        Write-Step "GUI-база: создаётся $GuiBase из $BaseSnapshot"
        Close-GuestSession -Context $Context
        Restore-VmSnapshot -Vm $Vm -Name $BaseSnapshot
        Start-VmHeadless -Vm $Vm
        $null = Wait-VmGuestAdditions -Vm $Vm -TimeoutSec $BootTimeoutSec
        $null = Wait-GuestReady -Context $Context -TimeoutSec $BootTimeoutSec
        $null = Initialize-GuestGuiBase -Vm $Vm -Context $Context -SnapshotName $GuiBase
        $status.created += $GuiBase
    }
    if ($WithUserBase) {
        if (Test-VmSnapshot -Vm $Vm -Name $GuiUser) {
            $status.user_base = $true
        } else {
            try {
                Write-Step "GUI-база: создаётся $GuiUser (стандартная учётка)"
                Close-GuestSession -Context $Context
                Restore-VmSnapshot -Vm $Vm -Name $BaseSnapshot
                Start-VmHeadless -Vm $Vm
                $null = Wait-VmGuestAdditions -Vm $Vm -TimeoutSec $BootTimeoutSec
                $null = Wait-GuestReady -Context $Context -TimeoutSec $BootTimeoutSec
                $user = New-GuiStandardUser -Context $Context -User 'e2egui'
                if (-not [bool](Get-JsonField $user 'Ok')) {
                    throw ('учётка e2egui осталась администратором: ' + [string](Get-JsonField $user 'IsAdmin'))
                }
                $null = Initialize-GuestGuiBase -Vm $Vm -Context $Context -SnapshotName $GuiUser `
                    -AutoLogonUserName ([string](Get-JsonField $user 'User')) `
                    -AutoLogonPassword ([string](Get-JsonField $user 'Password')) `
                    -TaskUser ([string](Get-JsonField $user 'User'))
                $status.created += $GuiUser
                $status.user_base = $true
            } catch {
                $status.user_error = $_.Exception.Message
                Write-Warning "GUI-база $GuiUser не создана: $($status.user_error)"
            }
        }
    }
    return [pscustomobject]$status
}

# --- Разбор снимков страницы -----------------------------------------------
<# Снимок по имени из результата пробы; $null — проба не дошла до шага. #>
function Get-GuiSnapshot {
    [CmdletBinding()]
    param($ProbeResult, [string]$Name)
    $snapshots = Get-JsonField $ProbeResult 'snapshots'
    return Get-JsonField $snapshots $Name
}

<# Все тексты снимка: контролы страницы, кнопки мастера, строки списков, UIA. #>
function Get-GuiSnapshotTexts {
    [CmdletBinding()]
    param($Snapshot)
    $texts = New-Object System.Collections.Generic.List[string]
    foreach ($control in @(Get-JsonField $Snapshot 'controls')) {
        $text = [string](Get-JsonField $control 'text')
        if ($text) { $texts.Add($text) }
    }
    foreach ($control in @(Get-JsonField $Snapshot 'wizard_controls')) {
        $text = [string](Get-JsonField $control 'text')
        if ($text) { $texts.Add($text) }
    }
    foreach ($list in @(Get-JsonField $Snapshot 'lists')) {
        foreach ($item in @(Get-JsonField $list 'items')) {
            $text = [string](Get-JsonField $item 'text')
            if ($text) { $texts.Add($text) }
        }
    }
    foreach ($element in @(Get-JsonField $Snapshot 'uia')) {
        $name = [string](Get-JsonField $element 'name')
        if ($name) { $texts.Add($name) }
    }
    return $texts.ToArray()
}

<# Есть ли в снимке текст (по умолчанию — подстрока; -Exact — точное равенство). #>
function Test-GuiSnapshotText {
    [CmdletBinding()]
    param($Snapshot, [string]$Text, [switch]$Exact)
    foreach ($value in (Get-GuiSnapshotTexts -Snapshot $Snapshot)) {
        if ($Exact) { if ($value -eq $Text) { return $true } }
        elseif ($value.Contains($Text)) { return $true }
    }
    return $false
}

<# Текст строки списка по индексу; $null — нет такого. #>
function Get-GuiListItemText {
    [CmdletBinding()]
    param($Snapshot, [int]$ListIndex = 0, [int]$ItemIndex = 0)
    $lists = @(Get-JsonField $Snapshot 'lists')
    if ($ListIndex -ge $lists.Count) { return $null }
    $items = @(Get-JsonField $lists[$ListIndex] 'items')
    if ($ItemIndex -ge $items.Count) { return $null }
    return [string](Get-JsonField $items[$ItemIndex] 'text')
}

<# Поля ввода страницы в порядке сверху вниз. #>
function Get-GuiEdits {
    [CmdletBinding()]
    param($Snapshot)
    $edits = @(Get-JsonField $Snapshot 'controls' | Where-Object {
            ([string](Get-JsonField $_ 'class')) -like '*Edit*' -or
            ([string](Get-JsonField $_ 'class')) -eq 'EDIT'
        })
    return @($edits | Sort-Object { @(Get-JsonField $_ 'rect')[1] })
}

<# Текст многострочного поля (итоговая сводка на экране завершения). #>
function Get-GuiMemoText {
    [CmdletBinding()]
    param($Snapshot)
    foreach ($control in @(Get-JsonField $Snapshot 'controls')) {
        $class = [string](Get-JsonField $control 'class')
        if ($class -like '*Memo*' -and [int](Get-JsonField $control 'chars') -gt 20) {
            return [string](Get-JsonField $control 'text')
        }
    }
    return ''
}

<#
    Контрол внутри поверхности страницы (прямоугольник в координатах страницы,
    допуск 1 px на округление масштаба).
#>
function Test-GuiControlInsidePage {
    [CmdletBinding()]
    param($Snapshot, $Control, [int]$Tolerance = 1)
    $page = Get-JsonField $Snapshot 'page'
    $rel = @(Get-JsonField $Control 'rect_rel')
    if (-not $rel -or $rel.Count -lt 4) { return $false }
    $width = [int](Get-JsonField $page 'width')
    $height = [int](Get-JsonField $page 'height')
    return (([int]$rel[0] -ge -$Tolerance) -and ([int]$rel[1] -ge -$Tolerance) -and
        ([int]$rel[2] -le ($width + $Tolerance)) -and ([int]$rel[3] -le ($height + $Tolerance)))
}

<#
    Пересечения видимых прямых детей поверхности страницы (пары). Вложенность
    исключена: Get-WizardSnapshot берёт только прямых детей поверхности.
    Пустые/нулевые прямоугольники пропускаются.
#>
function Get-GuiOverlaps {
    [CmdletBinding()]
    param($Snapshot)
    $controls = @(Get-JsonField $Snapshot 'controls' |
            Where-Object {
                ([int](Get-JsonField $_ 'width') -gt 0) -and
                ([int](Get-JsonField $_ 'height') -gt 0) -and
                ([int](Get-JsonField $_ 'chars') -gt 0 -or ([string](Get-JsonField $_ 'class')) -like '*ListBox*')
            })
    $overlaps = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $controls.Count; $i++) {
        for ($j = $i + 1; $j -lt $controls.Count; $j++) {
            $a = @(Get-JsonField $controls[$i] 'rect')
            $b = @(Get-JsonField $controls[$j] 'rect')
            $left = [Math]::Max([int]$a[0], [int]$b[0])
            $top = [Math]::Max([int]$a[1], [int]$b[1])
            $right = [Math]::Min([int]$a[2], [int]$b[2])
            $bottom = [Math]::Min([int]$a[3], [int]$b[3])
            if ($right - $left -gt 2 -and $bottom - $top -gt 2) {
                $overlaps.Add([pscustomobject]@{
                        a = ([string](Get-JsonField $controls[$i] 'class') + ': ' +
                            [string](Get-JsonField $controls[$i] 'text'))
                        b = ([string](Get-JsonField $controls[$j] 'class') + ': ' +
                            [string](Get-JsonField $controls[$j] 'text'))
                        overlap = @(($right - $left), ($bottom - $top))
                    })
            }
        }
    }
    return $overlaps.ToArray()
}

<#
    Подписи, которые обрезаны: измеренная по тексту высота больше высоты
    контрола (допуск 2 px). Пустой текст не проверяется.
#>
function Get-GuiClippedLabels {
    [CmdletBinding()]
    param($Snapshot, [int]$Tolerance = 2)
    $bad = New-Object System.Collections.Generic.List[object]
    foreach ($control in @(Get-JsonField $Snapshot 'controls')) {
        $required = Get-JsonField $control 'required_height'
        if ($null -eq $required) { continue }
        $height = [int](Get-JsonField $control 'height')
        if ([int]$required -gt ($height + $Tolerance)) {
            $bad.Add([pscustomobject]@{
                    class    = [string](Get-JsonField $control 'class')
                    text     = [string](Get-JsonField $control 'text')
                    height   = $height
                    required = [int]$required
                })
        }
    }
    return $bad.ToArray()
}

<#
    Обрезанные строки списка: измеренная высота строки больше фактической
    (допуск 2 px) либо фактическая меньше одной строки текста.
#>
function Get-GuiClippedListItems {
    [CmdletBinding()]
    param($Snapshot, [int]$Tolerance = 2)
    $bad = New-Object System.Collections.Generic.List[object]
    foreach ($list in @(Get-JsonField $Snapshot 'lists')) {
        $lineHeight = [int](Get-JsonField $list 'line_height')
        foreach ($item in @(Get-JsonField $list 'items')) {
            $height = [int](Get-JsonField $item 'height')
            $required = [int](Get-JsonField $item 'required_height')
            $text = [string](Get-JsonField $item 'text')
            $why = ''
            if ($required -gt 0 -and $required -gt ($height + $Tolerance)) { $why = 'required > height' }
            elseif ($lineHeight -gt 0 -and $height -lt ($lineHeight - $Tolerance)) { $why = 'height < line' }
            if ($why) {
                $bad.Add([pscustomobject]@{
                        index = [int](Get-JsonField $item 'index')
                        text  = $text
                        height = $height
                        required = $required
                        line  = $lineHeight
                        why   = $why
                    })
            }
        }
    }
    return $bad.ToArray()
}

<#
    Проверка «страница собрана»: снимок снят, подписи не обрезаны, строки
    списков не сжаты, видимые контролы не пересекаются, все внутри страницы.
    Возвращает { Ok; Problems[] }.
#>
function Test-GuiSnapshotLayout {
    [CmdletBinding()]
    param($Snapshot, [string[]]$IgnoreOverlapClasses = @())
    $problems = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Snapshot) {
        $problems.Add('снимок не снят')
        return [pscustomobject]@{ Ok = $false; Problems = $problems.ToArray() }
    }
    foreach ($label in (Get-GuiClippedLabels -Snapshot $Snapshot)) {
        $problems.Add(('обрезка подписи: {0} height={1} required={2} «{3}»' -f
                $label.class, $label.height, $label.required, $label.text))
    }
    foreach ($item in (Get-GuiClippedListItems -Snapshot $Snapshot)) {
        $problems.Add(('обрезка строки списка #{0}: height={1} required={2} line={3} «{4}»' -f
                $item.index, $item.height, $item.required, $item.line, $item.text))
    }
    foreach ($control in @(Get-JsonField $Snapshot 'controls')) {
        $class = [string](Get-JsonField $control 'class')
        if ($IgnoreOverlapClasses | Where-Object { $class -like $_ }) { continue }
        if (-not (Test-GuiControlInsidePage -Snapshot $Snapshot -Control $control)) {
            $problems.Add(('за пределами страницы: {0} «{1}» rect_rel={2}' -f
                    $class, [string](Get-JsonField $control 'text'),
                    (@(Get-JsonField $control 'rect_rel') -join ',')))
        }
    }
    foreach ($overlap in (Get-GuiOverlaps -Snapshot $Snapshot)) {
        $problems.Add(('пересечение: «{0}» и «{1}» на {2}x{3} px' -f
                $overlap.a, $overlap.b, $overlap.overlap[0], $overlap.overlap[1]))
    }
    return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems.ToArray() }
}
