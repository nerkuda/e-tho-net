<#
.SYNOPSIS
    Проверка первичной инициализации установщика ETN (etn init) и экрана ключа.

.DESCRIPTION
    Собирает тестовый установщик (installer/build.ps1 -TestMode) с фикстурой
    payload из installer/tests/fixtures/payload и прогоняет сценарии задачи
    686c5d76:

      1. Первая установка: hasFirstUser() == false -> etn init вызывается
         один раз, ключ пишется в защищённый файл, в журнал и install.json
         не попадает.
      2. Повторный запуск при живом администраторе: init не вызывается,
         ключ от предыдущего запуска показывается из защищённого файла.
      3. Подтверждение «Я сохранил ключ»: временный файл удаляется.
      4. Сбой после init до показа ключа: файл сохраняется, повторный запуск
         показывает тот же ключ, повторного init нет.
      5. База от прерванной попытки (_system.db без администратора):
         init доинициализирует сервер.
      6. Silent: init не вызывается никогда, отсутствие администратора —
         код 10 (ручной режим).
      7. Статические проверки .iss: критерий --check, --key-out, окружение
         ETN_DATA_DIR/ETN_PORT/ETN_HOST, icacls, защищённый файл ключа,
         чекбокс «Я сохранил ключ», предупреждение при закрытии.

    Фикстура CLI (fixtures/payload/server/dist/cli.js) запускается настоящим
    node.exe (/TESTNODEEXE): проверяются реальный вызов процесса, аргументы,
    переменные окружения и коды возврата. Значение ключа в журнал установщика,
    install.json и трассу фикстуры не попадает.

    Задача 686c5d76 (0.15.1).

.PARAMETER IsccPath
    Путь к ISCC.exe (передаётся в build.ps1).

.PARAMETER KeepArtifacts
    Не удалять рабочий каталог .tmp\init-key-tests после прогона.

.PARAMETER TimeoutSec
    Таймаут одного прогона установщика, секунд.

.EXAMPLE
    pwsh -File installer/tests/init-key.ps1
#>
[CmdletBinding()]
param(
    [string]$IsccPath,
    [switch]$KeepArtifacts,
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installerDir = Join-Path $repoRoot 'installer'
$buildScript = Join-Path $installerDir 'build.ps1'
$issPath = Join-Path $installerDir 'etn.iss'
$payloadDir = Join-Path $PSScriptRoot 'fixtures\payload'
$workRoot = Join-Path $repoRoot '.tmp\init-key-tests'
$appDir = Join-Path $workRoot 'app'
$dataDir = Join-Path $workRoot 'data'
$buildDir = Join-Path $workRoot 'build'
$version = '0.15.1'
$script:results = New-Object System.Collections.Generic.List[object]

$IsElevated = $false
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $IsElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'node.exe не найден в PATH: тесту нужен Node 22 для фикстуры CLI.' }

function Add-Result {
    param([string]$Name, [int]$Expected, [int]$Actual, [string]$Note = '')
    $ok = ($Expected -eq $Actual)
    $script:results.Add([pscustomobject]@{
        Scenario = $Name
        Expected = $Expected
        Actual   = $Actual
        Ok       = $ok
        Note     = $Note
    })
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-32} ожидалось {2,3}, получено {3,3}  {4}" -f $mark, $Name, $Expected, $Actual, $Note)
}

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    Add-Result -Name $Name -Expected 1 -Actual ([int]$Ok) -Note $Note
}

function Reset-State {
    foreach ($dir in @($appDir, $dataDir)) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
}

function New-ParamsFile {
    param(
        [int]$Server = 1,
        [int]$Client = 0,
        [string]$Scope = 'user',
        [string]$Mode = 'service',
        [string]$Login = 'admin',
        [string]$DisplayName = '',
        [int]$Port = 0,
        [string]$Name = 'params.ini'
    )
    # Свободный порт по умолчанию: предпроверка занятости порта настоящая, а на
    # машине разработчика 4321 может занимать запущенный сервер (9b310991).
    if ($Port -le 0) { $Port = Get-FreeTcpPort }
    $path = Join-Path $workRoot $Name
    $text = "server=$Server`r`nclient=$Client`r`nclient_scope=$Scope`r`nmode=$Mode`r`n" +
        "host=0.0.0.0`r`nport=$Port`r`nfirewall=1`r`nlogin=$Login`r`n" +
        "display_name=$DisplayName`r`n" +
        "original_user=$env:USERNAME`r`n"
    [System.IO.File]::WriteAllText($path, $text)
    return $path
}

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function Get-KeyPath {
    return (Join-Path $dataDir '.install\primary-key.txt')
}

function Read-Key {
    $path = Get-KeyPath
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return ([System.IO.File]::ReadAllText($path)).Trim()
}

function Get-Invocations {
    $path = Join-Path $dataDir '.fixture-invocations.jsonl'
    if (-not (Test-Path -LiteralPath $path)) { return @() }
    $lines = [System.IO.File]::ReadAllLines($path) | Where-Object { $_.Trim() -ne '' }
    $items = foreach ($line in $lines) { $line | ConvertFrom-Json }
    return @($items)
}

function Count-Inits {
    param([object[]]$Invocations)
    return @($Invocations | Where-Object { $_.argv -contains '--username' }).Count
}

function Count-Checks {
    param([object[]]$Invocations)
    return @($Invocations | Where-Object { $_.argv -contains '--check' }).Count
}

function Invoke-Setup {
    param([string[]]$Arguments)
    $proc = Start-Process -FilePath $script:SetupPath -ArgumentList $Arguments -PassThru
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        throw "Установщик не завершился за $TimeoutSec с — возможно, появилось окно или модальный диалог."
    }
    return $proc.ExitCode
}

function Get-LatestLog {
    $logDir = Join-Path $dataDir 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { return $null }
    return Get-ChildItem -LiteralPath $logDir -Filter 'install-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Get-LogText {
    $log = Get-LatestLog
    if (-not $log) { return '' }
    return Get-Content -LiteralPath $log.FullName -Raw
}

function Get-LogLine {
    param([string]$Pattern)
    $text = Get-LogText
    if (-not $text) { return '' }
    $m = [regex]::Match($text, $Pattern)
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

# --- Статические проверки .iss ----------------------------------------------
Write-Host '=== Статические проверки .iss ==='
$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$staticChecks = @(
    @{ Name = 'static:init-check'; Text = 'init --check'; Note = 'критерий hasFirstUser через CLI' },
    @{ Name = 'static:key-out'; Text = '--key-out'; Note = 'ключ в защищённый файл' },
    @{ Name = 'static:env-data-dir'; Text = "SetEnvironmentVariableW('ETN_DATA_DIR'"; Note = 'окружение init' },
    @{ Name = 'static:env-port'; Text = "SetEnvironmentVariableW('ETN_PORT'"; Note = '' },
    @{ Name = 'static:env-host'; Text = "SetEnvironmentVariableW('ETN_HOST'"; Note = '' },
    @{ Name = 'static:icacls'; Text = 'icacls.exe'; Note = 'ACL каталога ключа' },
    @{ Name = 'static:key-file'; Text = 'primary-key.txt'; Note = 'защищённый временный файл' },
    @{ Name = 'static:key-confirm'; Text = 'Я сохранил ключ'; Note = 'подтверждение' },
    @{ Name = 'static:key-warning'; Text = 'Ключ показывается один раз'; Note = 'предупреждение' },
    @{ Name = 'static:key-close-warning'; Text = 'SuppressibleMsgBox('; Note = 'закрытие без подтверждения' },
    @{ Name = 'static:display-name-validation'; Text = 'function ValidDisplayName'; Note = 'display_name из /PARAMS проверяется (дефект 6)' },
    @{ Name = 'static:init-once'; Text = 'etn init не вызывается'; Note = 'повторная инициализация запрещена' }
)
foreach ($check in $staticChecks) {
    $present = $issText.Contains($check.Text)
    Add-Check -Name $check.Name -Ok $present -Note $check.Note
}
# Ключ не пишется в журнал: ни одна строка LogLine не содержит GPendingKey.
$keyInLog = [regex]::IsMatch($issText, 'LogLine\([^\r\n]*GPendingKey')
Add-Check -Name 'static:key-not-logged' -Ok (-not $keyInLog) -Note 'LogLine без GPendingKey'

# --- Сборка тестового установщика -------------------------------------------
Write-Host '=== Сборка тестового установщика ==='
if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$psExe = (Get-Process -Id $PID).Path
$buildArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildScript,
    '-Version', $version,
    '-TestMode',
    '-PayloadRoot', $payloadDir,
    '-OutputDir', $buildDir,
    '-TestAppDir', $appDir,
    '-TestDataDir', $dataDir
)
if ($IsccPath) { $buildArgs += @('-IsccPath', $IsccPath) }
& $psExe @buildArgs
if ($LASTEXITCODE -ne 0) { throw "Сборка тестового установщика не удалась (код $LASTEXITCODE)." }

$script:SetupPath = Join-Path $buildDir "ETN-Setup-test-$version.exe"
if (-not (Test-Path -LiteralPath $script:SetupPath)) { throw "Тестовый установщик не найден: $script:SetupPath" }

$silent = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
$elevated = @('/TESTELEVATED=1')
if ($IsElevated) { $elevated = @() }
$initHooks = @('/TESTINIT=real', "/TESTNODEEXE=$nodeExe")

# --- 1. Первая установка: init один раз, ключ в защищённом файле ------------
Write-Host '=== Первая установка и ключ ==='
Reset-State
$serverPort = Get-FreeTcpPort
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Port $serverPort
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'first-install:code' -Expected 0 -Actual $code
$invocations = Get-Invocations
Add-Check -Name 'first-install:check-once' -Ok ((Count-Checks $invocations) -eq 1) -Note ("трасса: " + $invocations.Count)
Add-Check -Name 'first-install:init-once' -Ok ((Count-Inits $invocations) -eq 1)
$initCall = @($invocations | Where-Object { $_.argv -contains '--username' })[0]
$envOk = $false
$argsOk = $false
if ($initCall) {
    $envOk = ($initCall.env.ETN_DATA_DIR -eq $dataDir) -and
        ($initCall.env.ETN_PORT -eq [string]$serverPort) -and ($initCall.env.ETN_HOST -eq '0.0.0.0')
    $argsOk = ($initCall.argv -contains '--key-out') -and ($initCall.argv -contains 'admin')
}
Add-Check -Name 'first-install:env' -Ok $envOk -Note 'ETN_DATA_DIR/ETN_PORT/ETN_HOST в дочернем процессе'
Add-Check -Name 'first-install:args' -Ok $argsOk -Note '--username admin --key-out'
$key = Read-Key
Add-Check -Name 'first-install:key-file' -Ok ($key -match '^etn_[0-9a-f]{32}$') -Note ("длина " + $key.Length)
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'first-install:keystate' -Ok ($keyState -match 'hasfirstuser=1' -and $keyState -match 'init_attempted=1' -and $keyState -match 'pending=1' -and $keyState -match 'keylen=36') -Note $keyState
$logText = Get-LogText
Add-Check -Name 'first-install:key-not-in-log' -Ok (-not ($logText.Contains($key)))
$jsonPath = Join-Path $dataDir 'install.json'
$jsonText = ''
if (Test-Path -LiteralPath $jsonPath) { $jsonText = Get-Content -LiteralPath $jsonPath -Raw }
Add-Check -Name 'first-install:key-not-in-install-json' -Ok (-not ($jsonText.Contains($key)))
$traceText = ''
$tracePath = Join-Path $dataDir '.fixture-invocations.jsonl'
if (Test-Path -LiteralPath $tracePath) { $traceText = Get-Content -LiteralPath $tracePath -Raw }
Add-Check -Name 'first-install:key-not-in-trace' -Ok (-not ($traceText.Contains($key)))
$keyDir = Join-Path $dataDir '.install'
$acl = Get-Acl -LiteralPath $keyDir
$usersAce = @($acl.Access | Where-Object { $_.IdentityReference -eq 'BUILTIN\Users' })
Add-Check -Name 'first-install:acl-protected' -Ok ([bool]$acl.AreAccessRulesProtected) -Note 'наследование снято'
Add-Check -Name 'first-install:acl-no-users' -Ok ($usersAce.Count -eq 0) -Note 'нет доступа у BUILTIN\Users'

# --- 2. Повторный запуск: init не вызывается, ключ из файла -----------------
Write-Host '=== Повторный запуск (администратор есть) ==='
Start-Sleep -Milliseconds 1100
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Name 'params-repeat.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'repeat:code' -Expected 0 -Actual $code
$invocations = Get-Invocations
Add-Check -Name 'repeat:init-not-called' -Ok ((Count-Inits $invocations) -eq 1) -Note 'всего init за оба запуска'
Add-Check -Name 'repeat:check-called' -Ok ((Count-Checks $invocations) -ge 2)
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'repeat:keystate' -Ok ($keyState -match 'hasfirstuser=1' -and $keyState -match 'init_attempted=0' -and $keyState -match 'pending=1' -and $keyState -match 'previous=1') -Note $keyState
Add-Check -Name 'repeat:same-key' -Ok ((Read-Key) -eq $key) -Note 'ключ не перегенерирован'

# --- 3. Подтверждение «Я сохранил ключ»: файл удалён ------------------------
Write-Host '=== Подтверждение ключа ==='
Start-Sleep -Milliseconds 1100
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Name 'params-ack.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1', '/TESTKEYACK=1') + $initHooks)
Add-Result -Name 'ack:code' -Expected 0 -Actual $code
Add-Check -Name 'ack:key-file-deleted' -Ok (-not (Test-Path -LiteralPath (Get-KeyPath)))
Add-Check -Name 'ack:logged' -Ok ((Get-LogLine -Pattern 'INITACK deleted=(\d)') -eq '1')
Add-Check -Name 'ack:init-not-called' -Ok ((Count-Inits (Get-Invocations)) -eq 1)
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'ack:keystate' -Ok ($keyState -match 'pending=1' -and $keyState -match 'hasfirstuser=1') -Note $keyState

# --- 4. Повтор после подтверждения: ключа нет ------------------------------
Write-Host '=== Повтор после подтверждения ==='
Start-Sleep -Milliseconds 1100
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Name 'params-after-ack.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'after-ack:code' -Expected 0 -Actual $code
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'after-ack:no-pending-key' -Ok ($keyState -match 'pending=0' -and $keyState -match 'hasfirstuser=1') -Note $keyState
Add-Check -Name 'after-ack:init-not-called' -Ok ((Count-Inits (Get-Invocations)) -eq 1)

# --- 5. Сбой после init до показа ключа -------------------------------------
Write-Host '=== Сбой после init до показа ключа ==='
Reset-State
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Name 'params-fail.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1',
    '/TESTFAILAFTERINIT=1') + $initHooks)
Add-Result -Name 'fail-after-init:code' -Expected 10 -Actual $code
$keyAfterFail = Read-Key
Add-Check -Name 'fail-after-init:key-kept' -Ok ($keyAfterFail -match '^etn_[0-9a-f]{32}$') -Note 'ключ не потерян'
Add-Check -Name 'fail-after-init:init-once' -Ok ((Count-Inits (Get-Invocations)) -eq 1)
Start-Sleep -Milliseconds 1100
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Name 'params-restore.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'restore:code' -Expected 0 -Actual $code
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'restore:key-shown' -Ok ($keyState -match 'hasfirstuser=1' -and $keyState -match 'pending=1' -and $keyState -match 'previous=1') -Note $keyState
Add-Check -Name 'restore:same-key' -Ok ((Read-Key) -eq $keyAfterFail) -Note 'показан ключ из защищённого файла'
Add-Check -Name 'restore:init-not-repeated' -Ok ((Count-Inits (Get-Invocations)) -eq 1)
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -Name 'params-restore-ack.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1', '/TESTKEYACK=1') + $initHooks)
Add-Result -Name 'restore:ack-code' -Expected 0 -Actual $code
Add-Check -Name 'restore:key-file-deleted' -Ok (-not (Test-Path -LiteralPath (Get-KeyPath)))

# --- 6. База от прерванной попытки: init доинициализирует -------------------
Write-Host '=== База без администратора (прерванная попытка) ==='
Reset-State
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dataDir '_system.db'), '{"firstUser":false}')
Add-Check -Name 'partial:db-present' -Ok (Test-Path -LiteralPath (Join-Path $dataDir '_system.db'))
$params = New-ParamsFile -Server 1 -Client 0 -Login 'root' -Name 'params-partial.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'partial:code' -Expected 0 -Actual $code
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'partial:initialized' -Ok ($keyState -match 'hasfirstuser=1' -and $keyState -match 'init_attempted=1' -and $keyState -match 'pending=1') -Note $keyState
$initCall = @((Get-Invocations) | Where-Object { $_.argv -contains '--username' })[0]
Add-Check -Name 'partial:login-used' -Ok ([bool]($initCall -and ($initCall.argv -contains 'root')))
Add-Check -Name 'partial:key-file' -Ok ((Read-Key) -match '^etn_[0-9a-f]{32}$')

# --- 7. Silent: init не вызывается, администратор есть ----------------------
Write-Host '=== Silent server-only ==='
$invocationsBefore = Get-Invocations
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/SERVERONLY', '/TESTSERVICE=present', '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'silent:code' -Expected 0 -Actual $code
Add-Check -Name 'silent:init-not-called' -Ok ((Count-Inits (Get-Invocations)) -eq (Count-Inits $invocationsBefore)) -Note 'init в silent запрещён'
$keyState = Get-LogLine -Pattern 'INITSTATE ([^\r\n]+)'
Add-Check -Name 'silent:admin-checked' -Ok ($keyState -match 'hasfirstuser=1' -and $keyState -match 'init_attempted=0') -Note $keyState

# --- 8. Silent без администратора: код 10 (ручной режим) --------------------
Write-Host '=== Silent без администратора ==='
Remove-Item -LiteralPath (Join-Path $dataDir '_system.db') -Force
# Ключ от предыдущего сценария к проверке не относится: убираем его, чтобы
# убедиться, что silent не создаёт новый.
if (Test-Path -LiteralPath (Get-KeyPath)) {
    Remove-Item -LiteralPath (Get-KeyPath) -Force
}
Start-Sleep -Milliseconds 1100
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/SERVERONLY', '/TESTSERVICE=present', '/TESTHEALTH=ok') + $initHooks)
Add-Result -Name 'silent-no-admin:code' -Expected 10 -Actual $code
Add-Check -Name 'silent-no-admin:init-not-called' -Ok ((Count-Inits (Get-Invocations)) -eq (Count-Inits $invocationsBefore))
Add-Check -Name 'silent-no-admin:log' -Ok ([bool](Get-LogLine -Pattern '(нет первого администратора[^\r\n]*)')) -Note 'причина в журнале'
Add-Check -Name 'silent-no-admin:no-key' -Ok (-not (Test-Path -LiteralPath (Get-KeyPath)))

# --- 9. display_name из /PARAMS: та же проверка, что у логина ----------------
# Кавычка в отображаемом имени ломает командную строку etn init: установщик
# обязан отказаться (код 10) и не вызывать init (дефект приёмки каркаса 9b310991).
Write-Host '=== Недопустимый display_name из файла параметров ==='
Reset-State
$params = New-ParamsFile -Server 1 -Client 0 -Login 'admin' -DisplayName 'Bad"Name' -Name 'params-badname.ini'
$code = Invoke-Setup -Arguments (@($silent) + $elevated + @(
    '/PRIVILEGEDPHASE', "/PARAMS=`"$params`"", '/TESTHEALTH=ok', '/TESTKEYSTATE=1') + $initHooks)
Add-Result -Name 'bad-display-name:code' -Expected 10 -Actual $code
Add-Check -Name 'bad-display-name:init-not-called' -Ok ((Count-Inits (Get-Invocations)) -eq 0) -Note 'init не запускался'
Add-Check -Name 'bad-display-name:log' `
    -Ok ([bool](Get-LogLine -Pattern '(недопустимое отображаемое имя[^\r\n]*)')) -Note 'причина в журнале'
Add-Check -Name 'bad-display-name:no-key' -Ok (-not (Test-Path -LiteralPath (Get-KeyPath)))

# --- Итог --------------------------------------------------------------------
$failed = @($script:results | Where-Object { -not $_.Ok })
Write-Host ''
Write-Host ("Итого: {0} проверок, провалено {1}" -f $script:results.Count, $failed.Count)
if ($failed.Count -gt 0) {
    $failed | Format-Table -AutoSize | Out-String | Write-Host
    exit 1
}
if (-not $KeepArtifacts) { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue }
exit 0
