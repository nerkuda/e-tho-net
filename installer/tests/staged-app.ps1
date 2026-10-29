<#
.SYNOPSIS
    Staged-проверка установленного сервера ETN в режиме «приложение».

.DESCRIPTION
    Ставит установщик в тестовой сборке (installer/build.ps1 -TestMode), но с
    НАСТОЯЩИМ payload (installer/payload), в изолированные каталоги
    .tmp\installer-staged: каталог программы и каталог данных — песочница,
    реестр и служба не затрагиваются. Затем проверяет установленную раскладку
    и запускает сервер так, как его запускает режим «обычное приложение»:

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
         GET /api/v1/health → 200, status=ok, версия из payload.

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

# --- Staged-запуск в режиме «приложение» ------------------------------------
Write-Host '=== Запуск установленного сервера (режим приложения) ==='
$stdoutLog = Join-Path $workRoot 'server.out.log'
$stderrLog = Join-Path $workRoot 'server.err.log'
$previousEnv = @{
    ETN_DATA_DIR = $env:ETN_DATA_DIR
    ETN_PORT     = $env:ETN_PORT
    ETN_HOST     = $env:ETN_HOST
}
$serverProcess = $null
$health = $null
$healthOk = $false
try {
    $env:ETN_DATA_DIR = $dataDir
    $env:ETN_PORT = [string]$port
    $env:ETN_HOST = '127.0.0.1'
    $serverProcess = Start-Process -FilePath $installedNode `
        -ArgumentList 'dist/index.js' `
        -WorkingDirectory (Join-Path $appDir 'server') `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    $deadline = (Get-Date).AddSeconds(90)
    $lastError = ''
    while ((Get-Date) -lt $deadline) {
        if ($serverProcess.HasExited) {
            $tail = Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue
            throw "Сервер завершился с кодом $($serverProcess.ExitCode) до health-check. stderr: $tail"
        }
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v1/health" `
                -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                $health = $response.Content | ConvertFrom-Json
                $healthOk = $true
                break
            }
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $healthOk) {
        $tail = Get-Content -LiteralPath $stderrLog -Raw -ErrorAction SilentlyContinue
        throw "Health-check не прошёл за 90 с: $lastError. stderr: $tail"
    }
    Add-Check -Name 'app:health-200' -Ok $true -Note 'GET /api/v1/health'
    Add-Check -Name 'app:health-status' -Ok ($health.status -eq 'ok') -Note ([string]$health.status)
    Add-Check -Name 'app:health-version' -Ok ($health.version -eq $payloadVersion) `
        -Note ([string]$health.version + ' (payload ' + $payloadVersion + ')')
} finally {
    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $null = $serverProcess.WaitForExit(15000)
    }
    $env:ETN_DATA_DIR = $previousEnv.ETN_DATA_DIR
    $env:ETN_PORT = $previousEnv.ETN_PORT
    $env:ETN_HOST = $previousEnv.ETN_HOST
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
