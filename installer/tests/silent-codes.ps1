<#
.SYNOPSIS
    Проверка silent-контракта установщика ETN (коды 0 / 10 / 20).

.DESCRIPTION
    Собирает тестовый установщик (installer/build.ps1 -TestMode) с фиктивным
    payload из installer/tests/fixtures/payload и прогоняет матрицу сценариев
    silent server-only режима. Тестовая сборка изолирована: каталоги программы
    и данных — во временном каталоге .tmp\installer-tests, деинсталлятор не
    создаётся, реестр не затрагивается.

    Проверяется:
      1. /VERYSILENT без /SERVERONLY                          -> 20
      2. нет install.json                                      -> 20
      3. режим app                                            -> 20
      4. повреждённый install.json                             -> 20
      5. нет файлов сервера                                    -> 20
      6. нет службы                                            -> 20
      7. процесс не элевирован                                 -> 20
      8. неуспешный health-check                               -> 10
      9. успех: файлы на месте, install.json записан           -> 0
     10. повторный запуск той же версии                        -> 0
     11. понижение версии                                      -> 20
     12. ключ из файла параметров не попадает в журнал          (redaction)
     13. в .iss нет MsgBox (только журнал); прогоны без окон и без зависаний
     14. B2: {autopf} при обычном запуске — каталог пользователя
     15. B1: привилегированная фаза на чистой машине (без install.json/службы)
     16. B3/B5/Z3: состояние машины и галочки по умолчанию
         (not-installed/installed/update-available/repair/adopt/downgrade)
     17. B4: клиент «для всех» ставится, «для меня» — неэлевированной фазой
     18. Z2: last_log обновляется каждый запуск, повтор версии не меняет версию

    Коды Inno 1–8 контрактом не являются; тест падает на любом отклонении.

    Задача a1211915 (0.15.1).

.PARAMETER IsccPath
    Путь к ISCC.exe (передаётся в build.ps1).

.PARAMETER KeepArtifacts
    Не удалять рабочий каталог .tmp\installer-tests после прогона.

.PARAMETER TimeoutSec
    Таймаут одного прогона установщика, секунд (зависание = провал).

.EXAMPLE
    pwsh -File installer/tests/silent-codes.ps1
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
$workRoot = Join-Path $repoRoot '.tmp\installer-tests'
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
    Write-Host ("{0}  {1,-28} ожидалось {2,2}, получено {3,2}  {4}" -f $mark, $Name, $Expected, $Actual, $Note)
}

function Reset-State {
    foreach ($dir in @($appDir, $dataDir)) {
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
}

function Write-InstallJson {
    param([string]$Json)
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $dataDir 'install.json'), $Json + "`r`n",
        (New-Object System.Text.UTF8Encoding($false)))
}

function New-InstallJson {
    param([string]$ProductVersion = '0.15.0', [string]$Mode = 'service')
    $dataEscaped = $dataDir.Replace('\', '\\')
    return '{"schema":1,"product_version":"' + $ProductVersion + '","mode":"' + $Mode +
        '","data_dir":"' + $dataEscaped + '","host":"0.0.0.0","port":4321,' +
        '"firewall":true,"client_scope":null,"installed_at":"2026-10-01T10:00:00","last_log":""}'
}

function New-ServerFiles {
    param([string]$Version = '0.15.0')
    New-Item -ItemType Directory -Path (Join-Path $appDir 'server\dist') -Force | Out-Null
    $null = New-Item -ItemType Directory -Path (Join-Path $appDir 'server\node_modules') -Force
    [System.IO.File]::WriteAllText((Join-Path $appDir 'server\package.json'),
        '{"name":"@etn/server","version":"' + $Version + '"}')
    [System.IO.File]::WriteAllText((Join-Path $appDir 'server\dist\index.js'), '// stub')
}

function New-ParamsFile {
    param(
        [int]$Server = 1,
        [int]$Client = 0,
        [string]$Scope = 'user',
        [string]$Mode = 'service',
        [string]$Port = '4321',
        [string]$Name = 'params.ini'
    )
    $path = Join-Path $workRoot $Name
    $text = "server=$Server`r`nclient=$Client`r`nclient_scope=$Scope`r`nmode=$Mode`r`nhost=0.0.0.0`r`nport=$Port`r`nfirewall=1`r`n"
    [System.IO.File]::WriteAllText($path, $text)
    return $path
}

function Get-LogLine {
    param([string]$Pattern)
    $log = Get-LatestLog
    if (-not $log) { return '' }
    $text = Get-Content -LiteralPath $log.FullName -Raw
    $m = [regex]::Match($text, $Pattern)
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Invoke-StateProbe {
    param([string[]]$ExtraArgs = @())
    $code = Invoke-Setup -Arguments (@($silent) + @('/TESTSTATE=1') + $ExtraArgs)
    return [pscustomobject]@{
        Code   = $code
        State  = (Get-LogLine -Pattern 'TESTSTATE ([^\r\n]+)')
        Autopf = (Get-LogLine -Pattern 'autopf=([^;\r\n]+)')
    }
}

function Add-StateResult {
    param([string]$Name, [string]$Line, [string[]]$Pairs, [string]$Note = '')
    $map = @{}
    foreach ($part in (([string]$Line) -split '\s+')) {
        if ($part -match '^([^=]+)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
    }
    $bad = New-Object System.Collections.Generic.List[string]
    foreach ($pair in $Pairs) {
        $kv = $pair -split '=', 2
        if ($kv.Count -lt 2) { continue }
        $key = $kv[0]
        $expected = $kv[1]
        $actual = '<нет>'
        if ($map.ContainsKey($key)) { $actual = $map[$key] }
        if ($actual -ne $expected) { $bad.Add("$key=$actual (ожидалось $expected)") }
    }
    $ok = ($bad.Count -eq 0)
    $text = if ($ok) { $Pairs -join ' ' } else { $bad -join '; ' }
    if ($Note) { $text = $text + '  ' + $Note }
    $script:results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$ok; Ok = $ok; Note = $text })
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-34} {2}" -f $mark, $Name, $text)
}

function Get-LatestLog {
    $logDir = Join-Path $dataDir 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { return $null }
    return Get-ChildItem -LiteralPath $logDir -Filter 'install-*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
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

# --- Подготовка рабочего каталога -------------------------------------------
if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

Write-Host '=== Статические проверки .iss ==='
$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$msgBoxMatches = [regex]::Matches($issText, '(?<!Suppressible)MsgBox\s*\(')
if ($msgBoxMatches.Count -gt 0) {
    $script:results.Add([pscustomobject]@{ Scenario = 'static:no-msgbox'; Expected = 0; Actual = $msgBoxMatches.Count; Ok = $false; Note = 'MsgBox в .iss' })
    Write-Host ("FAIL  static:no-msgbox              найдено MsgBox: {0}" -f $msgBoxMatches.Count)
} else {
    $script:results.Add([pscustomobject]@{ Scenario = 'static:no-msgbox'; Expected = 0; Actual = 0; Ok = $true; Note = '' })
    Write-Host 'OK    static:no-msgbox              MsgBox в .iss нет'
}
foreach ($required in @('/SUPPRESSMSGBOXES', '/NORESTART', 'SERVERONLY', 'GetCustomSetupExitCode')) {
    $present = $issText.Contains($required)
    $markText = 'OK  '
    $presentText = 'есть'
    if (-not $present) { $markText = 'FAIL'; $presentText = 'НЕТ' }
    $script:results.Add([pscustomobject]@{ Scenario = "static:$required"; Expected = 1; Actual = [int]$present; Ok = $present; Note = '' })
    Write-Host ("{0}  static:{1,-20} {2}" -f $markText, $required, $presentText)
}
# B2: каталог программы выбирается по режиму установки ({autopf}), а не жёстко
# из Program Files — иначе неэлевированный экземпляр падает с Error 5.
$staticChecks = @(
    @{ Name = 'static:autopf-appdir'; Text = '#define AppDir "{autopf}\ETN"'; Note = 'каталог программы по режиму установки' },
    @{ Name = 'static:defaultdir-app'; Text = 'DefaultDirName={#AppDir}'; Note = '' },
    @{ Name = 'static:privileged-phase'; Text = 'ValidatePrivilegedPhasePreconditions'; Note = 'отдельная привилегированная фаза' }
)
foreach ($check in $staticChecks) {
    $present = $issText.Contains($check.Text)
    $markText = if ($present) { 'OK  ' } else { 'FAIL' }
    $script:results.Add([pscustomobject]@{ Scenario = $check.Name; Expected = 1; Actual = [int]$present; Ok = $present; Note = $check.Note })
    Write-Host ("{0}  {1,-28} {2}" -f $markText, $check.Name, $check.Note)
}

# --- Сборка тестового установщика -------------------------------------------
Write-Host '=== Сборка тестового установщика ==='
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

# --- 1. /VERYSILENT без /SERVERONLY -----------------------------------------
Reset-State
$code = Invoke-Setup -Arguments ($silent)
Add-Result -Name 'no-serveronly' -Expected 20 -Actual $code -Note 'тихая установка клиента запрещена'
$appCreated = Test-Path -LiteralPath (Join-Path $appDir 'server')
Add-Result -Name 'no-serveronly:no-changes' -Expected 0 -Actual ([int]$appCreated) -Note 'каталог программы не создан'

# --- 2. нет install.json ----------------------------------------------------
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present'))
Add-Result -Name 'no-install-json' -Expected 20 -Actual $code

# --- 3. режим app -----------------------------------------------------------
Reset-State
Write-InstallJson (New-InstallJson -Mode 'app')
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present'))
Add-Result -Name 'mode-app' -Expected 20 -Actual $code -Note 'самообновление только для службы'

# --- 4. повреждённый install.json -------------------------------------------
Reset-State
Write-InstallJson '{"schema":1,"product_version":'
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present'))
Add-Result -Name 'corrupt-install-json' -Expected 20 -Actual $code

# --- 5. нет файлов сервера ---------------------------------------------------
Reset-State
Write-InstallJson (New-InstallJson)
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present'))
Add-Result -Name 'missing-server-files' -Expected 20 -Actual $code

# --- 6. нет службы -----------------------------------------------------------
Reset-State
Write-InstallJson (New-InstallJson)
New-ServerFiles
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=absent'))
Add-Result -Name 'missing-service' -Expected 20 -Actual $code

# --- 7. процесс не элевирован -----------------------------------------------
if ($IsElevated) {
    Write-Host 'SKIP  not-elevated                  прогон идёт в элевированном процессе'
} else {
    Reset-State
    Write-InstallJson (New-InstallJson)
    New-ServerFiles
    $code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTSERVICE=present'))
    Add-Result -Name 'not-elevated' -Expected 20 -Actual $code
}

# --- 8. неуспешный health-check ---------------------------------------------
Reset-State
Write-InstallJson (New-InstallJson -ProductVersion '0.15.0')
New-ServerFiles
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present', '/TESTHEALTH=fail'))
Add-Result -Name 'health-check-failed' -Expected 10 -Actual $code
$jsonAfterFail = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$keptOld = $jsonAfterFail -match '"product_version":"0\.15\.0"'
Add-Result -Name 'health-fail:json-unchanged' -Expected 1 -Actual ([int]$keptOld) -Note 'install.json не объявляет новую версию'

# --- 9. успех ----------------------------------------------------------------
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present', '/TESTHEALTH=ok'))
Add-Result -Name 'success' -Expected 0 -Actual $code
$json = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$versionOk = [int]($json -match ('"product_version":"' + [regex]::Escape($version) + '"'))
Add-Result -Name 'success:install-json' -Expected 1 -Actual $versionOk
$lastLog = $null
if ($json -match '"last_log":"([^"]+)"') { $lastLog = $Matches[1].Replace('\\', '\') }
$logExists = $lastLog -and (Test-Path -LiteralPath $lastLog)
Add-Result -Name 'success:last-log' -Expected 1 -Actual ([int][bool]$logExists) -Note ([string]$lastLog)
$filesOk = (Test-Path -LiteralPath (Join-Path $appDir 'server\package.json')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'server\dist\index.js')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'node\node.exe')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'service\etn-service.xml'))
Add-Result -Name 'success:payload-files' -Expected 1 -Actual ([int]$filesOk)

# --- 10. повторный запуск той же версии -------------------------------------
Start-Sleep -Milliseconds 1100
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present', '/TESTHEALTH=ok'))
Add-Result -Name 'repeat-same-version' -Expected 0 -Actual $code -Note 'изменений нет'
$jsonRepeat = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$lastLog2 = $null
if ($jsonRepeat -match '"last_log":"([^"]+)"') { $lastLog2 = $Matches[1].Replace('\\', '\') }
$logAdvanced = $lastLog2 -and ($lastLog2 -ne $lastLog)
Add-Result -Name 'repeat:last-log-updated' -Expected 1 -Actual ([int][bool]$logAdvanced) -Note ("{0} -> {1}" -f $lastLog, $lastLog2)
$log2Exists = $lastLog2 -and (Test-Path -LiteralPath $lastLog2)
Add-Result -Name 'repeat:last-log-exists' -Expected 1 -Actual ([int][bool]$log2Exists)
$versionKept = $jsonRepeat -match ('"product_version":"' + [regex]::Escape($version) + '"')
Add-Result -Name 'repeat:version-kept' -Expected 1 -Actual ([int]$versionKept)

# --- 11. понижение версии ----------------------------------------------------
Reset-State
Write-InstallJson (New-InstallJson -ProductVersion '0.16.0')
New-ServerFiles
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present', '/TESTHEALTH=ok'))
Add-Result -Name 'downgrade' -Expected 20 -Actual $code -Note 'понижение запрещено'

# --- 12. секрет из файла параметров не попадает в журнал --------------------
Reset-State
Write-InstallJson (New-InstallJson)
New-ServerFiles
$paramsFile = Join-Path $workRoot 'params.ini'
[System.IO.File]::WriteAllText($paramsFile, "server=1`r`nApiKey=TOPSECRET-SENTINEL`r`n")
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present', '/TESTHEALTH=ok', '/PRIVILEGEDPHASE', "/PARAMS=`"$paramsFile`""))
Add-Result -Name 'params-file' -Expected 0 -Actual $code
$logFile = Get-LatestLog
$logText = ''
if ($logFile) { $logText = Get-Content -LiteralPath $logFile.FullName -Raw }
$secretLeaked = $logText.Contains('TOPSECRET-SENTINEL')
Add-Result -Name 'no-secret-in-log' -Expected 0 -Actual ([int]$secretLeaked) -Note 'ключ не пишется в журнал'
$redacted = $logText -match 'apikey=\*\*\*'
Add-Result -Name 'secret-redacted' -Expected 1 -Actual ([int]$redacted)

# ============================================================================
# Замечания независимой проверки: B1–B5, Z2, Z3.
# ============================================================================

# --- B2: каталог программы по режиму установки ({autopf}) --------------------
Write-Host '=== Каталог программы: per-user и {autopf} ==='
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/CURRENTUSER')
$expectedAutopf = Join-Path $env:LOCALAPPDATA 'Programs'
$autopfOk = ($probe.Autopf.Trim() -eq $expectedAutopf)
Add-Result -Name 'per-user-autopf' -Expected 1 -Actual ([int]$autopfOk) -Note ("autopf=" + $probe.Autopf + " (ожидалось " + $expectedAutopf + ")")

# --- B3, B5, Z3: состояние машины и галочки по умолчанию --------------------
Write-Host '=== Состояние машины и выбор компонентов ==='
Reset-State
$probe = Invoke-StateProbe
Add-Result -Name 'state-clean:code' -Expected 0 -Actual $probe.Code
Add-StateResult -Name 'state-clean:defaults' -Line $probe.State -Pairs @(
    'server_state=not-installed', 'client_state=not-installed',
    'default_server=1', 'default_client=1') -Note 'ETN нет вовсе — отмечены оба'

Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), 'stub')
$probe = Invoke-StateProbe
Add-StateResult -Name 'state-client-only:defaults' -Line $probe.State -Pairs @(
    'server_state=not-installed', 'client_state=installed',
    'default_server=0', 'default_client=1') -Note 'только установленное'

Reset-State
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dataDir '_system.db'), 'stub')
$probe = Invoke-StateProbe
Add-StateResult -Name 'state-data-only:adopt' -Line $probe.State -Pairs @(
    'server_state=adopt', 'default_server=1', 'default_client=0') -Note 'подключить существующие данные (B5)'

Reset-State
Write-InstallJson (New-InstallJson -ProductVersion '0.15.0')
New-ServerFiles -Version '0.15.0'
$probe = Invoke-StateProbe
Add-StateResult -Name 'state-update-available' -Line $probe.State -Pairs @(
    'server_state=update-available', 'files_version=0.15.0',
    'default_server=1', 'default_client=0')

Reset-State
Write-InstallJson (New-InstallJson -ProductVersion $version)
New-ServerFiles -Version $version
$probe = Invoke-StateProbe
Add-StateResult -Name 'state-installed' -Line $probe.State -Pairs @(
    'server_state=installed', ('files_version=' + $version)) -Note 'актуальная версия, не repair (Z3)'

Reset-State
Write-InstallJson (New-InstallJson -ProductVersion $version)
New-ServerFiles -Version '0.15.0'
$probe = Invoke-StateProbe
Add-StateResult -Name 'state-repair-version-mismatch' -Line $probe.State -Pairs @(
    'server_state=repair', 'files_version=0.15.0') -Note 'файлы не соответствуют install.json (Z3)'

Reset-State
Write-InstallJson (New-InstallJson -ProductVersion '0.16.0')
New-ServerFiles -Version '0.16.0'
$probe = Invoke-StateProbe
Add-StateResult -Name 'state-downgrade:defaults' -Line $probe.State -Pairs @(
    'server_state=downgrade', 'downgrade=1',
    'default_server=0', 'default_client=0') -Note 'понижение не отмечается'

# Z3: запись установки Inno (хук /TESTRECORD) — разрушенная установка сервера.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTRECORD=1')
Add-StateResult -Name 'state-record-only:repair' -Line $probe.State -Pairs @(
    'server_state=repair', 'record=1', 'default_server=1')

# B3: машинный клиент пишет ту же запись установки — сервер не отмечается.
Reset-State
New-Item -ItemType Directory -Path (Join-Path $appDir 'client') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'client\ETN.exe'), 'stub')
$probe = Invoke-StateProbe -ExtraArgs @('/TESTRECORD=1')
Add-StateResult -Name 'state-machine-client-with-record' -Line $probe.State -Pairs @(
    'server_state=not-installed', 'record=1',
    'default_server=0', 'default_client=1')

# B4: повышение прав нужно серверу и клиенту «для всех», но не клиенту «для меня».
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTSELECT=server')
Add-StateResult -Name 'need-elevation:server' -Line $probe.State -Pairs @('need_elevation=1')
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTSELECT=client-machine')
Add-StateResult -Name 'need-elevation:client-machine' -Line $probe.State -Pairs @('need_elevation=1')
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTSELECT=client-user')
Add-StateResult -Name 'need-elevation:client-user' -Line $probe.State -Pairs @('need_elevation=0')

# --- B1: привилегированная фаза на чистой машине ----------------------------
Write-Host '=== Привилегированная фаза (B1, B4) ==='
Reset-State
$privParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Name 'priv-server.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"", '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'privileged-clean:code' -Expected 0 -Actual $code -Note 'нет install.json и службы — silent-предусловия не применяются'
$privFiles = (Test-Path -LiteralPath (Join-Path $appDir 'server\dist\index.js')) -and
    (Test-Path -LiteralPath (Join-Path $appDir 'service\etn-service.xml'))
Add-Result -Name 'privileged-clean:files' -Expected 1 -Actual ([int]$privFiles)
$privJsonPath = Join-Path $dataDir 'install.json'
$privJsonOk = $false
if (Test-Path -LiteralPath $privJsonPath) {
    $privJson = Get-Content -LiteralPath $privJsonPath -Raw
    $privJsonOk = $privJson -match ('"product_version":"' + [regex]::Escape($version) + '"')
}
Add-Result -Name 'privileged-clean:install-json' -Expected 1 -Actual ([int]$privJsonOk)

if ($IsElevated) {
    Write-Host 'SKIP  privileged-not-elevated      прогон идёт в элевированном процессе'
} else {
    Reset-State
    $privParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Name 'priv-server2.ini'
    $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"", '/TESTHEALTH=ok'))
    Add-Result -Name 'privileged-not-elevated' -Expected 20 -Actual $code -Note 'нужны права администратора'
}

# --- B4: клиент «для всех» ставится, «для меня» — нет -----------------------
Reset-State
$privParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'priv-client-machine.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"", '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'privileged-client-machine:code' -Expected 0 -Actual $code -Note 'элевация при клиенте «для всех»'
$machineClient = Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe')
Add-Result -Name 'privileged-client-machine:files' -Expected 1 -Actual ([int]$machineClient)

Reset-State
$privParams = New-ParamsFile -Server 0 -Client 1 -Scope user -Name 'priv-client-user.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"", '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'privileged-client-user:code' -Expected 0 -Actual $code
$userClientInChild = (Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe')) -or
    (Test-Path -LiteralPath (Join-Path $appDir 'ETN.exe'))
Add-Result -Name 'privileged-client-user:not-copied' -Expected 0 -Actual ([int]$userClientInChild) -Note 'пользовательский клиент ставит неэлевированная фаза'

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
