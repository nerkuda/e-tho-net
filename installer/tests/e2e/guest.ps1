<#
.SYNOPSIS
    Гостевые операции E2E-тестов установщика ETN (WinRM + guestcontrol).

.DESCRIPTION
    Гость `ETN-Win11` принимает WinRM на 127.0.0.1:15985 (проброс на 5985).
    Проверено на стенде: WinRM-сессия с учёткой vz получает ПОЛНЫЙ токен
    администратора, а `VBoxManage guestcontrol run` — фильтрованный
    (неэлевированный). Поэтому:

      * элевированные команды и установщики — `Invoke-GuestElevated*` (WinRM);
      * неэлевированный контекст — `Invoke-GuestLimited*` (guestcontrol run);
      * копирование файлов и журналов — guestcontrol (vm.ps1), как требует
        карточка задачи.

    Секреты ВМ читаются из etn-vms.env ТОЛЬКО в момент прогона, в память
    процесса оркестратора. Значения не печатаются, не пишутся в JSON/журнал
    и не попадают в аргументы командной строки на хосте: guestcontrol
    получает временный passwordfile, который удаляется сразу после вызова.

    Задача 8789381a (0.15.3).
#>

$script:GuestContext = $null

<# Прочитать etn-vms.env в hashtable. Значения не логируются. #>
function Read-E2EEnvFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Нет файла секретов ВМ: $Path. Секреты читаются только при прогоне E2E."
    }
    $map = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $map[$Matches[1]] = $Matches[2].Trim()
        }
    }
    return $map
}

<#
    Контекст гостя: имя ВМ, учётка, порт WinRM, VBoxManage.
    Пароль живёт в PSCredential; значение отдельно не сохраняется.
#>
function New-GuestContext {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Vm,
        [Parameter(Mandatory = $true)][string]$SecretsPath,
        [int]$WinRmPort = 15985,
        [string]$VBoxManage = '',
        [int]$WinRmTimeoutSec = 1800
    )
    if (-not $script:VBoxManage) { $null = Resolve-VBoxManage -Explicit $VBoxManage }
    $secrets = Read-E2EEnvFile -Path $SecretsPath
    foreach ($required in @('WINVM_USER', 'WINVM_PASS')) {
        if (-not $secrets.ContainsKey($required)) { throw "В $SecretsPath нет ключа $required." }
    }
    $secure = ConvertTo-SecureString $secrets['WINVM_PASS'] -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($secrets['WINVM_USER'], $secure)

    $script:GuestContext = [pscustomobject]@{
        Vm              = $Vm
        UserName        = $secrets['WINVM_USER']
        Credential      = $credential
        WinRmPort       = $WinRmPort
        WinRmTimeoutSec = $WinRmTimeoutSec
        Session         = $null
    }
    return $script:GuestContext
}

function Get-GuestContext {
    if (-not $script:GuestContext) { throw 'Контекст гостя не создан: вызовите New-GuestContext.' }
    return $script:GuestContext
}

<# Открыть WinRM-сессию (элевированный токен у администратора). #>
function Open-GuestSession {
    [CmdletBinding()]
    param($Context = (Get-GuestContext))
    # Оборванная сессия остаётся в контексте со State=Broken/Closed: повторный
    # Invoke-Command на ней падает без попытки открыть новую. Поэтому годится
    # только Opened, остальное закрываем и открываем заново.
    if ($Context.Session -and $Context.Session.State -ne 'Opened') {
        Close-GuestSession -Context $Context
    }
    if ($Context.Session) { return $Context.Session }
    $option = New-PSSessionOption -OperationTimeout ($Context.WinRmTimeoutSec * 1000) `
        -IdleTimeout ($Context.WinRmTimeoutSec * 1000) -OpenTimeout 60000
    $Context.Session = New-PSSession -ComputerName '127.0.0.1' -Port $Context.WinRmPort `
        -Credential $Context.Credential -Authentication Negotiate -SessionOption $option
    return $Context.Session
}

function Close-GuestSession {
    [CmdletBinding()]
    param($Context = (Get-GuestContext))
    if ($Context.Session) {
        Remove-PSSession -Session $Context.Session -ErrorAction SilentlyContinue
        $Context.Session = $null
    }
}

<#
    Дождаться готовности WinRM после старта ВМ. Пробуем открыть сессию и
    выполнить whoami; ошибки — повтор с паузой.
#>
function Wait-GuestReady {
    [CmdletBinding()]
    param($Context = (Get-GuestContext), [int]$TimeoutSec = 300)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Open-GuestSession -Context $Context
            $who = Invoke-Command -Session $Context.Session -ScriptBlock { $env:COMPUTERNAME } -ErrorAction Stop
            if ($who) { return $true }
        } catch {
            Close-GuestSession -Context $Context
        }
        Start-Sleep -Seconds 5
    }
    throw "WinRM гостя не готов за $TimeoutSec с."
}

<# Элевированный скрипт в гостя (WinRM). Возвращает выход Invoke-Command. #>
function Invoke-GuestElevated {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock,
        [object[]]$ArgumentList = @(),
        $Context = (Get-GuestContext)
    )
    $null = Open-GuestSession -Context $Context
    return Invoke-Command -Session $Context.Session -ScriptBlock $ScriptBlock `
        -ArgumentList $ArgumentList -ErrorAction Stop
}

<#
    Транспортный сбой WinRM (соединение потеряно/сброшено), в отличие от
    ошибки самой удалённой команды. На VirtualBox 7.2.22 такие сбои
    наблюдались после resume «живого» снапшота и во время длинных GUI-проб
    (2026-11-08): «Сетевое соединение … было потеряно», HTTP 12152,
    HTTP 500 «Ошибка сервера» под нагрузкой установщика.
#>
function Test-GuestTransportError {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    foreach ($pattern in @(
            'Сетевое соединение с .* было потеряно',
            'Выполняющаяся команда отключена',
            'команда отключена, но по-прежнему выполняется',
            'still running on the remote server',
            'HTTP \(12152\)',
            'Ошибка сервера.*HTTP 500',
            'HTTP \(500\)',
            'HTTP 500',
            'The WinRM client received an HTTP server error status',
            'Службе WS-Management не удается обработать запрос',
            'The WS-Management service cannot process the request',
            'WinRM не удается выполнить операцию',
            'WinRM cannot complete the operation'
        )) {
        if ($Message -match $pattern) { return $true }
    }
    return $false
}

<#
    Идемпотентная гостевая операция с повтором после транспортного сбоя:
    сессия переоткрывается, WinRM дожидается готовности. Только для чтений и
    перезаписываемых файлов — повтор «запустить процесс/установщик» запрещён.
#>
function Invoke-GuestElevatedRetry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock,
        [object[]]$ArgumentList = @(),
        [int]$Attempts = 3,
        $Context = (Get-GuestContext)
    )
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return Invoke-GuestElevated -Context $Context -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
        } catch {
            $message = [string]$_.Exception.Message
            if ($attempt -ge $Attempts -or -not (Test-GuestTransportError -Message $message)) { throw }
            Write-Warning ("WinRM гостя: {0}; переоткрываю сессию (попытка {1} из {2})" -f `
                    $message, ($attempt + 1), $Attempts)
            Close-GuestSession -Context $Context
            try { $null = Wait-GuestReady -Context $Context -TimeoutSec 180 } catch { Start-Sleep -Seconds 5 }
        }
    }
}

<#
    Элевированная команда cmd.exe. Возвращает { Code; Output }.
    Output — stdout+stderr процесса, без учётных данных (их в команде нет).
#>
function Invoke-GuestElevatedCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
        param($CommandLine)
        $out = & cmd.exe /c $CommandLine 2>&1
        [pscustomobject]@{
            Code   = $LASTEXITCODE
            Output = (($out | Out-String).Trim())
        }
    } -ArgumentList @($Command)
}

<# Элевированный процесс (установщик). Возвращает { Code; Output; TimedOut }. #>
function Invoke-GuestElevatedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 900,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
        param($ExePath, $ArgumentList, $LimitSec)
        $proc = Start-Process -FilePath $ExePath -ArgumentList $ArgumentList -PassThru -WindowStyle Hidden
        if (-not $proc.WaitForExit($LimitSec * 1000)) {
            try { $proc.Kill() } catch { }
            return [pscustomobject]@{ Code = -1; Output = 'TIMEOUT'; TimedOut = $true }
        }
        return [pscustomobject]@{ Code = $proc.ExitCode; Output = ''; TimedOut = $false }
    } -ArgumentList @($Exe, $Arguments, $TimeoutSec)
}

<#
    НЕэлевированный процесс через guestcontrol (фильтрованный токен).
    Пароль передаётся временным passwordfile и удаляется в finally.
#>
function Invoke-GuestLimitedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [int]$TimeoutSec = 900,
        $Context = (Get-GuestContext)
    )
    $vbm = Get-VBoxManage
    $passwordFile = Join-Path $env:TEMP ('etn-e2e-pw-' + [guid]::NewGuid().ToString('N') + '.txt')
    $plain = $Context.Credential.GetNetworkCredential().Password
    [System.IO.File]::WriteAllText($passwordFile, $plain)
    $plain = $null
    try {
        # VBoxManage 7: программа и её аргументы — позиционные после `--`;
        # отдельный --exe= не нужен и дублировал бы путь.
        $arguments = @(
            'guestcontrol', $Context.Vm, 'run',
            "--username=$($Context.UserName)", "--passwordfile=$passwordFile",
            '--wait-stdout', '--wait-stderr', "--timeout=$($TimeoutSec * 1000)", '--',
            $Exe
        ) + $Arguments
        $output = & $vbm @arguments 2>&1
        $raw = $LASTEXITCODE
        # VBoxManage 7 отдаёт код гостевого процесса со смещением +32
        # (проверено: guest 0→0, 1→33, 7→39, 20→52, 42→74). Для сценариев
        # нужен код установщика, поэтому смещение снимается; RawCode — как есть.
        $code = if ($raw -gt 32) { $raw - 32 } else { $raw }
        return [pscustomobject]@{
            Code    = $code
            RawCode = $raw
            Output  = (($output | Out-String).Trim())
        }
    } finally {
        Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
        # После guestcontrol run WinRM-сессия остаётся в нерабочем состоянии:
        # следующий Invoke-Command висит до OperationTimeout (проверено на
        # стенде — сбор журналов S1 висел до WinRmTimeoutSec). Поэтому сессия
        # закрывается, а следующие элевированные вызовы откроют её заново.
        Close-GuestSession -Context $Context
    }
}

<# Существует ли путь в госте. #>
function Test-GuestPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $Context = (Get-GuestContext)
    )
    return [bool](Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
            param($GuestPath)
            Test-Path -LiteralPath $GuestPath
        } -ArgumentList @($Path))
}

<# Прочитать текстовый файл гостя; { Exists; Text }. #>
function Get-GuestText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($GuestPath)
        if (-not (Test-Path -LiteralPath $GuestPath)) {
            return [pscustomobject]@{ Exists = $false; Text = '' }
        }
        return [pscustomobject]@{
            Exists = $true
            Text   = [System.IO.File]::ReadAllText($GuestPath)
        }
    } -ArgumentList @($Path)
}

<#
    Прочитать файл гостя, который ещё пишется (журнал установщика).
    ReadAllText открывает без FileShare.ReadWrite: пока Inno держит свой
    журнал открытым, чтение падает «The process cannot access the file».
    Здесь файл открывается с общей записью — читать хвост можно в любой
    момент, не дожидаясь завершения процесса.
#>
function Get-GuestTextShared {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($GuestPath)
        if (-not (Test-Path -LiteralPath $GuestPath)) {
            return [pscustomobject]@{ Exists = $false; Text = '' }
        }
        $stream = [System.IO.FileStream]::new(
            $GuestPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite)
        try {
            $reader = [System.IO.StreamReader]::new($stream)
            return [pscustomobject]@{ Exists = $true; Text = $reader.ReadToEnd() }
        } finally {
            $stream.Dispose()
        }
    } -ArgumentList @($Path)
}

<# Записать текстовый файл в гостя (UTF-8 без BOM по умолчанию). #>
function Set-GuestText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        $Context = (Get-GuestContext)
    )
    $null = Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($GuestPath, $Content)
        $dir = Split-Path -Parent $GuestPath
        if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($GuestPath, $Content, (New-Object System.Text.UTF8Encoding($false)))
    } -ArgumentList @($Path, $Text)
}

<# SHA-256 файла гостя; $null — файла нет. #>
function Get-GuestFileHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($GuestPath)
        if (-not (Test-Path -LiteralPath $GuestPath)) { return $null }
        (Get-FileHash -LiteralPath $GuestPath -Algorithm SHA256).Hash
    } -ArgumentList @($Path)
}

<# Размер файла гостя; -1 — файла нет. #>
function Get-GuestFileSize {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $Context = (Get-GuestContext)
    )
    return [long](Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
            param($GuestPath)
            if (-not (Test-Path -LiteralPath $GuestPath)) { return -1 }
            (Get-Item -LiteralPath $GuestPath).Length
        } -ArgumentList @($Path))
}

<# Значение строкового REG_SZ/REG_EXPAND_SZ из реестра гостя; $null — нет. #>
function Get-GuestRegistryValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Name,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($KeyPath, $ValueName)
        try {
            $item = Get-ItemProperty -LiteralPath $KeyPath -Name $ValueName -ErrorAction Stop
            return [string]$item.$ValueName
        } catch {
            return $null
        }
    } -ArgumentList @($Key, $Name)
}

<# Статус службы Windows: Running/Stopped/... или Missing. #>
function Get-GuestServiceState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($ServiceName)
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -eq $service) { return 'Missing' }
        return [string]$service.Status
    } -ArgumentList @($Name)
}

<# HTTP GET тела health-check-а изнутри гостя; $null — сервер не ответил. #>
function Get-GuestHealth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($HealthUrl)
        try {
            $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            return $response.Content
        } catch {
            return $null
        }
    } -ArgumentList @($Url)
}

<#
    Ожидание, пока TCP-порт гостя станет слушающим (или наоборот свободным).
    Проверка — Get-NetTCPConnection в элевированной сессии.
#>
function Wait-GuestPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [switch]$Free,
        [int]$TimeoutSec = 60,
        $Context = (Get-GuestContext)
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $listening = [bool](Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
                param($PortNumber)
                @(Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue).Count -gt 0
            } -ArgumentList @($Port))
        if ($Free -and (-not $listening)) { return $true }
        if ((-not $Free) -and $listening) { return $true }
        Start-Sleep -Seconds 1
    }
    throw ("Порт $Port не стал " + $(if ($Free) { 'свободным' } else { 'занятым' }) + " за $TimeoutSec с.")
}

<#
    Снимок файлов каталога: относительный путь + SHA-256. Используется для
    проверки «файлы не изменились» (отказ обновления/понижения версии).
#>
function Get-GuestTreeHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        $Context = (Get-GuestContext)
    )
    return Invoke-GuestElevatedRetry -Context $Context -ScriptBlock {
        param($RootPath)
        if (-not (Test-Path -LiteralPath $RootPath)) { return @() }
        return @(Get-ChildItem -LiteralPath $RootPath -Recurse -File -Force |
            Sort-Object FullName |
            ForEach-Object {
                [pscustomobject]@{
                    path = $_.FullName.Substring($RootPath.Length).TrimStart('\')
                    hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                }
            })
    } -ArgumentList @($Root)
}

<#
    Копировать журналы установщика из гостя на хост ДО восстановления снапшота.
    Собираются: install-*.log приложения, Setup Log*.txt Inno, reason-файлы.

    Сбор ограничен по времени: WinRM-вызовы идут в отдельной сессии с коротким
    OperationTimeout, между шагами проверяется бюджет попытки; попыток —
    $Attempts. Зависший вызов не держит прогон до WinRmTimeoutSec основной
    сессии (1800 с). Берутся только файлы не старше $LogMaxAgeMinutes: в
    образе ВМ остаются журналы прежних запусков, их нельзя выдавать за свежие.
    Если журналы не собраны — исключение: оркестратор фиксирует его полем
    logs_error, а не пустым logs.
#>
function Save-GuestInstallerLogs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)][string]$HostRoot,
        [int]$TimeoutSec = 150,
        [int]$Attempts = 2,
        [int]$LogMaxAgeMinutes = 120,
        $Context = (Get-GuestContext)
    )
    $hostDir = Join-Path $HostRoot $Scenario
    # Старые файлы того же сценария не должны выдаваться за свежие журналы.
    if (Test-Path -LiteralPath $hostDir) {
        Remove-Item -LiteralPath $hostDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
    $lastError = ''
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        # Отдельная сессия с коротким таймаутом: зависший WinRM-вызов
        # обрывается за TimeoutSec, а не за 1800 с.
        $logContext = $Context.PSObject.Copy()
        $logContext.WinRmTimeoutSec = [Math]::Min($TimeoutSec, 120)
        $logContext.Session = $null
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $guestDir = "C:\e2e\logs\$Scenario"
            $zipGuest = "C:\e2e\logs\$Scenario.zip"
            # Копирование — средствами PowerShell в гостевой сессии, не cmd:
            # `& cmd.exe /c <строка с кавычками>` PowerShell экранирует \" и
            # cmd разбирает команду неверно (проверено: код 0, файлов нет).
            # Источники — те же, что у Get-GuestInstallLog, плюс временный
            # каталог профиля: отказы precheck пишут install-*.log туда.
            $copiedCount = Invoke-GuestElevated -Context $logContext -ScriptBlock {
                param($Dir, $UserName, $MaxAgeMinutes)
                if (Test-Path -LiteralPath $Dir) {
                    Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
                }
                New-Item -ItemType Directory -Path $Dir -Force | Out-Null
                $cutoff = (Get-Date).AddMinutes(-$MaxAgeMinutes)
                $sources = @(
                    (Join-Path $env:ProgramData 'ETN\logs'),
                    $env:TEMP,
                    'C:\Windows\Temp'
                )
                if ($UserName) { $sources += (Join-Path 'C:\Users' (Join-Path $UserName 'AppData\Local\Temp')) }
                if ($env:USERPROFILE) { $sources += (Join-Path $env:USERPROFILE 'AppData\Local\Temp') }
                # Клиент «только для меня» пишет журнал в %TEMP% своей учётки:
                # собираются профили всех пользователей гостя.
                $sources += @(Get-ChildItem -LiteralPath 'C:\Users' -Directory -ErrorAction SilentlyContinue |
                    ForEach-Object { Join-Path $_.FullName 'AppData\Local\Temp' })
                foreach ($source in ($sources | Where-Object { $_ } | Select-Object -Unique)) {
                    if (-not (Test-Path -LiteralPath $source)) { continue }
                    foreach ($pattern in @('install-*.log', 'Setup Log*.txt')) {
                        # Только журналы текущего прогона: в образе ВМ лежат
                        # старые файлы снапшота, их нельзя выдавать за свежие.
                        Get-ChildItem -LiteralPath $source -Filter $pattern -File -ErrorAction SilentlyContinue |
                            Where-Object { $_.LastWriteTime -gt $cutoff } |
                            ForEach-Object {
                                Copy-Item -LiteralPath $_.FullName -Destination $Dir -Force -ErrorAction SilentlyContinue
                            }
                    }
                }
                # Журнал деинсталлятора Inno лежит рядом с установщиками (S5).
                Get-ChildItem -LiteralPath 'C:\e2e' -Filter 'unins-*.log' -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.LastWriteTime -gt $cutoff } |
                    ForEach-Object {
                        Copy-Item -LiteralPath $_.FullName -Destination $Dir -Force -ErrorAction SilentlyContinue
                    }
                $reasonDir = Join-Path $env:ProgramData 'ETN\.install'
                if (Test-Path -LiteralPath $reasonDir) {
                    Get-ChildItem -LiteralPath $reasonDir -Filter 'reason*.txt' -File -ErrorAction SilentlyContinue |
                        Where-Object { $_.LastWriteTime -gt $cutoff } |
                        ForEach-Object {
                            Copy-Item -LiteralPath $_.FullName -Destination $Dir -Force -ErrorAction SilentlyContinue
                        }
                }
                return @(Get-ChildItem -LiteralPath $Dir -File -Force).Count
            } -ArgumentList @($guestDir, $logContext.UserName, $LogMaxAgeMinutes)
            if ([int]$copiedCount -le 0) {
                throw "в гостевом каталоге $guestDir нет журналов"
            }

            # Архив собирается в госте: guestcontrol copyfrom не раскрывает маски.
            $null = Invoke-GuestElevated -Context $logContext -ScriptBlock {
                param($Dir, $Zip)
                if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue }
                if (-not (Test-Path -LiteralPath $Dir)) { return }
                $items = @(Get-ChildItem -LiteralPath $Dir -File -Force)
                if ($items.Count -eq 0) { return }
                Compress-Archive -Path (Join-Path $Dir '*') -DestinationPath $Zip -Force
            } -ArgumentList @($guestDir, $zipGuest)
            if ($watch.Elapsed.TotalSeconds -gt $TimeoutSec) {
                throw "сбор журналов дольше $TimeoutSec с"
            }

            $passwordFile = Join-Path $env:TEMP ('etn-e2e-pw-' + [guid]::NewGuid().ToString('N') + '.txt')
            $plain = $logContext.Credential.GetNetworkCredential().Password
            [System.IO.File]::WriteAllText($passwordFile, $plain)
            $plain = $null
            $zipHost = Join-Path $hostDir "$Scenario-logs.zip"
            try {
                if (-not (Test-GuestPath -Path $zipGuest -Context $logContext)) {
                    throw "в гостевом каталоге $guestDir нет журналов"
                }
                Copy-GuestFileToHost -Vm $logContext.Vm -Source $zipGuest -Destination $zipHost `
                    -UserName $logContext.UserName -PasswordFile $passwordFile
                Expand-Archive -LiteralPath $zipHost -DestinationPath $hostDir -Force
                Remove-Item -LiteralPath $zipHost -Force -ErrorAction SilentlyContinue
            } finally {
                Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
            }

            $files = @(Get-ChildItem -LiteralPath $hostDir -File -Force)
            if ($files.Count -eq 0) { throw 'после распаковки на хосте нет журналов' }
            return $hostDir
        } catch {
            $lastError = $_.Exception.Message
            Write-Warning ("Попытка {0} из {1}: журналы сценария {2} не собраны: {3}" -f `
                    $attempt, $Attempts, $Scenario, $lastError)
            if ($attempt -lt $Attempts) { Start-Sleep -Seconds 3 }
        } finally {
            Close-GuestSession -Context $logContext
        }
    }
    throw "Журналы сценария ${Scenario} не собраны за $Attempts попыток: $lastError"
}
