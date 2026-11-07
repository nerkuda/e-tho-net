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
    }
}

<# Существует ли путь в госте. #>
function Test-GuestPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $Context = (Get-GuestContext)
    )
    return [bool](Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    $null = Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return [long](Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
        $listening = [bool](Invoke-GuestElevated -Context $Context -ScriptBlock {
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
    return Invoke-GuestElevated -Context $Context -ScriptBlock {
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
#>
function Save-GuestInstallerLogs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Scenario,
        [Parameter(Mandatory = $true)][string]$HostRoot,
        $Context = (Get-GuestContext)
    )
    $guestDir = "C:\e2e\logs\$Scenario"
    $null = Invoke-GuestElevatedCommand -Context $Context -Command (
        "if not exist `"$guestDir`" mkdir `"$guestDir`" & " +
        "copy /Y `"C:\ProgramData\ETN\logs\*.log`" `"$guestDir\`" >nul 2>&1 & " +
        'copy /Y "%TEMP%\install-*.log" "' + $guestDir + '\" >nul 2>&1 & ' +
        'copy /Y "%TEMP%\Setup Log*.txt" "' + $guestDir + '\" >nul 2>&1 & ' +
        "copy /Y `"C:\Windows\Temp\install-*.log`" `"$guestDir\`" >nul 2>&1 & " +
        "copy /Y `"C:\Windows\Temp\Setup Log*.txt`" `"$guestDir\`" >nul 2>&1 & " +
        "if exist `"C:\ProgramData\ETN\.install\reason*.txt`" copy /Y `"C:\ProgramData\ETN\.install\reason*.txt`" `"$guestDir\`" >nul 2>&1 & " +
        'exit /b 0'
    )
    $hostDir = Join-Path $HostRoot $Scenario
    New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
    & {   # Архив собирается в госте: guestcontrol copyfrom не раскрывает маски.
        $zipGuest = "C:\e2e\logs\$Scenario.zip"
        $null = Invoke-GuestElevated -Context $Context -ScriptBlock {
            param($Dir, $Zip)
            if (-not (Test-Path -LiteralPath $Dir)) { return }
            $items = @(Get-ChildItem -LiteralPath $Dir -File -Force)
            if ($items.Count -eq 0) { return }
            Compress-Archive -Path (Join-Path $Dir '*') -DestinationPath $Zip -Force
        } -ArgumentList @($guestDir, $zipGuest)
        $passwordFile = Join-Path $env:TEMP ('etn-e2e-pw-' + [guid]::NewGuid().ToString('N') + '.txt')
        $plain = $Context.Credential.GetNetworkCredential().Password
        [System.IO.File]::WriteAllText($passwordFile, $plain)
        $plain = $null
        $zipHost = Join-Path $hostDir "$Scenario-logs.zip"
        try {
            if (Test-GuestPath -Path $zipGuest -Context $Context) {
                Copy-GuestFileToHost -Vm $Context.Vm -Source $zipGuest -Destination $zipHost `
                    -UserName $Context.UserName -PasswordFile $passwordFile
                Expand-Archive -LiteralPath $zipHost -DestinationPath $hostDir -Force
                Remove-Item -LiteralPath $zipHost -Force -ErrorAction SilentlyContinue
            }
        } catch {
            Write-Warning "Журналы сценария $Scenario скопированы не полностью: $($_.Exception.Message)"
        } finally {
            Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue
        }
    }
    return $hostDir
}
