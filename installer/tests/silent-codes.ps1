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
         область задают фактические права процесса, а не радиокнопки;
         область сохраняется в install.json (mode=client) и восстанавливается;
         копия «только для меня» видна и в административном режиме
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
     25. ce3ab836 / 3acd9c3c: бэкап БД перед обновлением (/TESTBACKUP) —
         установщик извлекает самодостаточный etn-db-tool.mjs и вызывает его
         через node.exe поставки (рабочий каталог {app}\server) с аргументами
         backup --to/--report-out/--data-dir; путь архива и причина отказа
         читаются из отчёта key=value. Проверяется контракт: успех (архив,
         записи базы в манифесте, строка журнала с числом баз и байт), отказ
         инструмента и отчёт без причины (код 10 без архива), предупреждения
         инструмента в журнале, нет node.exe поставки (код 10), ремонт — код 0
         без бэкапа, без баз данных архив не создаётся. ZIP, integrity_check,
         WAL и ротация — в CLI (server/tests/db-backup.test.ts); в .iss
         SQLite-логики быть не должно (статический сторож)
     26. bb063ac3 / a1ea1d40: обновление сервера — порядок фаз до копирования
         (остановка службы → бэкап БД → снимок отката), ожидание реальной
         остановки службы (не остановилась — код 20), неудачный бэкап — код 10
         без замены файлов с поднятой службой (bc7cc846), расширенный
         health-check одним GET /api/v1/health (status/db/версия из тела;
         HTTP 500 и чужая версия — код 10 и откат), бюджет 60 с фактического
         времени (не сумма Sleep), возврат файлов из снимка и БД из архива,
         install.json только после успеха, снимок удаляется только при
         успехе, неудачный откат — код 10 с путём к архиву и диагностикой
         health прежней версии в причине
     27. 8b1f5980: регистрация службы WinSW после записи etn-service.xml и до
         запуска (install с конфигом рядом с exe; повторная установка не
         перегистрирует службу, WinSW 1073 — успех, сбой install — код 10),
         запуск без ожидания RUNNING (готовность подтверждает health-check;
         1056 — успех, 1061 — код 10), снятие при удалении — stop → uninstall
         до удаления файлов (проба /TESTUNINSTALLSERVICE: отказ uninstall/stop —
         код 10 с причиной), режим app службу не регистрирует и режим при
         обновлении сохраняется;
     28. 34f8e315: управление службой через etn-service.exe stop|status (без
         sc query): status=Started для любого не-Stopped, ожидание остановки
         по опросу status с бюджетом 60 с, повтор stop на 1061, личность
         службы (ImagePath/Start/DeleteFlag/NonExistent) — код 20 до
         копирования, откат без восстановления файлов/БД при неудачной
         остановке, uninstall 1072 с подтверждением status; sc query и
         *_PENDING в .iss отсутствуют;
     29. 8b1f5980 (приёмка): настоящий деинсталлятор (отдельная тестовая
         сборка с Uninstallable и своим AppId) с моделью службы и проверкой
         наличия etn-service.exe, как в продуктовой ветке: путь службы —
         {app}\service\etn-service.exe, stop и uninstall вызваны, пока файл
         ещё на месте, удаление завершается и файлы удаляются
     30. e375123f: шаблон службы и фикстура задают
         ETN_DEPLOYMENT=windows-service; после установки сгенерированный
         etn-service.xml сохраняет режим службы (сервер, запущенный службой,
         обязан определяться как windows-service)
     31. a7394117: одна запись деинсталляции при смене области реестра —
         GUI-админ-установка (HKCU) и тихое /ALLUSERS-обновление (HKLM) не
         оставляют дубля в «Программах и компонентах»; при обновлении из
         службы (LocalSystem) запись ищется в загруженных профилях HKEY_USERS
         (служебные SID и .DEFAULT не трогаются); режим «только для меня»
         машинную запись и профили не трогает; 7dcbeb0c: удаляется только
         запись машинной установки (InstallLocation/UninstallString указывают
         в {app}), per-user клиент «только для меня» и запись без этих
         значений сохраняются
     32. 1dddac77: пустое перечисление слушателей не считается свободным портом —
         запасная ветка проверяет порт эксклюзивным bind на 0.0.0.0 без
         listen() (SO_EXCLUSIVEADDRUSE): занятый на 0.0.0.0, loopback,
         конкретном адресе или LAN-адресе порт даёт 20, свободный — 0,
         невозможность проверки (хук /TESTPORTBINDFAIL) — 20 с причиной.
         Доступность TCP-таблицы проверяется пробой на loopback (иначе на
         build 28000 живая своя служба даёт «занят»): таблица сломана + служба
         запущена → 0; таблица сломана + службы нет → прежний fail-closed
         (хуки /TESTLISTENERTABLEOFF и /TESTNOSERVICE); обновление поверх
         живой службы проходит, чужой занятый порт по-прежнему даёт 20

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
    foreach ($dir in @($appDir, $dataDir, (Join-Path $workRoot 'shortcuts'))) {
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

# Работает ли перечисление слушателей на этой машине: собственный пробный
# слушатель на loopback обязан появиться в Get-NetTCPConnection со своим PID.
# На аномальной сборке Windows (1dddac77) TCP-таблица не показывает новые
# слушатели, причём пустой ответ и ошибка CIM неразличимы, — поэтому
# «таблица недоступна» доказывается пробой, а не текстом исключения.
function Test-ListenerTableWorks {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    try {
        $port = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
        for ($i = 0; $i -lt 10; $i++) {
            try {
                $found = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
                    Select-Object -First 1)
                if (($found.Count -gt 0) -and ([int]$found[0].OwningProcess -eq $PID)) { return $true }
            } catch { }
            Start-Sleep -Milliseconds 100
        }
        return $false
    } finally { $probe.Stop() }
}

function New-InstallJson {
    param([string]$ProductVersion = '0.15.0', [string]$Mode = 'service',
        [int]$Port = 0, [string]$Firewall = 'true', [string]$ClientScope = 'null')
    # Порт по умолчанию — свободный: предпроверка порта теперь настоящая, а на
    # машине разработчика 4321 может занимать запущенный сервер.
    if ($Port -le 0) { $Port = Get-FreeTcpPort }
    $dataEscaped = $dataDir.Replace('\', '\\')
    return '{"schema":1,"product_version":"' + $ProductVersion + '","mode":"' + $Mode +
        '","data_dir":"' + $dataEscaped + '","host":"0.0.0.0","port":' + $Port + ',' +
        '"firewall":' + $Firewall + ',"client_scope":' + $ClientScope +
        ',"installed_at":"2026-10-01T10:00:00","last_log":""}'
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

function Invoke-StateProbe {
    param([string[]]$ExtraArgs = @())
    $code = Invoke-Setup -Arguments (@($silent) + @('/TESTSTATE=1') + $ExtraArgs)
    return [pscustomobject]@{
        Code   = $code
        State  = (Get-LogLine -Pattern 'TESTSTATE ([^\r\n]+)')
        Notice = (Get-LogLine -Pattern 'TESTSTATE_NOTICE server_notice=([^\r\n]*)')
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
    param([string[]]$Arguments, [string]$Path)
    if (-not $Path) { $Path = $script:SetupPath }
    $proc = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        throw "Установщик не завершился за $TimeoutSec с — возможно, появилось окно или модальный диалог."
    }
    return $proc.ExitCode
}

# Настоящий деинсталлятор (приёмка 8b1f5980): Inno не даёт кода события, но
# процесс удаления возвращает код Inno (0 — удаление завершено, иначе — нет),
# а его журнал и наш журнал удаления показывают, что именно произошло.
function Invoke-Uninstaller {
    param([string]$Path, [string[]]$Arguments)
    $proc = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        throw "Деинсталлятор не завершился за $TimeoutSec с — возможно, появилось окно или модальный диалог."
    }
    return $proc.ExitCode
}

# Деинсталлятор Inno удаляет себя (и каталог программы) в самом конце, уже
# после возврата процесса-лаунчера: ждём исчезновения пути, а не одного момента.
function Wait-PathGone {
    param([string]$Path, [int]$TimeoutMs = 10000)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Path -LiteralPath $Path)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return -not (Test-Path -LiteralPath $Path)
}

# --- ce3ab836 / 3acd9c3c: бэкап БД — настоящий Node и инструмент ------------
# SQLite-операции вынесены в CLI сервера: установщик запускает извлечённый
# etn-db-tool.mjs через node.exe поставки (хук /TESTNODEEXE) с рабочим
# каталогом {app}\server. Фикстура инструмента (fixtures/payload/server/dist/
# db/db-backup.js) реализует только контракт установщика; ZIP, integrity_check,
# WAL и ротация проверяются TS-тестами сервера. better-sqlite3 нужен лишь
# хелперам теста — ими создаются базы для сценариев обновления.
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

# Раскладка установленного сервера для прямого прогона /TESTBACKUP: рабочий
# каталог инструмента {app}\server с package.json версии (имя ZIP и проверка
# версии архива при восстановлении). В продуктовом обновлении этот каталог уже
# есть от прежней установки; хук /TESTBACKUP запускается до копирования файлов.
function Initialize-BackupServerFiles {
    param([string]$Version = '0.15.1')
    $serverDir = Join-Path $appDir 'server'
    New-Item -ItemType Directory -Path $serverDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $serverDir 'package.json'),
        '{"name":"@etn/server","version":"' + $Version + '"}')
    New-Item -ItemType Directory -Path (Join-Path $serverDir 'dist') -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $serverDir 'dist\index.js'), '// stub')
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

# Архивы бэкапа — ZIP-файлы в <данные>\backups; имя формирует инструмент
# (etn-backup-<версия>-<YYYYMMDD-HHMMSS>[-N].zip, сущность 2975c553). Чужие
# файлы и каталоги архивами не считаются.
function Get-BackupArchives {
    $backups = Join-Path $dataDir 'backups'
    if (-not (Test-Path -LiteralPath $backups)) { return @() }
    return @(Get-ChildItem -LiteralPath $backups -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^etn-backup-(.+)-(\d{8}-\d{6})(?:-(\d+))?\.zip$' } |
        Sort-Object Name)
}

# Режим фикстуры etn-db-tool: отказ бэкапа/восстановления, отчёт без причины,
# предупреждение, успех без архива. Файл читается из <данные>\.install.
function Set-DatabaseToolMode {
    param([string]$Mode)
    $installDir = Join-Path $dataDir '.install'
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $installDir 'db-tool-mode.txt'), $Mode)
}

# «Архив» фикстуры — JSON-манифест (не ZIP): установщику формат не важен, он
# передаёт путь обратно в restore. Манифест доказывает, что инструмент получил
# --to и --data-dir и увидел обе базы.
function Get-FixtureArchiveManifest {
    param([string]$Archive)
    try {
        return (Get-Content -LiteralPath $Archive -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-LatestLogContains {
    param([string]$Pattern)
    $log = Get-LatestLog
    if (-not $log) { return $false }
    $text = Get-Content -LiteralPath $log.FullName -Raw
    return ($text -match $Pattern)
}

# Число вхождений шаблона в последний журнал: повтор stop 1061 проверяется
# числом команд, а не только фактом строки.
function Test-LatestLogCount {
    param([string]$Pattern)
    $log = Get-LatestLog
    if (-not $log) { return 0 }
    $text = Get-Content -LiteralPath $log.FullName -Raw
    return ([regex]::Matches($text, $Pattern)).Count
}

# --- bb063ac3: подставной health-сервер, снимок отката и порядок журнала -----
# Разбор тела health-check проверяется по-настоящему: установщик опрашивает
# локальный HTTP-сервер (Node 22), который отдаёт заданный ответ — версию,
# db или HTTP 500. Заодно сервер имитирует запись «неудачного запуска» в БД,
# чтобы откат БД можно было проверить по данным. DelayMs — задержка ответа:
# ею проверяется бюджет фактического времени (a1ea1d40).
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
const delayMs = Number(argv[9] || 0);
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
function reply(res, statusCode, body) {
  const send = function () {
    res.statusCode = statusCode;
    res.end(body);
  };
  if (delayMs > 0) setTimeout(send, delayMs); else send();
}
const server = http.createServer(function (req, res) {
  fs.appendFileSync(requestLog, req.url + '\n');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/v1/health') {
    mutate();
    if (mode === 'http500') {
      reply(res, 500, health('error', 'error', target));
      return;
    }
    if (mode === 'db-error') { reply(res, 200, health('ok', 'error', target)); return; }
    if (mode === 'wrong-version') { reply(res, 200, health('ok', 'ok', '9.9.9')); return; }
    reply(res, 200, health('ok', 'ok', target));
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
        [string]$Marker = '',
        [int]$DelayMs = 0
    )
    $scriptPath = Initialize-FakeHealthScript
    $port = Get-FreeTcpPort
    $requestLog = Join-Path $workRoot ('health-requests-' + $port + '.log')
    [System.IO.File]::WriteAllText($requestLog, '')
    $betterSqlite = Join-Path $repoRoot 'server\node_modules\better-sqlite3'
    $nodeArgs = @($scriptPath, [string]$port, $Mode, $version, $requestLog,
        (IfStrEmpty $DbPath), $betterSqlite, $Marker, [string]$DelayMs)
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

# Заготовка обновления: install.json старой версии, файлы сервера и службы.
# Каталог {app}\server с package.json уже есть — из него инструмент бэкапа
# берёт версию и резолвит библиотеки при запуске.
function New-UpdateFixture {
    param([string]$OldVersion = '0.15.0')
    Reset-State
    Write-InstallJson (New-InstallJson -ProductVersion $OldVersion)
    New-ServerFiles -Version $OldVersion
    New-Item -ItemType Directory -Path (Join-Path $appDir 'service') -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $appDir 'service\etn-service.exe'), 'stub')
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

# 8789381a (этап 2): статические проверки исходника вынесены в iss-static.ps1 —
# они не требуют запуска установщика и переживут удаление silent-codes (этап 6).
. (Join-Path $PSScriptRoot 'iss-static.ps1')

$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
$script:StaticResults = $script:results
Invoke-IssStaticChecks -RepoRoot $repoRoot -Results $script:results

# Срезы .iss, нужные runtime-проверкам ниже (раньше вычислялись в
# статическом блоке): шаги установки и текст отказа «нужен администратор».
# 12 hook-guard'ов удалены вместе с переносом статики (8789381a): их контракт
# инвертирован в Test-IssNoTestHooks (iss-static.ps1, -AssertNoHooks,
# активируется на этапе 5 вместе с удалением хуков).
$testModeBody = Get-IssIfdefBody -Text $issText -Name 'TestMode'
$stepBody = Get-IssFunctionBody -Text $issText -Name 'CurStepChanged'
$serverReason = Get-IssServerNeedsAdminText


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

# --- 860def0d / c4b68d78: экран компонентов без окон --------------------------
# /TESTLAYOUT=1 строит все экраны тем же кодом, что и мастер, и пишет в журнал
# фактические позиции, высоты строк списка и точный текст причины неактивности
# «Далее». Проверяется то, что видел пользователь: подписи не сжаты «дельтой»
# AdjustHeight, видимые контролы не налезают друг на друга, причина на экране
# и в границах страницы; экран компонентов — список TNewCheckListBox с
# фиксированным нижним блоком: список получает остаток высоты, не пересекается
# с нижним блоком, статусы и описания — group-строки уровня 1 с пустым subitem,
# начальный выбор совпадает с состоянием машины (c4b68d78).
Write-Host '=== c4b68d78: экран компонентов (TESTLAYOUT) ==='

function Get-LayoutLines {
    $log = Get-LatestLog
    if (-not $log) { return @() }
    return @(Get-Content -LiteralPath $log.FullName | ForEach-Object {
        if ($_ -match 'TESTLAYOUT (.*)$') { $Matches[1] }
    })
}

function Read-Layout {
    param([string[]]$Lines)
    $surfaces = @{}
    $controls = @{}
    foreach ($line in $Lines) {
        # Строки списка компонентов разбирает Read-List; под regex контролов они
        # попадать не должны (list — прямоугольник, item/items — строки списка).
        if ($line -match '^\w+ (list|items?)\b') { continue }
        if ($line -match '^next\b') { continue }
        if ($line -match '^(?<page>\w+) surface width=(?<w>\d+) height=(?<h>\d+)$') {
            $surfaces[$Matches['page']] = [pscustomobject]@{
                Width = [int]$Matches['w']; Height = [int]$Matches['h']
            }
            continue
        }
        if ($line -match '^(?<page>\w+) (?<name>\w+) left=(?<l>\d+) top=(?<t>\d+) width=(?<w>\d+) height=(?<h>\d+) visible=(?<v>[01])(?: chars=(?<c>\d+))?$') {
            if (-not $controls.ContainsKey($Matches['page'])) {
                $controls[$Matches['page']] = New-Object System.Collections.Generic.List[object]
            }
            $chars = -1
            if ($Matches['c'] -ne '') { $chars = [int]$Matches['c'] }
            $controls[$Matches['page']].Add([pscustomobject]@{
                Name = $Matches['name']; Left = [int]$Matches['l']; Top = [int]$Matches['t']
                Width = [int]$Matches['w']; Height = [int]$Matches['h']
                Visible = ($Matches['v'] -eq '1'); Chars = $chars
            })
        }
    }
    return [pscustomobject]@{ Surfaces = $surfaces; Controls = $controls }
}

# Список компонентов: прямоугольник, объявленное число строк и строки с
# фактическими level/checked/enabled/height/chars (height — LB_GETITEMHEIGHT).
function Read-List {
    param([string[]]$Lines, [string]$Page = 'components')
    $rect = $null
    $count = -1
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($line in $Lines) {
        if ($line -match ('^' + [regex]::Escape($Page) + ' list left=(?<l>\d+) top=(?<t>\d+) width=(?<w>\d+) height=(?<h>\d+)$')) {
            $rect = [pscustomobject]@{
                Left = [int]$Matches['l']; Top = [int]$Matches['t']
                Width = [int]$Matches['w']; Height = [int]$Matches['h']
            }
            continue
        }
        if ($line -match ('^' + [regex]::Escape($Page) + ' items count=(?<c>\d+)$')) {
            $count = [int]$Matches['c']
            continue
        }
        if ($line -match ('^' + [regex]::Escape($Page) + ' item idx=(?<i>\d+) level=(?<lv>\d+) checked=(?<c>[01]) enabled=(?<e>[01]) height=(?<h>\d+) chars=(?<ch>\d+) sub_chars=(?<sc>\d+)$')) {
            $items.Add([pscustomobject]@{
                Index = [int]$Matches['i']; Level = [int]$Matches['lv']
                Checked = ($Matches['c'] -eq '1'); Enabled = ($Matches['e'] -eq '1')
                Height = [int]$Matches['h']; Chars = [int]$Matches['ch']
                SubChars = [int]$Matches['sc']
            })
        }
    }
    return [pscustomobject]@{ Rect = $rect; Count = $count; Items = $items }
}

function Add-LayoutChecks {
    param(
        [string]$Suffix,
        [string]$Note = '',
        [int]$ServerSelected = 1,
        [int]$ClientSelected = 1,
        [int]$NextEnabled = 1,
        [int]$ServerEnabled = 1,
        [int]$ItemCount = 7,
        [string]$ReasonText = '',
        [int]$DataNoteVisible = -1
    )
    $lines = Get-LayoutLines
    Add-Result -Name "layout:${Suffix}:dump" -Expected 1 -Actual ([int]($lines.Count -gt 0)) `
        -Note ("строк снимка: " + $lines.Count + $Note)
    $state = @($lines | Where-Object { $_ -like 'state *' })[0]
    $both = ($state -match ('server_selected=' + $ServerSelected)) -and
        ($state -match ('client_selected=' + $ClientSelected))
    Add-Result -Name "layout:${Suffix}:default-selection" -Expected 1 -Actual ([int]$both) -Note $state

    $layout = Read-Layout -Lines $lines
    foreach ($page in @('components', 'admin', 'params', 'credentials', 'finished')) {
        Add-Result -Name "layout:${Suffix}:$page" -Expected 1 `
            -Actual ([int](($layout.Surfaces.ContainsKey($page)) -and ($layout.Controls.ContainsKey($page)))) `
            -Note "страница $page в снимке"
    }
    $components = @{}
    foreach ($ctl in $layout.Controls['components']) { $components[$ctl.Name] = $ctl }

    # 0. Список: слева сверху, во всю ширину поверхности, высота — остаток от
    #    нижнего блока (GList.Height := AltLink.Top - ScaleY(8)).
    $list = Read-List -Lines $lines
    $listOk = ($null -ne $list.Rect) -and ($null -ne $layout.Surfaces['components']) -and
        ($list.Rect.Left -eq 0) -and ($list.Rect.Top -eq 0) -and
        ($list.Rect.Width -eq $layout.Surfaces['components'].Width) -and ($list.Rect.Height -gt 0)
    Add-Result -Name "layout:${Suffix}:list" -Expected 1 -Actual ([int]$listOk) `
        -Note ('список слева сверху во всю ширину, высота — остаток нижнего блока')

    # 1. Строки списка: count, уровни, чек-состояние, enabled, перенос caption.
    #    Статусы и описания — group уровня 1 с пустым subitem (sub_chars=0),
    #    высота строки не меньше строки текста (перенос считается списком).
    $itemProblems = @()
    if ($list.Count -ne $ItemCount) { $itemProblems += "count=$($list.Count) (ожидалось $ItemCount)" }
    if ($list.Items.Count -ne $ItemCount) { $itemProblems += "строк=$($list.Items.Count)" }
    $expectLevel = @{ 0 = 0; 1 = 1; 2 = 1; 3 = 0; 4 = 1; 5 = 1; 6 = 1 }
    $expectChecked = @{ 0 = $ServerSelected; 1 = 0; 2 = 0; 3 = $ClientSelected; 4 = 0; 5 = 0; 6 = 0 }
    $expectEnabled = @{ 0 = $ServerEnabled; 1 = 0; 2 = 0; 3 = 1; 4 = 0; 5 = 0; 6 = 0 }
    foreach ($item in $list.Items) {
        $i = $item.Index
        if ($expectLevel.ContainsKey($i) -and ($item.Level -ne $expectLevel[$i])) {
            $itemProblems += "idx=$i level=$($item.Level)"
        }
        if ($expectChecked.ContainsKey($i) -and (([int]$item.Checked) -ne $expectChecked[$i])) {
            $itemProblems += "idx=$i checked=$([int]$item.Checked)"
        }
        if ($expectEnabled.ContainsKey($i) -and (([int]$item.Enabled) -ne $expectEnabled[$i])) {
            $itemProblems += "idx=$i enabled=$([int]$item.Enabled)"
        }
        if ($item.SubChars -ne 0) { $itemProblems += "idx=$i sub_chars=$($item.SubChars)" }
        if (($item.Chars -gt 0) -and ($item.Height -lt 15)) {
            $itemProblems += "idx=$i height=$($item.Height) при chars=$($item.Chars)"
        }
    }
    Add-Result -Name "layout:${Suffix}:list-items" -Expected 1 -Actual ([int]($itemProblems.Count -eq 0)) `
        -Note ($itemProblems -join ', ')

    # 2. Список не пересекается с нижним блоком: его низ не ниже верха первого
    #    видимого элемента блока (ссылка, каталог данных, лицензия, причина).
    $bottomTop = $null
    foreach ($name in @('serverAltLink', 'dataNote', 'license', 'reason')) {
        $ctl = $components[$name]
        if ($ctl -and $ctl.Visible -and ($ctl.Height -gt 0)) {
            if (($null -eq $bottomTop) -or ($ctl.Top -lt $bottomTop)) { $bottomTop = $ctl.Top }
        }
    }
    $clearOk = ($null -ne $list.Rect) -and ($null -ne $bottomTop) -and
        (($list.Rect.Top + $list.Rect.Height) -le $bottomTop)
    Add-Result -Name "layout:${Suffix}:list-clear" -Expected 1 -Actual ([int]$clearOk) `
        -Note ('низ списка ' + $(if ($list.Rect) { $list.Rect.Top + $list.Rect.Height } else { '?' }) +
            ' ≤ верх нижнего блока ' + $(if ($null -ne $bottomTop) { $bottomTop } else { '?' }))

    # 3. Кнопка «Далее», причина её неактивности и её ТОЧНЫЙ текст (T6). Неактивная
    #    кнопка обязана быть объяснена: причина есть, непустая, не сжата,
    #    помещается на страницу и совпадает с ожидаемой дословно.
    $next = @($lines | Where-Object { $_ -like 'next *' })[0]
    $reasonChars = -1
    if ($next -match 'reason_chars=(?<c>\d+)') { $reasonChars = [int]$Matches['c'] }
    $nextActual = -1
    if ($next -match 'enabled=(?<v>[01])') { $nextActual = [int]$Matches['v'] }
    $reasonDisplay = ''
    if ($next -match 'reason=(?<t>.*)$') { $reasonDisplay = $Matches['t'] }
    Add-Result -Name "layout:${Suffix}:next-enabled" -Expected $NextEnabled -Actual $nextActual -Note $next
    $reason = $components['reason']
    if ($NextEnabled -eq 0) {
        $fitsPage = $reason -and $layout.Surfaces.ContainsKey('components') -and
            (($reason.Top + $reason.Height) -le $layout.Surfaces['components'].Height)
        $reasonOk = ($reasonChars -gt 0) -and ($null -ne $reason) -and $reason.Visible -and
            ($reason.Chars -gt 0) -and ($reason.Chars -eq $reasonChars) -and
            ($reason.Height -ge 15) -and $fitsPage
        Add-Result -Name "layout:${Suffix}:reason-visible" -Expected 1 -Actual ([int]$reasonOk) `
            -Note ('причина неактивной «Далее» на экране и в границах страницы: chars=' + $reasonChars)
        $textOk = ($ReasonText -ne '') -and ($reasonDisplay -eq $ReasonText)
        Add-Result -Name "layout:${Suffix}:reason-text" -Expected 1 -Actual ([int]$textOk) `
            -Note ('ожидалось: ' + $ReasonText + '; получено: ' + $reasonDisplay)
    }
    else {
        $reasonOk = ($reasonChars -eq 0) -and ($reasonDisplay -eq '') -and
            (($null -eq $reason) -or ($reason.Chars -eq 0))
        Add-Result -Name "layout:${Suffix}:reason-empty" -Expected 1 -Actual ([int]$reasonOk) `
            -Note ('активная «Далее» причины не показывает: chars=' + $reasonChars)
    }
    # 4. Подпись с непустым текстом не сжата: высота не меньше строки. Высота 0
    #    допустима только для пустой подписи (chars=0).
    $bad = @()
    foreach ($page in $layout.Controls.Keys) {
        foreach ($ctl in $layout.Controls[$page]) {
            if (-not $ctl.Visible) { continue }
            if (($ctl.Chars -gt 0) -and ($ctl.Height -lt 15)) {
                $bad += "$page/$($ctl.Name)=$($ctl.Height) при chars=$($ctl.Chars)"
            }
        }
    }
    Add-Result -Name "layout:${Suffix}:no-squeezed" -Expected 1 -Actual ([int]($bad.Count -eq 0)) `
        -Note ($bad -join ', ')
    # 5. Видимые контролы с текстом не налезают друг на друга.
    $overlaps = @()
    foreach ($page in $layout.Controls.Keys) {
        $items = @($layout.Controls[$page] | Where-Object { $_.Visible -and $_.Height -gt 0 })
        for ($i = 0; $i -lt $items.Count; $i++) {
            for ($j = $i + 1; $j -lt $items.Count; $j++) {
                $a = $items[$i]; $b = $items[$j]
                $hOverlap = ($a.Left -lt ($b.Left + $b.Width)) -and ($b.Left -lt ($a.Left + $a.Width))
                $vOverlap = ($a.Top -lt ($b.Top + $b.Height)) -and ($b.Top -lt ($a.Top + $a.Height))
                if ($hOverlap -and $vOverlap) { $overlaps += "$page/$($a.Name)&$($b.Name)" }
            }
        }
    }
    Add-Result -Name "layout:${Suffix}:no-overlap" -Expected 1 -Actual ([int]($overlaps.Count -eq 0)) `
        -Note ($overlaps -join ', ')
    # 6. Содержимое не выходит за поверхность страницы.
    $overflows = @()
    foreach ($page in $layout.Controls.Keys) {
        if (-not $layout.Surfaces.ContainsKey($page)) { continue }
        $bottom = 0
        foreach ($ctl in @($layout.Controls[$page] | Where-Object { $_.Visible -and $_.Height -gt 0 })) {
            if (($ctl.Top + $ctl.Height) -gt $bottom) { $bottom = $ctl.Top + $ctl.Height }
        }
        if ($bottom -gt $layout.Surfaces[$page].Height) {
            $overflows += "$page bottom=$bottom > $($layout.Surfaces[$page].Height)"
        }
    }
    Add-Result -Name "layout:${Suffix}:content-fits" -Expected 1 -Actual ([int]($overflows.Count -eq 0)) `
        -Note ($overflows -join ', ')
    # 7. Статусы и описания действительно на экране: у сервера и клиента
    #    непустые group-строки с переносом; необязательная строка области
    #    клиента, когда она нужна, тоже непустая.
    $descProblems = @()
    foreach ($i in @(1, 2, 4, 5)) {
        $item = @($list.Items | Where-Object { $_.Index -eq $i })[0]
        if (-not $item) { $descProblems += "idx=$i нет строки"; continue }
        if (($item.Chars -le 0) -or ($item.Height -lt 15)) {
            $descProblems += "idx=$i chars=$($item.Chars) height=$($item.Height)"
        }
    }
    if ($ItemCount -eq 7) {
        $scope = @($list.Items | Where-Object { $_.Index -eq 6 })[0]
        if (-not $scope -or ($scope.Chars -le 0) -or ($scope.Height -lt 15)) {
            $descProblems += 'idx=6 строка области клиента пуста'
        }
    }
    Add-Result -Name "layout:${Suffix}:descriptions" -Expected 1 -Actual ([int]($descProblems.Count -eq 0)) `
        -Note ($descProblems -join ', ')
    # 8. Нижний блок: лицензия видна ровно при запросе лицензии, каталог данных —
    #    когда сервер выбран или установлен, причина всегда на экране.
    $licenseState = @($lines | Where-Object { $_ -like 'state *' })[0]
    $licensePrompt = [int]($licenseState -match 'license_prompt=1')
    $licenseCtl = $components['license']
    $licenseOk = ($licenseCtl -and ([int]$licenseCtl.Visible -eq $licensePrompt))
    Add-Result -Name "layout:${Suffix}:license-visible" -Expected 1 -Actual ([int]$licenseOk) `
        -Note ('лицензия видна ровно при license_prompt: ' + $licensePrompt)
    $dataNote = $components['dataNote']
    $expectedDataNote = $DataNoteVisible
    if ($expectedDataNote -lt 0) { $expectedDataNote = $ServerSelected }
    $dataNoteOk = ($null -ne $dataNote) -and ([int]$dataNote.Visible -eq $expectedDataNote)
    Add-Result -Name "layout:${Suffix}:datanote" -Expected 1 -Actual ([int]$dataNoteOk) `
        -Note ('каталог данных: ожидалось ' + $expectedDataNote + ', видим=' + $(if ($dataNote) { [int]$dataNote.Visible } else { '?' }))
    # 9. Сводка и кнопки итогового экрана: от левого края FinishedLabel.
    $finished = @{}
    foreach ($ctl in $layout.Controls['finished']) { $finished[$ctl.Name] = $ctl }
    $anchored = $finished.ContainsKey('label') -and $finished.ContainsKey('memo') -and
        ($finished['memo'].Left -eq $finished['label'].Left) -and
        ($finished['memo'].Width -eq $finished['label'].Width) -and
        ($finished['memo'].Top -eq $finished['label'].Top)
    Add-Result -Name "layout:${Suffix}:finished-anchored" -Expected 1 -Actual ([int]$anchored) `
        -Note 'memo начинается там же, где FinishedLabel (правее полосы оформления)'
}

Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTADMINMODE=1'))
Add-Result -Name 'layout:exit' -Expected 0 -Actual $code -Note 'снимок раскладки без установки'
# Реальный первый экран административного запуска: оба компонента отмечены,
# «Далее» неактивна до принятия лицензии MIT; причина обязана быть на экране.
Add-LayoutChecks -Suffix 'clean' -NextEnabled 0 `
    -ReasonText 'Далее недоступна: Примите условия лицензии MIT, чтобы продолжить.' `
    -Note ' (административный первый экран)'

# Повторный запуск в режиме «только для меня» поверх уже установленного клиента —
# сценарий «Переустановить клиент ETN»: «Далее» активна и причины не показывает,
# строка области клиента объясняет, куда ставится клиент.
Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), '')
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTUSERONLYMODE=1'))
Add-Result -Name 'layout:client-user-exit' -Expected 0 -Actual $code `
    -Note 'снимок: клиент «только для меня» уже установлен'
Add-LayoutChecks -Suffix 'client-user' -ServerSelected 0 -ClientSelected 1 `
    -ServerEnabled 0 -NextEnabled 1 `
    -Note ' (клиент уже установлен, лицензия не нужна)'

# Клиент установлен «для всех пользователей», установщик запущен «только для
# меня»: заменить машинную копию без прав администратора нельзя, выбор снят,
# «Далее» неактивна. Неактивная кнопка обязана объяснить причину на экране —
# ровно этот экран пользователь принял за зависание (5b9743da).
Reset-State
New-Item -ItemType Directory -Path (Join-Path $appDir 'client') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'client\ETN.exe'), '')
Write-InstallJson (New-InstallJson -Mode 'client' -ClientScope '"machine"')
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTUSERONLYMODE=1'))
Add-Result -Name 'layout:client-machine-exit' -Expected 0 -Actual $code `
    -Note 'снимок: клиент «для всех» в режиме «только для меня»'
Add-LayoutChecks -Suffix 'client-machine' -ServerSelected 0 -ClientSelected 0 `
    -ServerEnabled 0 -NextEnabled 0 `
    -ReasonText 'Далее недоступна: Клиент установлен для всех пользователей: нужны права администратора.'

# Административный запуск поверх клиента «только для меня»: копия в профиле
# остаётся, рядом ставится машинная; каталог данных скрыт (сервера нет), строка
# области клиента говорит об этом прямо (2dd215f7, замечание верификатора п.1).
Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), '')
Write-InstallJson (New-InstallJson -Mode 'client' -ClientScope '"user"')
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTADMINMODE=1'))
Add-Result -Name 'layout:admin-user-copy-exit' -Expected 0 -Actual $code `
    -Note 'снимок: административный режим поверх клиента «только для меня»'
Add-LayoutChecks -Suffix 'admin-user-copy' -ServerSelected 0 -ClientSelected 1 `
    -ServerEnabled 1 -NextEnabled 1 `
    -Note ' (клиент уже установлен в профиле, лицензия не нужна)'

# Понижение версии: установлена более новая — «Далее» неактивна, причина называет
# версию дословно; лицензия не запрашивается.
Reset-State
New-ServerFiles -Version '99.0.0'
Write-InstallJson (New-InstallJson -ProductVersion '99.0.0')
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTADMINMODE=1'))
Add-Result -Name 'layout:downgrade-exit' -Expected 0 -Actual $code `
    -Note 'снимок: установлена более новая версия'
Add-LayoutChecks -Suffix 'downgrade' -ServerSelected 0 -ClientSelected 0 `
    -ServerEnabled 1 -NextEnabled 0 -DataNoteVisible 1 `
    -ReasonText 'Далее недоступна: Установлена более новая версия 99.0.0 — понижение версии не поддерживается. Доступна только отмена.'

# Уведомление после возврата на экран (ошибка закрытия клиента): причина
# показывает его дословно и помещается в нижний блок даже при длинном тексте.
Reset-State
$noticeText = 'Установка не начата: клиент не закрылся и будет закрыт принудительно.'
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTADMINMODE=1',
    ('"/TESTNOTICE=' + $noticeText + '"')))
Add-Result -Name 'layout:notice-exit' -Expected 0 -Actual $code `
    -Note 'снимок: уведомление после возврата на экран'
Add-LayoutChecks -Suffix 'notice' -NextEnabled 0 `
    -ReasonText ('Далее недоступна: ' + $noticeText)


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
