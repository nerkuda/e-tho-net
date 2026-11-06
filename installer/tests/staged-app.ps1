<#
.SYNOPSIS
    Staged-проверка установленного сервера ETN в режиме «приложение».

.DESCRIPTION
    Ставит установщик в тестовой сборке (installer/build.ps1 -TestMode), но с
    НАСТОЯЩИМ payload (installer/payload), в изолированные каталоги
    .tmp\installer-staged: каталог программы и каталог данных — песочница,
    реестр и служба не затрагиваются. Затем проверяет установленную раскладку
    и запускает сервер двумя способами: как режим «обычное приложение» и с
    окружением из сгенерированного конфига службы:

      node.exe server\dist\index.js
      ETN_DATA_DIR=<каталог данных> ETN_PORT=<порт> ETN_HOST=127.0.0.1

    Проверяется:
      1. установка server-only: файлы поставки, install.json, etn init
         (реальный CLI) создал _system.db и ключ в защищённом каталоге;
      2. подстановка шаблона службы: нет плейсхолдеров, executable/arguments
         указывают на существующие файлы установленной раскладки;
      3. каталоги данных logs\service и backups созданы установщиком;
      4. правило брандмауэра «создано» (netsh подменён тестовым хуком);
      5. сервер из установленного каталога стартует и отвечает
         GET /api/v1/health → 200, status=ok, версия из payload;
      6. режим развёртывания (ошибка e375123f): «приложение» без
         ETN_DEPLOYMENT отдаёт deployment=standalone, а сервер, запущенный
         с окружением из сгенерированного etn-service.xml (включая
         ETN_DEPLOYMENT=windows-service), — deployment=windows-service
         в GET /api/v1/system/update.

    Задача 9b310991 (0.15.1): staged-запуск хотя бы в режиме «приложение».
    Нужен подготовленный payload: pwsh -File installer/fetch-payload.ps1.

.PARAMETER IsccPath
    Путь к ISCC.exe (передаётся в build.ps1).

.PARAMETER KeepArtifacts
    Не удалять .tmp\installer-staged после прогона.

.PARAMETER TimeoutSec
    Таймаут одного прогона установщика, секунд.

.EXAMPLE
    pwsh -File installer/tests/staged-app.ps1
#>
[CmdletBinding()]
param(
    [string]$IsccPath,
    [switch]$KeepArtifacts,
    [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installerDir = Join-Path $repoRoot 'installer'
$buildScript = Join-Path $installerDir 'build.ps1'
$payloadDir = Join-Path $installerDir 'payload'
$workRoot = Join-Path $repoRoot '.tmp\installer-staged'
$appDir = Join-Path $workRoot 'app'
$dataDir = Join-Path $workRoot 'data'
$buildDir = Join-Path $workRoot 'build'
$script:results = New-Object System.Collections.Generic.List[object]

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

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
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

# --- Предусловия: настоящий payload подготовлен -----------------------------
$requiredPayload = @(
    (Join-Path $payloadDir 'node\node.exe'),
    (Join-Path $payloadDir 'server\dist\index.js'),
    (Join-Path $payloadDir 'server\dist\cli.js'),
    (Join-Path $payloadDir 'service\etn-service.exe'),
    (Join-Path $payloadDir 'service\etn-service.xml'),
    (Join-Path $payloadDir 'server\node_modules\better-sqlite3\package.json'))
foreach ($required in $requiredPayload) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw ("Нет настоящего payload: $required. " +
            'Подготовьте его: pwsh -File installer/fetch-payload.ps1')
    }
}
$payloadServerPkg = Get-Content -LiteralPath (Join-Path $payloadDir 'server\package.json') -Raw -Encoding UTF8 |
    ConvertFrom-Json
$payloadVersion = [string]$payloadServerPkg.version
$version = $payloadVersion

# --- Чистые каталоги и сборка тестового установщика на настоящем payload ----
if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

Write-Host '=== Сборка тестового установщика на настоящем payload ==='
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

# --- Установка server-only с реальным etn init ------------------------------
Write-Host '=== Установка server-only (реальный etn init) ==='
New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
$port = Get-FreeTcpPort
$paramsPath = Join-Path $workRoot 'params.ini'
$paramsText = "server=1`r`nclient=0`r`nclient_scope=user`r`nmode=service`r`n" +
    "host=0.0.0.0`r`nport=$port`r`nfirewall=1`r`nlogin=staged`r`n" +
    "display_name=Staged Test`r`noriginal_user=$env:USERNAME`r`n"
[System.IO.File]::WriteAllText($paramsPath, $paramsText)

$silent = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
$hooks = @('/PRIVILEGEDPHASE', "/PARAMS=`"$paramsPath`"", '/TESTELEVATED=1',
    '/TESTHEALTH=ok', '/TESTINIT=real')
$code = Invoke-Setup -Arguments ($silent + $hooks)
Add-Result -Name 'install:code' -Expected 0 -Actual $code

$stagedLayout = (Test-Path -LiteralPath (Join-Path $appDir 'node\node.exe')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'server\dist\index.js')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'server\dist\cli.js')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'service\etn-service.exe')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'service\etn-service.xml'))
Add-Check -Name 'install:payload-layout' -Ok $stagedLayout -Note 'node, server\dist, service на месте'

$nodeVersion = ''
$installedNode = Join-Path $appDir 'node\node.exe'
if (Test-Path -LiteralPath $installedNode) { $nodeVersion = (& $installedNode -v).Trim() }
Add-Check -Name 'install:node-version' -Ok ($nodeVersion -match '^v22\.') -Note $nodeVersion

$installJsonPath = Join-Path $dataDir 'install.json'
$installJsonOk = $false
if (Test-Path -LiteralPath $installJsonPath) {
    $jsonText = Get-Content -LiteralPath $installJsonPath -Raw
    $installJsonOk = ($jsonText -match ('"port":' + $port + ',')) -and
        ($jsonText -match '"mode":"service"') -and ($jsonText -match '"firewall":true')
}
Add-Check -Name 'install:install-json' -Ok $installJsonOk -Note 'port/mode/firewall'

$systemDb = Test-Path -LiteralPath (Join-Path $dataDir '_system.db')
Add-Check -Name 'init:system-db' -Ok $systemDb -Note 'реальный etn init создал базу'
$keyPath = Join-Path $dataDir '.install\primary-key.txt'
$key = ''
if (Test-Path -LiteralPath $keyPath) { $key = ([System.IO.File]::ReadAllText($keyPath)).Trim() }
Add-Check -Name 'init:key-file' -Ok ($key -match '^etn_[0-9a-f]{32}$') -Note ("длина " + $key.Length)

$serviceDirs = (Test-Path -LiteralPath (Join-Path $dataDir 'logs\service')) -and
    (Test-Path -LiteralPath (Join-Path $dataDir 'backups'))
Add-Check -Name 'install:data-dirs' -Ok $serviceDirs -Note 'logs\service и backups'

# --- Подстановка шаблона службы: пути указывают на установленную раскладку ---
Write-Host '=== Конфигурация службы ==='
$serviceXmlPath = Join-Path $appDir 'service\etn-service.xml'
$serviceText = [System.IO.File]::ReadAllText($serviceXmlPath, [System.Text.Encoding]::UTF8)
Add-Check -Name 'service:no-placeholders' -Ok (-not $serviceText.Contains('{{'))
$serviceXmlOk = $false
$executableOk = $false
$argumentsOk = $false
try {
    $serviceXml = [xml]$serviceText
    $serviceXmlOk = $true
    $serviceDir = Join-Path $appDir 'service'
    $executable = ([string]$serviceXml.service.executable).Replace('%BASE%', $serviceDir)
    $arguments = ([string]$serviceXml.service.arguments).Trim('"').Replace('%BASE%', $serviceDir)
    $executableOk = Test-Path -LiteralPath ([System.IO.Path]::GetFullPath($executable))
    $argumentsOk = Test-Path -LiteralPath ([System.IO.Path]::GetFullPath($arguments))
} catch {
    Write-Host ("      etn-service.xml не разобран: {0}" -f $_.Exception.Message)
}
Add-Check -Name 'service:xml-parsed' -Ok $serviceXmlOk
Add-Check -Name 'service:executable-exists' -Ok $executableOk -Note 'node.exe рядом с {app}'
Add-Check -Name 'service:arguments-exist' -Ok $argumentsOk -Note 'server\dist\index.js рядом с {app}'

$logDir = Join-Path $dataDir 'logs'
$logText = ''
$latestLog = Get-ChildItem -LiteralPath $logDir -Filter 'install-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestLog) { $logText = Get-Content -LiteralPath $latestLog.FullName -Raw }
Add-Check -Name 'service:firewall-log' -Ok ($logText -match ('Правило брандмауэра создано: TCP ' + $port)) `
    -Note 'правило создано (тестовый netsh)'

# --- Бэкап БД: инструмент CLI и настоящий ZIP из установленной поставки -----
# ce3ab836 / 3acd9c3c: хук /TESTBACKUP запускает ту же функцию, что вызовет
# ветка обновления, но без /TESTNODEEXE — инструмент обязан отработать на
# реальных node.exe и server\node_modules установленной раскладки, а архив —
# быть ZIP по спецификации (сущность 2975c553): _system.db и networks\...\
# data.db, без WAL/SHM. Прогон идёт после чтения журнала установки: свой журнал
# он не должен подменять проверку выше.
Write-Host '=== Бэкап БД: инструмент CLI и ZIP из поставки ==='
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1'))
Add-Check -Name 'backup:code' -Ok ($code -eq 0) -Note 'node.exe поставки, без тестового хука'
$backupsDir = Join-Path $dataDir 'backups'
$archives = @(Get-ChildItem -LiteralPath $backupsDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^etn-backup-(.+)-(\d{8}-\d{6})(?:-(\d+))?\.zip$' })
Add-Check -Name 'backup:archive' -Ok ($archives.Count -eq 1) `
    -Note (($archives | ForEach-Object { $_.Name }) -join ', ')
if ($archives.Count -ge 1) {
    $archive = $archives[0]
    $unpacked = Join-Path $workRoot ('backup-unpack-' + [guid]::NewGuid().ToString('N'))
    $zipOk = $false
    try {
        Expand-Archive -LiteralPath $archive.FullName -DestinationPath $unpacked -Force
        $zipOk = Test-Path -LiteralPath (Join-Path $unpacked '_system.db')
    } catch {
        Write-Host ("      архив не распакован: {0}" -f $_.Exception.Message)
    }
    Add-Check -Name 'backup:zip' -Ok $zipOk -Note 'ZIP с _system.db'
    if ($zipOk) {
        $archiveDb = Join-Path $unpacked '_system.db'
        $integrityScript = @'
const Database=require('better-sqlite3');
const db=new Database(process.argv[1]);
const rows=db.pragma('integrity_check');
db.close();
console.log(rows.length===1&&String(rows[0].integrity_check)==='ok'?'ok':'bad');
'@
        $installedNode = Join-Path $appDir 'node\node.exe'
        Push-Location (Join-Path $appDir 'server')
        try {
            $integrityOut = @(& $installedNode -e $integrityScript $archiveDb 2>&1)
            $integrityCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        $integrityOk = ($integrityCode -eq 0) -and
            ([string]($integrityOut | Select-Object -Last 1) -eq 'ok')
        Add-Check -Name 'backup:integrity' -Ok $integrityOk `
            -Note ('node.exe поставки; ' + [string]($integrityOut | Select-Object -Last 1))
    } else {
        Add-Check -Name 'backup:integrity' -Ok $false -Note 'архив не распакован'
    }
} else {
    Add-Check -Name 'backup:zip' -Ok $false -Note 'архив не создан'
    Add-Check -Name 'backup:integrity' -Ok $false -Note 'архив не создан'
}

# --- Staged-запуск: режим «приложение» и окружение из конфигурации службы ---
Write-Host '=== Запуск установленного сервера: приложение и окружение службы ==='

# Переменные окружения сервера: недостающий ключ удаляется из процесса, чтобы
# прогоны не наследовали режим друг друга (в частности ETN_DEPLOYMENT).
function Set-StagedServerEnv {
    param([hashtable]$ServerEnv)
    foreach ($name in @('ETN_DATA_DIR', 'ETN_PORT', 'ETN_HOST', 'ETN_DEPLOYMENT')) {
        $value = $null
        if ($ServerEnv.ContainsKey($name)) { $value = $ServerEnv[$name] }
        [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

# Окружение службы — ровно env из сгенерированного etn-service.xml, то есть
# то, что WinSW передаст серверу при старте службы (ошибка e375123f).
function Get-StagedServiceEnv {
    param([string]$Path)
    $result = @{}
    $xml = [xml]([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8))
    foreach ($node in @($xml.SelectNodes('/service/env'))) {
        $result[[string]$node.GetAttribute('name')] = [string]$node.GetAttribute('value')
    }
    return $result
}

function Start-StagedServer {
    param([string]$Name, [hashtable]$ServerEnv, [int]$HealthTimeoutSec = 90)
    $outLog = Join-Path $workRoot ("server-$Name.out.log")
    $errLog = Join-Path $workRoot ("server-$Name.err.log")
    Set-StagedServerEnv -ServerEnv $ServerEnv
    $serverPort = [int]$ServerEnv['ETN_PORT']
    $process = Start-Process -FilePath $installedNode `
        -ArgumentList 'dist/index.js' `
        -WorkingDirectory (Join-Path $appDir 'server') `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog

    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $lastError = ''
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) {
            $tail = Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue
            throw "Сервер ($Name) завершился с кодом $($process.ExitCode) до health-check. stderr: $tail"
        }
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$serverPort/api/v1/health" `
                -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                return [pscustomobject]@{
                    Process = $process
                    Health  = ($response.Content | ConvertFrom-Json)
                    Port    = $serverPort
                }
            }
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    $tail = Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Health-check ($Name) не прошёл за $HealthTimeoutSec с: $lastError. stderr: $tail"
}

function Stop-StagedServer {
    param($Server)
    if ($null -eq $Server) { return }
    if (-not $Server.Process.HasExited) {
        Stop-Process -Id $Server.Process.Id -Force -ErrorAction SilentlyContinue
        $null = $Server.Process.WaitForExit(15000)
    }
}

function Get-StagedAdminJson {
    param([int]$ServerPort, [string]$Path, [string]$Key)
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:$ServerPort" + $Path) `
        -Headers @{ Authorization = "Bearer $Key" } -UseBasicParsing -TimeoutSec 5
    # Контракт API: полезная нагрузка — в поле data.
    $json = $response.Content | ConvertFrom-Json
    return $json.data
}

$serviceEnvForServer = Get-StagedServiceEnv -Path $serviceXmlPath
Add-Check -Name 'service:deployment-env' `
    -Ok ($serviceEnvForServer['ETN_DEPLOYMENT'] -eq 'windows-service') `
    -Note ('ETN_DEPLOYMENT=' + [string]$serviceEnvForServer['ETN_DEPLOYMENT'])

$previousEnv = @{}
foreach ($name in @('ETN_DATA_DIR', 'ETN_PORT', 'ETN_HOST', 'ETN_DEPLOYMENT')) {
    $previousEnv[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}
$appServer = $null
$serviceServer = $null
try {
    # 1. Режим «приложение»: без ETN_DEPLOYMENT сервер обязан считать себя
    #    standalone — иначе app-установка получила бы чужой режим.
    $appServer = Start-StagedServer -Name 'app' -ServerEnv @{
        ETN_DATA_DIR = $dataDir
        ETN_PORT     = [string]$port
        ETN_HOST     = '127.0.0.1'
    }
    $health = $appServer.Health
    Add-Check -Name 'app:health-200' -Ok $true -Note 'GET /api/v1/health'
    Add-Check -Name 'app:health-status' -Ok ($health.status -eq 'ok') -Note ([string]$health.status)
    Add-Check -Name 'app:health-version' -Ok ($health.version -eq $payloadVersion) `
        -Note ([string]$health.version + ' (payload ' + $payloadVersion + ')')
    $appUpdate = Get-StagedAdminJson -ServerPort $appServer.Port -Path '/api/v1/system/update' -Key $key
    Add-Check -Name 'app:deployment-standalone' -Ok ($appUpdate.deployment -eq 'standalone') `
        -Note ('deployment=' + [string]$appUpdate.deployment)
    Stop-StagedServer $appServer
    $appServer = $null

    # 2. Окружение службы из сгенерированного конфига: сервер должен назвать
    #    себя windows-service, иначе обновление из клиента отказывает как
    #    «сервер запущен не службой» (ошибка e375123f).
    $serviceServer = Start-StagedServer -Name 'service' -ServerEnv $serviceEnvForServer
    $svcHealth = $serviceServer.Health
    Add-Check -Name 'service:health-200' -Ok $true -Note 'GET /api/v1/health'
    Add-Check -Name 'service:health-status' -Ok ($svcHealth.status -eq 'ok') -Note ([string]$svcHealth.status)
    $svcUpdate = Get-StagedAdminJson -ServerPort $serviceServer.Port -Path '/api/v1/system/update' -Key $key
    Add-Check -Name 'service:deployment-windows-service' `
        -Ok ($svcUpdate.deployment -eq 'windows-service') `
        -Note ('deployment=' + [string]$svcUpdate.deployment)
} finally {
    Stop-StagedServer $appServer
    Stop-StagedServer $serviceServer
    foreach ($name in $previousEnv.Keys) {
        [System.Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process')
    }
}

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
