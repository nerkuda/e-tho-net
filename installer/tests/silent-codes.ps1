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
     17. B4: клиент «для всех» ставится, «для меня» — неэлевированной фазой;
         радиокнопки области клиента читаются обработчиком, область
         сохраняется в install.json (mode=client) и восстанавливается
     18. Z2: last_log обновляется каждый запуск, повтор версии не меняет версию
     19. Замечание 1: элевированный неадминистративный запуск не привилегированный
     20. Замечание 2: health-check fail-closed без службы — код 10, не успех
     21. Замечание 3: хук /TESTHEALTH только под #ifdef TestMode
     22. Замечание 4: файл параметров в общем каталоге, удаляется после чтения
     23. 9b310991: порт, занятый только на loopback или конкретном адресе,
         — код 20 (B1); ошибка netsh — предупреждение в журнале без отмены
         установки; статический сторож .iss — общий хелпер iss-guard.ps1 (B2)
     24. 9b310991 B3: CIM-запрос службы в том же -Command находит реальную
         службу (хук /TESTSERVICENAME); слушатель своего PID и PID-потомка
         (хук /TESTOWNSERVICEPID) — свободен, чужой — 20; реальный LAN-адрес
         машины (если есть) — 20
     25. ce3ab836: бэкап БД перед обновлением (/TESTBACKUP) — архив с копиями
         _system.db и networks\<uuid>\data.db проходит integrity_check,
         WAL-хвост сохраняется в том числе при неудачном чекпойнте (копируется
         -wal); ошибка создания и битая база — код 10 без архива; четвёртый
         архив удаляет самый старый, чужие файлы и каталоги не тронуты; ошибка
         удаления старого архива обновление не отменяет; ремонт — код 0 без
         бэкапа; без баз данных архив не создаётся
     26. bb063ac3: обновление сервера — порядок фаз до копирования (остановка
         службы → бэкап БД → снимок отката), ожидание реальной остановки
         службы (не остановилась — код 20), неудачный бэкап — код 10 без
         замены файлов с поднятой службой (bc7cc846), расширенный health-check
         с разбором тела /health и /version (status/db/версия/api; HTTP 500 и
         чужая версия — код 10 и откат), возврат файлов из снимка и БД из
         архива, install.json только после успеха, снимок удаляется только при
         успехе, неудачный откат — код 10 с путём к архиву в журнале

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
# Настоящий Node 22 для проверок бэкапа (ce3ab836): фикстура payload содержит
# только заглушку node.exe, а integrity_check должен выполняться по-настоящему.
$script:BackupNode = ''

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

function Get-FreeTcpPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function New-InstallJson {
    param([string]$ProductVersion = '0.15.0', [string]$Mode = 'service',
        [int]$Port = 0, [string]$Firewall = 'true')
    # Порт по умолчанию — свободный: предпроверка порта теперь настоящая, а на
    # машине разработчика 4321 может занимать запущенный сервер.
    if ($Port -le 0) { $Port = Get-FreeTcpPort }
    $dataEscaped = $dataDir.Replace('\', '\\')
    return '{"schema":1,"product_version":"' + $ProductVersion + '","mode":"' + $Mode +
        '","data_dir":"' + $dataEscaped + '","host":"0.0.0.0","port":' + $Port + ',' +
        '"firewall":' + $Firewall + ',"client_scope":null,"installed_at":"2026-10-01T10:00:00","last_log":""}'
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
        [int]$Port = 0,
        [int]$Firewall = 1,
        [string]$DisplayName = '',
        [string]$ReasonFile = '',
        [string]$Name = 'params.ini'
    )
    # Свободный порт по умолчанию: предпроверка порта настоящая, а на машине
    # разработчика 4321 может быть занят запущенным сервером.
    if ($Port -le 0) { $Port = Get-FreeTcpPort }
    $hostValue = '0.0.0.0'
    if ($Firewall -ne 1) { $hostValue = '127.0.0.1' }
    $path = Join-Path $workRoot $Name
    $text = "server=$Server`r`nclient=$Client`r`nclient_scope=$Scope`r`nmode=$Mode`r`n" +
        "host=$hostValue`r`nport=$Port`r`nfirewall=$Firewall`r`ndisplay_name=$DisplayName`r`n" +
        "reason_file=$ReasonFile`r`n"
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

# Время строки журнала (112642a4): журнал пишет метку с точностью до секунды,
# этого достаточно, чтобы доказать ожидание деинсталлятора (ping -n 4 ≈ 3 с).
function Get-LogMoment {
    param([string]$Pattern)
    $log = Get-LatestLog
    if (-not $log) { return $null }
    $text = Get-Content -LiteralPath $log.FullName -Raw
    $m = [regex]::Match($text, '(?m)^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})  \[[A-Z]+\]  ' + $Pattern)
    if (-not $m.Success) { return $null }
    return [datetime]::ParseExact($m.Groups[1].Value, 'yyyy-MM-dd HH:mm:ss',
        [System.Globalization.CultureInfo]::InvariantCulture)
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

# --- ce3ab836: бэкап БД — настоящий Node и better-sqlite3 -------------------
# Проверки бэкапа опираются на ту же раскладку поставки, что и продуктовый
# установщик: node.exe (хук /TESTNODEEXE) и better-sqlite3 в
# app\server\node_modules. В фикстуре payload только заглушки, поэтому модули
# копируются из репозитория (server/node_modules — сборка под Node 22).
function Invoke-NodeEval {
    param([string]$Script, [string[]]$Arguments = @())
    Push-Location (Join-Path $repoRoot 'server')
    try {
        $output = @(& $script:BackupNode -e $Script @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    return [pscustomobject]@{ Code = $exitCode; Output = $output }
}

function Initialize-BackupServerPayload {
    $modules = Join-Path $appDir 'server\node_modules'
    $sources = [ordered]@{
        'better-sqlite3'   = 'server\node_modules\better-sqlite3'
        'bindings'         = 'node_modules\bindings'
        'file-uri-to-path' = 'node_modules\file-uri-to-path'
    }
    foreach ($name in $sources.Keys) {
        $target = Join-Path $modules $name
        if (Test-Path -LiteralPath $target) { continue }
        $source = Join-Path $repoRoot $sources[$name]
        if (-not (Test-Path -LiteralPath $source)) { return $false }
        New-Item -ItemType Directory -Path $modules -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
    }
    return $true
}

# БД как после падения службы: -Values закоммичены и чекпойнтнуты, при
# -LeaveWalTail последняя запись остаётся только в -wal (process.exit без
# закрытия соединения).
function New-BackupTestDatabase {
    param([string]$Path, [string[]]$Values, [switch]$LeaveWalTail)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $script = @'
const Database=require('better-sqlite3');
const db=new Database(process.argv[1]);
db.pragma('journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS t(v TEXT)');
const values=String(process.argv[2]).split('|');
for(const v of values){if(v!==''){db.prepare('INSERT INTO t(v) VALUES (?)').run(v);}}
db.pragma('wal_checkpoint(TRUNCATE)');
if(process.argv[3]==='tail'){
  db.pragma('wal_autocheckpoint=0');
  db.prepare('INSERT INTO t(v) VALUES (?)').run(process.argv[4]);
  process.exit(0);
}
db.close();
'@
    $tailFlag = if ($LeaveWalTail) { 'tail' } else { 'open' }
    $tailValue = if ($LeaveWalTail) { 'wal-tail' } else { '' }
    $result = Invoke-NodeEval -Script $script -Arguments @($Path, ($Values -join '|'), $tailFlag, $tailValue)
    return ($result.Code -eq 0)
}

function Get-BackupTestValues {
    param([string]$Path)
    $script = @'
const Database=require('better-sqlite3');
const db=new Database(process.argv[1]);
console.log(db.prepare('SELECT v FROM t ORDER BY rowid').all().map(r=>r.v).join('|'));
db.close();
'@
    $result = Invoke-NodeEval -Script $script -Arguments @($Path)
    if ($result.Code -ne 0) { return '<ошибка чтения>' }
    return [string]($result.Output | Select-Object -Last 1)
}

function Test-BackupDatabaseIntegrity {
    param([string]$Path)
    $script = @'
const Database=require('better-sqlite3');
try{
  const db=new Database(process.argv[1]);
  const rows=db.pragma('integrity_check');
  db.close();
  console.log(rows.length===1&&String(rows[0].integrity_check)==='ok'?'ok':'bad');
}catch(e){console.log('bad')}
'@
    $result = Invoke-NodeEval -Script $script -Arguments @($Path)
    return ($result.Code -eq 0 -and [string]($result.Output | Select-Object -Last 1) -eq 'ok')
}

function Get-BackupArchives {
    $backups = Join-Path $dataDir 'backups'
    if (-not (Test-Path -LiteralPath $backups)) { return @() }
    return @(Get-ChildItem -LiteralPath $backups -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{8}-\d{6}(-\d+)?$' } | Sort-Object Name)
}

function Test-LatestLogContains {
    param([string]$Pattern)
    $log = Get-LatestLog
    if (-not $log) { return $false }
    $text = Get-Content -LiteralPath $log.FullName -Raw
    return ($text -match $Pattern)
}

# --- bb063ac3: подставной health-сервер, снимок отката и порядок журнала -----
# Разбор тела health-check проверяется по-настоящему: установщик опрашивает
# локальный HTTP-сервер (Node 22), который отдаёт заданный ответ — версию,
# db, HTTP 500 или неверный /api/v1/version. Заодно сервер имитирует запись
# «неудачного запуска» в БД, чтобы откат БД можно было проверить по данным.
function Initialize-FakeHealthScript {
    $scriptPath = Join-Path $workRoot 'fake-health.cjs'
    if (Test-Path -LiteralPath $scriptPath) { return $scriptPath }
    $text = @'
const http = require('http');
const fs = require('fs');
const argv = process.argv;
const port = Number(argv[2]);
const mode = argv[3];
const target = argv[4];
const requestLog = argv[5];
const dbPath = argv[6] || '';
const dbModule = argv[7] || '';
const marker = argv[8] || '';
let mutated = false;
function mutate() {
  if (mutated) return;
  mutated = true;
  if (!dbPath || dbPath === '-' || !marker || !dbModule) return;
  try {
    const Database = require(dbModule);
    const db = new Database(dbPath);
    db.prepare('INSERT INTO t(v) VALUES (?)').run(marker);
    db.close();
  } catch (e) {
    fs.appendFileSync(requestLog, 'mutate-error:' + String(e) + '\n');
  }
}
function health(status, db, version) {
  return JSON.stringify({ status: status, db: db, version: version, uptime: 1 });
}
const server = http.createServer(function (req, res) {
  fs.appendFileSync(requestLog, req.url + '\n');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/v1/health') {
    mutate();
    if (mode === 'http500') {
      res.statusCode = 500;
      res.end(health('error', 'error', target));
      return;
    }
    if (mode === 'db-error') { res.end(health('ok', 'error', target)); return; }
    if (mode === 'wrong-version') { res.end(health('ok', 'ok', '9.9.9')); return; }
    res.end(health('ok', 'ok', target));
    return;
  }
  if (req.url === '/api/v1/version') {
    const v = (mode === 'api-version') ? '9.9.9' : target;
    res.end(JSON.stringify({ version: v, api: 'v1' }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
server.listen(port, '127.0.0.1');
'@
    [System.IO.File]::WriteAllText($scriptPath, $text)
    return $scriptPath
}

function Test-TcpReady {
    param([int]$Port, [int]$TimeoutMs = 8000)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(200) -and $client.Connected) {
                $client.EndConnect($iar)
                return $true
            }
        } catch { } finally { $client.Close() }
        Start-Sleep -Milliseconds 100
    }
    return $false
}

function Start-FakeHealthServer {
    param(
        [string]$Mode = 'ok',
        [string]$DbPath = '',
        [string]$Marker = ''
    )
    $scriptPath = Initialize-FakeHealthScript
    $port = Get-FreeTcpPort
    $requestLog = Join-Path $workRoot ('health-requests-' + $port + '.log')
    [System.IO.File]::WriteAllText($requestLog, '')
    $betterSqlite = Join-Path $repoRoot 'server\node_modules\better-sqlite3'
    $nodeArgs = @($scriptPath, [string]$port, $Mode, $version, $requestLog,
        (IfStrEmpty $DbPath), $betterSqlite, $Marker)
    $proc = Start-Process -FilePath $script:BackupNode -ArgumentList $nodeArgs `
        -WorkingDirectory (Join-Path $repoRoot 'server') -PassThru
    if (-not (Test-TcpReady -Port $port)) {
        try { $proc.Kill() } catch { }
        throw "Подставной health-сервер не поднялся на порту $port"
    }
    return [pscustomobject]@{
        Process    = $proc
        Url        = 'http://127.0.0.1:' + $port
        RequestLog = $requestLog
    }
}

function IfStrEmpty {
    param([string]$Value)
    if ($Value -eq '') { return '-' }
    return $Value
}

function Stop-FakeHealthServer {
    param($Server)
    if ($null -eq $Server) { return }
    try { Stop-Process -Id $Server.Process.Id -Force -ErrorAction SilentlyContinue } catch { }
    try { $Server.Process.WaitForExit(3000) | Out-Null } catch { }
}

function Get-FakeHealthRequests {
    param($Server)
    if (-not (Test-Path -LiteralPath $Server.RequestLog)) { return '' }
    return (Get-Content -LiteralPath $Server.RequestLog -Raw)
}

# Индексы шаблонов в журнале последней установки: -1 — строки нет. Нужны для
# проверки порядка фаз (остановка → бэкап → снимок → копирование → health →
# install.json) по фактическому журналу, а не по коду.
function Get-LogPatternIndices {
    param([string[]]$Patterns)
    $log = Get-LatestLog
    $text = ''
    if ($log) { $text = Get-Content -LiteralPath $log.FullName -Raw }
    $result = @()
    foreach ($p in $Patterns) {
        $result += $text.IndexOf($p, [System.StringComparison]::Ordinal)
    }
    return $result
}

function Get-RollbackDirs {
    $root = Join-Path $dataDir '.install\rollback'
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    return @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name)
}

# Заготовка обновления: install.json старой версии, файлы сервера и службы,
# архив бэкапа требует настоящий node и better-sqlite3 поставки.
function New-UpdateFixture {
    param([string]$OldVersion = '0.15.0')
    Reset-State
    Write-InstallJson (New-InstallJson -ProductVersion $OldVersion)
    New-ServerFiles -Version $OldVersion
    New-Item -ItemType Directory -Path (Join-Path $appDir 'service') -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $appDir 'service\etn-service.exe'), 'stub')
    return (Initialize-BackupServerPayload)
}

# --- Подготовка рабочего каталога -------------------------------------------
if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

# --- Сторож статических проверок ---------------------------------------------
# Test-IssCode — общий хелпер installer/tests/iss-guard.ps1 (дефект B2 приёмки
# 9b310991): наивный подстрочный поиск по всему тексту проходил на
# закомментированной строке. Тот же хелпер использует init-key.ps1.
. (Join-Path $PSScriptRoot 'iss-guard.ps1')

function Add-StaticResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $script:results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $markText = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-28} {2}" -f $markText, $Name, $Note)
}

Write-Host '=== Статические проверки .iss ==='
$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8

# Сторож самопроверяется: закомментированный код НЕ считается, рабочий — считается.
$guardSelfTest = Test-IssGuardSelfTest
Add-StaticResult -Name 'static-guard:self-test' -Ok $guardSelfTest.Ok -Note $guardSelfTest.Message

# MsgBox вне SuppressibleMsgBox быть не должно. Построчный сторож: MsgBox в
# закомментированной строке ({ MsgBox(...) }) ошибкой не считается.
$msgBoxInCode = Test-IssCode -Text $issText -Pattern '(?<!Suppressible)MsgBox\s*\('
Add-StaticResult -Name 'static:no-msgbox' -Ok (-not $msgBoxInCode) `
    -Note 'MsgBox в коде .iss нет (строки комментариев не считаются)'
foreach ($required in @('/SUPPRESSMSGBOXES', '/NORESTART', 'SERVERONLY', 'GetCustomSetupExitCode')) {
    # ini-секции: там ';' — комментарий, а не разделитель операторов.
    $present = Test-IssCode -Text $issText -Pattern ([regex]::Escape($required)) -IniComments
    Add-StaticResult -Name "static:$required" -Ok $present
}
# B2: каталог программы выбирается по режиму установки ({autopf}), а не жёстко
# из Program Files — иначе неэлевированный экземпляр падает с Error 5.
# 9b310991: порт/хост/брандмауэр/каталог данных, подстановка шаблона службы,
# предпроверки и удаление правила при удалении программы.
$staticChecks = @(
    @{ Name = 'static:autopf-appdir'; Pattern = [regex]::Escape('#define AppDir "{autopf}\ETN"'); Note = 'каталог программы по режиму установки' },
    @{ Name = 'static:defaultdir-app'; Pattern = [regex]::Escape('DefaultDirName={#AppDir}'); Note = '' },
    @{ Name = 'static:privileged-phase'; Pattern = [regex]::Escape('ValidatePrivilegedPhasePreconditions'); Note = 'отдельная привилегированная фаза' },
    @{ Name = 'static:radio-onclick-user'; Pattern = [regex]::Escape('GScopeUserRadio.OnClick := @ComponentsChanged;'); Note = 'радиокнопка «только для меня»' },
    @{ Name = 'static:radio-onclick-machine'; Pattern = [regex]::Escape('GScopeMachineRadio.OnClick := @ComponentsChanged;'); Note = 'радиокнопка «для всех»' },
    @{ Name = 'static:selection-from-controls'; Pattern = [regex]::Escape('ApplySelection(GServerCheck.Checked, GClientCheck.Checked, GScopeMachineRadio.Checked);'); Note = 'выбор читается с контролов' },
    @{ Name = 'static:context-admin-mode'; Pattern = [regex]::Escape('GIsElevated and IsAdminInstallMode'); Note = 'привилегированный контекст — только admin mode' },
    @{ Name = 'static:params-shared-dir'; Pattern = [regex]::Escape('{commonappdata}\ETN\.install'); Note = 'файл параметров в общем каталоге' },
    @{ Name = 'static:params-public-fallback'; Pattern = [regex]::Escape("GetEnv('PUBLIC')"); Note = 'запасной общий каталог' },
    @{ Name = 'static:params-write-probe'; Pattern = [regex]::Escape('ProbeWritableDir(Dir)'); Note = 'проверка записи пробным файлом (дефект 1)' },
    @{ Name = 'static:params-temp-fallback'; Pattern = [regex]::Escape("ExpandConstant('{tmp}')"); Note = 'последний запасной каталог — %TEMP%' },
    @{ Name = 'static:port-default'; Pattern = [regex]::Escape("GServerPort := '4321'"); Note = 'порт по умолчанию 4321' },
    @{ Name = 'static:host-from-checkbox'; Pattern = [regex]::Escape("GServerHost := '127.0.0.1'"); Note = 'чекбокс задаёт ETN_HOST' },
    @{ Name = 'static:host-lan'; Pattern = [regex]::Escape("GServerHost := '0.0.0.0'"); Note = 'включённый чекбокс — 0.0.0.0' },
    @{ Name = 'static:data-dir-fixed'; Pattern = [regex]::Escape('{commonappdata}\ETN'); Note = 'каталог данных %ProgramData%\ETN' },
    @{ Name = 'static:port-page'; Pattern = [regex]::Escape('CreateServerParamsPage'); Note = 'экран «Параметры сервера»' },
    @{ Name = 'static:port-focus'; Pattern = [regex]::Escape('WizardForm.ActiveControl := GPortEdit'); Note = 'фокус на поле порта при ошибке' },
    @{ Name = 'static:precheck-function'; Pattern = [regex]::Escape('function CheckServerEnvironment'); Note = 'единая предпроверка окружения' },
    @{ Name = 'static:port-loopback-bind'; Pattern = [regex]::Escape('TcpListener([Net.IPAddress]::Loopback,$port)'); Note = 'пробный bind на loopback' },
    @{ Name = 'static:port-own-service-children'; Pattern = [regex]::Escape('$p.ParentProcessId'); Note = 'служба ETN: потомки WinSW, не только ProcessId' },
    @{ Name = 'static:firewall-warning-gui'; Pattern = [regex]::Escape('Внимание: правило брандмауэра Windows не создано'); Note = 'предупреждение netsh — в итоговой сводке' },
    @{ Name = 'static:firewall-warning-fact'; Pattern = [regex]::Escape('Установка продолжается: сервер слушает'); Note = 'в журнале — факт 0.0.0.0, а не «локально»' },
    @{ Name = 'static:free-space'; Pattern = [regex]::Escape('GetSpaceOnDisk64'); Note = 'проверка свободного места' },
    @{ Name = 'static:precheck-before-changes'; Pattern = [regex]::Escape('ValidatePrivilegedPhasePreconditions;'); Note = 'предпроверки до замены файлов' },
    @{ Name = 'static:service-template-subst'; Pattern = [regex]::Escape('function InstallServiceConfig'); Note = 'подстановка шаблона службы' },
    @{ Name = 'static:service-placeholder-data'; Pattern = [regex]::Escape("StringChangeEx(Text, '{{DATA_DIR}}'"); Note = 'плейсхолдер {{DATA_DIR}}' },
    @{ Name = 'static:service-placeholder-port'; Pattern = [regex]::Escape("StringChangeEx(Text, '{{PORT}}'"); Note = 'плейсхолдер {{PORT}}' },
    @{ Name = 'static:service-placeholder-host'; Pattern = [regex]::Escape("StringChangeEx(Text, '{{HOST}}'"); Note = 'плейсхолдер {{HOST}}' },
    @{ Name = 'static:service-log-dir'; Pattern = [regex]::Escape("GDataDir + '\logs\service'"); Note = 'каталог журнала службы создаёт установщик' },
    @{ Name = 'static:firewall-add'; Pattern = [regex]::Escape('advfirewall firewall add rule'); Note = 'правило брандмауэра создаётся' },
    @{ Name = 'static:firewall-delete'; Pattern = [regex]::Escape('advfirewall firewall delete rule'); Note = 'правило удаляется' },
    @{ Name = 'static:firewall-profiles'; Pattern = [regex]::Escape("FIREWALL_PROFILES = 'domain,private'"); Note = 'публичные сети не открываются' },
    @{ Name = 'static:firewall-checkbox'; Pattern = [regex]::Escape('Разрешить подключения с других компьютеров'); Note = 'чекбокс согласия' },
    @{ Name = 'static:firewall-uninstall'; Pattern = [regex]::Escape('CurUninstallStepChanged'); Note = 'правило удаляется при удалении программы' },
    @{ Name = 'static:display-name-validation'; Pattern = [regex]::Escape('function ValidDisplayName'); Note = 'display_name из /PARAMS проверяется (дефект 6)' },
    @{ Name = 'static:reason-file'; Pattern = [regex]::Escape('reason_file='); Note = 'причина отказа предусловия — родителю' },
    @{ Name = 'static:backup-entry'; Pattern = [regex]::Escape('function CreateDatabaseBackup(const Needed: Boolean): Boolean'); Note = 'бэкап: решение о необходимости передаёт вызывающий' },
    @{ Name = 'static:backup-keep-three'; Pattern = [regex]::Escape('BACKUPS_KEEP = 3'); Note = 'бэкап: три последних архива' }
)
foreach ($check in $staticChecks) {
    Add-StaticResult -Name $check.Name -Ok (Test-IssCode -Text $issText -Pattern $check.Pattern) -Note $check.Note
}
# Поля выбора каталога данных быть не должно (ADR 144bcdb0): проверка на
# отсутствие страницы, а не на наличие.
Add-StaticResult -Name 'static:no-datadir-choice' `
    -Ok (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('CreateInputDirPage')))) `
    -Note 'нет страницы выбора каталога данных'
# B1: проверка реального фрагмента ServerPortStatus, а не подстроки по всему
# файлу: старый bind-only код тоже содержал Get-NetTCPConnection (в ветке
# своей службы) и проходил подстрочный сторож.
$portBody = Get-IssFunctionBody -Text $issText -Name 'ServerPortStatus'
$portAllListeners = ($portBody -ne '') -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$v4=@(Get-NetTCPConnection -LocalPort $port -State Listen'))) -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$foreign=@($v4|Where-Object{$own -notcontains')))
Add-StaticResult -Name 'static:port-all-listeners' -Ok $portAllListeners `
    -Note 'ServerPortStatus: перебор слушателей и сравнение владельцев (фрагмент функции)'
# B3: скрипт передаётся как -Command "<скрипт>", вложенные двойные кавычки
# разбор командной строки срезает — внутри собранного Script их быть не должно
# (строка Args := ... с кавычками обёртки -Command исключается).
$portScriptPart = ((($portBody -split "`n") | Where-Object { $_ -notmatch '^\s*Args\s*:=' }) -join "`n")
Add-StaticResult -Name 'static:port-no-nested-dquotes' `
    -Ok (($portBody -ne '') -and ($portScriptPart -notmatch '"')) `
    -Note 'собранный Script в ServerPortStatus без двойных кавычек (B3)'
Add-StaticResult -Name 'static:port-own-service-hook' `
    -Ok (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$ownSeed'))) `
    -Note 'хук /TESTOWNSERVICEPID — своя служба по PID'
Add-StaticResult -Name 'static:port-service-name-hook' `
    -Ok (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$svcProbe'))) `
    -Note 'хук /TESTSERVICENAME — поведенческая проба CIM-запроса'
# Замечание 3: тестовый хук health-check не должен попадать в продуктовую
# сборку. Построчно: закомментированная директива блок не открывает.
$testModeBody = Get-IssIfdefBody -Text $issText -Name 'TestMode'
$hookUnderIfdef = ($testModeBody -ne '') -and
    (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('if GTestHealth')))
Add-StaticResult -Name 'static:health-hook-ifdef' -Ok $hookUnderIfdef `
    -Note 'хук /TESTHEALTH под #ifdef TestMode (построчно)'

# ce3ab836: бэкап БД — проверка по телам функций, а не подстрокой по файлу:
# integrity_check обязан быть в проверке копии, wal_checkpoint — в чекпойнте,
# перебор своих архивов (IsBackupDirName) — в выборе самого старого; хук
# /TESTBACKUP — под #ifdef.
$backupBody = Get-IssFunctionBody -Text $issText -Name 'CreateDatabaseBackup'
Add-StaticResult -Name 'static:backup-caller-decides' `
    -Ok (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('if not Needed'))) `
    -Note 'бэкап: ремонт той же версии — без архива (решает вызывающий)'
$integrityBody = Get-IssFunctionBody -Text $issText -Name 'VerifyDatabaseIntegrity'
Add-StaticResult -Name 'static:backup-integrity' `
    -Ok (Test-IssCode -Text $integrityBody -Pattern ([regex]::Escape("pragma(''integrity_check'')"))) `
    -Note 'PRAGMA integrity_check по каждой копии'
$checkpointBody = Get-IssFunctionBody -Text $issText -Name 'CheckpointDatabase'
Add-StaticResult -Name 'static:backup-checkpoint' `
    -Ok (Test-IssCode -Text $checkpointBody -Pattern ([regex]::Escape('wal_checkpoint(TRUNCATE)'))) `
    -Note 'чекпойнт WAL перед копированием'
$copyBody = Get-IssFunctionBody -Text $issText -Name 'CopyDatabasesInto'
$copyNodeFromSupply = (Test-IssCode -Text $copyBody -Pattern ([regex]::Escape('ServerNodeExe(GServerDir)'))) -and
    (Test-IssCode -Text $copyBody -Pattern ([regex]::Escape("GServerDir + '\server'")))
Add-StaticResult -Name 'static:backup-node-supply' -Ok $copyNodeFromSupply `
    -Note 'node.exe и node_modules — из установленной поставки'
$rotateBody = Get-IssFunctionBody -Text $issText -Name 'RotateBackupArchives'
$oldestBody = Get-IssFunctionBody -Text $issText -Name 'OldestBackupDirName'
$rotateOk = (Test-IssCode -Text $rotateBody -Pattern ([regex]::Escape('CountBackupDirs'))) -and
    (Test-IssCode -Text $rotateBody -Pattern ([regex]::Escape('OldestBackupDirName'))) -and
    (Test-IssCode -Text $rotateBody -Pattern ([regex]::Escape('DelTree'))) -and
    (Test-IssCode -Text $oldestBody -Pattern ([regex]::Escape('IsBackupDirName')))
Add-StaticResult -Name 'static:backup-rotation' -Ok $rotateOk `
    -Note 'ротация только своих архивов (IsBackupDirName), чужие не трогаются'
$backupHookIfdef = ($testModeBody -ne '') -and
    (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('if GTestBackup')))
Add-StaticResult -Name 'static:backup-hook-ifdef' -Ok $backupHookIfdef `
    -Note 'хук /TESTBACKUP под #ifdef TestMode'

# 112642a4: экраны, лицензия MIT, прогресс, экран ошибки и итоговая сводка.
# Проверки — по телам функций: подстрочный поиск по всему файлу проходил бы на
# закомментированной копии (дефект B2 приёмки 9b310991).
$componentsBody = Get-IssFunctionBody -Text $issText -Name 'CreateComponentsPage'
$licenseUi = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseCheck'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('Я принимаю условия лицензии MIT'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseLink')))
Add-StaticResult -Name 'static:license-checkbox' -Ok $licenseUi `
    -Note 'лицензия MIT: чекбокс согласия и ссылка на текст на экране компонентов'
$licenseLocal = (Test-IssCode -Text $issText -Pattern ([regex]::Escape("ExtractTemporaryFile('LICENSE')"))) -and
    (Test-IssCode -Text $issText -Pattern ([regex]::Escape('Source: "..\LICENSE"; Flags: dontcopy')))
Add-StaticResult -Name 'static:license-local-text' -Ok $licenseLocal `
    -Note 'текст лицензии в установщике и открывается локально (d75b7988)'
$licenseNeededBody = Get-IssFunctionBody -Text $issText -Name 'LicensePromptNeeded'
$licenseFirstOnly = (Test-IssCode -Text $licenseNeededBody -Pattern ([regex]::Escape("GServerState = 'not-installed'"))) -and
    (Test-IssCode -Text $licenseNeededBody -Pattern ([regex]::Escape("(GClientState <> 'installed')")))
Add-StaticResult -Name 'static:license-first-install-only' -Ok $licenseFirstOnly `
    -Note 'лицензия запрашивается только при первой установке'
$skipBody = Get-IssFunctionBody -Text $issText -Name 'ShouldSkipPage'
$skipLicense = (Test-IssCode -Text $skipBody -Pattern ([regex]::Escape('if PageID = wpLicense then'))) -and
    (Test-IssCode -Text $skipBody -Pattern ([regex]::Escape('if PageID = wpWelcome then')))
Add-StaticResult -Name 'static:skip-welcome-license' -Ok $skipLicense `
    -Note 'стандартные экраны приветствия и лицензии не показываются'
$skipError = (Test-IssCode -Text $skipBody -Pattern ([regex]::Escape('PageID = GErrorPage.ID'))) -and
    (Test-IssCode -Text $skipBody -Pattern ([regex]::Escape('Result := GExitCode = EXIT_OK')))
Add-StaticResult -Name 'static:skip-error-on-success' -Ok $skipError `
    -Note 'экран ошибки показывается только при сбое'
Add-StaticResult -Name 'static:welcome-page-disabled' `
    -Ok (Test-IssCode -Text $issText -Pattern ([regex]::Escape('DisableWelcomePage=yes')) -IniComments) `
    -Note 'первый экран — компоненты с приветствием'

$stageBody = Get-IssFunctionBody -Text $issText -Name 'SetInstallStage'
Add-StaticResult -Name 'static:stage-statuslabel' `
    -Ok (Test-IssCode -Text $stageBody -Pattern ([regex]::Escape('WizardForm.StatusLabel.Caption := Stage'))) `
    -Note 'подпись этапа — в StatusLabel страницы установки'
$stepBody = Get-IssFunctionBody -Text $issText -Name 'CurStepChanged'
$updateBody = Get-IssFunctionBody -Text $issText -Name 'PrepareServerUpdate'
$stageNames = @(
    'Замена файлов сервера ETN',
    'Подготовка каталогов данных',
    'Настройка службы',
    'Правило брандмауэра',
    'Инициализация сервера',
    'Запуск службы ETN',
    'Проверка работоспособности',
    'Запись параметров установки'
)
foreach ($stageName in $stageNames) {
    Add-StaticResult -Name ('static:stage:' + $stageName) `
        -Ok (Test-IssCode -Text $stepBody -Pattern ([regex]::Escape($stageName))) `
        -Note 'этап прогресса в CurStepChanged'
}
# Остановка службы перенесена в фазы обновления (bb063ac3): подпись этапа и
# сам вызов живут в PrepareServerUpdate, который ssInstall вызывает до копирования.
Add-StaticResult -Name 'static:stage:Остановка службы ETN' `
    -Ok (Test-IssCode -Text $updateBody -Pattern ([regex]::Escape('Остановка службы ETN'))) `
    -Note 'этап остановки службы в PrepareServerUpdate'
$backupStageBody = Get-IssFunctionBody -Text $issText -Name 'CreateDatabaseBackup'
Add-StaticResult -Name 'static:stage:backup' `
    -Ok (Test-IssCode -Text $backupStageBody -Pattern ([regex]::Escape('Резервная копия баз данных'))) `
    -Note 'этап бэкапа в CreateDatabaseBackup (вызовет bb063ac3)'

$errorBody = Get-IssFunctionBody -Text $issText -Name 'ErrorMemoText'
$errorParts = @('FailureReasonText', 'Журнал установки', 'Резервная копия баз данных', 'Следующий шаг')
$errorOk = $true
foreach ($part in $errorParts) { if (-not (Test-IssCode -Text $errorBody -Pattern ([regex]::Escape($part)))) { $errorOk = $false } }
Add-StaticResult -Name 'static:error-page-content' -Ok $errorOk `
    -Note 'экран ошибки: причина, журнал, бэкап и следующий шаг'
$errorPageBody = Get-IssFunctionBody -Text $issText -Name 'CreateErrorPage'
$errorButtons = (Test-IssCode -Text $errorPageBody -Pattern ([regex]::Escape('Открыть журнал'))) -and
    (Test-IssCode -Text $errorPageBody -Pattern ([regex]::Escape('Повторить установку'))) -and
    (Test-IssCode -Text $errorPageBody -Pattern ([regex]::Escape('GErrorPage := CreateCustomPage')))
Add-StaticResult -Name 'static:error-page-buttons' -Ok $errorButtons `
    -Note 'экран ошибки: журнал, папка данных, повтор установки'

$summaryBody = Get-IssFunctionBody -Text $issText -Name 'SummaryText'
$summaryParts = @('http://127.0.0.1:', 'Адрес в локальной сети', 'DetectLanIp',
    'Каталог данных', 'Журнал установки', 'GKeyWasShown')
$summaryOk = $true
foreach ($part in $summaryParts) { if (-not (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape($part)))) { $summaryOk = $false } }
Add-StaticResult -Name 'static:summary-content' -Ok $summaryOk `
    -Note 'сводка: локальный и LAN-адрес, каталог данных, журнал, напоминание о ключе'
$summaryLan = (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('if GServerFirewall then'))) -and
    (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('GFirewallWarning')))
Add-StaticResult -Name 'static:summary-lan-firewall' -Ok $summaryLan `
    -Note 'LAN-адрес только при открытом брандмауэре, предупреждение netsh — в сводке'
$finishedBody = Get-IssFunctionBody -Text $issText -Name 'CreateFinishedControls'
$finishedOk = (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('WizardForm.FinishedPage'))) -and
    (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('Запустить клиент'))) -and
    (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('Открыть папку данных'))) -and
    (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('Открыть журнал')))
Add-StaticResult -Name 'static:summary-page' -Ok $finishedOk `
    -Note 'сводка на странице завершения: memo и кнопки действий'
$pageChangedBody = Get-IssFunctionBody -Text $issText -Name 'CurPageChanged'
Add-StaticResult -Name 'static:summary-heading' `
    -Ok ((Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('FinishedHeadingLabel.Caption'))) -and
         (Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('GSummaryMemo.Lines.Text := SummaryText')))) `
    -Note 'заголовок завершения и текст сводки'
Add-StaticResult -Name 'static:downgrade-message' `
    -Ok ((Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('GDowngradeWarned'))) -and
         (Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('Понижение версии запрещено')))) `
    -Note 'сообщение при понижении версии'
$nextBody = Get-IssFunctionBody -Text $issText -Name 'NextButtonClick'
Add-StaticResult -Name 'static:port-suggestion' `
    -Ok (Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('SuggestFreePort'))) `
    -Note 'подсказка свободного порта при занятом'
Add-StaticResult -Name 'static:uac-back-to-components' `
    -Ok ((Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('ReturnToComponentsPage'))) -and
         (Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('GChildRanThisPass'))) -and
         (Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('wpReady')))) `
    -Note 'отказ UAC: возврат на экран компонентов с сохранённым выбором'
$prepareBody = Get-IssFunctionBody -Text $issText -Name 'PrepareToInstall'
Add-StaticResult -Name 'static:prepare-no-second-child' `
    -Ok (Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('if GChildRanThisPass then Exit'))) `
    -Note 'дочерний процесс не запускается второй раз'
Add-StaticResult -Name 'static:legacy-nsis-detect' `
    -Ok ((Test-IssCode -Text $issText -Pattern ([regex]::Escape("Pos('Uninstall ETN.exe', UninstallCmd)"))) -and
         (Test-IssCode -Text $issText -Pattern ([regex]::Escape('function FindLegacyClient'))) -and
         (Test-IssCode -Text $issText -Pattern ([regex]::Escape('function RunLegacyUninstaller')))) `
    -Note 'старый NSIS-клиент: поиск в реестре и удаление его деинсталлятором'
Add-StaticResult -Name 'static:legacy-removal-wired' `
    -Ok ((Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('RemoveLegacyBeforeInstall'))) -and
         (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'InitializeSetup') -Pattern ([regex]::Escape('RemoveLegacyBeforeInstall(True')))) `
    -Note 'удаление старого клиента до установки: GUI и привилегированная фаза'

# Блокер и замечания приёмки 112642a4.
$legacyArgsBody = Get-IssFunctionBody -Text $issText -Name 'UninstallerArgs'
Add-StaticResult -Name 'static:legacy-uninstall-args' `
    -Ok ((Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("_?=' + ExtractFileDir(Exe)"))) -and
         (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("'/S'"))) -and
         (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("Result := Rest + ' _?='")))) `
    -Note 'деинсталлятор старого клиента: /S и _?=<каталог> последним параметром (NSIS 3.2.2)'
$legacyRunBody = Get-IssFunctionBody -Text $issText -Name 'RunLegacyUninstaller'
Add-StaticResult -Name 'static:legacy-uninstall-waits' `
    -Ok ((Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape('ewWaitUntilTerminated'))) -and
         (Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape('WaitLegacyRecordGone')))) `
    -Note 'установка ждёт деинсталлятор и исчезновение записи Uninstall'
$licenseVisible = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseCheck.Visible := LicensePromptNeeded'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseLink.Visible := LicensePromptNeeded')))
Add-StaticResult -Name 'static:license-visible-rule' -Ok $licenseVisible `
    -Note 'чекбокс и ссылка лицензии привязаны к LicensePromptNeeded'
$clientStateBody = Get-IssFunctionBody -Text $issText -Name 'ClientStateText'
Add-StaticResult -Name 'static:client-state-selected' `
    -Ok (Test-IssCode -Text $clientStateBody -Pattern ([regex]::Escape('GLegacyClientFound and GClientSelected'))) `
    -Note 'обещание удалить старый клиент — только при выбранном клиенте'
Add-StaticResult -Name 'static:summary-run-button-client' `
    -Ok (Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('GSummaryRunButton.Visible := (GExitCode = EXIT_OK) and GClientSelected'))) `
    -Note 'кнопка «Запустить клиент» — только когда клиент выбран'
$lanBody = Get-IssFunctionBody -Text $issText -Name 'DetectLanIp'
Add-StaticResult -Name 'static:lan-excludes-virtual' `
    -Ok ((Test-IssCode -Text $lanBody -Pattern ([regex]::Escape('InterfaceDescription'))) -and
         (Test-IssCode -Text $lanBody -Pattern ([regex]::Escape('vEthernet'))) -and
         (Test-IssCode -Text $lanBody -Pattern ([regex]::Escape('Hyper-V')))) `
    -Note 'LAN-адрес: виртуальные адаптеры исключены, остальное помечено в сводке'
Add-StaticResult -Name 'static:progress-uac-generic' `
    -Ok ((Test-IssCode -Text $stepBody -Pattern ([regex]::Escape('Установка выполняется'))) -and
         (Test-IssCode -Text $stepBody -Pattern ([regex]::Escape('if GChildRanThisPass then')))) `
    -Note 'двухфазный UAC: без ложной конкретики этапа в родительском окне'
$adminBody = Get-IssFunctionBody -Text $issText -Name 'CreateAdminPage'
Add-StaticResult -Name 'static:display-name-field' -Ok (Test-IssCode -Text $adminBody -Pattern ([regex]::Escape('GAdminDisplayEdit'))) `
    -Note 'поле отображаемого имени на экране администратора'

# --- Сторож свежести payload в build.ps1 (дефект 3) --------------------------
# Продуктовая сборка (без -TestMode) обязана отказаться от устаревшей поставки
# до компиляции: иначе exe собирается, а падает уже на etn init --key-out.
Write-Host '=== Сторож свежести payload (дефект 3) ==='
$stalePayload = Join-Path $workRoot 'stale-payload'
foreach ($dir in @('node', 'service', 'server\dist', 'server\node_modules\better-sqlite3')) {
    New-Item -ItemType Directory -Path (Join-Path $stalePayload $dir) -Force | Out-Null
}
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'node\node.exe'), 'stub')
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'service\etn-service.exe'), 'stub')
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'service\etn-service.xml'), '<service><id>ETN</id></service>')
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'server\package.json'), '{"name":"@etn/server","version":"0.0.1"}')
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'server\dist\index.js'), '// stub')
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'server\dist\cli.js'), '// старая сборка без --key-out')
[System.IO.File]::WriteAllText((Join-Path $stalePayload 'server\node_modules\better-sqlite3\package.json'),
    '{"name":"better-sqlite3","version":"11.1.2"}')
$psExeForBuild = (Get-Process -Id $PID).Path
$staleOut = & $psExeForBuild -NoProfile -ExecutionPolicy Bypass -File $buildScript `
    -PayloadRoot $stalePayload -OutputDir (Join-Path $workRoot 'stale-out') 2>&1 | Out-String
$staleFailed = ($LASTEXITCODE -ne 0)
Add-StaticResult -Name 'build:stale-payload-fails' -Ok $staleFailed `
    -Note 'сборка без -TestMode не собирает exe из устаревшей поставки'
Add-StaticResult -Name 'build:stale-payload-message' -Ok ($staleOut -match 'Обновите payload') `
    -Note 'сообщение указывает на fetch-payload.ps1'

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

# --- 8b. health-check fail-closed: служба не найдена (без /TESTHEALTH) -------
Reset-State
Write-InstallJson (New-InstallJson -ProductVersion '0.15.0')
New-ServerFiles
$code = Invoke-Setup -Arguments ($silent + @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present'))
Add-Result -Name 'health-no-service' -Expected 10 -Actual $code -Note 'fail-closed: нет службы — не успех'
$jsonNoService = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$noServiceKept = $jsonNoService -match '"product_version":"0\.15\.0"'
Add-Result -Name 'health-no-service:json-unchanged' -Expected 1 -Actual ([int]$noServiceKept)
$healthMsg = Get-LogLine -Pattern '(Health-check не выполнен: служба не найдена[^\r\n]*)'
Add-Result -Name 'health-no-service:log' -Expected 1 -Actual ([int]([bool]$healthMsg)) -Note $healthMsg

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

# 112642a4: лицензия запрашивается только при первой установке; старый
# NSIS-клиент распознаётся (хук /TESTLEGACY), в том числе машинная запись.
Reset-State
$probe = Invoke-StateProbe
Add-StateResult -Name 'license:first-install' -Line $probe.State -Pairs @('license_prompt=1') `
    -Note 'чистая машина — лицензия запрашивается'
Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), 'stub')
$probe = Invoke-StateProbe
Add-StateResult -Name 'license:update-not-asked' -Line $probe.State -Pairs @(
    'client_state=installed', 'license_prompt=0') -Note 'обновление — лицензия не запрашивается'
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTLEGACY=0.14.1')
Add-StateResult -Name 'legacy-client:user' -Line $probe.State -Pairs @(
    'legacy=0.14.1', 'legacy_machine=0', 'license_prompt=1') `
    -Note 'старый NSIS-клиент текущего пользователя найден'
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTLEGACY=machine:0.14.1')
Add-StateResult -Name 'legacy-client:machine' -Line $probe.State -Pairs @(
    'legacy=0.14.1', 'legacy_machine=1') -Note 'машинная запись старого клиента найдена'

# Замечание 1 приёмки: правило лицензии проверяется по состоянию сервера,
# а не только по наличию клиента. Сервер установлен, клиента нет — обновление,
# лицензия не запрашивается.
Reset-State
Write-InstallJson (New-InstallJson -ProductVersion '0.15.0')
New-ServerFiles -Version '0.15.0'
$probe = Invoke-StateProbe
Add-StateResult -Name 'license:server-installed-client-missing' -Line $probe.State -Pairs @(
    'server_state=update-available', 'client_state=not-installed', 'license_prompt=0') `
    -Note 'обновление сервера без клиента — лицензия не запрашивается'
# Только данные без программы (adopt) — первая установка, лицензия нужна.
Reset-State
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dataDir '_system.db'), 'stub')
$probe = Invoke-StateProbe
Add-StateResult -Name 'license:adopt-data-only' -Line $probe.State -Pairs @(
    'server_state=adopt', 'license_prompt=1') -Note 'подключение данных — лицензия запрашивается'

# Блокер приёмки 112642a4: удаление старого NSIS-клиента дожидается конца
# работы деинсталлятора. Настоящий клиент на машине разработчика не
# запускается: /TESTLEGACYCMD подменяет деинсталлятор командой теста.
$legacyReasonFile = Join-Path $workRoot 'legacy-reason.txt'
$legacyCmd = Join-Path $env:SystemRoot 'System32\cmd.exe'

# 1. Медленный подставной деинсталлятор (ping -n 4 ≈ 3 с): установка обязана
#    ждать его завершения, а не продолжать копирование параллельно.
Reset-State
$legacyParams = New-ParamsFile -Server 0 -Client 1 -Scope user -Name 'legacy-slow.ini'
$legacySlow = '/TESTLEGACYCMD="' + $legacyCmd + ' /c ping -n 4 127.0.0.1 >nul"'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$legacyParams`"", '/TESTELEVATED=1', $legacySlow,
    '/TESTLEGACYSTUCK=0', '/TESTLEGACYWAIT=5000'))
Add-Result -Name 'legacy-uninstall:waits-code' -Expected 0 -Actual $code
$legacyStarted = Get-LogMoment -Pattern 'TESTLEGACYCMD: подставной деинсталлятор запущен'
$legacyFinished = Get-LogMoment -Pattern 'TESTLEGACYCMD: подставной деинсталлятор завершился, код 0'
$legacyWaited = $false
$legacySeconds = 0
if ($legacyStarted -and $legacyFinished) {
    $legacySeconds = [int]($legacyFinished - $legacyStarted).TotalSeconds
    $legacyWaited = ($legacySeconds -ge 2)
}
Add-Result -Name 'legacy-uninstall:waits' -Expected 1 -Actual ([int]$legacyWaited) `
    -Note ("установка ждала деинсталлятор " + $legacySeconds + " с")

# 2. Запись Uninstall исчезает не сразу: установка ждёт её исчезновения.
Reset-State
$legacyParams = New-ParamsFile -Server 0 -Client 1 -Scope user -Name 'legacy-wait.ini'
$legacyFast = '/TESTLEGACYCMD="' + $legacyCmd + ' /c exit 0"'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$legacyParams`"", '/TESTELEVATED=1', $legacyFast,
    '/TESTLEGACYSTUCK=1200', '/TESTLEGACYWAIT=5000'))
Add-Result -Name 'legacy-uninstall:record-wait-code' -Expected 0 -Actual $code
$recordWait = Get-LogLine -Pattern 'TESTLEGACYCMD result=ok wait_ms=(\d+)'
Add-Result -Name 'legacy-uninstall:record-wait' -Expected 1 `
    -Actual ([int]([int]$recordWait -ge 1000)) -Note ("wait_ms=" + $recordWait)

# 3. Запись не исчезла за бюджет ожидания: установка не начинается (код 20)
#    и называет причину.
Reset-State
Remove-Item -LiteralPath $legacyReasonFile -Force -ErrorAction SilentlyContinue
$legacyParams = New-ParamsFile -Server 0 -Client 1 -Scope user `
    -ReasonFile $legacyReasonFile -Name 'legacy-timeout.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$legacyParams`"", '/TESTELEVATED=1', $legacyFast,
    '/TESTLEGACYSTUCK=60000', '/TESTLEGACYWAIT=800'))
Add-Result -Name 'legacy-uninstall:timeout-code' -Expected 20 -Actual $code
$timeoutReason = ''
if (Test-Path -LiteralPath $legacyReasonFile) {
    $timeoutReason = [System.IO.File]::ReadAllText($legacyReasonFile, [System.Text.Encoding]::UTF8)
}
Add-Result -Name 'legacy-uninstall:timeout-reason' -Expected 1 `
    -Actual ([int]($timeoutReason -match 'запись установки не исчезла')) -Note $timeoutReason

# 4. Деинсталлятор вернул ненулевой код: установка не начинается.
Reset-State
Remove-Item -LiteralPath $legacyReasonFile -Force -ErrorAction SilentlyContinue
$legacyParams = New-ParamsFile -Server 0 -Client 1 -Scope user `
    -ReasonFile $legacyReasonFile -Name 'legacy-exit.ini'
$legacyFail = '/TESTLEGACYCMD="' + $legacyCmd + ' /c exit 7"'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$legacyParams`"", '/TESTELEVATED=1', $legacyFail,
    '/TESTLEGACYSTUCK=0', '/TESTLEGACYWAIT=5000'))
Add-Result -Name 'legacy-uninstall:nonzero-code' -Expected 20 -Actual $code
$nonzeroReason = ''
if (Test-Path -LiteralPath $legacyReasonFile) {
    $nonzeroReason = [System.IO.File]::ReadAllText($legacyReasonFile, [System.Text.Encoding]::UTF8)
}
Add-Result -Name 'legacy-uninstall:nonzero-reason' -Expected 1 `
    -Actual ([int]($nonzeroReason -match 'не удалось удалить старый клиент')) -Note $nonzeroReason

# 5. Аргументы деинсталлятора: /S и _?=<каталог> последним, без кавычек —
#    даже когда путь деинсталлятора содержит пробелы (документация NSIS 3.2.2).
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTLEGACYARGS=1'))
Add-Result -Name 'legacy-uninstall:args-code' -Expected 0 -Actual $code
$legacyArgs = Get-LogLine -Pattern 'TESTLEGACYARGS args=([^\r\n]+)'
$legacyArgsOk = ($legacyArgs -eq '/currentuser /S _?=C:\Program Files\ETN')
Add-Result -Name 'legacy-uninstall:args' -Expected 1 -Actual ([int]$legacyArgsOk) `
    -Note $legacyArgs

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

# Замечание 1: элевированный, но не административный запуск — не
# привилегированный контекст (иначе сервер ставится и в Program Files, и в
# профиль пользователя). /TESTGUIMODE отключает silent-термин контекста.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTGUIMODE=1')
Add-StateResult -Name 'gui-not-elevated-context' -Line $probe.State -Pairs @('in_privileged_context=0')
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTELEVATED=1', '/TESTGUIMODE=1')
Add-StateResult -Name 'elevated-not-admin-mode' -Line $probe.State -Pairs @('in_privileged_context=0')
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTELEVATED=1', '/TESTGUIMODE=1', '/CURRENTUSER')
Add-StateResult -Name 'elevated-currentuser' -Line $probe.State -Pairs @('in_privileged_context=0')

# Замечание 4: файл параметров — в общем каталоге, область клиента пишется,
# после чтения файл удаляется.
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTPARAMS=1', '/TESTSELECT=client-machine'))
Add-Result -Name 'params-shared:code' -Expected 0 -Actual $code
$paramsPath = Get-LogLine -Pattern 'TESTPARAMS path=(\S+) scope='
$paramsScope = Get-LogLine -Pattern 'TESTPARAMS path=\S+ scope=(\S+)'
$paramsDeleted = Get-LogLine -Pattern 'TESTPARAMS deleted=(\d)'
# Клиенту «для всех» каталог данных не нужен: .install в %ProgramData% не
# создаётся (иначе установка клиента оставляет серверный след). Путь — общий
# каталог (%PUBLIC%) или %TEMP%; оба проверены пробой записи.
$publicDir = [System.Environment]::GetEnvironmentVariable('PUBLIC')
$tempDir = [System.IO.Path]::GetTempPath().TrimEnd('\')
$sharedDirOk = $false
if ($paramsPath) {
    $paramsDir = Split-Path -Parent $paramsPath
    $sharedDirOk = ($paramsDir -notmatch '\\\.install$') -and
        (($paramsDir -eq $publicDir) -or ($paramsDir -eq $tempDir))
}
Add-Result -Name 'params-shared:path' -Expected 1 -Actual ([int]$sharedDirOk) -Note ("" + $paramsPath + " (клиент: не .install)")
Add-Result -Name 'params-shared:scope-machine' -Expected 1 -Actual ([int]($paramsScope -eq 'machine')) -Note ("scope=" + $paramsScope)
Add-Result -Name 'params-shared:deleted' -Expected 1 -Actual ([int]($paramsDeleted -eq '1')) -Note ("deleted=" + $paramsDeleted)
# Серверная установка: файл параметров — в %ProgramData%\ETN\.install (в
# тестовой сборке каталог данных подменён на .tmp\installer-tests\data).
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTPARAMS=1', '/TESTSELECT=server'))
Add-Result -Name 'params-server-install:code' -Expected 0 -Actual $code
$serverParamsPath = Get-LogLine -Pattern 'TESTPARAMS path=(\S+) scope='
$serverInstallOk = $serverParamsPath -and
    ($serverParamsPath -match '\\\.install\\params-.*\.json$') -and
    ($serverParamsPath.StartsWith($dataDir, [System.StringComparison]::OrdinalIgnoreCase))
Add-Result -Name 'params-server-install:path' -Expected 1 -Actual ([int][bool]$serverInstallOk) -Note $serverParamsPath
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTPARAMS=1', '/TESTSELECT=client-user'))
$paramsScopeUser = Get-LogLine -Pattern 'TESTPARAMS path=\S+ scope=(\S+)'
Add-Result -Name 'params-shared:scope-user' -Expected 1 -Actual ([int]($paramsScopeUser -eq 'user')) -Note ("scope=" + $paramsScopeUser)

# ============================================================================
# 9b310991: параметры сервера, предпроверки, подстановка шаблона, брандмауэр.
# ============================================================================
Write-Host '=== 9b310991: параметры сервера и предпроверки ==='
$precheckResult = Join-Path $workRoot 'precheck-reason.txt'

function Reset-PrecheckResult {
    Remove-Item -LiteralPath $precheckResult -Force -ErrorAction SilentlyContinue
}

function Get-PrecheckResult {
    # Установщик пишет причину в UTF-8 (9b310991); пустой файл = успех.
    if (-not (Test-Path -LiteralPath $precheckResult)) { return '' }
    $text = [System.IO.File]::ReadAllText($precheckResult, [System.Text.Encoding]::UTF8)
    return $text.Trim()
}

# Порт, занятый другим приложением: предпроверка возвращает 20 и понятную
# причину; журнал фиксирует результат той же функции, что вызывают экран
# параметров сервера и привилегированная фаза.
Reset-State
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$busyListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 0)
$busyListener.Start()
$busyPort = ([System.Net.IPEndPoint]$busyListener.LocalEndpoint).Port
try {
    Reset-PrecheckResult
    $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
        "/TESTPORT=$busyPort", "/TESTRESULT=`"$precheckResult`""))
} finally {
    $busyListener.Stop()
}
Add-Result -Name 'precheck:port-busy-code' -Expected 20 -Actual $code
$busyReason = Get-PrecheckResult
$busyReasonOk = $busyReason -match ('порт ' + $busyPort + ' занят другим приложением')
Add-Result -Name 'precheck:port-busy-reason' -Expected 1 -Actual ([int]$busyReasonOk) -Note $busyReason
$busyLog = Get-LogLine -Pattern 'TESTPRECHECK result=([^\r\n]+)'
Add-Result -Name 'precheck:port-busy-log' -Expected 1 -Actual ([int]([bool]$busyLog)) -Note $busyLog

# Порт занят ТОЛЬКО на loopback: сервер слушает 0.0.0.0, поэтому пробный bind
# на 0.0.0.0 такой слушатель не видит — дефект B1 приёмки 9b310991 (установщик
# возвращал 0, health-check попадал в чужой процесс). Установщик обязан
# перечислить всех слушателей (Get-NetTCPConnection) и вернуть 20.
Reset-State
$loopListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$loopListener.Start()
$loopPort = ([System.Net.IPEndPoint]$loopListener.LocalEndpoint).Port
try {
    Reset-PrecheckResult
    $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
        "/TESTPORT=$loopPort", "/TESTRESULT=`"$precheckResult`""))
} finally {
    $loopListener.Stop()
}
Add-Result -Name 'precheck:port-loopback-busy-code' -Expected 20 -Actual $code
$loopReason = Get-PrecheckResult
$loopReasonOk = $loopReason -match ('порт ' + $loopPort + ' занят другим приложением')
Add-Result -Name 'precheck:port-loopback-busy-reason' -Expected 1 -Actual ([int]$loopReasonOk) -Note $loopReason

# Порт занят на КОНКРЕТНОМ адресе (127.0.0.2 — отдельный адрес loopback-
# диапазона): пробный bind на 0.0.0.0 проходит (проверено: старый код считал
# порт свободным), а Get-NetTCPConnection видит слушателя — та же ошибка B1,
# что воспроизведена на 192.168.0.110.
Reset-State
$addrListener = $null
$addrPort = 0
$addrCaseOk = $false
try {
    $addrListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.2'), 0)
    $addrListener.Start()
    $addrPort = ([System.Net.IPEndPoint]$addrListener.LocalEndpoint).Port
    Reset-PrecheckResult
    $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
        "/TESTPORT=$addrPort", "/TESTRESULT=`"$precheckResult`""))
    Add-Result -Name 'precheck:port-address-busy-code' -Expected 20 -Actual $code
    $addrReason = Get-PrecheckResult
    $addrReasonOk = $addrReason -match ('порт ' + $addrPort + ' занят другим приложением')
    Add-Result -Name 'precheck:port-address-busy-reason' -Expected 1 -Actual ([int]$addrReasonOk) -Note $addrReason
    $addrCaseOk = $true
} catch {
    Write-Host ('      конкретный адрес 127.0.0.2 недоступен: ' + $_.Exception.Message)
} finally {
    if ($null -ne $addrListener) { $addrListener.Stop() }
}
if (-not $addrCaseOk) {
    Add-Result -Name 'precheck:port-address-busy-code' -Expected 1 -Actual 0 -Note '127.0.0.2 не занялся — сценарий не выполнен'
}

# B3: ветка «порт занят собственной службой ETN». Скрипт ServerPortStatus
# передаётся в powershell.exe -Command "<...>", и вложенные двойные кавычки
# срезаются разбором командной строки: CIM-фильтр становился невалидным,
# $svc всегда null, слушатель своей службы считался чужим. Поведенческие
# пробы идут через настоящий ServerPortStatus тестового установщика.
Write-Host '=== 9b310991 B3: собственная служба и цепочка потомков WinSW ==='

# 1. CIM-запрос в том же -Command: имя реальной запущенной службы подменяется
#    хуком; скрипт возвращает 0, только если служба действительно найдена
#    (сломанный фильтр с кавычками даёт 2 при любом имени).
$probeServiceName = ''
$spooler = $null
try {
    $spooler = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -eq 'Spooler' } |
        Select-Object -First 1)
} catch { }
if (($spooler.Count -gt 0) -and ($spooler[0].State -eq 'Running') -and ([int]$spooler[0].ProcessId -gt 0)) {
    $probeServiceName = 'Spooler'
} else {
    try {
        $running = @(Get-CimInstance Win32_Service | Where-Object {
                ($_.State -eq 'Running') -and ([int]$_.ProcessId -gt 0) } |
            Select-Object -First 1)
        if ($running.Count -gt 0) { $probeServiceName = $running[0].Name }
    } catch { }
}
if ($probeServiceName -eq '') {
    Add-StaticResult -Name 'ownsvc:query-real-service' -Ok $false -Note 'на машине нет запущенной службы с PID — проба невозможна'
} else {
    Reset-State
    Reset-PrecheckResult
    $probePort = Get-FreeTcpPort
    $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', "/TESTPORT=$probePort",
        "/TESTSERVICENAME=$probeServiceName", "/TESTRESULT=`"$precheckResult`""))
    Add-Result -Name 'ownsvc:query-real-service' -Expected 0 -Actual $code `
        -Note ("служба $probeServiceName найдена через -Command")
    Add-Result -Name 'ownsvc:query-real-reason-empty' -Expected 1 `
        -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'причина пуста'
}

Reset-State
Reset-PrecheckResult
$missingPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', "/TESTPORT=$missingPort",
    '/TESTSERVICENAME=ETN-NoSuchService-9f2a', "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'ownsvc:query-missing-service' -Expected 20 -Actual $code
$missingReason = Get-PrecheckResult
$missingReasonOk = $missingReason -match 'не удалось проверить занятость порта'
Add-Result -Name 'ownsvc:query-missing-reason' -Expected 1 -Actual ([int]$missingReasonOk) -Note $missingReason

# 2. Слушатель, принадлежащий «своей службе» и её потомку. Дерево процессов:
#    обёртка (хук = её PID, как PID службы WinSW) -> процесс-слушатель.
$listenerPort = Get-FreeTcpPort
$listenerFile = Join-Path $workRoot 'ownsvc-listener.ps1'
$wrapperFile = Join-Path $workRoot 'ownsvc-wrapper.ps1'
$childPidFile = Join-Path $workRoot 'ownsvc-child.pid'
Remove-Item -LiteralPath $childPidFile -Force -ErrorAction SilentlyContinue
$listenerText = @"
`$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $listenerPort)
`$l.Start()
Start-Sleep -Seconds 120
"@
[System.IO.File]::WriteAllText($listenerFile, $listenerText, [System.Text.Encoding]::UTF8)
$wrapperText = @"
`$child = Start-Process -FilePath '$psExe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','$listenerFile') -PassThru -WindowStyle Hidden
`$child.Id | Set-Content -LiteralPath '$childPidFile'
Start-Sleep -Seconds 120
"@
[System.IO.File]::WriteAllText($wrapperFile, $wrapperText, [System.Text.Encoding]::UTF8)
$wrapper = Start-Process -FilePath $psExe `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $wrapperFile) `
    -PassThru -WindowStyle Hidden
$childPid = 0
$ownerPid = 0
try {
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        if (($childPid -eq 0) -and (Test-Path -LiteralPath $childPidFile)) {
            $pidText = ([System.IO.File]::ReadAllText($childPidFile)).Trim()
            if ($pidText -match '^\d+$') { $childPid = [int]$pidText }
        }
        try {
            $conn = @(Get-NetTCPConnection -LocalPort $listenerPort -State Listen -ErrorAction Stop |
                Select-Object -First 1)
            if ($conn.Count -gt 0) { $ownerPid = [int]$conn[0].OwningProcess }
        } catch { }
        if (($ownerPid -gt 0) -and ($childPid -gt 0)) { break }
        Start-Sleep -Milliseconds 200
    }
    $ready = ($ownerPid -gt 0) -and ($childPid -gt 0) -and ($ownerPid -eq $childPid)
    Add-Result -Name 'ownsvc:listener-ready' -Expected 1 -Actual ([int]$ready) `
        -Note ("слушатель pid=$ownerPid, обёртка pid=" + $wrapper.Id)

    if ($ready) {
        # Чужой слушатель без хука — занят (контроль: проба не пустая).
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$listenerPort", "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'ownsvc:foreign-listener-busy' -Expected 20 -Actual $code
        Add-Result -Name 'ownsvc:foreign-listener-reason' -Expected 1 `
            -Actual ([int]((Get-PrecheckResult) -match ('порт ' + $listenerPort + ' занят другим приложением'))) `
            -Note 'слушатель неизвестного PID — занят'

        # PID самой службы = PID процесса-слушателя — своим.
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$listenerPort", "/TESTOWNSERVICEPID=$childPid",
            "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'ownsvc:self-pid-code' -Expected 0 -Actual $code
        Add-Result -Name 'ownsvc:self-pid-reason-empty' -Expected 1 `
            -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'слушатель своего PID — свободен для ETN'

        # PID службы = PID обёртки (родителя): потомок WinSW — своим.
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$listenerPort", "/TESTOWNSERVICEPID=$($wrapper.Id)",
            "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'ownsvc:descendant-pid-code' -Expected 0 -Actual $code
        Add-Result -Name 'ownsvc:descendant-pid-reason-empty' -Expected 1 `
            -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'слушатель-потомок WinSW — свободен для ETN'
    } else {
        Add-Result -Name 'ownsvc:foreign-listener-busy' -Expected 1 -Actual 0 -Note 'дерево процессов не поднялось'
        Add-Result -Name 'ownsvc:self-pid-code' -Expected 1 -Actual 0 -Note 'дерево процессов не поднялось'
        Add-Result -Name 'ownsvc:descendant-pid-code' -Expected 1 -Actual 0 -Note 'дерево процессов не поднялось'
    }
} finally {
    if ($childPid -gt 0) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
    if ($ownerPid -gt 0) { Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $wrapper.Id -Force -ErrorAction SilentlyContinue
}

# Замечание 6: реальный LAN-адрес машины (если он есть). Тот же путь кода,
# что loopback/127.0.0.2, но адрес не из loopback-диапазона.
$lanAddress = ''
try {
    $lanAddress = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
            ($_.IPAddress -notmatch '^127\.') -and ($_.IPAddress -notmatch '^169\.254\.') } |
        Select-Object -First 1 -ExpandProperty IPAddress)
} catch { }
if ($lanAddress) {
    $lanListener = $null
    try {
        $lanListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($lanAddress), 0)
        $lanListener.Start()
        $lanPort = ([System.Net.IPEndPoint]$lanListener.LocalEndpoint).Port
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$lanPort", "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'precheck:port-lan-busy-code' -Expected 20 -Actual $code -Note ("LAN $lanAddress")
        $lanReason = Get-PrecheckResult
        Add-Result -Name 'precheck:port-lan-busy-reason' -Expected 1 `
            -Actual ([int]($lanReason -match ('порт ' + $lanPort + ' занят другим приложением'))) -Note $lanReason
    } catch {
        Write-Host ('      LAN-адрес ' + $lanAddress + ' недоступен для bind: ' + $_.Exception.Message)
    } finally {
        if ($null -ne $lanListener) { $lanListener.Stop() }
    }
} else {
    Write-Host '      LAN-адрес не найден — кейс реального LAN-адреса не выполнялся'
}

# Некорректный порт.
Reset-State
Reset-PrecheckResult
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', '/TESTPORT=70000',
    "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:port-invalid-code' -Expected 20 -Actual $code
$invalidReason = Get-PrecheckResult
$invalidReasonOk = $invalidReason -match 'некорректный порт "70000"'
Add-Result -Name 'precheck:port-invalid-reason' -Expected 1 -Actual ([int]$invalidReasonOk) -Note $invalidReason

# Свободный порт и достаточно места: предпроверка проходит (причина пуста).
Reset-State
Reset-PrecheckResult
$freePort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', "/TESTPORT=$freePort",
    "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:ok-code' -Expected 0 -Actual $code
Add-Result -Name 'precheck:ok-reason' -Expected 1 -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'причина пуста'

# Путь каталога данных занят файлом — ошибка и без прав администратора.
Reset-State
Reset-PrecheckResult
$blockedPath = Join-Path $workRoot 'blocked-data-dir'
[System.IO.File]::WriteAllText($blockedPath, 'not a directory')
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', "/TESTPORT=$freePort",
    "/TESTDATADIR=`"$blockedPath`"", "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:datadir-file-code' -Expected 20 -Actual $code
$blockedReason = Get-PrecheckResult
$blockedReasonOk = $blockedReason -match 'путь каталога данных занят файлом'
Add-Result -Name 'precheck:datadir-file-reason' -Expected 1 -Actual ([int]$blockedReasonOk) -Note $blockedReason
Remove-Item -LiteralPath $blockedPath -Force -ErrorAction SilentlyContinue

# Недостаток свободного места: порог подменён тестовым хуком.
Reset-State
Reset-PrecheckResult
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', "/TESTPORT=$freePort",
    '/TESTMINFREE=900000000000000', "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:free-space-code' -Expected 20 -Actual $code
$spaceReason = Get-PrecheckResult
$spaceReasonOk = $spaceReason -match 'недостаточно свободного места для каталога данных'
Add-Result -Name 'precheck:free-space-reason' -Expected 1 -Actual ([int]$spaceReasonOk) -Note $spaceReason

Write-Host '=== 9b310991: подстановка шаблона службы и брандмауэр ==='

# Серверная установка с включённым брандмауэром: шаблон службы подставлен,
# каталоги данных созданы, правило «разрешено» (netsh подменён тестовым хуком).
Reset-State
$serverPort = Get-FreeTcpPort
$privParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Port $serverPort `
    -Firewall 1 -DisplayName 'ETN Server' -Name 'server-fw.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"",
    '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'server-fw:code' -Expected 0 -Actual $code

$serviceXmlPath = Join-Path $appDir 'service\etn-service.xml'
$serviceXmlOk = $false
$serviceNoPlaceholders = $false
$serviceValuesOk = $false
$serviceDescription = ''
if (Test-Path -LiteralPath $serviceXmlPath) {
    $serviceText = [System.IO.File]::ReadAllText($serviceXmlPath, [System.Text.Encoding]::UTF8)
    $serviceNoPlaceholders = -not $serviceText.Contains('{{')
    try {
        $serviceXml = [xml]$serviceText
        $envNodes = @($serviceXml.SelectNodes('/service/env'))
        $dataEnv = ($envNodes | Where-Object { $_.name -eq 'ETN_DATA_DIR' } | Select-Object -First 1).value
        $portEnv = ($envNodes | Where-Object { $_.name -eq 'ETN_PORT' } | Select-Object -First 1).value
        $hostEnv = ($envNodes | Where-Object { $_.name -eq 'ETN_HOST' } | Select-Object -First 1).value
        $logPath = [string]$serviceXml.service.logpath
        $serviceDescription = [string]$serviceXml.service.description
        $serviceValuesOk = ($dataEnv -eq $dataDir) -and ($portEnv -eq [string]$serverPort) -and
            ($hostEnv -eq '0.0.0.0') -and ($logPath -eq (Join-Path $dataDir 'logs\service'))
        $serviceXmlOk = $true
    } catch {
        Write-Host ("      etn-service.xml не разобран как XML: {0}" -f $_.Exception.Message)
    }
}
Add-Result -Name 'server-fw:xml-parsed' -Expected 1 -Actual ([int]$serviceXmlOk)
Add-Result -Name 'server-fw:no-placeholders' -Expected 1 -Actual ([int]$serviceNoPlaceholders)
Add-Result -Name 'server-fw:env-values' -Expected 1 -Actual ([int]$serviceValuesOk) -Note ('данные/порт/хост/журнал; ' + $serviceDescription)
Add-Result -Name 'server-fw:description-utf8' -Expected 1 `
    -Actual ([int]($serviceDescription -eq 'ETN — сервер графовых баз знаний')) -Note $serviceDescription

$serviceDirsOk = (Test-Path -LiteralPath (Join-Path $dataDir 'logs\service')) -and
    (Test-Path -LiteralPath (Join-Path $dataDir 'backups'))
Add-Result -Name 'server-fw:data-dirs' -Expected 1 -Actual ([int]$serviceDirsOk) -Note 'logs\service и backups созданы установщиком'

$fwAddLog = Get-LogLine -Pattern 'Правило брандмауэра создано: TCP ([0-9]+)'
Add-Result -Name 'server-fw:rule-created' -Expected 1 -Actual ([int]($fwAddLog -eq [string]$serverPort)) -Note ("TCP " + $fwAddLog)
$fwProfiles = Get-LogLine -Pattern 'Правило брандмауэра создано: TCP [0-9]+, профили ([a-z,]+)'
Add-Result -Name 'server-fw:profiles' -Expected 1 -Actual ([int]($fwProfiles -eq 'domain,private')) -Note $fwProfiles
$fwAddCmd = Get-LogLine -Pattern 'FIREWALL \(тестовый режим, без изменений\): netsh advfirewall firewall add rule name="ETN Server" dir=in action=allow protocol=TCP localport=([0-9]+)'
Add-Result -Name 'server-fw:netsh-add' -Expected 1 -Actual ([int]($fwAddCmd -eq [string]$serverPort)) -Note ("localport=" + $fwAddCmd)
$jsonFw = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$jsonFwOk = ($jsonFw -match ('"port":' + $serverPort + ',')) -and
    ($jsonFw -match '"host":"0\.0\.0\.0"') -and ($jsonFw -match '"firewall":true') -and
    ($jsonFw -match '"mode":"service"')
Add-Result -Name 'server-fw:install-json' -Expected 1 -Actual ([int]$jsonFwOk) -Note 'port/host/firewall/mode'

# Брандмауэр выключен: правило удаляется, новое не создаётся, ETN_HOST=127.0.0.1.
Reset-State
$serverPort2 = Get-FreeTcpPort
$privParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Port $serverPort2 `
    -Firewall 0 -Name 'server-nofw.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"",
    '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'server-nofw:code' -Expected 0 -Actual $code
$nofwAdd = Get-LogLine -Pattern 'FIREWALL \(тестовый режим, без изменений\): netsh advfirewall firewall add rule'
Add-Result -Name 'server-nofw:no-add' -Expected 1 -Actual ([int]($nofwAdd -eq '')) -Note 'правило не создаётся'
$nofwDelete = Get-LogLine -Pattern '(FIREWALL \(тестовый режим, без изменений\): netsh advfirewall firewall delete rule name="ETN Server")'
Add-Result -Name 'server-nofw:delete-first' -Expected 1 -Actual ([int]($nofwDelete -ne '')) -Note 'старое правило удаляется'
$nofwMsg = Get-LogLine -Pattern 'подключения с других компьютеров запрещены \(порт ([0-9]+)'
Add-Result -Name 'server-nofw:log' -Expected 1 -Actual ([int]($nofwMsg -eq [string]$serverPort2)) -Note ("порт " + $nofwMsg)
$nofwXml = [System.IO.File]::ReadAllText((Join-Path $appDir 'service\etn-service.xml'), [System.Text.Encoding]::UTF8)
$nofwHostOk = $nofwXml -match 'name="ETN_HOST" value="127\.0\.0\.1"'
Add-Result -Name 'server-nofw:host-local' -Expected 1 -Actual ([int]$nofwHostOk) -Note 'ETN_HOST=127.0.0.1'

# Ошибка netsh (тестовый хук /TESTFIREWALL=fail): установка НЕ отменяется
# (код 0, install.json с firewall=true), в журнале — понятное предупреждение,
# что сервер слушает 0.0.0.0, но LAN может блокироваться брандмауэром.
Reset-State
$fwFailPort = Get-FreeTcpPort
$privParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Port $fwFailPort `
    -Firewall 1 -Name 'server-fw-fail.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"",
    '/TESTELEVATED=1', '/TESTHEALTH=ok', '/TESTFIREWALL=fail'))
Add-Result -Name 'server-fw-fail:code' -Expected 0 -Actual $code
$fwFailWarn = Get-LogLine -Pattern ('(Брандмауэр: правило «ETN Server» не создано \(TCP ' + $fwFailPort + '\).*Установка продолжается)')
Add-Result -Name 'server-fw-fail:warning' -Expected 1 -Actual ([int]($fwFailWarn -ne '')) -Note 'предупреждение в журнале'
$fwFailHost = Get-LogLine -Pattern 'Установка продолжается: сервер слушает (0\.0\.0\.0)'
Add-Result -Name 'server-fw-fail:host-fact' -Expected 1 -Actual ([int]($fwFailHost -eq '0.0.0.0')) -Note ('слушает ' + $fwFailHost)
$fwFailJson = ''
if (Test-Path -LiteralPath (Join-Path $dataDir 'install.json')) {
    $fwFailJson = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
}
Add-Result -Name 'server-fw-fail:install-json' -Expected 1 -Actual ([int]($fwFailJson -match '"firewall":true')) -Note 'firewall остаётся значением чекбокса'

# Отказ предпроверки в привилегированной фазе: код 20, причина — в файле,
# изменения не выполнялись (нет файлов сервера и install.json).
Reset-State
$busyListener2 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 0)
$busyListener2.Start()
$busyPort2 = ([System.Net.IPEndPoint]$busyListener2.LocalEndpoint).Port
$privReason = Join-Path $workRoot 'priv-reason.txt'
Remove-Item -LiteralPath $privReason -Force -ErrorAction SilentlyContinue
$privParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Port $busyPort2 `
    -ReasonFile $privReason -Name 'server-busy.ini'
try {
    $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"",
        '/TESTELEVATED=1', '/TESTHEALTH=ok'))
} finally {
    $busyListener2.Stop()
}
Add-Result -Name 'priv-precheck:code' -Expected 20 -Actual $code
$privReasonText = ''
if (Test-Path -LiteralPath $privReason) {
    $privReasonText = ([System.IO.File]::ReadAllText($privReason, [System.Text.Encoding]::UTF8)).Trim()
}
Add-Result -Name 'priv-precheck:reason-file' -Expected 1 `
    -Actual ([int]($privReasonText -match ('порт ' + $busyPort2 + ' занят другим приложением'))) -Note $privReasonText
$privNoChanges = (-not (Test-Path -LiteralPath (Join-Path $appDir 'server\dist\index.js'))) -and
    (-not (Test-Path -LiteralPath (Join-Path $appDir 'service'))) -and
    (-not (Test-Path -LiteralPath (Join-Path $dataDir 'install.json')))
Add-Result -Name 'priv-precheck:no-changes' -Expected 1 -Actual ([int]$privNoChanges) -Note 'файлы и install.json не созданы'

# Установка только клиента «для всех»: серверных каталогов и конфигурации
# службы не появляется (каталог данных задан отдельно — журнал в песочницу не
# пишется, чтобы проверка была про установку, а не про тестовый движок).
Reset-State
$clientOnlyData = Join-Path $workRoot 'client-only-data'
if (Test-Path -LiteralPath $clientOnlyData) { Remove-Item -LiteralPath $clientOnlyData -Recurse -Force }
$privParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-only.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"",
    '/TESTELEVATED=1', '/TESTHEALTH=ok', "/TESTDATADIR=`"$clientOnlyData`""))
Add-Result -Name 'client-only:code' -Expected 0 -Actual $code
$clientNoServerDirs = (-not (Test-Path -LiteralPath (Join-Path $clientOnlyData 'logs\service'))) -and
    (-not (Test-Path -LiteralPath (Join-Path $clientOnlyData 'backups'))) -and
    (-not (Test-Path -LiteralPath (Join-Path $appDir 'service\etn-service.xml')))
Add-Result -Name 'client-only:no-server-dirs' -Expected 1 -Actual ([int]$clientNoServerDirs) -Note 'нет logs\service, backups и etn-service.xml'
$clientOnlyJson = ''
if (Test-Path -LiteralPath (Join-Path $clientOnlyData 'install.json')) {
    $clientOnlyJson = Get-Content -LiteralPath (Join-Path $clientOnlyData 'install.json') -Raw
}
$clientOnlyJsonOk = ($clientOnlyJson -match '"mode":"client"') -and
    ($clientOnlyJson -match '"client_scope":"machine"')
Add-Result -Name 'client-only:install-json' -Expected 1 -Actual ([int]$clientOnlyJsonOk) `
    -Note 'mode=client, client_scope=machine'


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
# install.json обязателен и для клиента «для всех» без сервера: иначе повторный
# запуск потеряет область клиента и поставит вторую per-user копию.
$clientJsonPath = Join-Path $dataDir 'install.json'
$clientJsonOk = $false
if (Test-Path -LiteralPath $clientJsonPath) {
    $clientJson = Get-Content -LiteralPath $clientJsonPath -Raw
    $clientJsonOk = ($clientJson -match '"mode":"client"') -and ($clientJson -match '"client_scope":"machine"')
}
Add-Result -Name 'client-machine:install-json' -Expected 1 -Actual ([int]$clientJsonOk) -Note 'mode=client, client_scope=machine'
$probe = Invoke-StateProbe
Add-StateResult -Name 'client-machine:repeat-state' -Line $probe.State -Pairs @(
    'server_state=not-installed', 'client_state=installed',
    'default_server=0', 'default_client=1',
    'client_scope=machine', 'need_elevation=1') -Note 'область клиента восстановлена'

Reset-State
$privParams = New-ParamsFile -Server 0 -Client 1 -Scope user -Name 'priv-client-user.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$privParams`"", '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'privileged-client-user:code' -Expected 0 -Actual $code
$userClientInChild = (Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe')) -or
    (Test-Path -LiteralPath (Join-Path $appDir 'ETN.exe'))
Add-Result -Name 'privileged-client-user:not-copied' -Expected 0 -Actual ([int]$userClientInChild) -Note 'пользовательский клиент ставит неэлевированная фаза'

# ============================================================================
# ce3ab836: бэкап БД перед обновлением — формат, целостность, ротация.
# ============================================================================
Write-Host '=== ce3ab836: бэкап БД, три архива и integrity_check ==='

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $script:BackupNode = $nodeCommand.Source }
$backupNodeVersion = ''
if ($script:BackupNode) { $backupNodeVersion = (& $script:BackupNode -v).Trim() }
Add-StaticResult -Name 'backup:node22' -Ok ($backupNodeVersion -match '^v22\.') `
    -Note ('Node для integrity_check: ' + $backupNodeVersion)
if (-not $backupNodeVersion.StartsWith('v22.')) {
    throw "Проверки бэкапа требуют Node 22 в PATH (найдено: '$backupNodeVersion')."
}
$backupNodeArg = "/TESTNODEEXE=`"$script:BackupNode`""

# --- A. Архив создаётся: копии баз, WAL-хвост, integrity_check --------------
Reset-State
$payloadModulesOk = Initialize-BackupServerPayload
Add-StaticResult -Name 'backup:server-modules' -Ok $payloadModulesOk `
    -Note 'better-sqlite3 в app\server\node_modules (как в поставке)'
$networkId = '11111111-2222-3333-4444-555555555555'
$systemDb = Join-Path $dataDir '_system.db'
$networkDb = Join-Path $dataDir ('networks\' + $networkId + '\data.db')
$dbFixturesOk = (New-BackupTestDatabase -Path $systemDb -Values @('alpha', 'beta') -LeaveWalTail) -and
    (New-BackupTestDatabase -Path $networkDb -Values @('gamma'))
Add-StaticResult -Name 'backup:fixtures' -Ok $dbFixturesOk `
    -Note 'WAL-база с незачекпойнченным хвостом и база сети'
Add-StaticResult -Name 'backup:wal-left' -Ok (Test-Path -LiteralPath ($systemDb + '-wal')) `
    -Note 'после «падения службы» -wal остался на диске'
$foreignFile = Join-Path $dataDir 'backups\notes.txt'
$foreignDirFile = Join-Path $dataDir 'backups\my-copy\keep.txt'
New-Item -ItemType Directory -Path (Split-Path -Parent $foreignDirFile) -Force | Out-Null
[System.IO.File]::WriteAllText($foreignFile, 'foreign')
[System.IO.File]::WriteAllText($foreignDirFile, 'foreign')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:create-code' -Expected 0 -Actual $code
$archives = @(Get-BackupArchives)
Add-Result -Name 'backup:one-archive' -Expected 1 -Actual ([int]$archives.Count)
if ($archives.Count -ge 1) {
    $archive = $archives[-1].FullName
    $systemCopy = Join-Path $archive '_system.db'
    $networkCopy = Join-Path $archive ('networks\' + $networkId + '\data.db')
    Add-Result -Name 'backup:system-copy' -Expected 1 -Actual ([int](Test-Path -LiteralPath $systemCopy))
    Add-Result -Name 'backup:network-copy' -Expected 1 -Actual ([int](Test-Path -LiteralPath $networkCopy))
    Add-Result -Name 'backup:system-integrity' -Expected 1 `
        -Actual ([int](Test-BackupDatabaseIntegrity -Path $systemCopy))
    Add-Result -Name 'backup:network-integrity' -Expected 1 `
        -Actual ([int](Test-BackupDatabaseIntegrity -Path $networkCopy))
    $systemValues = Get-BackupTestValues -Path $systemCopy
    Add-Result -Name 'backup:wal-tail-kept' -Expected 1 `
        -Actual ([int]($systemValues -eq 'alpha|beta|wal-tail')) -Note $systemValues
    Add-Result -Name 'backup:checkpoint-no-wal' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath ($systemCopy + '-wal'))) `
        -Note 'чекпойнт перед копированием: архив — самодостаточный файл базы'
} else {
    Add-Result -Name 'backup:system-copy' -Expected 1 -Actual 0 -Note 'архив не создан'
    Add-Result -Name 'backup:system-integrity' -Expected 1 -Actual 0 -Note 'архив не создан'
}
Add-Result -Name 'backup:foreign-file' -Expected 1 -Actual ([int](Test-Path -LiteralPath $foreignFile))
Add-Result -Name 'backup:foreign-dir' -Expected 1 -Actual ([int](Test-Path -LiteralPath $foreignDirFile))

# --- B. Ошибка создания архива: код 10, файлы не тронуты --------------------
Reset-State
$null = Initialize-BackupServerPayload
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$blockedBackups = Join-Path $dataDir 'backups'
[System.IO.File]::WriteAllText($blockedBackups, 'occupied')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:fail-code' -Expected 10 -Actual $code
$failArchives = @(Get-BackupArchives)
Add-Result -Name 'backup:fail-no-archive' -Expected 0 -Actual ([int]$failArchives.Count)
$blockedKept = ((Get-Content -LiteralPath $blockedBackups -Raw).Trim() -eq 'occupied')
Add-Result -Name 'backup:fail-path-kept' -Expected 1 -Actual ([int]$blockedKept) `
    -Note 'путь backups остался прежним файлом'
Add-Result -Name 'backup:fail-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'не удалось создать каталог архивов'))

# --- C. Битая база: integrity_check не пройден, архив удалён, код 10 ---------
Reset-State
$null = Initialize-BackupServerPayload
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $dataDir '_system.db'), 'not a sqlite database at all')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:corrupt-code' -Expected 10 -Actual $code
$corruptArchives = @(Get-BackupArchives)
Add-Result -Name 'backup:corrupt-no-archive' -Expected 0 -Actual ([int]$corruptArchives.Count)
Add-Result -Name 'backup:corrupt-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'integrity_check не пройден'))

# --- D. Нет node.exe поставки: архив не проходит проверку -------------------
Reset-State
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1'))
Add-Result -Name 'backup:no-node-code' -Expected 10 -Actual $code
$noNodeArchives = @(Get-BackupArchives)
Add-Result -Name 'backup:no-node-no-archive' -Expected 0 -Actual ([int]$noNodeArchives.Count)
Add-Result -Name 'backup:no-node-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'нет node.exe поставки'))

# --- E. Ремонт той же версии: Needed=False, бэкапа нет ----------------------
Reset-State
$null = Initialize-BackupServerPayload
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$repairForeign = Join-Path $dataDir 'backups\manual\keep.txt'
New-Item -ItemType Directory -Path (Split-Path -Parent $repairForeign) -Force | Out-Null
[System.IO.File]::WriteAllText($repairForeign, 'foreign')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=skip', $backupNodeArg))
Add-Result -Name 'backup:repair-code' -Expected 0 -Actual $code
$repairArchives = @(Get-BackupArchives)
Add-Result -Name 'backup:repair-no-archive' -Expected 0 -Actual ([int]$repairArchives.Count)
Add-Result -Name 'backup:repair-foreign-kept' -Expected 1 -Actual ([int](Test-Path -LiteralPath $repairForeign))
Add-Result -Name 'backup:repair-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'ремонт'))

# --- F. Четвёртый архив: самый старый удалён, остаётся три ------------------
Reset-State
$null = Initialize-BackupServerPayload
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$backupsDir = Join-Path $dataDir 'backups'
$oldNames = @('20000101-000001', '20000102-000002', '20000103-000003')
foreach ($oldName in $oldNames) {
    New-Item -ItemType Directory -Path (Join-Path $backupsDir $oldName) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $dataDir '_system.db') -Destination (Join-Path $backupsDir "$oldName\_system.db")
}
$rotateForeignFile = Join-Path $backupsDir 'notes.txt'
$rotateForeignDir = Join-Path $backupsDir 'manual-copy\keep.txt'
New-Item -ItemType Directory -Path (Split-Path -Parent $rotateForeignDir) -Force | Out-Null
[System.IO.File]::WriteAllText($rotateForeignFile, 'foreign')
[System.IO.File]::WriteAllText($rotateForeignDir, 'foreign')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:rotate-code' -Expected 0 -Actual $code
$rotateArchives = @(Get-BackupArchives)
$rotateNames = @($rotateArchives | ForEach-Object { $_.Name })
Add-Result -Name 'backup:rotate-three-left' -Expected 3 -Actual ([int]$rotateArchives.Count) `
    -Note ($rotateNames -join ', ')
Add-Result -Name 'backup:rotate-oldest-deleted' -Expected 0 `
    -Actual ([int]($rotateNames -contains '20000101-000001'))
$olderKept = ($rotateNames -contains '20000102-000002') -and ($rotateNames -contains '20000103-000003')
Add-Result -Name 'backup:rotate-newer-kept' -Expected 1 -Actual ([int]$olderKept)
$newNames = @($rotateNames | Where-Object { $oldNames -notcontains $_ })
Add-Result -Name 'backup:rotate-new-present' -Expected 1 -Actual ([int]($newNames.Count -eq 1)) `
    -Note ($newNames -join ', ')
Add-Result -Name 'backup:rotate-foreign-kept' -Expected 1 `
    -Actual ([int]((Test-Path -LiteralPath $rotateForeignFile) -and (Test-Path -LiteralPath $rotateForeignDir)))

# --- G. Удаление старого архива не удалось: обновление не отменяется --------
Reset-State
$null = Initialize-BackupServerPayload
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$backupsDir = Join-Path $dataDir 'backups'
foreach ($oldName in $oldNames) {
    New-Item -ItemType Directory -Path (Join-Path $backupsDir $oldName) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $dataDir '_system.db') -Destination (Join-Path $backupsDir "$oldName\_system.db")
}
$lockPath = Join-Path $backupsDir '20000101-000001\locked.bin'
[System.IO.File]::WriteAllText($lockPath, 'locked')
$lockHandle = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
try {
    $code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
} finally {
    $lockHandle.Dispose()
}
Add-Result -Name 'backup:locked-rotate-code' -Expected 0 -Actual $code `
    -Note 'ошибка удаления не отменяет обновление'
$lockedArchives = @(Get-BackupArchives)
Add-Result -Name 'backup:locked-rotate-count' -Expected 4 -Actual ([int]$lockedArchives.Count)
Add-Result -Name 'backup:locked-rotate-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'не удалось удалить старый архив'))

# --- H. Баз данных нет: архив не нужен, обновление продолжается -------------
Reset-State
$null = Initialize-BackupServerPayload
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:no-databases-code' -Expected 0 -Actual $code
Add-Result -Name 'backup:no-databases-no-dir' -Expected 0 `
    -Actual ([int](Test-Path -LiteralPath (Join-Path $dataDir 'backups')))
Add-Result -Name 'backup:no-databases-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'нет баз данных'))

# --- I. Чекпойнт невозможен (база занята читателем): копируется WAL ---------
# Служба остановлена, но файл базы удерживает другой процесс: checkpoint
# получает ошибку, установщик обязан скопировать -wal и всё равно получить
# согласованный архив, проходящий integrity_check.
Reset-State
$null = Initialize-BackupServerPayload
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha') -LeaveWalTail
$busyDbPath = Join-Path $dataDir '_system.db'
$readerHandle = [System.IO.File]::Open($busyDbPath, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
    $code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
} finally {
    $readerHandle.Dispose()
}
Add-Result -Name 'backup:wal-fallback-code' -Expected 0 -Actual $code `
    -Note 'checkpoint не удался — WAL скопирован'
$fallbackArchives = @(Get-BackupArchives)
Add-Result -Name 'backup:wal-fallback-archive' -Expected 1 -Actual ([int]$fallbackArchives.Count)
if ($fallbackArchives.Count -ge 1) {
    $fallbackCopy = Join-Path $fallbackArchives[-1].FullName '_system.db'
    Add-Result -Name 'backup:wal-fallback-integrity' -Expected 1 `
        -Actual ([int](Test-BackupDatabaseIntegrity -Path $fallbackCopy))
    $fallbackValues = Get-BackupTestValues -Path $fallbackCopy
    Add-Result -Name 'backup:wal-fallback-values' -Expected 1 `
        -Actual ([int]($fallbackValues -eq 'alpha|wal-tail')) -Note $fallbackValues
    Add-Result -Name 'backup:wal-fallback-selfcontained' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath ($fallbackCopy + '-wal'))) `
        -Note 'после проверки архив — самодостаточный файл базы'
} else {
    Add-Result -Name 'backup:wal-fallback-integrity' -Expected 1 -Actual 0 -Note 'архив не создан'
}
Add-Result -Name 'backup:wal-fallback-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'копируется файл журнала'))

# ============================================================================
# bb063ac3: обновление — остановка службы, бэкап, снимок отката, health-check.
# ============================================================================
Write-Host '=== bb063ac3: остановка службы, бэкап, health-check и откат ==='

$updateArgs = @('/SERVERONLY', '/TESTELEVATED=1', '/TESTSERVICE=present')
$nodeArg = "/TESTNODEEXE=`"$script:BackupNode`""
$fastHealth = @('/TESTHEALTHWAIT=4000', '/TESTHEALTHSTEP=500')

# --- Статические сторожи порядка (bb063ac3) ---------------------------------
$orderBody = Get-IssFunctionBody -Text $issText -Name 'PrepareServerUpdate'
$pStop = $orderBody.IndexOf('StopServiceForUpdate')
$pBackup = $orderBody.IndexOf('CreateDatabaseBackup(True)')
$pSnapshot = $orderBody.IndexOf('CreateRollbackSnapshot')
Add-StaticResult -Name 'static:update-order' `
    -Ok (($pStop -ge 0) -and ($pBackup -gt $pStop) -and ($pSnapshot -gt $pBackup)) `
    -Note ('остановка → бэкап → снимок отката (' + $pStop + ' < ' + $pBackup + ' < ' + $pSnapshot + ')')
$ssInstallBody = ''
$ssPostInstallBody = ''
$pInstallStep = $stepBody.IndexOf('if CurStep = ssInstall')
$pPostStep = $stepBody.IndexOf('if CurStep = ssPostInstall')
if (($pInstallStep -ge 0) -and ($pPostStep -gt $pInstallStep)) {
    $ssInstallBody = $stepBody.Substring($pInstallStep, $pPostStep - $pInstallStep)
    $ssPostInstallBody = $stepBody.Substring($pPostStep)
}
Add-StaticResult -Name 'static:update-before-copy' `
    -Ok (($ssInstallBody -ne '') -and
        (Test-IssCode -Text $ssInstallBody -Pattern ([regex]::Escape('PrepareServerUpdate(Reason)')))) `
    -Note 'фазы обновления вызываются в ssInstall — до копирования файлов'
Add-StaticResult -Name 'static:no-stop-in-postinstall' `
    -Ok (($ssPostInstallBody -ne '') -and
        (-not (Test-IssCode -Text $ssPostInstallBody -Pattern ([regex]::Escape('StopServiceForUpdate'))))) `
    -Note 'в ssPostInstall служба не останавливается (перенесено в ssInstall)'
Add-StaticResult -Name 'static:install-json-after-health' `
    -Ok (($stepBody.IndexOf('ProbeHealth(True)') -ge 0) -and
        ($stepBody.IndexOf('ProbeHealth(True)') -lt $stepBody.IndexOf('WriteInstallJson'))) `
    -Note 'install.json пишется только после health-check'
Add-StaticResult -Name 'static:cleanup-after-success' `
    -Ok ([bool]($stepBody -match '(?s)if \(GExitCode = EXIT_OK\) and GDoPrivilegedWork then\s*\r?\n\s*CleanupRollbackSnapshot;')) `
    -Note 'снимок отката удаляется только при успехе'
$stopBody = Get-IssFunctionBody -Text $issText -Name 'StopServiceForUpdate'
$waitBody = Get-IssFunctionBody -Text $issText -Name 'WaitServiceStopped'
Add-StaticResult -Name 'static:wait-service-stopped' `
    -Ok ((Test-IssCode -Text $stopBody -Pattern ([regex]::Escape('WaitServiceStopped'))) -and
        (Test-IssCode -Text $waitBody -Pattern ([regex]::Escape('ServiceStoppedNow')))) `
    -Note 'ожидание реальной остановки службы (sc query, опрос)'
$healthBody = Get-IssFunctionBody -Text $issText -Name 'CheckHealthOnce'
$healthParts = (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape('/api/v1/health'))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape('/api/v1/version'))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape("JsonGetRaw(Body, 'db')"))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape('GProductVersion')))
Add-StaticResult -Name 'static:health-parses-body' -Ok $healthParts `
    -Note 'health и version: разбор тела (status/db/version/api), а не только код'
$rollbackBody = Get-IssFunctionBody -Text $issText -Name 'RollbackAfterFailure'
Add-StaticResult -Name 'static:rollback-messages' `
    -Ok ((Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('Откат выполнен'))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('Откат не выполнен'))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('архив: ')))) `
    -Note 'журнал: «Откат выполнен» / «Откат не выполнен, архив: …»'
$rollbackRootBody = Get-IssFunctionBody -Text $issText -Name 'RollbackRoot'
Add-StaticResult -Name 'static:rollback-dir' `
    -Ok (Test-IssCode -Text $rollbackRootBody -Pattern ([regex]::Escape('\.install\rollback'))) `
    -Note 'снимок отката в %ProgramData%\ETN\.install\rollback'
$restoreBody = Get-IssFunctionBody -Text $issText -Name 'RestoreDatabaseFromBackup'
Add-StaticResult -Name 'static:rollback-db-wal' `
    -Ok (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape("DeleteFile(Dest + '-wal')"))) `
    -Note 'при восстановлении БД WAL неудачного запуска удаляется'
Add-StaticResult -Name 'static:update-hooks-ifdef' `
    -Ok ((Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('GTestHealthUrl'))) -and
        (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('GTestRollback')))) `
    -Note 'хуки health-url и отката — только под #ifdef TestMode'
# Бэкап только при смене версии (карточка bb063ac3). Прежняя версия неизвестна
# (adopt/первая установка) — архив не создаётся: иначе установка поверх чужих
# данных падала бы на проверке целостности их _system.db (регрессия init-key).
$backupNeededBody = Get-IssFunctionBody -Text $issText -Name 'BackupNeeded'
Add-StaticResult -Name 'static:backup-version-only' `
    -Ok ((Test-IssCode -Text $backupNeededBody -Pattern ([regex]::Escape("if Old = '' then"))) -and
        (Test-IssCode -Text $backupNeededBody -Pattern ([regex]::Escape('SemverCompare(Old, GProductVersion)'))) -and
        (-not (Test-IssCode -Text $backupNeededBody -Pattern ([regex]::Escape('Result := GDataDirPresent'))))) `
    -Note 'архив только при известной смене версии, без версии — не нужен'

# --- A. Успешное обновление с настоящим разбором тела health-check ----------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$srv = Start-FakeHealthServer -Mode 'ok' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)"))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'update-ok:code' -Expected 0 -Actual $code
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$targetOk = $jsonText -match ('"product_version":"' + [regex]::Escape($version) + '"')
Add-Result -Name 'update-ok:install-json' -Expected 1 -Actual ([int]$targetOk) -Note ('версия ' + $version)
$archives = @(Get-BackupArchives)
Add-Result -Name 'update-ok:archive' -Expected 1 -Actual ([int]($archives.Count -ge 1))
Add-Result -Name 'update-ok:snapshot-removed' -Expected 0 -Actual ([int](@(Get-RollbackDirs).Count))
$requests = Get-FakeHealthRequests -Server $srv
$bothEndpoints = ($requests -match '/api/v1/health') -and ($requests -match '/api/v1/version')
Add-Result -Name 'update-ok:endpoints' -Expected 1 -Actual ([int][bool]$bothEndpoints) `
    -Note 'health-check проверил и /health, и /version'
$order = Get-LogPatternIndices -Patterns @(
    'Этап: Остановка службы ETN',
    'Бэкап БД: архив создан',
    'Снимок отката: создан',
    'Замена файлов сервера ETN',
    'Health-check http://127.0.0.1',
    'install.json записан')
$orderOk = ($order[0] -ge 0) -and ($order[1] -gt $order[0]) -and ($order[2] -gt $order[1]) -and
    ($order[3] -gt $order[2]) -and ($order[4] -gt $order[3]) -and ($order[5] -gt $order[4])
Add-Result -Name 'update-ok:log-order' -Expected 1 -Actual ([int]$orderOk) `
    -Note ($order -join ' < ')
$newIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
Add-Result -Name 'update-ok:files-replaced' -Expected 1 -Actual ([int]($newIndex -ne $oldIndex)) `
    -Note 'новые файлы скопированы'

# --- B. health вернул чужую версию: код 10 и полный откат -------------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$srv = Start-FakeHealthServer -Mode 'wrong-version' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)"))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'update-foreign:code' -Expected 10 -Actual $code
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
$keptOld = $jsonText -match '"product_version":"0\.15\.0"'
Add-Result -Name 'update-foreign:json-unchanged' -Expected 1 -Actual ([int]$keptOld)
$reverted = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js')) -eq $oldIndex
Add-Result -Name 'update-foreign:files-restored' -Expected 1 -Actual ([int]$reverted) `
    -Note 'файлы возвращены из снимка отката'
$rollbackDirs = @(Get-RollbackDirs)
Add-Result -Name 'update-foreign:snapshot-kept' -Expected 1 -Actual ([int]$rollbackDirs.Count)
$snapshotServer = (Test-Path -LiteralPath (Join-Path $dataDir ('.install\rollback\' +
    $rollbackDirs[0].Name + '\server\dist\index.js')))
Add-Result -Name 'update-foreign:snapshot-content' -Expected 1 -Actual ([int]$snapshotServer) `
    -Note 'снимок содержит прежний server (создан до копирования)'
Add-Result -Name 'update-foreign:rollback-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат выполнен')) `
    -Note 'журнал: «Откат выполнен»'
Add-Result -Name 'update-foreign:health-reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'версия 9\.9\.9 вместо 0\.15\.1')) `
    -Note 'журнал называет причину: чужая версия'
$dbValues = Get-BackupTestValues -Path (Join-Path $dataDir '_system.db')
Add-Result -Name 'update-foreign:db-restored' -Expected 1 -Actual ([int]($dbValues -eq 'alpha')) `
    -Note ('данные после отката: ' + $dbValues)

# --- C. health вернул 500: код 10 и откат -----------------------------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$srv = Start-FakeHealthServer -Mode 'http500' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)"))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'update-http500:code' -Expected 10 -Actual $code
Add-Result -Name 'update-http500:rollback' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат выполнен')) `
    -Note 'HTTP-ошибка health — повод для отката'

# --- D. /api/v1/version вернул чужую версию: код 10 и откат -----------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$srv = Start-FakeHealthServer -Mode 'api-version' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)"))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'update-version:code' -Expected 10 -Actual $code
Add-Result -Name 'update-version:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'version: версия 9\.9\.9 вместо 0\.15\.1')) `
    -Note 'проверяется и GET /api/v1/version'

# --- E. health с db=error: код 10 и откат -----------------------------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$srv = Start-FakeHealthServer -Mode 'db-error' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)"))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'update-db-error:code' -Expected 10 -Actual $code
Add-Result -Name 'update-db-error:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'health: db=error вместо ok')) `
    -Note 'db=ok обязателен'

# --- F. Неудачный откат: код 10 и путь к архиву в журнале -------------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$srv = Start-FakeHealthServer -Mode 'http500' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)", '/TESTROLLBACK=fail'))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'update-rollback-fail:code' -Expected 10 -Actual $code
Add-Result -Name 'update-rollback-fail:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат не выполнен')) `
    -Note 'журнал: «Откат не выполнен»'
Add-Result -Name 'update-rollback-fail:archive-path' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат не выполнен: [^\r\n]*архив: [^\r\n]*backups')) `
    -Note 'в сообщении путь к архиву БД'

# --- G. Бэкап не удался: код 10, файлы не заменены, служба поднята ----------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$blockedBackups = Join-Path $dataDir 'backups'
[System.IO.File]::WriteAllText($blockedBackups, 'occupied')
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @($nodeArg))
Add-Result -Name 'update-backup-fail:code' -Expected 10 -Actual $code `
    -Note 'сценарий bc7cc846: неудачный бэкап отменяет обновление'
$stillOld = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js')) -eq $oldIndex
Add-Result -Name 'update-backup-fail:files-untouched' -Expected 1 -Actual ([int]$stillOld)
Add-Result -Name 'update-backup-fail:no-snapshot' -Expected 0 -Actual ([int](@(Get-RollbackDirs).Count))
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
Add-Result -Name 'update-backup-fail:json-unchanged' -Expected 1 `
    -Actual ([int]($jsonText -match '"product_version":"0\.15\.0"'))
Add-Result -Name 'update-backup-fail:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'не удалось создать каталог архивов'))
Add-Result -Name 'update-backup-fail:service-back' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN: запущена')) `
    -Note 'служба поднята обратно на прежней версии'

# --- H. Служба не остановилась: код 20, изменений нет -----------------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$code = Invoke-Setup -Arguments ($silent + $updateArgs +
    @('/TESTSERVICESTATE=running', '/TESTSERVICEWAIT=1000'))
Add-Result -Name 'update-stop-fail:code' -Expected 20 -Actual $code `
    -Note 'служба не остановилась — предусловие не выполнено'
Add-Result -Name 'update-stop-fail:files-untouched' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex))
Add-Result -Name 'update-stop-fail:no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'update-stop-fail:no-snapshot' -Expected 0 -Actual ([int](@(Get-RollbackDirs).Count))
Add-Result -Name 'update-stop-fail:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'не остановилась за 1000 мс'))

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
