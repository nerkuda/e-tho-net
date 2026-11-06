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
foreach ($required in @('SERVERONLY', 'GetCustomSetupExitCode')) {
    # ini-секции: там ';' — комментарий, а не разделитель операторов.
    $present = Test-IssCode -Text $issText -Pattern ([regex]::Escape($required)) -IniComments
    Add-StaticResult -Name "static:$required" -Ok $present
}
# Контракт silent-обновления: установщик флаги сам не собирает — их передаёт
# служба (server/src/update/installer-runner.ts). /ALLUSERS обязателен с
# 2dd215f7: служба элевирована, но административный режим установки сам не
# включается, и без флага тихая установка ушла бы в профиль LocalSystem.
$runnerPath = Join-Path $repoRoot 'server\src\update\installer-runner.ts'
$runnerText = Get-Content -LiteralPath $runnerPath -Raw -Encoding UTF8
foreach ($required in @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SERVERONLY', '/ALLUSERS')) {
    $present = [bool]($runnerText -match [regex]::Escape("'$required'"))
    Add-StaticResult -Name "static:runner$required" -Ok $present `
        -Note 'флаг silent-обновления службы'
}
# B2: каталог программы выбирается по фактическим правам процесса, а не жёстко
# из Program Files — иначе неэлевированный экземпляр падает с Error 5. Ошибка
# aa5af30c: {autopf} при PrivilegesRequired=lowest всегда указывает на профиль,
# поэтому каталог вычисляет GetDefaultAppDir (IsAdmin → Program Files).
# 9b310991: порт/хост/брандмауэр/каталог данных, подстановка шаблона службы,
# предпроверки и удаление правила при удалении программы.
$staticChecks = @(
    @{ Name = 'static:autopf-appdir'; Pattern = [regex]::Escape('#define AppDir "{code:GetDefaultAppDir}"'); Note = 'каталог программы по фактическим правам процесса' },
    @{ Name = 'static:defaultdir-app'; Pattern = [regex]::Escape('DefaultDirName={#AppDir}'); Note = '' },
    @{ Name = 'static:privileged-phase'; Pattern = [regex]::Escape('ValidatePrivilegedPhasePreconditions'); Note = 'отдельная привилегированная фаза' },
    @{ Name = 'static:context-admin-mode'; Pattern = [regex]::Escape('GIsElevated and GAdminInstallMode'); Note = 'привилегированный контекст — только admin mode' },
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
    @{ Name = 'static:port-fail-closed-bind'; Pattern = [regex]::Escape('SocketOptionName]::ExclusiveAddressUse'); Note = 'fail-closed: эксклюзивный bind на 0.0.0.0 без listen()' },
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
    @{ Name = 'static:setup-mutex'; Pattern = [regex]::Escape('SetupMutex=ETNSetup'); Note = 'параллельный запуск установщика запрещён' },
    @{ Name = 'static:uninstall-scope-cleanup'; Pattern = [regex]::Escape('RemoveDuplicateUninstallRecord;'); Note = 'запись деинсталляции прежней области удаляется после установки (a7394117)' },
    @{ Name = 'static:uninstall-user-hives'; Pattern = [regex]::Escape("RegGetSubkeyNames(HKU, '', Names)"); Note = 'при /ALLUSERS запись ищется в загруженных профилях HKEY_USERS (a7394117)' },
    @{ Name = 'static:appid-single-source'; Pattern = [regex]::Escape("UNINSTALL_KEY_NAME = '{#ProductUninstallKey}';"); Note = 'имя ключа деинсталляции берётся из AppId, без второго литерала (a7394117)' },
    @{ Name = 'static:uninstall-record-owner'; Pattern = [regex]::Escape('if not IsMachineUninstallRecord(Root, SubKey) then'); Note = 'удаляется только запись машинной установки; per-user клиент сохраняется (7dcbeb0c)' }
)
foreach ($check in $staticChecks) {
    Add-StaticResult -Name $check.Name -Ok (Test-IssCode -Text $issText -Pattern $check.Pattern) -Note $check.Note
}

# e375123f: шаблон службы обязан задавать ETN_DEPLOYMENT=windows-service —
# без него сервер, запущенный службой, определяет себя как standalone и
# отклоняет обновление из клиента («сервер запущен не службой»). Значение
# фиксированное, не плейсхолдер: проверяется разбором XML, а не подстрокой.
# Фикстура повторяет шаблон — по ней проверяются подстановка и конфиг после
# установки; статический сторож страхует, что fixture не разойдётся.
function Get-ServiceDeploymentEnv {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $xml = [xml]([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8))
        $node = $xml.SelectSingleNode('/service/env[@name="ETN_DEPLOYMENT"]')
        if ($null -eq $node) { return '' }
        return [string]$node.GetAttribute('value')
    } catch {
        return $null
    }
}
$templateDeployment = Get-ServiceDeploymentEnv -Path (Join-Path $installerDir 'service\etn-service.xml')
Add-StaticResult -Name 'static:service-deployment-env' `
    -Ok ($templateDeployment -eq 'windows-service') `
    -Note ('шаблон службы: ETN_DEPLOYMENT=' + (IfStrEmpty ([string]$templateDeployment)))
$fixtureDeployment = Get-ServiceDeploymentEnv -Path (Join-Path $PSScriptRoot 'fixtures\payload\service\etn-service.xml')
Add-StaticResult -Name 'static:service-fixture-deployment' `
    -Ok ($fixtureDeployment -eq 'windows-service') `
    -Note ('фикстура: ETN_DEPLOYMENT=' + (IfStrEmpty ([string]$fixtureDeployment)))
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
# 1dddac77: хуки имитации сломанной TCP-таблицы и отсутствия службы —
# переменные скрипта и разбор параметров только в тестовой сборке.
$portTableHooks = (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$tableOff'))) -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$noSvc')))
Add-StaticResult -Name 'static:port-table-hooks' -Ok $portTableHooks `
    -Note 'хуки /TESTLISTENERTABLEOFF и /TESTNOSERVICE доходят до скрипта'
$portTableHooksIfdef = (Test-IssCode -Text $testModeBody `
        -Pattern ([regex]::Escape("ParamValue('TESTLISTENERTABLEOFF')"))) -and
    (Test-IssCode -Text $testModeBody `
        -Pattern ([regex]::Escape("ParamValue('TESTNOSERVICE')")))
Add-StaticResult -Name 'static:port-table-hooks-ifdef' -Ok $portTableHooksIfdef `
    -Note 'портовые хуки разбираются только под #ifdef TestMode'

# 3acd9c3c: SQLite-операции вынесены в CLI сервера (etn backup / etn restore).
# Pascal только извлекает самодостаточный etn-db-tool.mjs, запускает его через
# node.exe поставки с рабочим каталогом {app}\server и разбирает отчёт
# key=value. Сторожа — по телам функций: возврат SQL-логики в .iss запрещён.
$backupBody = Get-IssFunctionBody -Text $issText -Name 'CreateDatabaseBackup'
Add-StaticResult -Name 'static:backup-caller-decides' `
    -Ok (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('if not Needed'))) `
    -Note 'бэкап: ремонт той же версии — без архива (решает вызывающий)'
$skipEmptyBody = Get-IssFunctionBody -Text $issText -Name 'HasDatabaseFiles'
Add-StaticResult -Name 'static:backup-skip-empty' `
    -Ok ((Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('if not HasDatabaseFiles'))) -and
        (Test-IssCode -Text $skipEmptyBody -Pattern ([regex]::Escape("'\_system.db'"))) -and
        (Test-IssCode -Text $skipEmptyBody -Pattern ([regex]::Escape("'\data.db'")))) `
    -Note 'нет баз — инструмент не запускается (node.exe ещё не скопирован)'
$toolFileOk = (Test-IssCode -Text $issText -Pattern ([regex]::Escape('Source: "{#ServerPayload}\dist\db\db-backup.js"'))) -and
    (Test-IssCode -Text $issText -Pattern ([regex]::Escape('DestName: "etn-db-tool.mjs"'))) -and
    (Test-IssCode -Text $issText -Pattern ([regex]::Escape('Flags: dontcopy')))
Add-StaticResult -Name 'static:backup-tool-file' -Ok $toolFileOk `
    -Note 'инструмент в поставке установщика (dontcopy, .mjs — ESM вне пакета)'
$extractBody = Get-IssFunctionBody -Text $issText -Name 'EnsureDatabaseTool'
$extractOk = (Test-IssCode -Text $extractBody -Pattern ([regex]::Escape('ExtractTemporaryFile(DB_TOOL_FILENAME)'))) -and
    (Test-IssCode -Text $extractBody -Pattern ([regex]::Escape("ExpandConstant('{tmp}')"))) -and
    (Test-IssCode -Text $extractBody -Pattern ([regex]::Escape('GetExceptionMessage')))
Add-StaticResult -Name 'static:backup-tool-extract' -Ok $extractOk `
    -Note 'извлечение во {tmp} до запуска, ошибка — причина в журнал'
$runToolBody = Get-IssFunctionBody -Text $issText -Name 'RunDatabaseTool'
$toolNodeOk = (Test-IssCode -Text $runToolBody -Pattern ([regex]::Escape('ServerNodeExe(GServerDir)'))) -and
    (Test-IssCode -Text $runToolBody -Pattern ([regex]::Escape('Exec(NodeExe'))) -and
    (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape("GServerDir + '\server'")))
Add-StaticResult -Name 'static:backup-tool-node' -Ok $toolNodeOk `
    -Note 'node.exe из {app}\node, рабочий каталог {app}\server (резолв библиотек)'
$backupArgsOk = (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('backup --to'))) -and
    (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('--report-out'))) -and
    (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('--data-dir')))
Add-StaticResult -Name 'static:backup-tool-args' -Ok $backupArgsOk `
    -Note 'backup --to/--report-out/--data-dir — контракт CLI'
$reportBody = Get-IssFunctionBody -Text $issText -Name 'DatabaseReportValue'
$reportOk = (Test-IssCode -Text $reportBody -Pattern ([regex]::Escape("Prefix := Key + '='"))) -and
    (Test-IssCode -Text $reportBody -Pattern ([regex]::Escape('Copy(Line, Length(Prefix) + 1')))
Add-StaticResult -Name 'static:backup-report-parse' -Ok $reportOk `
    -Note 'отчёт key=value: разделитель — первый ='
$applyBody = Get-IssFunctionBody -Text $issText -Name 'ApplyDatabaseToolReport'
$applyOk = (Test-IssCode -Text $applyBody -Pattern ([regex]::Escape('GBackupReason'))) -and
    (Test-IssCode -Text $applyBody -Pattern ([regex]::Escape("DatabaseReportValue(ReportPath, 'archive')"))) -and
    (Test-IssCode -Text $applyBody -Pattern ([regex]::Escape("DatabaseReportValue(ReportPath, 'warnings')")))
Add-StaticResult -Name 'static:backup-report-apply' -Ok $applyOk `
    -Note 'архив/причина/предупреждения из отчёта в GLastBackupDir/GBackupReason/журнал'
$restoreBody = Get-IssFunctionBody -Text $issText -Name 'RestoreDatabaseFromArchive'
$restoreArgsOk = (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('restore --from'))) -and
    (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('--force'))) -and
    (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('--report-out'))) -and
    (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('--data-dir')))
Add-StaticResult -Name 'static:restore-tool-args' -Ok $restoreArgsOk `
    -Note 'restore --from/--force/--report-out/--data-dir — контракт CLI'
$sqliteGone = ((Get-IssFunctionBody -Text $issText -Name 'VerifyDatabaseIntegrity') -eq '') -and
    ((Get-IssFunctionBody -Text $issText -Name 'CheckpointDatabase') -eq '') -and
    ((Get-IssFunctionBody -Text $issText -Name 'CopyDatabasesInto') -eq '') -and
    ((Get-IssFunctionBody -Text $issText -Name 'RotateBackupArchives') -eq '') -and
    ((Get-IssFunctionBody -Text $issText -Name 'OldestBackupDirName') -eq '') -and
    (-not (Test-IssCode -Text $backupBody -Pattern ([regex]::Escape('wal_checkpoint')))) -and
    (-not (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape("'-wal'"))))
Add-StaticResult -Name 'static:backup-no-sqlite' -Ok $sqliteGone `
    -Note 'SQLite/чекпойнт/копирования/ротации в Pascal нет — только вызов CLI'
$latestBody = Get-IssFunctionBody -Text $issText -Name 'LatestBackupDirName'
$stampBody = Get-IssFunctionBody -Text $issText -Name 'BackupZipStamp'
$latestOk = (Test-IssCode -Text $latestBody -Pattern ([regex]::Escape("'\etn-backup-*.zip'"))) -and
    (Test-IssCode -Text $latestBody -Pattern ([regex]::Escape('BackupZipStamp'))) -and
    (Test-IssCode -Text $stampBody -Pattern ([regex]::Escape("Copy(Name, I + 1, 8)")))
Add-StaticResult -Name 'static:backup-latest-zip' -Ok $latestOk `
    -Note 'самый свежий архив для сообщений — по метке времени в имени ZIP'
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
    'Регистрация службы ETN',
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
Add-StaticResult -Name 'static:ready-no-long-ops' `
    -Ok ((Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('wpReady'))) -and
         (-not ($nextBody -match [regex]::Escape('CloseRunningClient'))) -and
         (-not ($nextBody -match [regex]::Escape('RemoveLegacyBeforeInstall'))) -and
         (-not ($nextBody -match [regex]::Escape('ewWaitUntilTerminated')))) `
    -Note 'NextButtonClick(wpReady) не ждёт процессов: долгие операции — в PrepareToInstall (5b9743da)'
Add-StaticResult -Name 'static:ready-no-script-elevation' `
    -Ok ((-not ($nextBody -match [regex]::Escape('RunElevatedChild'))) -and
         (-not ($nextBody -match [regex]::Escape("ShellExec('runas'")))) `
    -Note 'на экране готовности права не запрашиваются: их даёт запуск от имени администратора (или /ALLUSERS в silent)'
$prepareBody = Get-IssFunctionBody -Text $issText -Name 'PrepareToInstall'
Add-StaticResult -Name 'static:prepare-long-ops' `
    -Ok ((Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('CloseRunningClient(True, Reason)'))) -and
         (Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('RemoveLegacyBeforeInstall(GIsElevated, Reason)'))) -and
         (Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('Изменения не выполнялись')))) `
    -Note 'закрытие клиента и удаление старого клиента — на странице «Подготовка к установке», ошибка строкой (5b9743da)'
Add-StaticResult -Name 'static:prepare-no-script-elevation' `
    -Ok ((Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('if not InPrivilegedContext then Exit'))) -and
         (-not ($prepareBody -match [regex]::Escape('RunElevatedChild'))) -and
         (-not ($prepareBody -match [regex]::Escape("ShellExec('runas'")))) `
    -Note 'PrepareToInstall не поднимает второй экземпляр: права даёт запуск от имени администратора или /ALLUSERS'
Add-StaticResult -Name 'static:legacy-nsis-detect' `
    -Ok ((Test-IssCode -Text $issText -Pattern ([regex]::Escape("Pos('Uninstall ETN.exe', UninstallCmd)"))) -and
         (Test-IssCode -Text $issText -Pattern ([regex]::Escape('function FindLegacyClient'))) -and
         (Test-IssCode -Text $issText -Pattern ([regex]::Escape('function RunLegacyUninstaller')))) `
    -Note 'старый NSIS-клиент: поиск в реестре и удаление его деинсталлятором'
Add-StaticResult -Name 'static:legacy-removal-wired' `
    -Ok ((Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('RemoveLegacyBeforeInstall'))) -and
         (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'InitializeSetup') -Pattern ([regex]::Escape('RemoveLegacyBeforeInstall(True')))) `
    -Note 'удаление старого клиента до установки: «Подготовка к установке» и привилегированная фаза'

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
# Ошибка 5b9743da: подпись клиента и причина неактивности «Далее» на экране
# компонентов обязаны говорить одно и то же. Раньше в режиме «только для меня»
# подпись предлагала «выберите клиент, чтобы заменить», а кнопка была неактивна
# без видимой причины — экран противоречил сам себе.
$reasonTextBody = Get-IssFunctionBody -Text $issText -Name 'ComponentsReasonText'
Add-StaticResult -Name 'static:client-scope-reason-consistent' `
    -Ok ((Test-IssCode -Text $clientStateBody -Pattern ([regex]::Escape('нужны права'))) -and
         (Test-IssCode -Text $reasonTextBody -Pattern ([regex]::Escape('нужны права'))) -and
         (Test-IssCode -Text $reasonTextBody -Pattern ([regex]::Escape('GInstalledClientScope = ''machine'''))) -and
         (Test-IssCode -Text $reasonTextBody -Pattern ([regex]::Escape('GUserOnlyMode')))) `
    -Note 'машинный клиент в режиме «только для меня»: причина и подпись совпадают (5b9743da)'
# Ошибка 5b9743da: нажатия «Далее» и «Отмена» оставляют след в журнале. Без этого
# по логу нельзя было отличить «обработчик завис» от «клик не дошёл до окна».
$cancelBody = Get-IssFunctionBody -Text $issText -Name 'CancelButtonClick'
Add-StaticResult -Name 'static:button-entry-log' `
    -Ok ((Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('Кнопка «Далее»: страница'))) -and
         (Test-IssCode -Text $cancelBody -Pattern ([regex]::Escape('Кнопка «Отмена»: страница')))) `
    -Note 'нажатия «Далее» и «Отмена» пишутся в журнал до любых проверок (5b9743da)'
$updateStateBody = Get-IssFunctionBody -Text $issText -Name 'UpdateComponentsState'
Add-StaticResult -Name 'static:next-state-log' `
    -Ok ((Test-IssCode -Text $updateStateBody -Pattern ([regex]::Escape('«Далее» '))) -and
         (Test-IssCode -Text $updateStateBody -Pattern ([regex]::Escape('причина: ')))) `
    -Note 'состояние «Далее» и причина неактивности пишутся в журнал при каждой смене (5b9743da)'
Add-StaticResult -Name 'static:summary-run-button-client' `
    -Ok (Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('GSummaryRunButton.Visible := (GExitCode = EXIT_OK) and GClientSelected'))) `
    -Note 'кнопка «Запустить клиент» — только когда клиент выбран'
$lanBody = Get-IssFunctionBody -Text $issText -Name 'DetectLanIp'
Add-StaticResult -Name 'static:lan-excludes-virtual' `
    -Ok ((Test-IssCode -Text $lanBody -Pattern ([regex]::Escape('InterfaceDescription'))) -and
         (Test-IssCode -Text $lanBody -Pattern ([regex]::Escape('vEthernet'))) -and
         (Test-IssCode -Text $lanBody -Pattern ([regex]::Escape('Hyper-V')))) `
    -Note 'LAN-адрес: виртуальные адаптеры исключены, остальное помечено в сводке'
Add-StaticResult -Name 'static:progress-no-second-pass' `
    -Ok ((-not ($stepBody -match [regex]::Escape('GChildRanThisPass'))) -and
         (-not ($stepBody -match [regex]::Escape('RunElevatedChild')))) `
    -Note 'установка идёт одним экземпляром: в CurStepChanged нет дочернего прохода (2dd215f7)'
$adminBody = Get-IssFunctionBody -Text $issText -Name 'CreateAdminPage'
Add-StaticResult -Name 'static:display-name-field' -Ok (Test-IssCode -Text $adminBody -Pattern ([regex]::Escape('GAdminDisplayEdit'))) `
    -Note 'поле отображаемого имени на экране администратора'

# --- 98ad5eec: клиент в поставке, ярлыки, закрытие ETN.exe -------------------
Write-Host '=== 98ad5eec: клиент, ярлыки, закрытие ETN.exe (статика) ==='
$clientFilesMachine = Test-IssCode -Text $issText -IniComments `
    -Pattern ([regex]::Escape('Source: "{#ClientPayload}\*"; DestDir: "{app}\client"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientMachine'))
$clientFilesUser = Test-IssCode -Text $issText -IniComments `
    -Pattern ([regex]::Escape('Source: "{#ClientPayload}\*"; DestDir: "{#ClientUserDir}"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientUser'))
Add-StaticResult -Name 'static:client-files-scope' -Ok ($clientFilesMachine -and $clientFilesUser) `
    -Note '[Files] клиента: «для всех» — {app}\client, «для меня» — {#ClientUserDir} (профиль, не {app})'
$iconsOk = (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Name: "{#ShortcutDesktopDir}\ETN"'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Name: "{#ShortcutMenuDir}\ETN"'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Name: "{#ShortcutUserDesktopDir}\ETN"'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Name: "{#ShortcutUserMenuDir}\ETN"'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Filename: "{app}\client\ETN.exe"'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Filename: "{#ClientUserDir}\ETN.exe"'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Check: InstallClientMachine'))) -and
    (Test-IssCode -Text $issText -IniComments -Pattern ([regex]::Escape('Check: InstallClientUser')))
Add-StaticResult -Name 'static:client-shortcuts' -Ok $iconsOk `
    -Note 'ярлыки: рабочий стол и меню «Пуск», цель и Check — по области установки'
# Ошибка 0f8dd0f3, п.7 (860def0d): при client_scope=user ETN.exe оказывался в
# Program Files, если установщик запущен в административном режиме (/ALLUSERS):
# пользовательская ветка копировала в {app}, а {app} в этом режиме —
# {commonpf}. Каталог пользовательской области обязан быть явным и совпадать с
# ClientInstallPath; поиск клиента и признак «клиент установлен» — тоже.
$explicitUserDir = ($issText -match [regex]::Escape('#define ClientUserDir "{localappdata}\Programs\ETN"')) -and
    ($issText -match [regex]::Escape('#define ClientUserDir TestAppDir'))
$exePathBody = Get-IssFunctionBody -Text $issText -Name 'ClientExePath'
$filesPresentBody = Get-IssFunctionBody -Text $issText -Name 'ClientFilesPresent'
$userDirSearchOk = ($exePathBody -match [regex]::Escape('ClientInstallPath')) -and
    ($filesPresentBody -match [regex]::Escape('ClientUserCopyPresent'))
Add-StaticResult -Name 'static:client-user-dir-explicit' -Ok ($explicitUserDir -and $userDirSearchOk) `
    -Note 'пользовательский клиент — явно в профиле (не {app}); путь и признак установки это учитывают'
# Ошибка 0f8dd0f3, п.6: «Запустить клиент» после установки сервера обязан
# передать имя и адрес локального сервера аргументами командной строки.
$runClientBody = Get-IssFunctionBody -Text $issText -Name 'RunClientClick'
$connectParamsBody = Get-IssFunctionBody -Text $issText -Name 'ClientConnectParams'
$connectArgsOk = (Test-IssCode -Text $runClientBody -Pattern ([regex]::Escape('Params := ClientConnectParams'))) -and
    (Test-IssCode -Text $runClientBody -Pattern ([regex]::Escape("ShellExecAsOriginalUser('open', Exe, Params,"))) -and
    (Test-IssCode -Text $connectParamsBody -Pattern ([regex]::Escape('--connect-url="http://localhost:'))) -and
    (Test-IssCode -Text $connectParamsBody -Pattern ([regex]::Escape('--connect-name="'))) -and
    (Test-IssCode -Text $connectParamsBody -Pattern ([regex]::Escape('Локальный сервер'))) -and
    (Test-IssCode -Text $connectParamsBody -Pattern ([regex]::Escape('GServerPort')))
Add-StaticResult -Name 'static:client-run-connect-args' -Ok $connectArgsOk `
    -Note '«Запустить клиент» передаёт --connect-name/--connect-url с портом установки'
$installPathBody = Get-IssFunctionBody -Text $issText -Name 'ClientInstallPath'
$userClientDirBody = Get-IssFunctionBody -Text $issText -Name 'UserClientDir'
$installPathOk = (Test-IssCode -Text $installPathBody -Pattern ([regex]::Escape('UserClientDir'))) -and
    (Test-IssCode -Text $installPathBody -Pattern ([regex]::Escape("'{commonpf}'"))) -and
    (Test-IssCode -Text $userClientDirBody -Pattern ([regex]::Escape('{#ClientUserDir}')))
Add-StaticResult -Name 'static:client-install-path' -Ok $installPathOk `
    -Note 'каталог клиента по области: профиль пользователя ({#ClientUserDir}) / Program Files'
$jsonBody = Get-IssFunctionBody -Text $issText -Name 'BuildInstallJson'
Add-StaticResult -Name 'static:client-scope-json' `
    -Ok ((Test-IssCode -Text $jsonBody -Pattern ([regex]::Escape('"client_scope"'))) -and
         (Test-IssCode -Text $jsonBody -Pattern ([regex]::Escape("Scope := 'user'"))) -and
         (Test-IssCode -Text $jsonBody -Pattern ([regex]::Escape("Scope := 'machine'")))) `
    -Note 'client_scope (user/machine) пишется в install.json'

# Ошибка 2dd215f7: отказ элевации/оболочки невозможно разобрать без точного
# Win32-кода ShellExec и без значения унаследованного шима __COMPAT_LAYER.
# Сторож держит диагностику в коде, а не в комментариях: без неё повторный
# отчёт с голой машины снова будет слепым.
$initBody = Get-IssFunctionBody -Text $issText -Name 'InitializeSetup'
$elevationDiagOk = ($issText -match '(?m)^SetupLogging=yes\s*$') -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'ShellErrorText') -Pattern ([regex]::Escape('ERROR_ACCESS_DENIED'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'OpenLocalLicense') -Pattern ([regex]::Escape('ShellErrorText(Code)'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'RetryInstallClick') -Pattern ([regex]::Escape('ShellErrorText(Code)'))) -and
    (Test-IssCode -Text $initBody -Pattern ([regex]::Escape("'Слой совместимости: __COMPAT_LAYER='"))) -and
    (Test-IssCode -Text $initBody -Pattern ([regex]::Escape("ExpandConstant('{log}')")))
Add-StaticResult -Name 'static:elevation-diagnostics' -Ok $elevationDiagOk `
    -Note 'отказ ShellExec: Win32-код в журнал, шим __COMPAT_LAYER логируется; SetupLogging включён'

# Ошибка aa5af30c: respawn мастера после диалога режима Inno на машине
# пользователя оставлял окно без ввода. Решение — вернуться к
# PrivilegesRequired=lowest без dialog-override: мастер стартует и работает в
# одном процессе, без перезапуска. Режим выбирается по фактическим правам
# процесса: обычный запуск — только клиент «только для меня», запуск от имени
# администратора — сервер и клиент «для всех пользователей».
# /ALLUSERS остаётся разрешённым (commandline): тихое автообновление службы
# запускает установщик из LocalSystem уже элевированным — Inno включает
# административный режим без UAC и без respawn (см. installer-runner.test.ts).
# Скриптовый self-exec установщика запрещён платформой (Exec/ShellExec/FileCopy
# по {srcexe} до старта установки дают код 5), поэтому второго экземпляра и
# RunElevatedChild быть не должно.
$setupSection = [regex]::Match($issText, '(?ms)^\[Setup\](.*?)^\[\w').Groups[1].Value
$noRespawnOk = ($setupSection -match '(?m)^PrivilegesRequired=lowest\s*$') -and
    ($setupSection -match '(?m)^PrivilegesRequiredOverridesAllowed=commandline\s*$') -and
    ($setupSection -notmatch '(?m)^PrivilegesRequired=admin\s*$') -and
    ($setupSection -notmatch '(?m)^PrivilegesRequiredOverridesAllowed=.*\bdialog\b') -and
    ($setupSection -notmatch '(?m)^UsePreviousPrivileges=') -and
    ($issText -notmatch '(?m)^PrivilegesRequiredOverrideTitle=') -and
    ($issText -notmatch '(?m)^PrivilegesRequiredOverrideInstruction=')
Add-StaticResult -Name 'static:no-respawn-mode' -Ok $noRespawnOk `
    -Note 'продукт: lowest + commandline без dialog/UsePreviousPrivileges — мастер не перезапускается после диалога режима'

$defaultDirBody = Get-IssFunctionBody -Text $issText -Name 'GetDefaultAppDir'
$modeByRightsOk = ($issText -match [regex]::Escape('#define AppDir "{code:GetDefaultAppDir}"')) -and
    (Test-IssCode -Text $issText -Pattern ([regex]::Escape('DefaultDirName={#AppDir}'))) -and
    (Test-IssCode -Text $defaultDirBody -Pattern ([regex]::Escape('if IsAdmin then'))) -and
    (Test-IssCode -Text $defaultDirBody -Pattern ([regex]::Escape("{commonpf}"))) -and
    (Test-IssCode -Text $defaultDirBody -Pattern ([regex]::Escape("{localappdata}"))) -and
    (Test-IssCode -Text $initBody -Pattern ([regex]::Escape('GAdminInstallMode := IsAdmin or IsAdminInstallMode'))) -and
    (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape("ParamExists('ELEVATEHELPER')")))) -and
    (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape("ShellExec('runas'")))) -and
    (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('RunElevatedChild')))) -and
    (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('RelaunchAdminInstallMode'))))
Add-StaticResult -Name 'static:mode-by-process-rights' -Ok $modeByRightsOk `
    -Note 'режим по фактическим правам процесса: IsAdmin → сервер и Program Files, обычный запуск → профиль; второго экземпляра нет'

$serverReasonBody = Get-IssFunctionBody -Text $issText -Name 'ServerUnavailableReason'
$serverReason = 'Для установки сервера закройте установщик и запустите его от имени администратора (правый клик → Запуск от имени администратора).'
$serverReasonOk = (Test-IssCode -Text $serverReasonBody -Pattern ([regex]::Escape($serverReason))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'UpdateComponentsState') -Pattern ([regex]::Escape('ServerUnavailableReason'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'ComponentsReasonText') -Pattern ([regex]::Escape('ServerUnavailableReason')))
Add-StaticResult -Name 'static:server-needs-admin-launch' -Ok $serverReasonOk `
    -Note 'причина недоступности сервера в обычном запуске — дословно «запустите от имени администратора» (экран и журнал)'

# Режим «только для меня» (2dd215f7): без прав администратора сервер и клиент
# «для всех» недоступны. Сервер выключен и снят из выбора, область клиента —
# только профиль пользователя, мастер объясняет отказ и путь к серверу.
$userOnlyOk = (Test-IssCode -Text $initBody -Pattern ([regex]::Escape('GUserOnlyMode := (not GAdminInstallMode)'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'ApplySelection') -Pattern ([regex]::Escape('ServerChecked and (not GUserOnlyMode)'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'ApplyDefaultSelection') -Pattern ([regex]::Escape('if GUserOnlyMode then'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'ApplyDefaultSelection') -Pattern ([regex]::Escape('GClientScopeUser := True'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'UpdateComponentsState') -Pattern ([regex]::Escape('GServerCheck.Enabled := not GUserOnlyMode'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'UpdateReadyMemo') -Pattern ([regex]::Escape('if GUserOnlyMode then')))
Add-StaticResult -Name 'static:user-only-mode' -Ok $userOnlyOk `
    -Note 'режим «только для меня»: сервер выключен, клиент в профиль, экран объясняет отказ и путь к серверу'

# Administrator Protection: элевированный процесс — отдельный профиль SMAA,
# поэтому в административном режиме клиент ставится только «для всех»; из
# элевированного процесса клиент не запускается (профиль не тот).
$applyBody = Get-IssFunctionBody -Text $issText -Name 'ApplySelection'
$installUserBody = Get-IssFunctionBody -Text $issText -Name 'InstallClientUser'
$adminScopeOk = (Test-IssCode -Text $initBody -Pattern ([regex]::Escape('GAdminMachineScope := GAdminInstallMode and (not GPrivilegedPhase)'))) -and
    (Test-IssCode -Text $applyBody -Pattern ([regex]::Escape('(not GAdminMachineScope)'))) -and
    (Test-IssCode -Text $installUserBody -Pattern ([regex]::Escape('(not GAdminMachineScope)'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'RunClientClick') -Pattern ([regex]::Escape('if GAdminMachineScope then'))) -and
    (Test-IssCode -Text $pageChangedBody -Pattern ([regex]::Escape('(not GAdminMachineScope)')))
Add-StaticResult -Name 'static:admin-machine-scope' -Ok $adminScopeOk `
    -Note 'admin-режим: клиент только machine, автозапуск из setup отключён'

# Чистка недостижимых радиокнопок области (замечание верификатора 2dd215f7,
# п.4): в продуктовой сборке область задаёт диалог режима, радиокнопок в
# мастере быть не должно. Сторож краснеет, если контрол вернут.
Add-StaticResult -Name 'static:no-scope-radios' `
    -Ok (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('TNewRadioButton')))) `
    -Note 'выбора области в мастере нет: её задаёт диалог режима Inno'

# Замечание верификатора п.1: признак «клиент установлен» обязан видеть копию
# «только для меня» в профиле и в административном режиме — иначе /ALLUSERS
# поверх user-установки молча ставил вторую копию.
$clientFilesBody = Get-IssFunctionBody -Text $issText -Name 'ClientFilesPresent'
$clientUserBody = Get-IssFunctionBody -Text $issText -Name 'ClientUserCopyPresent'
$bothAreasOk = (Test-IssCode -Text $clientFilesBody -Pattern ([regex]::Escape('ClientUserCopyPresent'))) -and
    (Test-IssCode -Text $clientFilesBody -Pattern ([regex]::Escape('MachineAppDir'))) -and
    (Test-IssCode -Text $clientUserBody -Pattern ([regex]::Escape('UserClientDir'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'UserClientDir') -Pattern ([regex]::Escape('{#ClientUserDir}')))
Add-StaticResult -Name 'static:client-both-areas' -Ok $bothAreasOk `
    -Note 'клиент ищется в профиле и в машинной области; путь профиля — явная {#ClientUserDir}'

# Замечание верификатора п.1 (сообщение): при найденной user-копии в
# административном режиме мастер честно говорит, что копия в профиле останется.
$scopeTextBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeText'
$userCopyMsgOk = (Test-IssCode -Text $scopeTextBody -Pattern ([regex]::Escape('GUserClientCopyPresent'))) -and
    (Test-IssCode -Text $scopeTextBody -Pattern ([regex]::Escape('Найден клиент «только для меня»')))
Add-StaticResult -Name 'static:client-user-copy-message' -Ok $userCopyMsgOk `
    -Note 'admin-режим поверх user-копии: сказано, что она останется и рядом появится машинная'

# Ярлыки несут параметры подключения: в административном режиме это
# единственный путь prefill (клиент из элевированного процесса не запускаем).
$shortcutArgsOk = ([regex]::Matches($issText, [regex]::Escape('Parameters: "{code:ClientConnectParamsConst}"')).Count -eq 4) -and
    ($issText -match [regex]::Escape('function ClientConnectParamsConst(Param: String): String;'))
Add-StaticResult -Name 'static:client-shortcut-connect-args' -Ok $shortcutArgsOk `
    -Note 'все четыре ярлыка передают ClientConnectParams (обёртка Param: String)'

$closeBody = Get-IssFunctionBody -Text $issText -Name 'CloseRunningClient'
$softIdx = $closeBody.IndexOf('SoftCloseClientPids')
$softWaitIdx = $closeBody.IndexOf('WaitClientProcessesGone(ClientCloseWaitMs')
$forceIdx = $closeBody.IndexOf('ForceCloseClientPids')
$forceWaitIdx = $closeBody.IndexOf('WaitClientProcessesGone(CLIENT_KILL_WAIT_MS')
$closeOrder = ($closeBody -ne '') -and ($softIdx -ge 0) -and ($softWaitIdx -gt $softIdx) -and
    ($forceIdx -gt $softWaitIdx) -and ($forceWaitIdx -gt $forceIdx)
Add-StaticResult -Name 'static:client-close-order' -Ok $closeOrder `
    -Note 'мягкое закрытие → ожидание → принудительное → ожидание'
$softBody = Get-IssFunctionBody -Text $issText -Name 'SoftCloseClientPids'
$forceBody = Get-IssFunctionBody -Text $issText -Name 'ForceCloseClientPids'
$softNoForce = (Test-IssCode -Text $softBody -Pattern ([regex]::Escape("RunTaskkill('/PID ' + Pid, True)"))) -and
    (-not (Test-IssCode -Text $softBody -Pattern ([regex]::Escape("'/F"))))
$forceKills = Test-IssCode -Text $forceBody -Pattern ([regex]::Escape("RunTaskkill('/F /PID ' + Pid + ' /T', False)"))
Add-StaticResult -Name 'static:client-close-taskkill' -Ok ($softNoForce -and $forceKills) `
    -Note 'мягко — taskkill без /F, принудительно — /F /PID … /T'
$closeCallIdx = $stepBody.IndexOf('CloseRunningClient(False, Reason)')
$prepIdx = $stepBody.IndexOf('PrepareServerUpdate(Reason)')
$closeBeforeCopy = ($closeCallIdx -ge 0) -and ($prepIdx -gt $closeCallIdx)
Add-StaticResult -Name 'static:client-close-before-copy' -Ok $closeBeforeCopy `
    -Note 'закрытие клиента — в ssInstall до PrepareServerUpdate и копирования'
$closeGuard = (Test-IssCode -Text $stepBody -Pattern ([regex]::Escape('if not CloseRunningClient(False, Reason) then'))) -and
    (Test-IssCode -Text $stepBody -Pattern ([regex]::Escape('GExitCode := EXIT_PRECONDITION'))) -and
    (Test-IssCode -Text $stepBody -Pattern ([regex]::Escape('ExitProcess(EXIT_PRECONDITION)')))
Add-StaticResult -Name 'static:client-close-code20' -Ok $closeGuard `
    -Note 'клиент не закрылся — код 20 и выход до копирования файлов'
Add-StaticResult -Name 'static:client-close-gui-warning' `
    -Ok ((Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('CloseRunningClient(True, Reason)'))) -and
         (Test-IssCode -Text $issText -Pattern ([regex]::Escape('Закрыть клиент и продолжить установку?')))) `
    -Note 'GUI: предупреждение и согласие перед копированием файлов (PrepareToInstall)'
$clientPidsProduct = Get-IssFunctionBodyWithoutIfdef -Text $issText -Name 'ClientPidsRunning' -Ifdef 'TestMode'
$clientHooksIfdef = ($clientPidsProduct -ne '') -and
    (-not ($clientPidsProduct -match 'GTestClientPids')) -and
    (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('GTestClientPids')))
Add-StaticResult -Name 'static:client-hooks-ifdef' -Ok $clientHooksIfdef `
    -Note 'модель клиента и хуки /TESTCLIENT* — только под #ifdef TestMode'
# Закрытие только своих процессов (замечание приёмки 98ad5eec): в продуктовой
# ветке Get-Process фильтруется по каталогам возможных установок клиента
# (ClientCloseRoots: выбранная область + второй вариант ADR 144bcdb0), иначе
# ETN.exe другого пользователя приводит к 30+15 с и коду 20. Оба каталога нужны
# и потому, что в привилегированной фазе {localappdata} — профиль того же
# пользователя, а машинный клиент из Program Files тоже может работать
# (905dec4c).
$realPidsProduct = Get-IssFunctionBodyWithoutIfdef -Text $issText -Name 'RealClientPids' -Ifdef 'TestMode'
$closeFilterOk = (Test-IssCode -Text $realPidsProduct -Pattern ([regex]::Escape('ClientPathCondition'))) -and
    (-not (Test-IssCode -Text $realPidsProduct -Pattern ([regex]::Escape('ClientCloseRoot(')))) -and
    (-not (Test-IssCode -Text $realPidsProduct -Pattern ([regex]::Escape("Get-Process -Name ''ETN''|ForEach-Object{`$_.Id}"))))
$closeRootsBody = Get-IssFunctionBody -Text $issText -Name 'ClientCloseRoots'
$closeRootsOk = (Test-IssCode -Text $closeRootsBody -Pattern ([regex]::Escape('{localappdata}'))) -and
    (Test-IssCode -Text $closeRootsBody -Pattern ([regex]::Escape('{commonpf}'))) -and
    (Test-IssCode -Text $closeRootsBody -Pattern ([regex]::Escape('ClientInstallPath')))
$pathCondBody = Get-IssFunctionBody -Text $issText -Name 'ClientPathCondition'
$rootCondBody = Get-IssFunctionBody -Text $issText -Name 'ClientRootCondition'
$pathCondOk = (Test-IssCode -Text $pathCondBody -Pattern ([regex]::Escape(' -or '))) -and
    (Test-IssCode -Text $rootCondBody -Pattern ([regex]::Escape('StartsWith')))
Add-StaticResult -Name 'static:client-close-own-processes' -Ok ($closeFilterOk -and $closeRootsOk -and $pathCondOk) `
    -Note 'фильтр Get-Process — оба каталога клиента; чужие ETN.exe не трогаются'
# Диалог Inno «Не удалось автоматически закрыть все приложения…» со списком
# 4× «ETN» — Restart Manager; выбор «Игнорировать» вёл к сбою копирования
# d3dcompiler_47.dll (905dec4c). Наше закрытие (мягко → /F) заменяет RM, а сам
# механизм должен быть выключен, иначе список и «Игнорировать» возвращаются.
$setupSection = [regex]::Match($issText, '(?ms)^\[Setup\](.*?)^\[').Groups[1].Value
$rmOff = ($setupSection -match '(?m)^\s*CloseApplications\s*=\s*no\s*$') -and
    ($setupSection -match '(?m)^\s*RestartApplications\s*=\s*no\s*$')
Add-StaticResult -Name 'static:restart-manager-off' -Ok $rmOff `
    -Note 'Restart Manager выключен: список ETN и «Игнорировать» недоступны'
# Обновление: область клиента фиксирована — радиокнопки скрыты, область
# выводится текстом (ea8e223a, 4a66b7a5; замечание приёмки 98ad5eec).
$updateStateBody = Get-IssFunctionBody -Text $issText -Name 'UpdateComponentsState'
$scopeLabelOk = (Test-IssCode -Text $updateStateBody -Pattern ([regex]::Escape('GScopeFixedLabel.Visible := ClientScopeFixed or GAdminMachineScope'))) -and
    (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('GScopeUserRadio')))) -and
    (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('GScopeMachineRadio'))))
$scopeFixedBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeFixed'
$scopeFixedOk = Test-IssCode -Text $scopeFixedBody -Pattern ([regex]::Escape("GClientState = 'installed'"))
$scopeTextBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeText'
# Формулировка пользователя (ошибка 860def0d, n5): вариант установки и что
# сделать, чтобы получить другой, — без термина «область установки».
# Строки Pascal переносятся по '+', поэтому фразы проверяем по телу функции,
# склеенному через границы строк и строковых литералов: иначе «обычным двойным
# кликом» разорвано между строками и кавычками конкатенации.
$scopeTextFlat = ($scopeTextBody -replace '\r?\n\s*', ' ') -replace "'\s*\+\s*'", ''
$scopeTextOk = (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('Клиент установлен в варианте «только для меня»'))) -and
    (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('Клиент установлен в варианте «для всех пользователей»'))) -and
    (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('Запуск от имени администратора'))) -and
    (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('обычным двойным кликом'))) -and
    (-not (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('в диалоге режима')))) -and
    (-not (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('удалите клиента и выполните установку заново')))) -and
    (-not (Test-IssCode -Text $scopeTextFlat -Pattern ([regex]::Escape('область установки'))))
Add-StaticResult -Name 'static:client-scope-fixed-text' -Ok ($scopeLabelOk -and $scopeFixedOk -and $scopeTextOk) `
    -Note 'при установленном клиенте область выводится текстом в формулировке пользователя (радиокнопок нет)'
Add-StaticResult -Name 'static:client-launch-original-user' `
    -Ok (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'RunClientClick') `
        -Pattern ([regex]::Escape("ShellExecAsOriginalUser('open', Exe"))) `
    -Note 'запуск клиента с итоговой сводки — от исходного пользователя (режим app)'
$fetchText = Get-Content -LiteralPath (Join-Path $installerDir 'fetch-payload.ps1') -Raw -Encoding UTF8
$buildText = Get-Content -LiteralPath $buildScript -Raw -Encoding UTF8
Add-StaticResult -Name 'static:payload-fetch-client' `
    -Ok (($fetchText -match [regex]::Escape("'-w', '@etn/client', 'run', 'package:dir'")) -and
         ($fetchText -match [regex]::Escape('payloadClient')) -and
         ($fetchText -match [regex]::Escape("'client\ETN.exe'"))) `
    -Note 'fetch-payload: сборка клиента (--dir) и копирование в payload\client'
Add-StaticResult -Name 'static:payload-required-client' `
    -Ok ($buildText -match [regex]::Escape("'client\ETN.exe'")) `
    -Note 'build.ps1: клиент — обязательный файл payload'
Add-StaticResult -Name 'static:freshness-full-trees' `
    -Ok (($buildText -match [regex]::Escape('Compare-PayloadTree')) -and
         ($buildText -match [regex]::Escape("Relative = 'server\dist'")) -and
         ($buildText -match [regex]::Escape("Relative = 'server\migrations'"))) `
    -Note 'свежесть: весь server\dist и все migrations, а не два файла'
# Свежесть клиента (замечание приёмки 98ad5eec): версия из паспорта поставки
# сверяется с репозиторием, файлы client\ — по хэш-карте; fetch-payload.ps1
# обязан писать и то, и другое, а также удалять паспорт в начале прогона.
Add-StaticResult -Name 'static:freshness-client-version' `
    -Ok (($buildText -match [regex]::Escape("'server-manifest.json'")) -and
         ($buildText -match [regex]::Escape("client_version")) -and
         ($buildText -match [regex]::Escape("client\package.json"))) `
    -Note 'свежесть клиента: client_version из манифеста сверяется с client/package.json'
Add-StaticResult -Name 'static:freshness-client-hashes' `
    -Ok (($buildText -match [regex]::Escape('Compare-PayloadHashMap')) -and
         ($buildText -match [regex]::Escape('client.hashes')) -and
         ($fetchText -match [regex]::Escape('Get-TreeHashes')) -and
         ($fetchText -match [regex]::Escape('hashes     = $clientHashes'))) `
    -Note 'свежесть клиента: хэши файлов client сверяются с client.hashes манифеста'
Add-StaticResult -Name 'static:freshness-manifest-invalidated' `
    -Ok (($fetchText -match [regex]::Escape("Remove-Item -LiteralPath `$manifestPath -Force")) -and
         ($fetchText -match [regex]::Escape("'server-manifest.json'"))) `
    -Note 'fetch-payload удаляет паспорт в начале: недописанный прогон не выглядит свежим'
$builderYml = Get-Content -LiteralPath (Join-Path $repoRoot 'client\electron-builder.yml') -Raw -Encoding UTF8
$dirTarget = ($builderYml -match '(?m)^\s+-\s+dir\s*$') -and
    ($builderYml -notmatch '(?m)^\s*-\s*nsis\s*$') -and
    ($builderYml -notmatch '(?m)^nsis\s*:')
Add-StaticResult -Name 'static:client-dir-target' -Ok $dirTarget `
    -Note 'electron-builder: цель win — dir, NSIS снят (один установщик)'
$clientPkgText = Get-Content -LiteralPath (Join-Path $repoRoot 'client\package.json') -Raw -Encoding UTF8
Add-StaticResult -Name 'static:client-package-dir-script' `
    -Ok (($clientPkgText -match [regex]::Escape('"package:dir"')) -and
         ($clientPkgText -match [regex]::Escape('electron-builder --dir'))) `
    -Note 'npm -w @etn/client run package:dir собирает win-unpacked'


# --- 860def0d: UX-тексты и раскладка экранов (статика) ----------------------
# Пользователь видел обрезанные подсказки на всех экранах, не видел описаний
# сервера, клиента и разницы областей, читал «режим service» и терял сводку под
# полосой оформления. Сторожа держат и тексты (договорённости ТП, дословные
# формулировки), и механику: высоту подписи задаёт FitLabel, а не «дельта»
# AdjustHeight, раскладка пересчитывается от фактических высот.
Write-Host '=== 860def0d: UX-тексты и раскладка экранов (статика) ==='
$fitBody = Get-IssFunctionBody -Text $issText -Name 'FitLabel'
$fitOk = (Test-IssCode -Text $fitBody -Pattern ([regex]::Escape('Delta := Lbl.AdjustHeight'))) -and
    (-not ($issText -match 'Height\s*:=\s*\w+\.AdjustHeight'))
Add-StaticResult -Name 'static:fitlabel-no-delta' -Ok $fitOk `
    -Note 'AdjustHeight вызывается без присваивания Height (дельта сжимала подпись до полосы)'

$componentsBody = Get-IssFunctionBody -Text $issText -Name 'UpdateComponentsState'
$componentsTextOk = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('Сервер хранит графовые базы знаний'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('Клиент — окно для работы с базами'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('«Только для меня» — клиент в вашем профиле'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('«Для всех пользователей» — в Program Files')))
Add-StaticResult -Name 'static:components-descriptions' -Ok $componentsTextOk `
    -Note 'что такое сервер и клиент и чем различаются области — подписи на экране компонентов'

$layoutBody = Get-IssFunctionBody -Text $issText -Name 'LayoutComponentsPage'
$fitPageBody = Get-IssFunctionBody -Text $issText -Name 'FitComponentsPage'
$layoutOk = (Test-IssCode -Text $layoutBody -Pattern ([regex]::Escape('GServerHintLabel.Height'))) -and
    (Test-IssCode -Text $layoutBody -Pattern ([regex]::Escape('GClientHintLabel.Height'))) -and
    (Test-IssCode -Text $layoutBody -Pattern ([regex]::Escape('GScopeHintLabel.Height'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('FitLabel(GScopeHintLabel)'))) -and
    (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('FitComponentsPage'))) -and
    (Test-IssCode -Text $fitPageBody -Pattern ([regex]::Escape('LayoutComponentsPage')))
Add-StaticResult -Name 'static:components-relayout' -Ok $layoutOk `
    -Note 'позиции — по фактическим высотам подписей после каждой смены текста, с проверкой «поместилось» (5b9743da)'

$readyComponents = Get-IssFunctionBody -Text $issText -Name 'CreateComponentsPage'
$readyOk = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('not GComponentsReady'))) -and
    (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsReady := True')))
Add-StaticResult -Name 'static:components-init-guard' -Ok $readyOk `
    -Note 'программная установка Checked не снимает выбор клиента (OnClick до готовности экрана)'

$adminBody = Get-IssFunctionBody -Text $issText -Name 'CreateAdminPage'
$adminFlat = $adminBody -replace '\r?\n\s*', ' '
$adminSubtitleRx = 'Первый пользователь станет администратором ETN\. Задайте его логин и ' +
    ''' \+ ''отображаемое имя, а после установки сервера получите ключ для входа\.'
$adminOk = ($adminFlat -match $adminSubtitleRx) -and
    (Test-IssCode -Text $adminBody -Pattern ([regex]::Escape('GAdminHintLabel.WordWrap := True'))) -and
    (Test-IssCode -Text $adminBody -Pattern ([regex]::Escape('FitLabel(GAdminHintLabel)')))
Add-StaticResult -Name 'static:admin-texts' -Ok $adminOk `
    -Note 'подзаголовок — дословно формулировка пользователя; подсказка с переносом и пересчётом'

$modeBody = Get-IssFunctionBody -Text $issText -Name 'ServerModeText'
$modeOk = (Test-IssCode -Text $modeBody -Pattern ([regex]::Escape('автоматический запуск в режиме службы Windows'))) -and
    (Test-IssCode -Text $modeBody -Pattern ([regex]::Escape('ручной запуск сервера как обычного приложения'))) -and
    (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'UpdateServerParamsState') `
        -Pattern ([regex]::Escape('ServerModeText(')))
Add-StaticResult -Name 'static:server-mode-human' -Ok $modeOk `
    -Note 'режим запуска на экране — по-человечески, без термина service'

$readyMemoBody = Get-IssFunctionBody -Text $issText -Name 'UpdateReadyMemo'
# Ошибка aa5af30c: режим больше не выбирается диалогом Inno до мастера (этот
# диалог вызывал respawn и ломал ввод). В обычном запуске мастер объясняет
# режим «только для меня» и что для сервера или клиента «для всех» нужно
# закрыть установщик и запустить его от имени администратора; в диалоге режима
# больше не предлагаем выбрать вариант.
$serverReasonBody = Get-IssFunctionBody -Text $issText -Name 'ServerUnavailableReason'
$reasonTextBody = Get-IssFunctionBody -Text $issText -Name 'ComponentsReasonText'
$uacOk = (-not (Test-IssCode -Text $readyMemoBody -Pattern ([regex]::Escape('Windows запросит права администратора')))) -and
    (Test-IssCode -Text $readyMemoBody -Pattern ([regex]::Escape('if GUserOnlyMode then'))) -and
    (Test-IssCode -Text $updateStateBody -Pattern ([regex]::Escape('GServerHintLabel.Caption := ServerUnavailableReason'))) -and
    (Test-IssCode -Text $serverReasonBody -Pattern ([regex]::Escape('Запуск от имени администратора'))) -and
    (Test-IssCode -Text $reasonTextBody -Pattern ([regex]::Escape('GUserOnlyMode and GServerRequested and (not GServerSelected)'))) -and
    (Test-IssCode -Text $reasonTextBody -Pattern ([regex]::Escape('Result := ServerUnavailableReason'))) -and
    (Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('GUserOnlyMode')))
Add-StaticResult -Name 'static:mode-guidance' -Ok $uacOk `
    -Note 'мастер объясняет режим «только для меня» и что сервер ставится запуском от имени администратора'

$portBody = Get-IssFunctionBody -Text $issText -Name 'ServerPortStatus'
# 1dddac77: доступность TCP-таблицы проверяется пробой на loopback (порт 0) —
# listen только на loopback диалога брандмауэра не даёт; слушать 0.0.0.0
# нельзя (860def0d, п.4), а запасная ветка обязана работать fail-closed —
# эксклюзивный bind на 0.0.0.0 (SO_EXCLUSIVEADDRUSE) без listen(): bind без
# флага проходил при живом слушателе (SO_REUSEADDR, ложное «свободен»).
$portProbeLoopback = Test-IssCode -Text $portBody `
    -Pattern ([regex]::Escape('TcpListener([Net.IPAddress]::Loopback,0)'))
$portNoAnyListener = -not (Test-IssCode -Text $portBody `
    -Pattern ([regex]::Escape('TcpListener([Net.IPAddress]::Any')))
$portNoListenCall = -not (Test-IssCode -Text $portBody -Pattern '\.Listen\s*\(')
$portNetsh = Test-IssCode -Text $portBody `
    -Pattern ([regex]::Escape('show excludedportrange protocol=tcp'))
Add-StaticResult -Name 'static:port-no-firewall-prompt' `
    -Ok ($portProbeLoopback -and $portNoAnyListener -and $portNoListenCall -and $portNetsh) `
    -Note 'проба таблицы — loopback, bind на 0.0.0.0 без listen(), таблица исключений netsh'
$portExclusive = (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('ExclusiveAddressUse'))) -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('SetSocketOption')))
Add-StaticResult -Name 'static:port-exclusive-bind' -Ok $portExclusive `
    -Note 'fail-closed: bind с SO_EXCLUSIVEADDRUSE, иначе SO_REUSEADDR даёт ложное «свободен»'
# 1dddac77: проба таблицы (слушатель на loopback с портом 0 виден со своим PID)
# и ветка «таблица недоступна + служба запущена → порт свой», без которой на
# build 28000 установка/автообновление поверх живой службы падают с кодом 20.
$portTableProbe = ($portBody -ne '') -and $portProbeLoopback -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('OwningProcess -eq $PID'))) -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$tableOk')))
Add-StaticResult -Name 'static:port-listener-table-probe' -Ok $portTableProbe `
    -Note 'проба TCP-таблицы: свежий loopback-слушатель обязан быть виден со своим PID'
$portTableServiceOwn = (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$tableOk -eq 0'))) -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('$svcFound -eq 1'))) -and
    (Test-IssCode -Text $portBody -Pattern ([regex]::Escape('exit 0')))
Add-StaticResult -Name 'static:port-tableoff-service-own' -Ok $portTableServiceOwn `
    -Note 'таблица недоступна + своя служба запущена → порт свой (0), иначе fail-closed'

$finishedBody = Get-IssFunctionBody -Text $issText -Name 'CreateFinishedControls'
$finishedOk = (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('WizardForm.FinishedLabel.Left'))) -and
    (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('WizardForm.FinishedLabel.Width'))) -and
    (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('WizardForm.FinishedLabel.Top'))) -and
    (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('WizardForm.FinishedPage.ClientHeight'))) -and
    (-not (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('Left := 0'))))
Add-StaticResult -Name 'static:finished-anchored' -Ok $finishedOk `
    -Note 'сводка и кнопки — по FinishedLabel, а не от левого края (полоса оформления)'

$initProduct = Get-IssFunctionBodyWithoutIfdef -Text $issText -Name 'InitializeSetup' -Ifdef 'TestMode'
$layoutHookIfdef = (-not ($initProduct -match [regex]::Escape("ParamValue('TESTLAYOUT')"))) -and
    (-not ($initProduct -match [regex]::Escape("GTestLayout = '1'"))) -and
    (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('GTestLayout'))) -and
    (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('DumpLayout')))
Add-StaticResult -Name 'static:layout-hook-ifdef' -Ok $layoutHookIfdef `
    -Note '/TESTLAYOUT и снимок раскладки — только под #ifdef TestMode'


# --- Сторож свежести payload в build.ps1 (дефект 3, 98ad5eec) ----------------
# Продуктовая сборка (без -TestMode) обязана отказаться от устаревшей поставки
# до компиляции: иначе exe собирается, а падает уже на etn init --key-out.
# Задача 98ad5eec расширила проверку на весь server/dist и все migrations и
# сделала клиент обязательным — проверяются обе стороны: неполный payload и
# payload, разошедшийся со сборкой репозитория, не собираются; свежий —
# собирается (иначе сторож браковал бы верную поставку).
Write-Host '=== Сторож свежести payload (дефект 3, 98ad5eec) ==='
function Copy-Tree {
    param([string]$Source, [string]$Destination)
    & robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $Source -> $Destination завершился с кодом $LASTEXITCODE." }
}

function New-FreshnessPayload {
    param([string]$Path, [switch]$WithoutClient, [switch]$WithoutMigrations,
        [string]$ClientVersion)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
    foreach ($dir in @('node', 'service', 'server\node_modules\better-sqlite3', 'client\resources')) {
        New-Item -ItemType Directory -Path (Join-Path $Path $dir) -Force | Out-Null
    }
    [System.IO.File]::WriteAllText((Join-Path $Path 'node\node.exe'), 'stub')
    [System.IO.File]::WriteAllText((Join-Path $Path 'service\etn-service.exe'), 'stub')
    $templateText = Get-Content -LiteralPath (Join-Path $installerDir 'service\etn-service.xml') -Raw -Encoding UTF8
    [System.IO.File]::WriteAllText((Join-Path $Path 'service\etn-service.xml'), $templateText,
        (New-Object System.Text.UTF8Encoding($false)))
    $serverPkg = Get-Content -LiteralPath (Join-Path $repoRoot 'server\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    [System.IO.File]::WriteAllText((Join-Path $Path 'server\package.json'),
        '{"name":"@etn/server","version":"' + $serverPkg.version + '"}')
    [System.IO.File]::WriteAllText((Join-Path $Path 'server\node_modules\better-sqlite3\package.json'),
        '{"name":"better-sqlite3","version":"11.1.2"}')
    if (-not $WithoutMigrations) {
        Copy-Tree -Source (Join-Path $repoRoot 'server\migrations') -Destination (Join-Path $Path 'server\migrations')
    }
    if (Test-Path -LiteralPath (Join-Path $repoRoot 'server\dist')) {
        Copy-Tree -Source (Join-Path $repoRoot 'server\dist') -Destination (Join-Path $Path 'server\dist')
    } else {
        New-Item -ItemType Directory -Path (Join-Path $Path 'server\dist') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $Path 'server\dist\index.js'), '// stub')
        [System.IO.File]::WriteAllText((Join-Path $Path 'server\dist\cli.js'), '// --key-out --check')
        New-Item -ItemType Directory -Path (Join-Path $Path 'server\dist\db') -Force | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $Path 'server\dist\db\db-backup.js'),
            '// backup --to restore --from --report-out')
    }
    if (-not $WithoutClient) {
        [System.IO.File]::WriteAllText((Join-Path $Path 'client\ETN.exe'), 'stub')
        [System.IO.File]::WriteAllText((Join-Path $Path 'client\resources\app.asar'), 'stub')
    }
    Write-FreshnessManifest -Path $Path -ClientVersion $ClientVersion
}

# Хэши дерева фикстуры — как в fetch-payload.ps1 (ключ — путь через '/'):
# build.ps1 сверяет client\ с картой client.hashes из паспорта поставки.
function Get-FixtureTreeHashes {
    param([string]$Root)
    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Root)) { return $map }
    Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
        $map[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $map
}

# Паспорт поставки фикстуры: client_version и хэши client\ — без него
# продуктовый build.ps1 отказывается от payload как от недописанного.
function Write-FreshnessManifest {
    param([string]$Path, [string]$ClientVersion)
    $clientPkg = Get-Content -LiteralPath (Join-Path $repoRoot 'client\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $ClientVersion) { $ClientVersion = [string]$clientPkg.version }
    $hashes = Get-FixtureTreeHashes -Root (Join-Path $Path 'client')
    $manifest = [ordered]@{
        server_version = '0.0.0'
        client_version = $ClientVersion
        client         = [ordered]@{
            version = $ClientVersion
            files   = $hashes.Count
            hashes  = $hashes
        }
    }
    [System.IO.File]::WriteAllText((Join-Path $Path 'server-manifest.json'),
        ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-PayloadBuild {
    param([string]$Payload, [string]$OutputName)
    $out = & $psExeForBuild -NoProfile -ExecutionPolicy Bypass -File $buildScript `
        -PayloadRoot $Payload -OutputDir (Join-Path $workRoot $OutputName) 2>&1 | Out-String
    return [pscustomobject]@{ Code = $LASTEXITCODE; Output = $out }
}

$psExeForBuild = (Get-Process -Id $PID).Path

# A. Клиент обязателен: без client\ETN.exe сборка отказывается.
$noClientPayload = Join-Path $workRoot 'payload-no-client'
New-FreshnessPayload -Path $noClientPayload -WithoutClient
$noClientBuild = Invoke-PayloadBuild -Payload $noClientPayload -OutputName 'no-client-out'
Add-StaticResult -Name 'build:payload-requires-client' `
    -Ok (($noClientBuild.Code -ne 0) -and ($noClientBuild.Output -match 'client\\ETN\.exe')) `
    -Note 'без клиента в payload продуктовый установщик не собирается'

# B. Правка server\dist после сборки ловится сравнением всего каталога.
$staleDistPayload = Join-Path $workRoot 'payload-stale-dist'
New-FreshnessPayload -Path $staleDistPayload
[System.IO.File]::AppendAllText((Join-Path $staleDistPayload 'server\dist\index.js'),
    "`r`n// локальная правка после сборки`r`n")
$staleDistBuild = Invoke-PayloadBuild -Payload $staleDistPayload -OutputName 'stale-dist-out'
Add-StaticResult -Name 'build:stale-dist-detected' `
    -Ok (($staleDistBuild.Code -ne 0) -and ($staleDistBuild.Output -match 'server\\dist')) `
    -Note 'изменённый файл server\dist — payload устарел'
Add-StaticResult -Name 'build:stale-dist-message' `
    -Ok ($staleDistBuild.Output -match 'Обновите payload') `
    -Note 'сообщение указывает на fetch-payload.ps1'

# C. Правка migrations после сборки ловится так же.
$staleMigPayload = Join-Path $workRoot 'payload-stale-migrations'
New-FreshnessPayload -Path $staleMigPayload
$firstMigration = Get-ChildItem -LiteralPath (Join-Path $staleMigPayload 'server\migrations\system') `
    -Filter '*.sql' -File | Select-Object -First 1
if (-not $firstMigration) { throw 'В репозитории нет миграций system\*.sql для проверки свежести.' }
[System.IO.File]::AppendAllText($firstMigration.FullName, "`r`n-- локальная правка`r`n")
$staleMigBuild = Invoke-PayloadBuild -Payload $staleMigPayload -OutputName 'stale-migrations-out'
Add-StaticResult -Name 'build:stale-migrations-detected' `
    -Ok (($staleMigBuild.Code -ne 0) -and ($staleMigBuild.Output -match 'server\\migrations')) `
    -Note 'изменённый файл migrations — payload устарел'

# D. Свежий payload проверку проходит (нет ложного отказа) и собирается.
$freshPayload = Join-Path $workRoot 'payload-fresh'
New-FreshnessPayload -Path $freshPayload
$freshBuild = Invoke-PayloadBuild -Payload $freshPayload -OutputName 'fresh-out'
Add-StaticResult -Name 'build:fresh-payload-accepted' `
    -Ok (($freshBuild.Code -eq 0) -and ($freshBuild.Output -match 'Payload свежий')) `
    -Note 'свежий payload: весь server/dist, migrations и клиент совпадают'

# E. Версия клиента из манифеста сверяется с client/package.json: подмена
# client_version — отказ. Раньше client_version писался, но не читался, и
# старый клиент после неудачной package:dir проходил как свежий.
$versionPayload = Join-Path $workRoot 'payload-client-version'
New-FreshnessPayload -Path $versionPayload -ClientVersion '0.0.0'
$versionBuild = Invoke-PayloadBuild -Payload $versionPayload -OutputName 'client-version-out'
$repoClientVersion = [string](Get-Content -LiteralPath (Join-Path $repoRoot 'client\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Add-StaticResult -Name 'build:client-version-mismatch' `
    -Ok (($versionBuild.Code -ne 0) -and
         ($versionBuild.Output -match 'клиентом 0\.0\.0') -and
         ($versionBuild.Output -match [regex]::Escape("client $repoClientVersion"))) `
    -Note 'client_version в манифесте разошёлся с client/package.json — сборка не начинается'

# F. Хэши файлов client\ сверяются с манифестом: правка после записи паспорта
# (недокопия/подмена) — отказ.
$clientHashPayload = Join-Path $workRoot 'payload-client-hash'
New-FreshnessPayload -Path $clientHashPayload
[System.IO.File]::AppendAllText((Join-Path $clientHashPayload 'client\resources\app.asar'),
    "`r`n// правка после записи манифеста`r`n")
$clientHashBuild = Invoke-PayloadBuild -Payload $clientHashPayload -OutputName 'client-hash-out'
Add-StaticResult -Name 'build:client-hash-mismatch' `
    -Ok (($clientHashBuild.Code -ne 0) -and
         ($clientHashBuild.Output -match 'client') -and
         ($clientHashBuild.Output -match 'отличаются от манифеста')) `
    -Note 'файл client разошёлся с client.hashes — payload устарел'

# G. Паспорта поставки нет (fetch-payload.ps1 не дошёл до конца) — отказ, а не
# молчаливая сборка со старым клиентом.
$noManifestPayload = Join-Path $workRoot 'payload-no-manifest'
New-FreshnessPayload -Path $noManifestPayload
Remove-Item -LiteralPath (Join-Path $noManifestPayload 'server-manifest.json') -Force
$noManifestBuild = Invoke-PayloadBuild -Payload $noManifestPayload -OutputName 'no-manifest-out'
Add-StaticResult -Name 'build:manifest-required' `
    -Ok (($noManifestBuild.Code -ne 0) -and ($noManifestBuild.Output -match 'server-manifest\.json')) `
    -Note 'без паспорта поставки сборка не начинается'


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

# --- 860def0d: раскладка экранов без окон ------------------------------------
# /TESTLAYOUT=1 строит все экраны тем же кодом, что и мастер, и пишет в журнал
# фактические позиции и высоты контролов. Проверяется то, что видел пользователь:
# подписи не сжаты «дельтой» AdjustHeight, видимые контролы не налезают друг на
# друга, содержимое помещается на поверхность страницы, сводка не заходит на
# полосу оформления; на чистой машине выбраны оба компонента.
Write-Host '=== 860def0d: раскладка экранов (TESTLAYOUT) ==='

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
        if ($line -match '^(?<page>\w+) surface width=(?<w>\d+) height=(?<h>\d+)$') {
            $surfaces[$Matches['page']] = [int]$Matches['h']
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

function Add-LayoutChecks {
    param(
        [string]$Suffix,
        [string]$Note = '',
        [int]$ServerSelected = 1,
        [int]$ClientSelected = 1,
        [int]$NextEnabled = 1,
        [int]$ScopeText = 1
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
    # 0. Кнопка «Далее» и причина её неактивности (ошибка 5b9743da). Пользователь
    #    видел неактивную кнопку без объяснения и принимал это за зависание,
    #    поэтому прогон проверяет не только состояние кнопки, но и то, что у
    #    неактивной кнопки причина есть, она непустая, не сжата и помещается на
    #    страницу, а у активной причины нет.
    $components = @{}
    foreach ($ctl in $layout.Controls['components']) { $components[$ctl.Name] = $ctl }
    $next = @($lines | Where-Object { $_ -like 'next enabled=*' })[0]
    $reasonChars = -1
    if ($next -match 'reason_chars=(?<c>\d+)') { $reasonChars = [int]$Matches['c'] }
    $nextActual = -1
    if ($next -match 'enabled=(?<v>[01])') { $nextActual = [int]$Matches['v'] }
    Add-Result -Name "layout:${Suffix}:next-enabled" -Expected $NextEnabled -Actual $nextActual -Note $next
    $reason = $components['reason']
    if ($NextEnabled -eq 0) {
        $fitsPage = $reason -and $layout.Surfaces.ContainsKey('components') -and
            (($reason.Top + $reason.Height) -le $layout.Surfaces['components'])
        $reasonOk = ($reasonChars -gt 0) -and ($null -ne $reason) -and $reason.Visible -and
            ($reason.Chars -gt 0) -and ($reason.Chars -eq $reasonChars) -and
            ($reason.Height -ge 15) -and $fitsPage
        Add-Result -Name "layout:${Suffix}:reason-visible" -Expected 1 -Actual ([int]$reasonOk) `
            -Note ('причина неактивной «Далее» на экране и в границах страницы: chars=' + $reasonChars)
    }
    else {
        $reasonOk = ($reasonChars -eq 0) -and (($null -eq $reason) -or ($reason.Chars -eq 0))
        Add-Result -Name "layout:${Suffix}:reason-empty" -Expected 1 -Actual ([int]$reasonOk) `
            -Note ('активная «Далее» причины не показывает: chars=' + $reasonChars)
    }
    # 1. Подпись с непустым текстом не сжата: высота не меньше строки. Высота 0
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
    # 2. Видимые контролы с текстом не налезают друг на друга.
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
    # 3. Содержимое не выходит за поверхность страницы.
    $overflows = @()
    foreach ($page in $layout.Controls.Keys) {
        if (-not $layout.Surfaces.ContainsKey($page)) { continue }
        $bottom = 0
        foreach ($ctl in @($layout.Controls[$page] | Where-Object { $_.Visible -and $_.Height -gt 0 })) {
            if (($ctl.Top + $ctl.Height) -gt $bottom) { $bottom = $ctl.Top + $ctl.Height }
        }
        if ($bottom -gt $layout.Surfaces[$page]) {
            $overflows += "$page bottom=$bottom > $($layout.Surfaces[$page])"
        }
    }
    Add-Result -Name "layout:${Suffix}:content-fits" -Expected 1 -Actual ([int]($overflows.Count -eq 0)) `
        -Note ($overflows -join ', ')
    # 4. Описания компонентов и области клиента действительно на экране. В
    #    режиме обновления область выводится фиксированным текстом (scopeFixed),
    #    отдельного пояснения режима нет — это не пропажа, а дедупликация
    #    (ошибка 5b9743da). В тесном состоянии (5b9743da: «только для меня» +
    #    старый клиент) пояснение режима уступает место причине неактивности
    #    «Далее» — там оно дублирует подсказку сервера, поэтому ScopeText=0.
    $scopeShown = (($components.ContainsKey('scopeFixed')) -and $components['scopeFixed'].Visible -and
        ($components['scopeFixed'].Height -ge 15)) -or
        (($components.ContainsKey('scopeHint')) -and $components['scopeHint'].Visible -and
        ($components['scopeHint'].Height -ge 15))
    $descriptions = $components.ContainsKey('serverHint') -and $components['serverHint'].Visible -and
        ($components['serverHint'].Height -ge 15) -and
        $components.ContainsKey('clientHint') -and $components['clientHint'].Visible -and
        ($components['clientHint'].Height -ge 15) -and
        (($ScopeText -eq 0) -or $scopeShown)
    Add-Result -Name "layout:${Suffix}:descriptions" -Expected 1 -Actual ([int]$descriptions) `
        -Note ('сервер, клиент и (если нужен) текст области клиента — видимые подписи с переносом; scope=' + $ScopeText)
    # 5. Сводка и кнопки итогового экрана: от левого края FinishedLabel.
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
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1'))
Add-Result -Name 'layout:exit' -Expected 0 -Actual $code -Note 'снимок раскладки без установки'
# На чистой машине выбраны оба компонента, но «Далее» неактивна до принятия
# лицензии MIT — причина при этом обязана быть на экране (5b9743da).
Add-LayoutChecks -Suffix 'clean' -NextEnabled 0

# Длинное состояние клиента (найден старый NSIS-клиент) — проверка на реальном
# сообщении, которое раньше выходило за край и обрезалось. Лицензия не принята,
# поэтому «Далее» неактивна по той же причине.
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTLEGACY=machine:0.14.1'))
Add-Result -Name 'layout:legacy-exit' -Expected 0 -Actual $code -Note 'снимок с найденным старым клиентом'
Add-LayoutChecks -Suffix 'legacy' -NextEnabled 0

# Точное состояние из ошибки 5b9743da (машина пользователя): запуск «только для
# меня», найден старый NSIS-клиент 0.14.1 «для всех», лицензия ещё не принята.
# Здесь причина неактивности «Далее» уезжала за нижний край (на снимке HEAD:
# top=337 при поверхности 309 — не видна), а в журнале не было ни строки о
# кнопке: неактивная «Далее» выглядела зависшей. После исправления причина на
# экране, «Далее» в журнале, а лишняя подсказка режима уступает место.
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTUSERONLYMODE=1',
    '/TESTLEGACY=machine:0.14.1'))
Add-Result -Name 'layout:user-legacy-exit' -Expected 0 -Actual $code `
    -Note 'снимок: «только для меня» + старый клиент 0.14.1 (состояние из ошибки)'
Add-LayoutChecks -Suffix 'user-legacy' -ServerSelected 0 -ClientSelected 1 -NextEnabled 0 -ScopeText 0

# Ошибка 5b9743da: повторный запуск в режиме «только для меня» поверх уже
# установленного клиента — это сценарий «Переустановить клиент ETN». «Далее»
# обязана быть активной и не показывать причины, а содержимое — помещаться на
# страницу (текст области клиента и подсказка режима не дублируются).
Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), '')
$code = Invoke-Setup -Arguments ($silent + @('/TESTLAYOUT=1', '/TESTUSERONLYMODE=1'))
Add-Result -Name 'layout:client-user-exit' -Expected 0 -Actual $code `
    -Note 'снимок: клиент «только для меня» уже установлен'
Add-LayoutChecks -Suffix 'client-user' -ServerSelected 0 -ClientSelected 1 -NextEnabled 1

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
Add-LayoutChecks -Suffix 'client-machine' -ServerSelected 0 -ClientSelected 0 -NextEnabled 0


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
# /SERVERONLY не ставит клиент: ни машинной, ни пользовательской раскладки.
$serverOnlyClient = (Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe')) -or
    (Test-Path -LiteralPath (Join-Path $appDir 'ETN.exe'))
Add-Result -Name 'success:no-client' -Expected 0 -Actual ([int]$serverOnlyClient) `
    -Note '/SERVERONLY: файлы клиента не устанавливаются'
$serverOnlyShortcuts = (Test-Path -LiteralPath (Join-Path $workRoot 'shortcuts\desktop\ETN.lnk')) -or
    (Test-Path -LiteralPath (Join-Path $workRoot 'shortcuts\menu\ETN.lnk'))
Add-Result -Name 'success:no-client-shortcuts' -Expected 0 -Actual ([int]$serverOnlyShortcuts) `
    -Note '/SERVERONLY: ярлыки клиента не создаются'

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
    'default_server=0', 'default_client=1',
    'scope_fixed=1', 'machine_copy=1', 'user_copy=0') -Note 'обновление: область клиента фиксирована'

# B4: повышение прав нужно серверу и клиенту «для всех», но не клиенту «для меня».
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTSELECT=server')
Add-StateResult -Name 'need-elevation:server' -Line $probe.State -Pairs @('need_elevation=1')
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTSELECT=client-machine')
Add-StateResult -Name 'need-elevation:client-machine' -Line $probe.State -Pairs @(
    'need_elevation=1', 'scope_fixed=0') -Note 'первая установка: клиент «для всех»'
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTSELECT=client-user')
Add-StateResult -Name 'need-elevation:client-user' -Line $probe.State -Pairs @('need_elevation=0')

# 2dd215f7: в административном режиме «клиент для меня» запрещён — под
# Administrator Protection элевированный процесс работает в отдельном профиле
# SMAA. Выбор принудительно machine.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTADMINMODE=1', '/TESTSELECT=client-user')
Add-StateResult -Name 'admin-mode:client-scope' -Line $probe.State -Pairs @(
    'client_scope=machine', 'scope_fixed=0') `
    -Note 'admin-режим: клиент только для всех (SMAA-профиль не трогаем)'

# 2dd215f7: элевация штатная — режим выбирает диалог Inno до мастера, права
# запрашивает Windows один раз на старте. Неадминистративный режим («только для
# меня») моделируется /TESTUSERONLYMODE=1: сервер недоступен (службе нужны
# права администратора), клиент ставится в профиль пользователя, радиокнопки
# области скрыты, повышение прав не нужно.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTUSERONLYMODE=1')
Add-StateResult -Name 'user-only-mode:defaults' -Line $probe.State -Pairs @(
    'default_server=0', 'default_client=1', 'client_scope=user',
    'need_elevation=0') `
    -Note 'режим «только для меня»: клиент в профиль, сервер не предлагается'

# Защита от программного выбора: /TESTSELECT идёт через ту же ApplySelection,
# что и обработчики экрана; сервер здесь не выбирается, область — только user.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTUSERONLYMODE=1', '/TESTSELECT=server')
Add-StateResult -Name 'user-only-mode:server-guard' -Line $probe.State -Pairs @(
    'default_server=0', 'default_client=0', 'need_elevation=0') `
    -Note 'сервер в режиме «только для меня» не выбирается даже программно'
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTUSERONLYMODE=1', '/TESTSELECT=client-machine')
Add-StateResult -Name 'user-only-mode:scope-guard' -Line $probe.State -Pairs @(
    'default_client=1', 'client_scope=user', 'need_elevation=0') `
    -Note 'область клиента принудительно user: клиент «для всех» требует прав'

# Административный режим — это запуск от имени администратора (в тихом
# автообновлении — /ALLUSERS из LocalSystem). На чистой машине предлагаются
# сервер и клиент «для всех», область фиксирована machine.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTADMINMODE=1')
Add-StateResult -Name 'admin-mode:defaults' -Line $probe.State -Pairs @(
    'default_server=1', 'default_client=1', 'client_scope=machine',
    'need_elevation=1') `
    -Note 'административный режим: сервер и клиент «для всех» по умолчанию'

# Матрица режимов (ошибка aa5af30c): режим определяется фактическими правами
# процесса, а не диалогом Inno. user-mode — обычный запуск: сервер выключен,
# причина дословно «запустите от имени администратора»; admin-mode — запуск от
# имени администратора (или /ALLUSERS из LocalSystem): сервер доступен,
# причины нет. Строка причины — та же, что на экране компонентов.
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTUSERONLYMODE=1')
Add-StateResult -Name 'mode-matrix:user' -Line $probe.State -Pairs @(
    'server_enabled=0', 'need_elevation=0') `
    -Note 'обычный запуск: сервер недоступен, прав не требует'
Add-Result -Name 'mode-matrix:user-reason' -Expected 1 `
    -Actual ([int]($probe.Notice -eq $serverReason)) -Note ("" + $probe.Notice)
Reset-State
$probe = Invoke-StateProbe -ExtraArgs @('/TESTADMINMODE=1')
Add-StateResult -Name 'mode-matrix:admin' -Line $probe.State -Pairs @(
    'server_enabled=1', 'need_elevation=1') `
    -Note 'запуск от администратора: сервер доступен'
Add-Result -Name 'mode-matrix:admin-no-reason' -Expected 1 `
    -Actual ([int](-not $probe.Notice)) -Note ("" + $probe.Notice)

# Замечание верификатора п.1: копия клиента «только для меня» видна и в
# административном режиме (иначе /ALLUSERS поверх user-установки молча ставил
# вторую копию с сообщением «клиент не установлен»). В тестовой сборке
# {#ClientUserDir} = каталог программы, поэтому пользовательская копия —
# ETN.exe в корне appDir.
Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), 'stub')
$probe = Invoke-StateProbe -ExtraArgs @('/TESTADMINMODE=1')
Add-StateResult -Name 'admin-mode:user-copy-visible' -Line $probe.State -Pairs @(
    'client_state=installed', 'user_copy=1', 'machine_copy=0',
    'default_client=1', 'client_scope=machine', 'scope_fixed=1') `
    -Note 'admin-режим видит копию «только для меня» и рядом ставит «для всех»'

# Машинная копия (appDir\client\ETN.exe) не считается пользовательской:
# machine_copy=1, user_copy=0 — мастер не путает области.
Reset-State
New-Item -ItemType Directory -Path (Join-Path $appDir 'client') -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'client\ETN.exe'), 'stub')
$probe = Invoke-StateProbe -ExtraArgs @('/TESTADMINMODE=1')
Add-StateResult -Name 'admin-mode:machine-copy-visible' -Line $probe.State -Pairs @(
    'client_state=installed', 'user_copy=0', 'machine_copy=1') `
    -Note 'машинная копия не считается пользовательской'

# Копия «только для меня» в user-режиме: клиент обновляется в профиле,
# сервер по-прежнему недоступен.
Reset-State
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $appDir 'ETN.exe'), 'stub')
$probe = Invoke-StateProbe -ExtraArgs @('/TESTUSERONLYMODE=1')
Add-StateResult -Name 'user-only-mode:user-copy' -Line $probe.State -Pairs @(
    'client_state=installed', 'user_copy=1', 'machine_copy=0',
    'default_client=1', 'client_scope=user', 'scope_fixed=1') `
    -Note 'режим «только для меня»: найденная копия обновляется в профиле'

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
        "/TESTPORT=$busyPort", '/TESTNOSERVICE=1', "/TESTRESULT=`"$precheckResult`""))
} finally {
    $busyListener.Stop()
}
Add-Result -Name 'precheck:port-busy-code' -Expected 20 -Actual $code
$busyReason = Get-PrecheckResult
$busyReasonOk = $busyReason -match ('порт ' + $busyPort + ' занят другим приложением')
Add-Result -Name 'precheck:port-busy-reason' -Expected 1 -Actual ([int]$busyReasonOk) -Note $busyReason
$busyLog = Get-LogLine -Pattern 'TESTPRECHECK result=([^\r\n]+)'
Add-Result -Name 'precheck:port-busy-log' -Expected 1 -Actual ([int]([bool]$busyLog)) -Note $busyLog

# Свободный порт после занятого: fail-closed проба (эксклюзивный bind без
# listen()) не должна давать ложного «занят» — код 0, причина пуста (1dddac77).
Reset-State
Reset-PrecheckResult
$freeAfterBusyPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
    "/TESTPORT=$freeAfterBusyPort", '/TESTNOSERVICE=1', "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:port-free-code' -Expected 0 -Actual $code
Add-Result -Name 'precheck:port-free-reason' -Expected 1 `
    -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'причина пуста'

# 1dddac77: TCP-таблица сломана (хук /TESTLISTENERTABLEOFF), службы ETN нет
# (/TESTNOSERVICE) — fail-closed не ослабляется: занятый порт остаётся занятым,
# свободный — свободным.
Reset-State
$tableOffListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 0)
$tableOffListener.Start()
$tableOffPort = ([System.Net.IPEndPoint]$tableOffListener.LocalEndpoint).Port
try {
    Reset-PrecheckResult
    $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
        "/TESTPORT=$tableOffPort", '/TESTLISTENERTABLEOFF=1', '/TESTNOSERVICE=1',
        "/TESTRESULT=`"$precheckResult`""))
} finally {
    $tableOffListener.Stop()
}
Add-Result -Name 'precheck:port-tableoff-busy-code' -Expected 20 -Actual $code
$tableOffReason = Get-PrecheckResult
$tableOffReasonOk = $tableOffReason -match ('порт ' + $tableOffPort + ' занят другим приложением')
Add-Result -Name 'precheck:port-tableoff-busy-reason' -Expected 1 `
    -Actual ([int]$tableOffReasonOk) -Note $tableOffReason
Reset-State
Reset-PrecheckResult
$tableOffFreePort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
    "/TESTPORT=$tableOffFreePort", '/TESTLISTENERTABLEOFF=1', '/TESTNOSERVICE=1',
    "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:port-tableoff-free-code' -Expected 0 -Actual $code
Add-Result -Name 'precheck:port-tableoff-free-reason' -Expected 1 `
    -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'причина пуста'

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
        "/TESTPORT=$loopPort", '/TESTNOSERVICE=1', "/TESTRESULT=`"$precheckResult`""))
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
        "/TESTPORT=$addrPort", '/TESTNOSERVICE=1', "/TESTRESULT=`"$precheckResult`""))
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
# Доступность перечисления слушателей доказывается собственной пробой
# (Test-ListenerTableWorks): на нормальной Windows таблица показывает свежий
# loopback-слушатель с нашим PID, на аномальной (1dddac77) — нет, и тогда
# владельца сокета установщик доказать не может.
$tableWorks = Test-ListenerTableWorks
$listenerAlive = $false
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
        if ($childPid -gt 0) {
            $listenerAlive = Test-TcpReady -Port $listenerPort -TimeoutMs 300
        }
        $ownerOk = $tableWorks -and ($ownerPid -eq $childPid)
        $aliveOk = (-not $tableWorks) -and $listenerAlive
        if (($childPid -gt 0) -and ($ownerOk -or $aliveOk)) { break }
        Start-Sleep -Milliseconds 200
    }
    # На аномальной сборке Windows перечисление слушателей не работает
    # (1dddac77): владельца сокета не узнать. Готовность подтверждается
    # подключением к слушателю; порт своей запущенной службы установщик
    # считает своим и без таблицы (см. ownsvc:* ниже).
    $ready = ($childPid -gt 0) -and
        (($tableWorks -and ($ownerPid -eq $childPid)) -or ((-not $tableWorks) -and $listenerAlive))
    $readyNote = "слушатель pid=$ownerPid, обёртка pid=" + $wrapper.Id
    if (-not $tableWorks) { $readyNote += ' (перечисление слушателей недоступно: готовность по connect)' }
    Add-Result -Name 'ownsvc:listener-ready' -Expected 1 -Actual ([int]$ready) -Note $readyNote

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

        # PID самой службы = PID процесса-слушателя — своим, в том числе на ОС
        # со сломанной TCP-таблицей (build 28000): служба зарегистрирована и
        # запущена, порт считается своим — её остановит ssInstall, а
        # работоспособность проверит health-check. До фикса здесь был
        # fail-closed 20, и обновление поверх живой службы не проходило.
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$listenerPort", "/TESTOWNSERVICEPID=$childPid",
            "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'ownsvc:self-pid-code' -Expected 0 -Actual $code `
            -Note 'слушатель своего PID — свободен для ETN'
        Add-Result -Name 'ownsvc:self-pid-reason-empty' -Expected 1 `
            -Actual ([int]((Get-PrecheckResult) -eq '')) `
            -Note 'слушатель своего PID — порт свой, причина пуста'

        # Таблица сломана (хук /TESTLISTENERTABLEOFF): та же ветка на любой ОС.
        # Порт занят слушателем, bind упал бы (10048) — установщик обязан
        # вернуть 0 по признаку запущенной службы, иначе обновление не пройдёт.
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$listenerPort", "/TESTOWNSERVICEPID=$childPid",
            '/TESTLISTENERTABLEOFF=1', "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'ownsvc:tableoff-own-service-code' -Expected 0 -Actual $code `
            -Note 'таблица сломана + своя служба запущена — порт свой (0)'
        Add-Result -Name 'ownsvc:tableoff-own-service-reason-empty' -Expected 1 `
            -Actual ([int]((Get-PrecheckResult) -eq '')) -Note 'причина пуста'

        # PID службы = PID обёртки (родителя): потомок WinSW — своим.
        Reset-State
        Reset-PrecheckResult
        $code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1',
            "/TESTPORT=$listenerPort", "/TESTOWNSERVICEPID=$($wrapper.Id)",
            "/TESTRESULT=`"$precheckResult`""))
        Add-Result -Name 'ownsvc:descendant-pid-code' -Expected 0 -Actual $code `
            -Note 'слушатель-потомок WinSW — свободен для ETN'
        Add-Result -Name 'ownsvc:descendant-pid-reason-empty' -Expected 1 `
            -Actual ([int]((Get-PrecheckResult) -eq '')) `
            -Note 'слушатель-потомок WinSW — порт свой, причина пуста'
    } else {
        Add-Result -Name 'ownsvc:foreign-listener-busy' -Expected 1 -Actual 0 -Note 'дерево процессов не поднялось'
        Add-Result -Name 'ownsvc:self-pid-code' -Expected 1 -Actual 0 -Note 'дерево процессов не поднялось'
        Add-Result -Name 'ownsvc:tableoff-own-service-code' -Expected 1 -Actual 0 -Note 'дерево процессов не поднялось'
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
            "/TESTPORT=$lanPort", '/TESTNOSERVICE=1', "/TESTRESULT=`"$precheckResult`""))
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

# Проверка невозможна: неизвестный отказ пробного bind (хук /TESTPORTBINDFAIL)
# даёт статус 2 — код 20 с понятной причиной, а не «порт свободен» (1dddac77,
# fail-closed). Хук имитирует ошибку, которую нельзя воспроизвести по заказу.
Reset-State
Reset-PrecheckResult
$bindFailPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/TESTPRECHECK=1', "/TESTPORT=$bindFailPort",
    '/TESTPORTBINDFAIL=1', "/TESTRESULT=`"$precheckResult`""))
Add-Result -Name 'precheck:port-bindfail-code' -Expected 20 -Actual $code
$bindFailReason = Get-PrecheckResult
Add-Result -Name 'precheck:port-bindfail-reason' -Expected 1 `
    -Actual ([int]($bindFailReason -match ('не удалось проверить занятость порта ' + $bindFailPort))) `
    -Note $bindFailReason

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
$serviceDeployment = ''
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
        # StrictMode: обращение к .value отсутствующего узла — исключение,
        # поэтому сначала узел, потом значение (отсутствие — красная проверка).
        $deploymentNode = $envNodes | Where-Object { $_.name -eq 'ETN_DEPLOYMENT' } | Select-Object -First 1
        if ($null -ne $deploymentNode) { $serviceDeployment = [string]$deploymentNode.value }
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
# e375123f: сгенерированный конфиг обязан сохранить режим службы — без него
# сервер не отличит службу от обычного процесса.
Add-Result -Name 'server-fw:deployment-env' -Expected 1 `
    -Actual ([int]($serviceDeployment -eq 'windows-service')) `
    -Note ('ETN_DEPLOYMENT=' + (IfStrEmpty $serviceDeployment))
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
# Ярлыки создаются этим же прогоном; проверяются до Reset-State следующего
# сценария, иначе их уже нет.
$desktopLnk = Join-Path $workRoot 'shortcuts\desktop\ETN.lnk'
$menuLnk = Join-Path $workRoot 'shortcuts\menu\ETN.lnk'
Add-Result -Name 'client-machine:shortcut-desktop' -Expected 1 `
    -Actual ([int](Test-Path -LiteralPath $desktopLnk)) -Note 'ярлык на рабочем столе'
Add-Result -Name 'client-machine:shortcut-menu' -Expected 1 `
    -Actual ([int](Test-Path -LiteralPath $menuLnk)) -Note 'ярлык в меню «Пуск»'
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

# --- 98ad5eec: клиент «только для меня» — установка и ярлыки -----------------
# /TESTUSERINSTALL=1 обходит silent-предусловия и ставит только клиента
# (silent-контракт клиент не ставит), /VERYSILENT оставляет запуск без окон:
# проверяется та же ветка [Files]/[Icons], что и в GUI, — неэлевированная фаза
# ставит клиента в {app} (профиль).
Write-Host '=== 98ad5eec: клиент «только для меня» ==='
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTSELECT=client-user', '/TESTUSERINSTALL=1', '/TESTELEVATED=1', '/TESTHEALTH=ok'))
Add-Result -Name 'client-user:code' -Expected 0 -Actual $code
Add-Result -Name 'client-user:exe' -Expected 1 `
    -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'ETN.exe'))) `
    -Note 'клиент «для меня» — в корне {app}'
Add-Result -Name 'client-user:not-machine' -Expected 0 `
    -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe'))) `
    -Note 'в {app}\client машинная копия не появляется'
Add-Result -Name 'client-user:shortcut-desktop' -Expected 1 `
    -Actual ([int](Test-Path -LiteralPath $desktopLnk))
Add-Result -Name 'client-user:shortcut-menu' -Expected 1 `
    -Actual ([int](Test-Path -LiteralPath $menuLnk))

# --- 0f8dd0f3 (п.6 860def0d): предзаполнение подключения клиента -------------
# «Запустить клиент» после установки сервера передаёт имя и адрес локального
# сервера аргументами командной строки. Хук /TESTCONNECTPARAMS печатает ровно
# ту строку параметров, которую получил бы ETN.exe, — клиент не запускается.
Write-Host '=== 0f8dd0f3: connect-параметры кнопки «Запустить клиент» ==='
Reset-State
$connectPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/TESTSELECT=server', "/TESTPORT=$connectPort", '/TESTCONNECTPARAMS=1'))
Add-Result -Name 'connect-params:code' -Expected 0 -Actual $code
$connectLine = Get-LogLine -Pattern 'TESTCONNECTPARAMS ([^\r\n]+)'
$expectedConnect = '--connect-url="http://localhost:' + $connectPort + '" --connect-name="Локальный сервер"'
Add-Result -Name 'connect-params:server' -Expected 1 `
    -Actual ([int]($connectLine -eq $expectedConnect)) `
    -Note "порт установки и имя по умолчанию; получено: $connectLine"
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTSELECT=client-user', '/TESTCONNECTPARAMS=1'))
Add-Result -Name 'connect-params:no-server-code' -Expected 0 -Actual $code
$connectLine = Get-LogLine -Pattern 'TESTCONNECTPARAMS ([^\r\n]+)'
Add-Result -Name 'connect-params:no-server' -Expected 1 `
    -Actual ([int]($connectLine -eq '(none)')) `
    -Note 'сервера нет — клиент запускается без предзаполнения'
# Замечание верификатора: хук проверки не должен попадать в продуктовую сборку.
Add-StaticResult -Name 'static:connect-params-hook-ifdef' `
    -Ok ((Test-IssCode -Text $issText -Pattern ([regex]::Escape("ParamValue('TESTCONNECTPARAMS')"))) -and
        (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape("ParamValue('TESTCONNECTPARAMS')")))) `
    -Note 'хук /TESTCONNECTPARAMS есть только под #ifdef TestMode'

# --- 98ad5eec: закрытие запущенного клиента ----------------------------------
# Модель процессов: /TESTCLIENTPIDS — что «запущено», /TESTCLIENTGONE — через
# сколько мс процесс выходит после мягкого закрытия, /TESTCLIENTFORCE=fail —
# не выходит и после /F, /TESTCLIENTWAIT — бюджет ожидания. Порядок «мягко →
# ожидание → /F» проверяется строками журнала.
Write-Host '=== 98ad5eec: закрытие запущенного клиента ==='
function Get-ClientCloseLog {
    $log = Get-LatestLog
    if (-not $log) { return '' }
    return Get-Content -LiteralPath $log.FullName -Raw
}

Reset-State
$closeParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-close-soft.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$closeParams`"",
    '/TESTELEVATED=1', '/TESTCLIENTPIDS=4242', '/TESTCLIENTGONE=0'))
Add-Result -Name 'client-close:soft-code' -Expected 0 -Actual $code
$softLog = Get-ClientCloseLog
Add-Result -Name 'client-close:soft-wait' `
    -Expected 1 -Actual ([int]($softLog -match 'мягкое закрытие')) `
    -Note 'мягкое закрытие (taskkill без /F)'
Add-Result -Name 'client-close:soft-closed' `
    -Expected 1 -Actual ([int]($softLog -match 'закрыт мягко')) `
    -Note 'процесс вышел после мягкого закрытия'
Add-Result -Name 'client-close:soft-no-force' `
    -Expected 0 -Actual ([int]($softLog -match 'принудительное закрытие')) `
    -Note 'принудительное не применялось — хватило мягкого'
Add-Result -Name 'client-close:soft-files' -Expected 1 `
    -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe'))) `
    -Note 'файлы клиента заменены после закрытия'

Reset-State
$closeParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-close-timeout.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$closeParams`"",
    '/TESTELEVATED=1', '/TESTCLIENTPIDS=4242', '/TESTCLIENTGONE=60000',
    '/TESTCLIENTWAIT=500', '/TESTCLIENTFORCE=ok'))
Add-Result -Name 'client-close:timeout-code' -Expected 0 -Actual $code
$timeoutLog = Get-ClientCloseLog
$forceIdxLog = $timeoutLog.IndexOf('принудительное закрытие')
$softIdxLog = $timeoutLog.IndexOf('мягкое закрытие')
Add-Result -Name 'client-close:timeout-force' `
    -Expected 1 -Actual ([int]($timeoutLog -match 'не закрылся — принудительное закрытие')) `
    -Note 'после таймаута — /F'
Add-Result -Name 'client-close:timeout-order' `
    -Expected 1 -Actual ([int](($softIdxLog -ge 0) -and ($forceIdxLog -gt $softIdxLog))) `
    -Note 'сначала мягкое закрытие, потом принудительное'
Add-Result -Name 'client-close:timeout-closed' `
    -Expected 1 -Actual ([int]($timeoutLog -match 'принудительно закрыт')) `
    -Note 'после /F процесс закрыт, установка продолжена'

Reset-State
$closeReasonFile = Join-Path $workRoot 'client-close-fail.reason'
$closeParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-close-fail.ini' `
    -ReasonFile $closeReasonFile
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$closeParams`"",
    '/TESTELEVATED=1', '/TESTCLIENTPIDS=4242', '/TESTCLIENTGONE=60000',
    '/TESTCLIENTWAIT=500', '/TESTCLIENTFORCE=fail'))
Add-Result -Name 'client-close:fail-code' -Expected 20 -Actual $code `
    -Note 'процесс не закрылся — код 20'
Add-Result -Name 'client-close:fail-not-copied' -Expected 0 `
    -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe'))) `
    -Note 'файлы клиента не заменялись'
Add-Result -Name 'client-close:fail-no-json' -Expected 0 `
    -Actual ([int](Test-Path -LiteralPath (Join-Path $dataDir 'install.json'))) `
    -Note 'запись установки не создавалась'
$closeReason = ''
if (Test-Path -LiteralPath $closeReasonFile) { $closeReason = Get-Content -LiteralPath $closeReasonFile -Raw }
Add-Result -Name 'client-close:fail-reason' -Expected 1 `
    -Actual ([int]($closeReason -match 'клиент ETN не закрыт')) `
    -Note 'причина для родителя записана в reason-файл'

Reset-State
$writeParams = New-ParamsFile -Server 1 -Client 0 -Scope user -Name 'server-no-client-close.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$writeParams`"",
    '/TESTELEVATED=1', '/TESTSERVICE=present', '/TESTHEALTH=ok', '/TESTCLIENTPIDS=4242'))
Add-Result -Name 'client-close:server-only-skip' -Expected 0 -Actual $code `
    -Note 'сервер без клиента: запущенный клиент не трогается'
$serverOnlyLog = Get-ClientCloseLog
Add-Result -Name 'client-close:server-only-no-close' -Expected 0 `
    -Actual ([int]($serverOnlyLog -match 'мягкое закрытие')) `
    -Note 'без выбранного клиента taskkill не вызывается'

# --- 98ad5eec: реальное закрытие ETN.exe (Get-Process + taskkill) ------------
# Модель проверяет порядок, но не сам taskkill. Здесь запускается настоящий
# процесс с именем ETN.exe (копия powershell.exe с невидимой формой; окно вне
# экрана и без кнопки на панели задач) и закрывается мягко. Фильтр
# /TESTCLIENTPATH не даёт задеть клиент пользователя, если он запущен.
$realCloseOk = $true
$psHostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$dummyDir = Join-Path $workRoot 'dummy'
$dummyExe = Join-Path $dummyDir 'ETN.exe'
$dummyForm = Join-Path $dummyDir 'form.ps1'
if (-not (Test-Path -LiteralPath $psHostExe)) {
    $realCloseOk = $false
    Add-StaticResult -Name 'client-close:real-host' -Ok $false -Note "нет $psHostExe"
} else {
    if (Test-Path -LiteralPath $dummyDir) { Remove-Item -LiteralPath $dummyDir -Recurse -Force }
    New-Item -ItemType Directory -Path $dummyDir -Force | Out-Null
    Copy-Item -LiteralPath $psHostExe -Destination $dummyExe -Force
    [System.IO.File]::WriteAllText($dummyForm,
        "Add-Type -AssemblyName System.Windows.Forms`r`n" +
        "`$f = New-Object System.Windows.Forms.Form`r`n" +
        "`$f.ShowInTaskbar = `$false`r`n" +
        "`$f.StartPosition = 'Manual'`r`n" +
        "`$f.Location = New-Object System.Drawing.Point(-10000, -10000)`r`n" +
        "`$f.FormBorderStyle = 'None'`r`n" +
        "`$f.Width = 10`r`n`$f.Height = 10`r`n" +
        "[System.Windows.Forms.Application]::Run(`$f)`r`n")
    Reset-State
    $closeParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-close-real.ini'
    $dummy = Start-Process -FilePath $dummyExe `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dummyForm) -PassThru
    try {
        Start-Sleep -Seconds 2
        Add-Result -Name 'client-close:real-started' -Expected 1 `
            -Actual ([int](-not $dummy.HasExited)) -Note "PID $($dummy.Id)"
        # Мягкое закрытие (taskkill без /F) посылает WM_CLOSE окну процесса.
        # На раннере CI — служба Gitea в сессии 0 без интерактивного рабочего
        # стола: окно у подставного процесса не создаётся (MainWindowHandle =
        # 0), и taskkill отвечает «can only be terminated forcefully». Там
        # проверяем штатный откат — ненулевой код мягкой попытки и
        # принудительное закрытие /F. На машине с рабочим столом ожидание
        # прежнее: мягкое закрытие с кодом 0.
        $hasDesktop = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $dummy.Refresh()
            if ($dummy.HasExited) { break }
            if ($dummy.MainWindowHandle -ne 0) { $hasDesktop = $true; break }
            Start-Sleep -Milliseconds 250
        }
        Write-Host ("client-close: интерактивный рабочий стол={0}" -f [int]$hasDesktop)
        $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$closeParams`"",
            '/TESTELEVATED=1', '/TESTCLIENTREAL=1', "/TESTCLIENTPATH=$dummyDir",
            '/TESTCLIENTWAIT=5000'))
        Add-Result -Name 'client-close:real-code' -Expected 0 -Actual $code
        $null = $dummy.WaitForExit(5000)
        Add-Result -Name 'client-close:real-exited' -Expected 1 `
            -Actual ([int]$dummy.HasExited) -Note 'процесс ETN.exe закрыт (мягко или откатом /F)'
        $realLog = Get-ClientCloseLog
        # Исход зависит от окружения: на интерактивном рабочем столе мягкое
        # закрытие обычно проходит; в сессии без рабочего стола WM_CLOSE не
        # доставляется (MainWindowHandle=0) и штатно срабатывает откат /F.
        # Допустимы оба пути, но журнал обязан показать один из них целиком:
        # либо «закрыт мягко», либо «не закрылся → принудительное → закрыт».
        # (Раньше ветку выбирал MainWindowHandle, и при нулевом handle, но
        # успешном закрытии тест краснел на исправном установщике.)
        $softClosedOk = ($realLog -match 'закрыт мягко')
        $forceFallbackOk = ($realLog -match 'не закрылся — принудительное закрытие \(taskkill /F\)') -and
            ($realLog -match 'принудительно закрыт за')
        if ($softClosedOk) {
            $softOk = $true
            $softNote = 'мягкое закрытие: процесс закрыт (рабочий стол: ' + [int]$hasDesktop + ')'
        } else {
            $softOk = $forceFallbackOk
            $softNote = 'мягкая попытка не прошла, откат /F выполнен (рабочий стол: ' +
                [int]$hasDesktop + ')'
        }
        Add-Result -Name 'client-close:real-soft' -Expected 1 `
            -Actual ([int]$softOk) -Note $softNote
        Add-Result -Name 'client-close:real-files' -Expected 1 `
            -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe')))
    } finally {
        if (-not $dummy.HasExited) { Stop-Process -Id $dummy.Id -Force -ErrorAction SilentlyContinue }
    }
}
if ($realCloseOk) {
    # Два подставных процесса с именем ETN.exe: свой — в каталоге установки
    # теста, чужой — вне его. Закрывается только свой: раньше продуктовый
    # Get-Process брал все ETN.exe машины (замечание приёмки 98ad5eec).
    $foreignDir = Join-Path $workRoot 'dummy-foreign'
    $foreignExe = Join-Path $foreignDir 'ETN.exe'
    $ownExe = ''
    $own = $null
    $foreign = $null
    try {
        if (Test-Path -LiteralPath $foreignDir) { Remove-Item -LiteralPath $foreignDir -Recurse -Force }
        New-Item -ItemType Directory -Path $foreignDir -Force | Out-Null
        Copy-Item -LiteralPath $psHostExe -Destination $foreignExe -Force
        Reset-State
        New-Item -ItemType Directory -Path $appDir -Force | Out-Null
        $ownExe = Join-Path $appDir 'ETN.exe'
        Copy-Item -LiteralPath $psHostExe -Destination $ownExe -Force
        $foreign = Start-Process -FilePath $foreignExe `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dummyForm) -PassThru
        $own = Start-Process -FilePath $ownExe `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dummyForm) -PassThru
        Start-Sleep -Seconds 2
        Add-Result -Name 'client-close:two-started' -Expected 2 `
            -Actual ([int](-not $own.HasExited) + [int](-not $foreign.HasExited)) `
            -Note "свой PID $($own.Id), чужой PID $($foreign.Id)"
        # /TESTCLIENTPATH не задан: фильтр — каталог программы теста ($appDir).
        $twoParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-close-two.ini'
        $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$twoParams`"",
            '/TESTELEVATED=1', '/TESTCLIENTREAL=1', '/TESTCLIENTWAIT=5000'))
        Add-Result -Name 'client-close:two-code' -Expected 0 -Actual $code
        $null = $own.WaitForExit(5000)
        Add-Result -Name 'client-close:own-exited' -Expected 1 -Actual ([int]$own.HasExited) `
            -Note 'свой ETN.exe закрыт'
        Add-Result -Name 'client-close:foreign-alive' -Expected 1 -Actual ([int](-not $foreign.HasExited)) `
            -Note 'чужой ETN.exe вне области установки не тронут'
    } finally {
        if ($null -ne $own -and -not $own.HasExited) { Stop-Process -Id $own.Id -Force -ErrorAction SilentlyContinue }
        if ($null -ne $foreign -and -not $foreign.HasExited) { Stop-Process -Id $foreign.Id -Force -ErrorAction SilentlyContinue }
    }
}
if ($realCloseOk) {
    Add-StaticResult -Name 'client-close:real-available' -Ok $true -Note 'реальная ветка выполнена'
}

# --- 905dec4c: клиент перехватывает закрытие — установщик обязан применить /F -
# Electron перехватывает WM_CLOSE, поэтому мягкое закрытие не завершает клиента;
# в карточке ошибки диалог Inno со списком 4× «ETN» и выбор «Игнорировать» вели к
# сбою копирования d3dcompiler_47.dll. Здесь подставной ETN.exe с окном, которое
# отменяет и WM_CLOSE, и завершение сеанса (Restart Manager): закрыть его можно
# только принудительно. Установка обязана: мягкая попытка → таймаут → /F всех
# процессов клиента → копирование файлов.
if ($realCloseOk) {
    Write-Host '=== 905dec4c: клиент игнорирует мягкое закрытие ==='
    $stubbornDir = Join-Path $workRoot 'dummy-stubborn'
    # Подставной клиент лежит ТАМ ЖЕ, куда установщик копирует файл
    # ($appDir\client\ETN.exe): иначе копирование не столкнулось бы с занятым
    # файлом и тест не доказывал бы закрытие ДО копирования.
    $stubbornExe = Join-Path $appDir 'client\ETN.exe'
    $stubbornCompile = Join-Path $stubbornDir 'stubborn-compile.ps1'
    # Подставной клиент — Windows-приложение БЕЗ консоли: у консольного
    # powershell.exe WM_CLOSE закрывает консоль и процесс завершается, тогда
    # мягкое закрытие выглядело бы успешным. WndProc игнорирует WM_CLOSE и
    # WM_QUERYENDSESSION — как Electron, перехватывающий закрытие; завершить
    # такой процесс можно только /F.
    $stubbornSource = @'
param([string]$Out)
$cs = "using System;`nusing System.Windows.Forms;`npublic class StubbornForm : Form {`n  protected override void WndProc(ref Message m) {`n    if (m.Msg == 0x0010 || m.Msg == 0x0011) { m.Result = IntPtr.Zero; return; }`n    base.WndProc(ref m);`n  }`n  [STAThread] public static void Main() { Application.Run(new StubbornForm()); }`n}"
Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly $Out -OutputType WindowsApplication
'@
    Reset-State
    if (Test-Path -LiteralPath $stubbornDir) { Remove-Item -LiteralPath $stubbornDir -Recurse -Force }
    New-Item -ItemType Directory -Path $stubbornDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $stubbornExe) -Force | Out-Null
    [System.IO.File]::WriteAllText($stubbornCompile, $stubbornSource,
        (New-Object System.Text.UTF8Encoding($false)))
    # Сборка Windows-приложения — Windows PowerShell 5.1: Add-Type в pwsh 7 не
    # поддерживает -OutputType WindowsApplication.
    & $psHostExe -NoProfile -ExecutionPolicy Bypass -File $stubbornCompile -Out $stubbornExe
    Add-Result -Name 'client-close:stubborn-built' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $stubbornExe)) -Note 'подставной ETN.exe собран'
    if (-not (Test-Path -LiteralPath $stubbornExe)) {
        throw 'Не удалось собрать подставной ETN.exe, игнорирующий мягкое закрытие.'
    }
    # Три процесса, как у Electron (main + renderer + GPU): фильтр по каталогу
    # обязан найти все, а принудительное закрытие — завершить все до копирования.
    $stubbornPids = @()
    $stubborn = @()
    try {
        foreach ($n in 1..3) {
            $proc = Start-Process -FilePath $stubbornExe -PassThru
            $stubborn += $proc
            $stubbornPids += $proc.Id
        }
        Start-Sleep -Seconds 2
        $alive = @($stubborn | Where-Object { -not $_.HasExited }).Count
        Add-Result -Name 'client-close:stubborn-started' -Expected 3 -Actual $alive `
            -Note ("PID " + ($stubbornPids -join ','))
        $stubbornParams = New-ParamsFile -Server 0 -Client 1 -Scope machine -Name 'client-close-stubborn.ini'
        $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE', "/PARAMS=`"$stubbornParams`"",
            '/TESTELEVATED=1', '/TESTCLIENTREAL=1', '/TESTCLIENTWAIT=1500'))
        Add-Result -Name 'client-close:stubborn-code' -Expected 0 -Actual $code `
            -Note 'установка продолжилась после принудительного закрытия'
        foreach ($proc in $stubborn) {
            $null = $proc.WaitForExit(5000)
            $proc.Refresh()
        }
        $stillAlive = @($stubborn | Where-Object { -not $_.HasExited }).Count
        Add-Result -Name 'client-close:stubborn-all-exited' -Expected 0 -Actual $stillAlive `
            -Note 'все процессы клиента завершены до копирования'
        $stubbornLog = Get-ClientCloseLog
        Add-Result -Name 'client-close:stubborn-force' -Expected 1 `
            -Actual ([int](($stubbornLog -match 'не закрылся — принудительное закрытие') -and
                ($stubbornLog -match 'принудительно закрыт'))) `
            -Note 'мягкое закрытие не сработало — применено /F (перехват WM_CLOSE)'
        Add-Result -Name 'client-close:stubborn-files' -Expected 1 `
            -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'client\ETN.exe'))) `
            -Note 'файлы клиента заменены (d3dcompiler_47.dll не заблокирован)'
    } finally {
        foreach ($proc in $stubborn) {
            if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        }
    }
}

# ============================================================================
# ce3ab836 / 3acd9c3c: бэкап БД — контракт установщика с CLI сервера.
# ============================================================================
Write-Host '=== ce3ab836 / 3acd9c3c: бэкап БД — инструмент и отчёт ==='

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $script:BackupNode = $nodeCommand.Source }
$backupNodeVersion = ''
if ($script:BackupNode) { $backupNodeVersion = (& $script:BackupNode -v).Trim() }
Add-StaticResult -Name 'backup:node22' -Ok ($backupNodeVersion -match '^v22\.') `
    -Note ('Node для инструмента: ' + $backupNodeVersion)
if (-not $backupNodeVersion.StartsWith('v22.')) {
    throw "Проверки бэкапа требуют Node 22 в PATH (найдено: '$backupNodeVersion')."
}
$backupNodeArg = "/TESTNODEEXE=`"$script:BackupNode`""

# --- A. Успех: инструмент получил --to/--data-dir, архив и отчёт разобраны ---
Reset-State
$null = Initialize-BackupServerFiles
$networkId = '11111111-2222-3333-4444-555555555555'
$systemDb = Join-Path $dataDir '_system.db'
$networkDb = Join-Path $dataDir ('networks\' + $networkId + '\data.db')
$dbFixturesOk = (New-BackupTestDatabase -Path $systemDb -Values @('alpha', 'beta')) -and
    (New-BackupTestDatabase -Path $networkDb -Values @('gamma'))
Add-StaticResult -Name 'backup:fixtures' -Ok $dbFixturesOk `
    -Note 'базы _system.db и networks\<uuid>\data.db'
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
    $archive = $archives[-1]
    $archiveNameOk = $archive.Name -match '^etn-backup-0\.15\.1-\d{8}-\d{6}(-\d+)?\.zip$'
    Add-Result -Name 'backup:archive-name' -Expected 1 -Actual ([int]$archiveNameOk) `
        -Note $archive.Name
    $manifest = Get-FixtureArchiveManifest -Archive $archive.FullName
    $entries = @()
    if ($null -ne $manifest) { $entries = @($manifest.files | ForEach-Object { [string]$_.entry }) }
    Add-Result -Name 'backup:manifest-system' -Expected 1 `
        -Actual ([int]($entries -contains '_system.db'))
    Add-Result -Name 'backup:manifest-network' -Expected 1 `
        -Actual ([int]($entries -contains ('networks/' + $networkId + '/data.db')))
    Add-Result -Name 'backup:manifest-count' -Expected 2 -Actual ([int]$entries.Count) `
        -Note '--data-dir: обе базы найдены инструментом'
} else {
    Add-Result -Name 'backup:archive-name' -Expected 1 -Actual 0 -Note 'архив не создан'
    Add-Result -Name 'backup:manifest-count' -Expected 2 -Actual 0 -Note 'архив не создан'
}
Add-Result -Name 'backup:log-created' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Бэкап БД: архив создан: [^\r\n]*etn-backup-[^\r\n]* \(баз: 2, байт: \d+\)')) `
    -Note 'журнал: путь архива, число баз и байт из отчёта'
Add-Result -Name 'backup:report-archive' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'TESTBACKUP result=ok needed=1 archive=[^\r\n]*etn-backup-[^\r\n]*\.zip')) `
    -Note 'GLastBackupDir заполнен путём из отчёта'
Add-Result -Name 'backup:foreign-file' -Expected 1 -Actual ([int](Test-Path -LiteralPath $foreignFile))
Add-Result -Name 'backup:foreign-dir' -Expected 1 -Actual ([int](Test-Path -LiteralPath $foreignDirFile))

# --- B. Отказ инструмента: код 10, архива нет, причина в журнале ------------
Reset-State
$null = Initialize-BackupServerFiles
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
Set-DatabaseToolMode -Mode 'fail-backup'
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:fail-code' -Expected 10 -Actual $code `
    -Note 'ненулевой код инструмента — код 10'
Add-Result -Name 'backup:fail-no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'backup:fail-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Бэкап БД: fixture backup failure \(код 1\)')) `
    -Note 'причина из отчёта — в журнал'

# --- C. Инструмент упал без отчёта: причина всё равно известна --------------
Reset-State
$null = Initialize-BackupServerFiles
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
Set-DatabaseToolMode -Mode 'no-report'
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:no-report-code' -Expected 10 -Actual $code
Add-Result -Name 'backup:no-report-no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'backup:no-report-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Бэкап БД: код 1 \(код 1\)')) `
    -Note 'без отчёта причина — код возврата'

# --- D. Нет node.exe поставки: инструмент не запускается --------------------
Reset-State
$null = Initialize-BackupServerFiles
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1'))
Add-Result -Name 'backup:no-node-code' -Expected 10 -Actual $code
Add-Result -Name 'backup:no-node-no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'backup:no-node-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'нет node.exe поставки')) `
    -Note 'путь node.exe — {app}\node\node.exe'

# --- E. Ремонт той же версии: Needed=False, бэкапа нет ----------------------
Reset-State
$null = Initialize-BackupServerFiles
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$repairForeign = Join-Path $dataDir 'backups\manual\keep.txt'
New-Item -ItemType Directory -Path (Split-Path -Parent $repairForeign) -Force | Out-Null
[System.IO.File]::WriteAllText($repairForeign, 'foreign')
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=skip', $backupNodeArg))
Add-Result -Name 'backup:repair-code' -Expected 0 -Actual $code
Add-Result -Name 'backup:repair-no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'backup:repair-foreign-kept' -Expected 1 -Actual ([int](Test-Path -LiteralPath $repairForeign))
Add-Result -Name 'backup:repair-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'ремонт'))

# --- F. Предупреждения инструмента: успех, но предупреждение в журнале ------
Reset-State
$null = Initialize-BackupServerFiles
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
Set-DatabaseToolMode -Mode 'warn'
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:warn-code' -Expected 0 -Actual $code
Add-Result -Name 'backup:warn-archive' -Expected 1 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'backup:warn-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Бэкап БД: предупреждения: fixture warning')) `
    -Note 'warnings из отчёта — в журнал, обновление продолжается'

# --- G. Баз данных нет: архив не создаётся, обновление продолжается ---------
Reset-State
$null = Initialize-BackupServerFiles
$code = Invoke-Setup -Arguments ($silent + @('/TESTBACKUP=1', $backupNodeArg))
Add-Result -Name 'backup:no-databases-code' -Expected 0 -Actual $code
Add-Result -Name 'backup:no-databases-no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'backup:no-databases-log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'нет баз данных'))

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
        (-not (Test-IssCode -Text $ssPostInstallBody -Pattern ([regex]::Escape('StopServiceForUpdate')))) -and
        (-not (Test-IssCode -Text $ssPostInstallBody -Pattern ([regex]::Escape('PrepareServerUpdate'))))) `
    -Note 'в ssPostInstall нет ни остановки службы, ни фаз обновления (они в ssInstall)'
Add-StaticResult -Name 'static:install-json-after-health' `
    -Ok (($stepBody.IndexOf('ProbeHealth(True)') -ge 0) -and
        ($stepBody.IndexOf('ProbeHealth(True)') -lt $stepBody.IndexOf('WriteInstallJson'))) `
    -Note 'install.json пишется только после health-check'
Add-StaticResult -Name 'static:cleanup-after-success' `
    -Ok ([bool]($stepBody -match '(?s)if \(GExitCode = EXIT_OK\) and GDoPrivilegedWork then\s*\r?\n\s*CleanupRollbackSnapshot;')) `
    -Note 'снимок отката удаляется только при успехе'
Add-StaticResult -Name 'static:cleanup-after-install-json' `
    -Ok (($stepBody.IndexOf('WriteInstallJson') -ge 0) -and
        ($stepBody.IndexOf('WriteInstallJson') -lt $stepBody.IndexOf('CleanupRollbackSnapshot'))) `
    -Note 'сначала install.json, затем удаление снимка отката (замечание приёмки)'
$stopBody = Get-IssFunctionBody -Text $issText -Name 'StopServiceForUpdate'
$waitBody = Get-IssFunctionBody -Text $issText -Name 'WaitServiceStopped'
Add-StaticResult -Name 'static:wait-service-stopped' `
    -Ok ((Test-IssCode -Text $stopBody -Pattern ([regex]::Escape("RunServiceCommand('stop')"))) -and
        (Test-IssCode -Text $waitBody -Pattern ([regex]::Escape('ServiceStatusOutput'))) -and
        (Test-IssCode -Text $waitBody -Pattern ([regex]::Escape('ServiceNowSeconds'))) -and
        (-not (Test-IssCode -Text $waitBody -Pattern ([regex]::Escape('Waited := Waited +')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('sc query')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('ServiceStateOutput')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('ServiceStoppedNow')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('START_PENDING')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('STOP_PENDING'))))) `
    -Note 'stop → WaitServiceStopped по etn-service.exe status; sc query/_PENDING удалены; бюджет по часам'
$healthBody = Get-IssFunctionBody -Text $issText -Name 'CheckHealthOnce'
$healthParts = (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape('/api/v1/health'))) -and
    (-not (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape('/api/v1/version')))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape("if Status <> 'ok'"))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape("if Db <> 'ok'"))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape("JsonGetRaw(Body, 'db')"))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape("JsonGetRaw(Body, 'version')"))) -and
    (Test-IssCode -Text $healthBody -Pattern ([regex]::Escape('GProductVersion')))
Add-StaticResult -Name 'static:health-parses-body' -Ok $healthParts `
    -Note 'один GET /health: status/db/version разбираются и сравниваются; /api/v1/version не вызывается'
$probeHealthBody = Get-IssFunctionBody -Text $issText -Name 'ProbeHealth'
$probeBudget = (Test-IssCode -Text $probeHealthBody -Pattern ([regex]::Escape('ServiceNowSeconds'))) -and
    (-not (Test-IssCode -Text $probeHealthBody -Pattern ([regex]::Escape('Elapsed := Elapsed +')))) -and
    (Test-IssCode -Text $probeHealthBody -Pattern ([regex]::Escape('RemainingMs'))) -and
    (-not (Test-IssCode -Text $probeHealthBody -Pattern ([regex]::Escape('Sleep(HealthStepMs)'))))
Add-StaticResult -Name 'static:health-actual-budget' -Ok $probeBudget `
    -Note 'бюджет ProbeHealth по ServiceNowSeconds; Sleep не уходит за остаток'
$rollbackBody = Get-IssFunctionBody -Text $issText -Name 'RollbackAfterFailure'
$rollbackHealthReason = (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('Прежняя версия не отвечает'))) -and
    (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('GHealthReason'))) -and
    (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('ServiceStartManually')))
Add-StaticResult -Name 'static:rollback-health-reason' -Ok $rollbackHealthReason `
    -Note 'неудача health прежней версии дописывается в GFailureReason, а не только WARN'
Add-StaticResult -Name 'static:rollback-messages' `
    -Ok ((Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('Откат выполнен'))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('Откат не выполнен'))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('архив: ')))) `
    -Note 'журнал: «Откат выполнен» / «Откат не выполнен, архив: …»'
$rollbackRootBody = Get-IssFunctionBody -Text $issText -Name 'RollbackRoot'
Add-StaticResult -Name 'static:rollback-dir' `
    -Ok (Test-IssCode -Text $rollbackRootBody -Pattern ([regex]::Escape('\.install\rollback'))) `
    -Note 'снимок отката в %ProgramData%\ETN\.install\rollback'
$restoreBody = Get-IssFunctionBody -Text $issText -Name 'RestoreDatabaseFromArchive'
Add-StaticResult -Name 'static:rollback-db-tool' `
    -Ok ((Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('RunDatabaseTool'))) -and
        (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('restore --from'))) -and
        (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('ApplyDatabaseToolReport')))) `
    -Note 'восстановление БД — restore инструмента, не Pascal (WAL/SHM — в CLI)'
# Блокер 1 приёмки: откат восстанавливает БД только из архива ЭТОГО запуска.
# LatestBackupDir (самый свежий архив прошлых обновлений) в откате недопустим:
# он не отражает состояние базы на момент остановки службы.
Add-StaticResult -Name 'static:rollback-own-archive' `
    -Ok ((-not (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('LatestBackupDir')))) -and
        (-not (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('LatestBackupDir')))) -and
        (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape('GLastBackupDir')))) `
    -Note 'откат БД — только GLastBackupDir; LatestBackupDir — только экран'
# Блокер 2 приёмки: файлы возвращаются точным составом снимка — каталоги
# server и service подменяются целиком, лишние файлы новой версии исчезают.
$restoreFilesBody = Get-IssFunctionBody -Text $issText -Name 'RestoreInstallFiles'
$replaceTreeBody = Get-IssFunctionBody -Text $issText -Name 'ReplaceTreeFromSnapshot'
Add-StaticResult -Name 'static:rollback-exact-files' `
    -Ok ((Test-IssCode -Text $restoreFilesBody -Pattern ([regex]::Escape('ReplaceTreeFromSnapshot'))) -and
        (Test-IssCode -Text $restoreFilesBody -Pattern ([regex]::Escape("GServerDir + '\server'"))) -and
        (Test-IssCode -Text $restoreFilesBody -Pattern ([regex]::Escape("GServerDir + '\service'"))) -and
        (Test-IssCode -Text $replaceTreeBody -Pattern ([regex]::Escape('DelTree')))) `
    -Note 'server и service подменяются целиком: состав файлов = снимок'
# Замечание приёмки: хранится только снимок текущего запуска, после успеха —
# ни одного.
$snapshotBody = Get-IssFunctionBody -Text $issText -Name 'CreateRollbackSnapshot'
$cleanupBody = Get-IssFunctionBody -Text $issText -Name 'CleanupRollbackSnapshot'
Add-StaticResult -Name 'static:rollback-snapshot-rotation' `
    -Ok ((Test-IssCode -Text $snapshotBody -Pattern ([regex]::Escape('CleanupRollbackSnapshotsExcept(GLastRollbackDir)'))) -and
        (Test-IssCode -Text $cleanupBody -Pattern ([regex]::Escape("CleanupRollbackSnapshotsExcept(Keep)")))) `
    -Note 'старые снимки отката удаляются; после успеха — все'
# Блокер 3 приёмки: причина сбоя и итог отката — в GUI и в reason-файле.
# Дочерней фазы больше нет (2dd215f7), причина — GFailureReason установщика;
# reason-файл пишется после откатa, иначе перезапись скрыла бы его причину.
Add-StaticResult -Name 'static:failure-reason-gui' `
    -Ok ((Test-IssCode -Text $ssPostInstallBody -Pattern ([regex]::Escape('WriteReasonFile(GFailureReason)'))) -and
        ($ssPostInstallBody.IndexOf('RollbackAfterFailure') -lt
         $ssPostInstallBody.IndexOf('WriteReasonFile(GFailureReason)'))) `
    -Note 'код 10: reason-файл перезаписан после откатa, причина — GFailureReason'
# Замечание приёмки: прямое указание потери данных при откате (ed2e42df).
Add-StaticResult -Name 'static:rollback-data-loss-text' `
    -Ok ((Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('потеряны'))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('восстановить невозможно')))) `
    -Note 'сообщение отката прямо называет потерю записей после остановки службы'
# Замечание приёмки: сообщение о неудачном бэкапе содержит причину, объём и журнал.
Add-StaticResult -Name 'static:backup-failure-details' `
    -Ok ((Test-IssCode -Text $orderBody -Pattern ([regex]::Escape('GBackupReason'))) -and
        (Test-IssCode -Text $orderBody -Pattern ([regex]::Escape('DatabaseBackupSizeBytes'))) -and
        (Test-IssCode -Text $orderBody -Pattern ([regex]::Escape('журнал: ')))) `
    -Note 'причина + требуемый объём + путь к журналу (bc7cc846)'
# Замечание приёмки: экран не выдаёт старый архив за резервную копию отката.
$errorMemoBody = Get-IssFunctionBody -Text $issText -Name 'ErrorMemoText'
$summaryBody = Get-IssFunctionBody -Text $issText -Name 'SummaryText'
Add-StaticResult -Name 'static:error-memo-own-archive' `
    -Ok ((Test-IssCode -Text $errorMemoBody -Pattern ([regex]::Escape('BackupPathForMessage'))) -and
        (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('BackupPathForMessage')))) `
    -Note 'старый архив помечается «не для отката», а не выдаётся за резервную копию'
# Замечание приёмки: в режиме app health-check не выполняется — иначе
# обновление уходило бы в откат (сервер не запущен).
Add-StaticResult -Name 'static:app-no-health' `
    -Ok ((Test-IssCode -Text $ssPostInstallBody -Pattern ([regex]::Escape('HealthCheckApplicable'))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('HealthCheckApplicable')))) `
    -Note 'режим app: health-check пропускается (и после отката тоже)'
# Замечание приёмки: все хуки обновления — только под #ifdef TestMode, а не
# два из десяти. Проверяется разбор каждого параметра.
$hookNames = @(
    'TESTSERVICE', 'TESTSERVICECMD', 'TESTSERVICESTATE', 'TESTSERVICESTOP',
    'TESTSERVICESTART', 'TESTSERVICEWAIT', 'TESTSERVICEINSTALL',
    'TESTSERVICEUNINSTALL', 'TESTSERVICEREALFILE', 'TESTSERVICESTATUS',
    'TESTSERVICEIMAGE', 'TESTSERVICESTARTTYPE', 'TESTSERVICEDELETEFLAG',
    'TESTUNINSTALLSERVICE', 'TESTHEALTHURL', 'TESTHEALTHWAIT', 'TESTHEALTHSTEP',
    'TESTHEALTH', 'TESTROLLBACK', 'TESTNODEEXE')
$hooksOutside = @()
foreach ($hook in $hookNames) {
    $hookPattern = [regex]::Escape("ParamValue('$hook')")
    if ((Test-IssCode -Text $issText -Pattern $hookPattern) -and
        (-not (Test-IssCode -Text $testModeBody -Pattern $hookPattern))) {
        $hooksOutside += $hook
    }
}
Add-StaticResult -Name 'static:update-hooks-ifdef' `
    -Ok (($hookNames.Count -eq 20) -and ($hooksOutside.Count -eq 0)) `
    -Note ('все ' + $hookNames.Count + ' хуков обновления под #ifdef TestMode; вне: ' +
        $(if ($hooksOutside.Count -eq 0) { 'нет' } else { $hooksOutside -join ',' }))
# Бэкап только при смене версии (карточка bb063ac3). Прежняя версия неизвестна
# (adopt/первая установка) — архив не создаётся: иначе установка поверх чужих
# данных падала бы на проверке целостности их _system.db (регрессия init-key).
$backupNeededBody = Get-IssFunctionBody -Text $issText -Name 'BackupNeeded'
Add-StaticResult -Name 'static:backup-version-only' `
    -Ok ((Test-IssCode -Text $backupNeededBody -Pattern ([regex]::Escape("if Old = '' then"))) -and
        (Test-IssCode -Text $backupNeededBody -Pattern ([regex]::Escape('SemverCompare(Old, GProductVersion)'))) -and
        (-not (Test-IssCode -Text $backupNeededBody -Pattern ([regex]::Escape('Result := GDataDirPresent'))))) `
    -Note 'архив только при известной смене версии, без версии — не нужен'

# --- 8b1f5980: регистрация и снятие службы WinSW -----------------------------
# Статические сторожи порядка: install — после записи etn-service.xml и до
# start; uninstall — в usUninstall, до удаления файлов. Проверка по телам
# функций и срезам ветвей, а не подстрокой по всему файлу.
$pConfig = $ssPostInstallBody.IndexOf('InstallServiceConfig')
$pRegister = $ssPostInstallBody.IndexOf('RegisterServiceIfNeeded')
$pStart = $ssPostInstallBody.IndexOf('StartServiceIfNeeded')
Add-StaticResult -Name 'static:service-register-order' `
    -Ok (($ssPostInstallBody -ne '') -and ($pConfig -ge 0) -and
        ($pRegister -gt $pConfig) -and ($pStart -gt $pRegister)) `
    -Note ('конфигурация → регистрация → запуск (' + $pConfig + ' < ' + $pRegister +
        ' < ' + $pStart + ')')
$registerBody = Get-IssFunctionBody -Text $issText -Name 'RegisterServiceIfNeeded'
Add-StaticResult -Name 'static:service-install-command' `
    -Ok ((Test-IssCode -Text $registerBody -Pattern ([regex]::Escape("RunServiceCommand('install')"))) -and
        (Test-IssCode -Text $registerBody -Pattern ([regex]::Escape("GServerMode = 'app'"))) -and
        (Test-IssCode -Text $registerBody -Pattern ([regex]::Escape('ServiceRegistered')))) `
    -Note 'install после проверки app/регистрации; режим app службу не регистрирует'
# 1073 разбирается общей функцией ServiceCommandResult — её вызывает и
# продуктовая ветка, и модель TestMode: иначе удаление продуктовой ветки
# оставалось зелёным (замечание приёмки 0978b96a).
$commandResultBody = Get-IssFunctionBody -Text $issText -Name 'ServiceCommandResult'
$installCallPos = $registerBody.IndexOf("RunServiceCommand('install')")
$identityAfterInstall = -1
if ($installCallPos -ge 0) {
    $identityAfterInstall = $registerBody.IndexOf('CheckServiceIdentity', $installCallPos)
}
Add-StaticResult -Name 'static:service-install-exists' `
    -Ok ((Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('ERROR_SERVICE_EXISTS'))) -and
        (Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape("(Verb = 'install')"))) -and
        (Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('Result := True'))) -and
        ($identityAfterInstall -gt $installCallPos)) `
    -Note '1073 — успех только для своей службы: разбор общий, личность перепроверяется после install'
# Продуктовая ветка RunServiceCommand — без #ifdef TestMode: проверка файла и
# вызов общего разбора кода возврата обязаны быть именно в ней.
$runServiceProd = Get-IssFunctionBodyWithoutIfdef -Text $issText -Name 'RunServiceCommand' -Ifdef 'TestMode'
Add-StaticResult -Name 'static:service-production-branch' `
    -Ok (($runServiceProd -ne '') -and
        (Test-IssCode -Text $runServiceProd -Pattern ([regex]::Escape('FileExists(ServiceExePath)'))) -and
        (Test-IssCode -Text $runServiceProd -Pattern ([regex]::Escape('ServiceCommandResult(Verb, Code)'))) -and
        (-not (Test-IssCode -Text $runServiceProd -Pattern ([regex]::Escape('GTestService'))))) `
    -Note 'продуктовая ветка: проверка exe и общий разбор 1073 без тестовых хуков'
$startBody = Get-IssFunctionBody -Text $issText -Name 'StartServiceIfNeeded'
Add-StaticResult -Name 'static:service-start-wait' `
    -Ok ((Test-IssCode -Text $startBody -Pattern ([regex]::Escape("RunServiceCommand('start')"))) -and
        (-not (Test-IssCode -Text $startBody -Pattern ([regex]::Escape('WaitServiceRunning')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('WaitServiceRunning')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('ServiceRunningNow')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('SERVICE_START_WAIT_MS'))))) `
    -Note 'start вызывается всегда; RUNNING не ждём — готовность подтверждает health-check'
# Личность службы проверяется до копирования: PrepareServerUpdate вызывает
# CheckServiceIdentity раньше EnsureDatabaseTool и StopServiceForUpdate, а сама
# проверка смотрит ImagePath/Start/DeleteFlag/status.
$prepareBody = Get-IssFunctionBody -Text $issText -Name 'PrepareServerUpdate'
$identityBody = Get-IssFunctionBody -Text $issText -Name 'CheckServiceIdentity'
$pIdentity = $prepareBody.IndexOf('CheckServiceIdentity')
$pStop = $prepareBody.IndexOf('StopServiceForUpdate')
Add-StaticResult -Name 'static:service-identity-before-copy' `
    -Ok (($pIdentity -ge 0) -and ($pStop -gt $pIdentity) -and
        (Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('EXIT_PRECONDITION'))) -and
        (Test-IssCode -Text $identityBody -Pattern ([regex]::Escape('ServiceImagePathMatches'))) -and
        (Test-IssCode -Text $identityBody -Pattern ([regex]::Escape('ServiceStartDisabled'))) -and
        (Test-IssCode -Text $identityBody -Pattern ([regex]::Escape('ServiceDeleteFlagSet'))) -and
        (Test-IssCode -Text $identityBody -Pattern ([regex]::Escape('SERVICE_STATE_MISSING')))) `
    -Note ('личность службы до остановки/копирования (' + $pIdentity + ' < ' + $pStop +
        '): ImagePath, Start=4, DeleteFlag, NonExistent')
# Откат не трогает файлы/БД, если служба не остановилась: проверка стоит до
# RestoreInstallFiles, при отказе — Exit без restore.
$pRollbackStop = $rollbackBody.IndexOf('StopServiceForUpdate')
$pRestoreFiles = $rollbackBody.IndexOf('RestoreInstallFiles')
$pRestoreDb = $rollbackBody.IndexOf('RestoreDatabaseFromArchive')
Add-StaticResult -Name 'static:service-rollback-stop-guard' `
    -Ok (($pRollbackStop -ge 0) -and ($pRestoreFiles -gt $pRollbackStop) -and
        ($pRestoreDb -gt $pRollbackStop) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('файлы новой версии и '))) -and
        (Test-IssCode -Text $rollbackBody -Pattern ([regex]::Escape('БД не восстановлены')))) `
    -Note ('откат: StopServiceForUpdate → RestoreInstallFiles (' + $pRollbackStop +
        ' < ' + $pRestoreFiles + '); при отказе файлы/БД не трогаются')
# Снятие службы подтверждается через status: uninstall 1072 возвращает 0, но
# ключ может остаться.
$removeBody = Get-IssFunctionBody -Text $issText -Name 'RemoveServiceOnUninstall'
$removedBody = Get-IssFunctionBody -Text $issText -Name 'WaitServiceRemoved'
Add-StaticResult -Name 'static:service-uninstall-confirm' `
    -Ok ((Test-IssCode -Text $removeBody -Pattern ([regex]::Escape("RunServiceCommand('uninstall')"))) -and
        (Test-IssCode -Text $removeBody -Pattern ([regex]::Escape('WaitServiceRemoved'))) -and
        (Test-IssCode -Text $removedBody -Pattern ([regex]::Escape('ServiceStatusOutput'))) -and
        (Test-IssCode -Text $removedBody -Pattern ([regex]::Escape('ServiceNowSeconds'))) -and
        (Test-IssCode -Text $removedBody -Pattern ([regex]::Escape('SERVICE_STATE_MISSING')))) `
    -Note 'uninstall → polling status до NonExistent (exit 0 не доказывает удаление)'
# Разбор кодов WinSW: 1056 — успех старта, 1061/1062 — переход останова,
# 1060/1072 — успех только у uninstall, 1058 — отдельное сообщение.
Add-StaticResult -Name 'static:service-codes' `
    -Ok ((Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('ERROR_SERVICE_ALREADY_RUNNING'))) -and
        (Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('ERROR_SERVICE_CANNOT_ACCEPT_CTRL'))) -and
        (Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('ERROR_SERVICE_NOT_ACTIVE'))) -and
        (Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('ERROR_SERVICE_DOES_NOT_EXIST'))) -and
        (Test-IssCode -Text $commandResultBody -Pattern ([regex]::Escape('ERROR_SERVICE_MARKED_FOR_DELETE'))) -and
        (Test-IssCode -Text $issText -Pattern ([regex]::Escape('ERROR_SERVICE_DISABLED')))) `
    -Note '1056/1061/1062/1060/1072/1058 разобраны отдельно'
# Путь к etn-service.exe не зависит от глобалов, заполняемых только установкой:
# деинсталлятор не вызывает InitializeSetup, и GServerDir в нём пуст (блокер
# приёмки 0978b96a). В установке {app} ещё не раскрыт внутри InitializeSetup
# (проба /TESTUNINSTALLSERVICE), поэтому GServerDir — первый кандидат, {app} —
# запасной и единственный в деинсталляторе.
$serviceDirBody = Get-IssFunctionBody -Text $issText -Name 'ServiceDir'
$serviceExeBody = Get-IssFunctionBody -Text $issText -Name 'ServiceExePath'
Add-StaticResult -Name 'static:service-path-by-app' `
    -Ok ((Test-IssCode -Text $serviceDirBody -Pattern ([regex]::Escape("ExpandConstant('{app}')"))) -and
        (Test-IssCode -Text $serviceExeBody -Pattern ([regex]::Escape('ServiceDir'))) -and
        (-not (Test-IssCode -Text $serviceExeBody -Pattern ([regex]::Escape('GServerDir'))))) `
    -Note 'ServiceExePath = ServiceDir\service\etn-service.exe; в деинсталляторе — {app}'
# Инициализация деинсталлятора: каталог данных, режим и журнал удаления —
# из install.json/{commonappdata}, а не из пустых глобалов setup.
$initUninstallBody = Get-IssFunctionBody -Text $issText -Name 'InitializeUninstall'
Add-StaticResult -Name 'static:uninstall-init' `
    -Ok (($initUninstallBody -ne '') -and
        (Test-IssCode -Text $initUninstallBody -Pattern ([regex]::Escape("ExpandConstant('{#DataDir}')"))) -and
        (Test-IssCode -Text $initUninstallBody -Pattern ([regex]::Escape("JsonGetRaw(Text, 'data_dir')"))) -and
        (Test-IssCode -Text $initUninstallBody -Pattern ([regex]::Escape("JsonGetRaw(Text, 'mode')"))) -and
        (Test-IssCode -Text $initUninstallBody -Pattern ([regex]::Escape('GLogPath'))) -and
        (-not (Test-IssCode -Text $initUninstallBody -Pattern ([regex]::Escape('GServerDir'))))) `
    -Note 'деинсталлятор: данные/режим из install.json, свой журнал, без GServerDir'
# Снятие службы — строго в usUninstall: срез функции до usPostUninstall.
$uninstallBody = Get-IssFunctionBody -Text $issText -Name 'CurUninstallStepChanged'
$pPostUninstall = $uninstallBody.IndexOf('usPostUninstall')
$usUninstallBody = ''
if ($pPostUninstall -gt 0) {
    $usUninstallBody = $uninstallBody.Substring(0, $pPostUninstall)
}
Add-StaticResult -Name 'static:service-uninstall-before-files' `
    -Ok (($usUninstallBody -ne '') -and
        (Test-IssCode -Text $usUninstallBody -Pattern ([regex]::Escape('RemoveServiceOnUninstall(Reason)'))) -and
        (Test-IssCode -Text $usUninstallBody -Pattern ([regex]::Escape('Abort;')))) `
    -Note 'служба снимается в usUninstall (до удаления файлов), отказ отменяет удаление'
$removeBody = Get-IssFunctionBody -Text $issText -Name 'RemoveServiceOnUninstall'
Add-StaticResult -Name 'static:service-uninstall-commands' `
    -Ok ((Test-IssCode -Text $removeBody -Pattern ([regex]::Escape('StopServiceForUpdate(Reason, True)'))) -and
        (Test-IssCode -Text $removeBody -Pattern ([regex]::Escape("RunServiceCommand('uninstall')")))) `
    -Note 'снятие: stop (с ожиданием, NonExistent допустим) → etn-service.exe uninstall'
# Uninstaller Inno не поддерживает свой код события: договорный код 10
# проверяется пробой /TESTUNINSTALLSERVICE, которая вызывает тот же код.
$uninstallProbeBody = Get-IssFunctionBody -Text $issText -Name 'RunUninstallServiceProbe'
Add-StaticResult -Name 'static:service-uninstall-probe' `
    -Ok ((Test-IssCode -Text $uninstallProbeBody -Pattern ([regex]::Escape('RemoveServiceOnUninstall(Reason)'))) -and
        (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape("if GTestUninstallService = '1'"))) -and
        (Test-IssCode -Text $testModeBody -Pattern ([regex]::Escape('RunUninstallServiceProbe')))) `
    -Note 'проба /TESTUNINSTALLSERVICE вызывает то же снятие: отказ — код 10 с причиной'

# --- A. Успешное обновление с настоящим разбором тела health-check ----------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
# Сетевая база: успешное обновление обязано сохранить её данные (7130ba81).
$networkDb = Join-Path $dataDir 'networks\11111111-2222-3333-4444-555555555555\data.db'
$null = New-BackupTestDatabase -Path $networkDb -Values @('network-data')
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
$singleEndpoint = ($requests -match '/api/v1/health') -and
    (-not ($requests -match '/api/v1/version'))
Add-Result -Name 'update-ok:single-endpoint' -Expected 1 -Actual ([int][bool]$singleEndpoint) `
    -Note 'health-check вызвал только /api/v1/health; второй GET /version не выполняется'
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
# Сценарий 7130ba81: данные сохранены, etn init не повторяется.
$dbValues = Get-BackupTestValues -Path (Join-Path $dataDir '_system.db')
Add-Result -Name 'update-ok:system-db-preserved' -Expected 1 `
    -Actual ([int](($dbValues -split '\|') -contains 'alpha')) `
    -Note ('записи до обновления на месте: ' + $dbValues)
Add-Result -Name 'update-ok:network-db-preserved' -Expected 1 `
    -Actual ([int]((Get-BackupTestValues -Path $networkDb) -eq 'network-data')) `
    -Note 'данные сетевой базы сохранены'
$noInit = (-not (Test-LatestLogContains -Pattern 'etn init: запуск')) -and
    (Test-LatestLogContains -Pattern 'etn init не вызывается')
Add-Result -Name 'update-ok:no-init' -Expected 1 -Actual ([int]$noInit) `
    -Note 'etn init при обновлении не вызывался'

# --- A1. a1ea1d40: бюджет health-check — фактическое время, не сумма Sleep ---
# Ответ подставного сервера задержан на 2 с, бюджет 3000 мс, шаг 500 мс.
# Старая арифметика (Elapsed прирастал только на Sleep) делала 6 попыток:
# 6 × (2 + 0,5) ≈ 15 с только на первый опрос. Фактический бюджет — 2 попытки
# (второй запрос заканчивается уже за бюджетом) ≈ 4,5 с + health прежней
# версии после отката ≈ 2 с. Порог 12 с отсекает старую сумму пауз с запасом.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$srv = Start-FakeHealthServer -Mode 'wrong-version' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write' -DelayMs 2000
$budgetWatch = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs +
        @('/TESTHEALTHWAIT=3000', '/TESTHEALTHSTEP=500', $nodeArg, "/TESTHEALTHURL=$($srv.Url)"))
} finally {
    $budgetWatch.Stop()
    Stop-FakeHealthServer $srv
}
$budgetSeconds = [math]::Round($budgetWatch.Elapsed.TotalSeconds, 1)
Add-Result -Name 'update-health-budget:code' -Expected 10 -Actual $code
Add-Result -Name 'update-health-budget:actual-time' -Expected 1 `
    -Actual ([int]($budgetSeconds -lt 12)) `
    -Note ('установка ' + $budgetSeconds + ' с; сумма Sleep дала бы ~15 с только на первый опрос')
$budgetRequests = @((Get-FakeHealthRequests -Server $srv) -split "`n" |
    Where-Object { $_.Trim() -ne '' }).Count
Add-Result -Name 'update-health-budget:requests' -Expected 1 `
    -Actual ([int]($budgetRequests -lt 6)) `
    -Note ('запросов к health: ' + $budgetRequests + '; старая сумма пауз сделала бы 7')

# --- A2. 1dddac77: своя служба жива, TCP-таблица недоступна -----------------
# На build 28000 таблица слушателей не работает: без спецветки эксклюзивный
# bind падал на порту собственной службы, и обновление поверх работающей
# установки всегда получало 20. Служба запущена (PID процесса передан хуком),
# таблица недоступна (хук) — обновление обязано пройти.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$fixturePort = 0
try {
    $fixtureJson = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw | ConvertFrom-Json
    $fixturePort = [int]$fixtureJson.port
} catch { }
$ownServiceListener = $null
$srv = $null
try {
    if ($fixturePort -gt 0) {
        $ownServiceListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $fixturePort)
        $ownServiceListener.Start()
    }
    $srv = Start-FakeHealthServer -Mode 'ok' -DbPath (Join-Path $dataDir '_system.db') `
        -Marker 'new-version-write'
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)", '/TESTLISTENERTABLEOFF=1',
            "/TESTOWNSERVICEPID=$PID"))
} finally {
    if ($null -ne $ownServiceListener) { $ownServiceListener.Stop() }
    if ($null -ne $srv) { Stop-FakeHealthServer $srv }
}
Add-Result -Name 'update-tableoff-own:code' -Expected 0 -Actual $code `
    -Note 'таблица сломана + своя служба запущена — обновление проходит'
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
Add-Result -Name 'update-tableoff-own:install-json' -Expected 1 `
    -Actual ([int]($jsonText -match ('"product_version":"' + [regex]::Escape($version) + '"'))) `
    -Note ('версия ' + $version)
Add-Result -Name 'update-tableoff-own:health' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Health-check http://127\.0\.0\.1')) `
    -Note 'health-check выполнен'

# Контроль: та же сломанная таблица, но службы нет — чужой занятый порт даёт 20.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$fixturePort = 0
try {
    $fixtureJson = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw | ConvertFrom-Json
    $fixturePort = [int]$fixtureJson.port
} catch { }
$foreignListener = $null
try {
    if ($fixturePort -gt 0) {
        $foreignListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $fixturePort)
        $foreignListener.Start()
    }
    $code = Invoke-Setup -Arguments ($silent + $updateArgs +
        @('/TESTLISTENERTABLEOFF=1', '/TESTNOSERVICE=1'))
} finally {
    if ($null -ne $foreignListener) { $foreignListener.Stop() }
}
Add-Result -Name 'update-tableoff-foreign:code' -Expected 20 -Actual $code `
    -Note 'таблица сломана, службы нет, порт занят — обновление отклонено'
$keptIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js')) -eq $oldIndex
Add-Result -Name 'update-tableoff-foreign:no-changes' -Expected 1 -Actual ([int]$keptIndex) `
    -Note 'файлы не заменены'
Add-Result -Name 'update-tableoff-foreign:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern ('порт ' + $fixturePort + ' занят другим приложением'))) `
    -Note 'журнал называет причину'

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
# Блокер 2 приёмки: после отката нет файлов, которых не было в снимке
# (их принесла новая версия), и восстановлен файл снимка.
$leftover = 0
foreach ($rel in @('server\dist\cli.js', 'server\migrations\001_stub.sql',
        'server\node_modules\stub-dep\package.json')) {
    if (Test-Path -LiteralPath (Join-Path $appDir $rel)) { $leftover++ }
}
Add-Result -Name 'update-foreign:no-new-files' -Expected 0 -Actual $leftover `
    -Note 'файлы новой версии удалены: сервер не применит новые миграции'
$pkgOld = (Get-Content -LiteralPath (Join-Path $appDir 'server\package.json') -Raw) -match
    '"version":"0\.15\.0"'
Add-Result -Name 'update-foreign:snapshot-file-back' -Expected 1 -Actual ([int]$pkgOld) `
    -Note 'файл снимка на месте (package.json прежней версии)'
$strayDirs = @(Get-ChildItem -LiteralPath (Join-Path $appDir 'server') -Directory -Force |
    Where-Object { $_.Name -like '*.rollback-*' })
foreach ($rel in @('server', 'service')) {
    $stray = Join-Path $appDir ($rel + '.rollback-' + $rel)
    if (Test-Path -LiteralPath $stray) { $strayDirs += Get-Item -LiteralPath $stray }
}
Add-Result -Name 'update-foreign:no-swap-leftovers' -Expected 0 -Actual ([int]$strayDirs.Count) `
    -Note 'временные каталоги подмены удалены'
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
Add-Result -Name 'update-foreign:rollback-health' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат: прежняя версия отвечает на health-check')) `
    -Note 'после отката health прежней версии пройден без требования целевой версии'
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

# --- D. (удалён a1ea1d40) Второй GET /api/v1/version больше не вызывается ----
# Бывший тест «/version вернул чужую версию» удалён вместе с самим запросом:
# версия проверяется из тела /health (тест update-foreign и сторожа выше).

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

# --- F. Неудачный откат: код 10, путь к архиву и health в причине ------------
# a1ea1d40: неудача health прежней версии после отката не маскируется —
# дописывается в GFailureReason вместе с подсказкой ServiceStartManually.
# Причина доступна только через reason-файл, поэтому запуск привилегированной
# фазы с /PARAMS (как в тесте ремонта).
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$reasonRollbackFail = Join-Path $workRoot 'rollback-fail-reason.txt'
$paramsRollbackFail = New-ParamsFile -ReasonFile $reasonRollbackFail -Name 'rollback-fail.ini'
$srv = Start-FakeHealthServer -Mode 'http500' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
        "/PARAMS=`"$paramsRollbackFail`"", '/TESTELEVATED=1', '/TESTSERVICE=present',
        $nodeArg) + $fastHealth + @("/TESTHEALTHURL=$($srv.Url)", '/TESTROLLBACK=fail'))
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
$reasonRollbackText = ''
if (Test-Path -LiteralPath $reasonRollbackFail) {
    $reasonRollbackText = Get-Content -LiteralPath $reasonRollbackFail -Raw
}
Add-Result -Name 'update-rollback-fail:health-reason' -Expected 1 `
    -Actual ([int](
        ($reasonRollbackText -match 'Прежняя версия не отвечает') -and
        ($reasonRollbackText -match 'health: HTTP-ошибка') -and
        ($reasonRollbackText -match 'etn-service\.exe start'))) `
    -Note 'неудача health прежней версии (диагностика + ServiceStartManually) — в причине'

# --- G. Бэкап не удался: код 10, файлы не заменены, служба поднята ----------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$blockedBackups = Join-Path $dataDir 'backups'
[System.IO.File]::WriteAllText($blockedBackups, 'occupied')
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @($nodeArg, '/TESTHEALTH=ok'))
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
# Замечание приёмки: сообщение о неудачном бэкапе содержит причину, требуемый
# объём и путь к журналу (сценарий bc7cc846).
Add-Result -Name 'update-backup-fail:message-details' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'резервная копия баз данных не создана: каталог архивов не создан[^\r\n]*требуется свободного места: \d+[^\r\n]*журнал: ')) `
    -Note 'причина + объём + журнал в сообщении'
$serviceBack = (Test-LatestLogContains -Pattern 'Служба ETN: команда start принята') -and
    (-not (Test-LatestLogContains -Pattern 'служба не запущена'))
Add-Result -Name 'update-backup-fail:service-back' -Expected 1 -Actual ([int]$serviceBack) `
    -Note 'служба возвращена и подтверждена health-check-ом (start не ждёт RUNNING)'

# --- G2. Инструмент бэкапа отказал: причина из отчёта в сообщении -----------
# Тот же сценарий bc7cc846, но отказ приходит из CLI (битая база, нет места):
# причина обязана попасть в сообщение об отмене, файлы — не заменены.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
Set-DatabaseToolMode -Mode 'fail-backup'
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @($nodeArg, '/TESTHEALTH=ok'))
Add-Result -Name 'update-tool-fail:code' -Expected 10 -Actual $code
$stillOld = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js')) -eq $oldIndex
Add-Result -Name 'update-tool-fail:files-untouched' -Expected 1 -Actual ([int]$stillOld)
Add-Result -Name 'update-tool-fail:no-archive' -Expected 0 -Actual ([int](@(Get-BackupArchives).Count))
Add-Result -Name 'update-tool-fail:message' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'резервная копия баз данных не создана: fixture backup failure[^\r\n]*журнал: ')) `
    -Note 'причина из отчёта инструмента — в сообщении об отмене'
$toolBack = (Test-LatestLogContains -Pattern 'Служба ETN: команда start принята') -and
    (-not (Test-LatestLogContains -Pattern 'служба не запущена'))
Add-Result -Name 'update-tool-fail:service-back' -Expected 1 -Actual ([int]$toolBack) `
    -Note 'служба возвращена и подтверждена health-check-ом'

# --- G3. Бэкап не удался и служба не ответила: причина дополнена ------------
# После неудачного бэкапа start не ждёт RUNNING, поэтому возврат службы
# подтверждается health-check-ом прежней версии; если она не отвечает, в
# причину добавляется подсказка о ручном запуске (34f8e315).
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$blockedBackups = Join-Path $dataDir 'backups'
[System.IO.File]::WriteAllText($blockedBackups, 'occupied')
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @($nodeArg, '/TESTHEALTH=fail'))
Add-Result -Name 'update-backup-unhealthy:code' -Expected 10 -Actual $code
Add-Result -Name 'update-backup-unhealthy:hint' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба не запущена; запустите вручную \(etn-service\.exe start\), журнал: ')) `
    -Note 'в причине — подсказка о ручном запуске и путь к журналу'
Add-Result -Name 'update-backup-unhealthy:files-untouched' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex)) `
    -Note 'файлы не заменены'

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

# --- H2. Остановка 1061/1062: переход и повтор -------------------------------
# WinSW: stop на StartPending/StopPending — 1061 (управление не принято), на
# остановленной — 1062. 1061 повторяется раз в ~1 с в пределах бюджета, после
# любого кода состояние подтверждается через status=Stopped.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$code = Invoke-Setup -Arguments ($silent + $updateArgs +
    @($nodeArg, '/TESTSERVICESTOP=1061', '/TESTHEALTH=ok'))
Add-Result -Name 'service-stop-1061:code' -Expected 0 -Actual $code `
    -Note 'stop 1061: повтор stop и подтверждение остановки'
$stopCount = Test-LatestLogCount -Pattern 'команда stop'
Add-Result -Name 'service-stop-1061:retry' -Expected 1 -Actual ([int]($stopCount -ge 2)) `
    -Note ('команд stop: ' + $stopCount)
Add-Result -Name 'service-stop-1061:transition' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба в переходном состоянии \(1061\)')) `
    -Note 'журнал называет переход 1061'
Add-Result -Name 'service-stop-1061:stopped' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN остановлена')) `
    -Note 'остановка подтверждена status'

$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$code = Invoke-Setup -Arguments ($silent + $updateArgs +
    @($nodeArg, '/TESTSERVICESTOP=1062', '/TESTHEALTH=ok'))
Add-Result -Name 'service-stop-1062:code' -Expected 0 -Actual $code `
    -Note 'stop 1062 — служба уже остановлена, ждём status=Stopped'
Add-Result -Name 'service-stop-1062:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба уже остановлена \(1062\)')) `
    -Note 'журнал называет 1062'

# --- H3. Ошибка status: быстрый отказ до копирования, код 20 -----------------
# Причина конкретная (status не выполнен), ожидание остановки не начинается,
# файлы и БД не трогаются.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @('/TESTSERVICESTATUS=fail'))
Add-Result -Name 'service-status-fail:code' -Expected 20 -Actual $code `
    -Note 'ошибка status — предусловие не выполнено'
Add-Result -Name 'service-status-fail:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'не удалось определить состояние службы ETN: etn-service.exe status не выполнен')) `
    -Note 'причина названа конкретно'
Add-Result -Name 'service-status-fail:fast' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Остановка службы ETN \(status=Started\)')) `
    -Note 'ожидание остановки не начиналось'
Add-Result -Name 'service-status-fail:no-copy' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex)) `
    -Note 'файлы не заменены'
Add-Result -Name 'service-status-fail:no-archive' -Expected 0 `
    -Actual ([int](@(Get-BackupArchives).Count))

# --- H4. Личность службы: чужой/устаревший ImagePath — код 20 ----------------
# install для существующей службы не выполняется (1073), поэтому чужая служба
# отсекается до копирования: иначе start упал бы уже после замены файлов.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$foreignImage = Join-Path $workRoot 'foreign\etn-service.exe'
$code = Invoke-Setup -Arguments ($silent + $updateArgs +
    @("/TESTSERVICEIMAGE=$foreignImage"))
Add-Result -Name 'service-identity-image:code' -Expected 20 -Actual $code `
    -Note 'чужой ImagePath — предусловие не выполнено'
Add-Result -Name 'service-identity-image:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'зарегистрирована с другим путём: .*etn-service\.exe')) `
    -Note 'журнал называет путь службы и ожидаемый'
Add-Result -Name 'service-identity-image:no-copy' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex))
Add-Result -Name 'service-identity-image:no-install' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда install'))
Add-Result -Name 'service-identity-image:no-start' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда start'))

# --- H5. Личность службы: Start=4 (disabled) — код 20 -----------------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @('/TESTSERVICESTARTTYPE=4'))
Add-Result -Name 'service-identity-starttype:code' -Expected 20 -Actual $code `
    -Note 'отключённая служба — предусловие не выполнено'
Add-Result -Name 'service-identity-starttype:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'отключена \(Start=4\)')) `
    -Note 'журнал называет Start=4'
Add-Result -Name 'service-identity-starttype:no-copy' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex))

# --- H6. Личность службы: DeleteFlag=1 (pending delete) — код 20 ------------
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @('/TESTSERVICEDELETEFLAG=1'))
Add-Result -Name 'service-identity-deleteflag:code' -Expected 20 -Actual $code `
    -Note 'служба помечена на удаление — предусловие не выполнено'
Add-Result -Name 'service-identity-deleteflag:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'помечена на удаление \(DeleteFlag=1\)')) `
    -Note 'журнал называет DeleteFlag=1'
Add-Result -Name 'service-identity-deleteflag:no-copy' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex))

# --- H7. Личность службы: ключ есть, SCM не видит (NonExistent) — код 20 ----
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @('/TESTSERVICESTATUS=nonexistent'))
Add-Result -Name 'service-identity-nonexistent:code' -Expected 20 -Actual $code `
    -Note 'несогласованное состояние реестр/SCM — предусловие не выполнено'
Add-Result -Name 'service-identity-nonexistent:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'зарегистрирована в реестре, но SCM её не видит')) `
    -Note 'журнал называет несогласованное состояние'
Add-Result -Name 'service-identity-nonexistent:no-copy' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -eq $oldIndex))

# --- H8. Откат при неудачной остановке: файлы и БД не восстановлены ---------
# health-check новой версии не прошёл, а службу новой версии остановить не
# удалось: restore по живой БД недопустим — снимок и архив остаются точкой
# ручного восстановления, файлы новой версии не откатываются.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$oldIndex = [System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))
$srv = Start-FakeHealthServer -Mode 'http500' -DbPath (Join-Path $dataDir '_system.db') `
    -Marker 'new-version-write'
try {
    $code = Invoke-Setup -Arguments ($silent + $updateArgs + $fastHealth +
        @($nodeArg, "/TESTHEALTHURL=$($srv.Url)", '/TESTSERVICESTOP=fail-after-start'))
} finally {
    Stop-FakeHealthServer $srv
}
Add-Result -Name 'service-rollback-stop-fail:code' -Expected 10 -Actual $code
Add-Result -Name 'service-rollback-stop-fail:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат не выполнен: служба ETN не остановилась')) `
    -Note 'причина — служба не остановилась'
Add-Result -Name 'service-rollback-stop-fail:message' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'файлы новой версии и БД не восстановлены; снимок: ')) `
    -Note 'сообщение прямо говорит: файлы новой версии и БД не восстановлены'
Add-Result -Name 'service-rollback-stop-fail:files-new' -Expected 1 `
    -Actual ([int](([System.IO.File]::ReadAllText((Join-Path $appDir 'server\dist\index.js'))) -ne $oldIndex)) `
    -Note 'файлы новой версии остались (откат файлов не выполнялся)'
$dbAfter = Get-BackupTestValues -Path (Join-Path $dataDir '_system.db')
Add-Result -Name 'service-rollback-stop-fail:db-new' -Expected 1 `
    -Actual ([int](($dbAfter -split '\|') -contains 'new-version-write')) `
    -Note ('БД не восстановлена (записи неудачного запуска на месте): ' + $dbAfter)
Add-Result -Name 'service-rollback-stop-fail:snapshot-kept' -Expected 1 `
    -Actual ([int](@(Get-RollbackDirs).Count)) `
    -Note 'снимок отката оставлен точкой ручного восстановления'
Add-Result -Name 'service-rollback-stop-fail:archive-kept' -Expected 1 `
    -Actual ([int](@(Get-BackupArchives).Count)) `
    -Note 'архив БД оставлен'

# --- I. Ремонт той же версии: старый архив не подставляется в откат --------
# Блокер 1 приёмки: при ремонте архив не создаётся (версия та же), но файлы
# заменяются и снимок создаётся. Прежний откат брал LatestBackupDir — самый
# свежий архив ПРОШЛЫХ обновлений — и затирал актуальную БД. Здесь health
# возвращает 9.9.9: БД обязана остаться 'alpha', устаревший архив — нетронутым.
$null = New-UpdateFixture -OldVersion $version
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
# Снимок прошлого запуска: после снимка этого запуска исчезает (замечание 4).
$oldSnapshot = Join-Path $dataDir '.install\rollback\20260101-000000\server\dist'
New-Item -ItemType Directory -Path $oldSnapshot -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $oldSnapshot 'index.js'), '// stale-snapshot')
# Устаревший архив прошлых обновлений: LatestBackupDirName выбирает ZIP по
# метке времени в имени — файл с валидным именем, содержимое не важно.
$staleArchive = Join-Path $dataDir 'backups\etn-backup-0.15.0-20260101-000000.zip'
New-Item -ItemType Directory -Path (Split-Path -Parent $staleArchive) -Force | Out-Null
[System.IO.File]::WriteAllText($staleArchive, 'stale-archive')
$oldIndexPath = Join-Path $appDir 'server\dist\index.js'
[System.IO.File]::WriteAllText($oldIndexPath, '// old-repair-marker')
$reasonRepair = Join-Path $workRoot 'repair-reason.txt'
$paramsRepair = New-ParamsFile -ReasonFile $reasonRepair -Name 'repair.ini'
$srv = Start-FakeHealthServer -Mode 'wrong-version'
try {
    $code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
        "/PARAMS=`"$paramsRepair`"", '/TESTELEVATED=1', '/TESTSERVICE=present',
        $nodeArg) + $fastHealth + @("/TESTHEALTHURL=$($srv.Url)"))
} finally { Stop-FakeHealthServer $srv }
Add-Result -Name 'update-repair:code' -Expected 10 -Actual $code `
    -Note 'health 9.9.9 после ремонта — код 10'
$liveDb = Get-BackupTestValues -Path (Join-Path $dataDir '_system.db')
Add-Result -Name 'update-repair:db-untouched' -Expected 1 -Actual ([int]($liveDb -eq 'alpha')) `
    -Note ('БД после отката: ' + $liveDb)
$staleText = ''
if (Test-Path -LiteralPath $staleArchive) {
    $staleText = (Get-Content -LiteralPath $staleArchive -Raw).Trim()
}
Add-Result -Name 'update-repair:stale-archive-kept' -Expected 1 `
    -Actual ([int]($staleText -eq 'stale-archive')) `
    -Note 'старый архив не подставлен и не изменён'
Add-Result -Name 'update-repair:no-stale-restore' -Expected 1 -Actual ([int](
    (Test-LatestLogContains -Pattern 'Откат БД: архив в этом запуске не создавался') -and
    (Test-LatestLogContains -Pattern 'база оставлена как есть') -and
    (-not (Test-LatestLogContains -Pattern 'Откат БД: база восстановлена из')))) `
    -Note 'журнал: архив не создавался, база оставлена как есть'
$rollbackDirs = @(Get-RollbackDirs)
Add-Result -Name 'update-repair:old-snapshot-removed' -Expected 1 -Actual ([int](
    ($rollbackDirs.Count -eq 1) -and ($rollbackDirs[0].Name -ne '20260101-000000'))) `
    -Note 'хранится только снимок текущего запуска'
$reasonText = ''
if (Test-Path -LiteralPath $reasonRepair) {
    $reasonText = Get-Content -LiteralPath $reasonRepair -Raw
}
Add-Result -Name 'update-repair:reason-rollback' -Expected 1 -Actual ([int](
    ($reasonText -match 'Откат выполнен') -and
    ($reasonText -match 'архив БД не создавался') -and
    ($reasonText -match 'восстановить невозможно'))) `
    -Note 'reason-файл: причина + итог отката (блокер 3)'
$restoredIndex = (Get-Content -LiteralPath $oldIndexPath -Raw).Trim()
Add-Result -Name 'update-repair:files-restored' -Expected 1 `
    -Actual ([int]($restoredIndex -eq '// old-repair-marker')) `
    -Note 'файлы возвращены из снимка'

# --- J. Режим app: health-check не выполняется, откат не начинается --------
# Замечание приёмки: сервер в режиме app установщик не запускает — безусловный
# опрос health ждал бы таймаут и уводил обновление в откат с кодом 10.
$null = New-UpdateFixture
Write-InstallJson (New-InstallJson -ProductVersion '0.15.0' -Mode 'app')
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
# Снимок прошлого запуска: после успеха не остаётся ни одного снимка (замечание 4).
$oldSnapshotApp = Join-Path $dataDir '.install\rollback\20260101-000000\server'
New-Item -ItemType Directory -Path $oldSnapshotApp -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $oldSnapshotApp 'package.json'), '{"version":"0.14.0"}')
$paramsApp = New-ParamsFile -Mode 'app' -Name 'app-mode.ini'
$closedPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsApp`"", '/TESTELEVATED=1', '/TESTSERVICE=absent', $nodeArg) +
    @($fastHealth) + @('/TESTHEALTHURL=http://127.0.0.1:' + $closedPort))
Add-Result -Name 'app-mode:code' -Expected 0 -Actual $code `
    -Note 'обновление не уходит в откат из-за health'
Add-Result -Name 'app-mode:no-health' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Режим app: health-check не выполняется')) `
    -Note 'health в app-режиме пропущен'
Add-Result -Name 'app-mode:no-rollback' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Откат: начинается')) `
    -Note 'откат не начинался'
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
Add-Result -Name 'app-mode:install-json' -Expected 1 `
    -Actual ([int]($jsonText -match ('"product_version":"' + [regex]::Escape($version) + '"'))) `
    -Note 'запись установки обновлена'
Add-Result -Name 'app-mode:snapshot-removed' -Expected 0 -Actual ([int](@(Get-RollbackDirs).Count))

# --- 8b1f5980: регистрация и снятие службы WinSW ----------------------------
Write-Host '=== 8b1f5980: регистрация и снятие службы WinSW ==='

# Конфигурация службы в каталоге программы: свежая установка копирует шаблон
# из payload, ремонт той же версии файлы не заменяет — шаблон кладётся тестом.
function New-ServiceFixture {
    New-Item -ItemType Directory -Path (Join-Path $appDir 'service') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures\payload\service\etn-service.xml') `
        -Destination (Join-Path $appDir 'service\etn-service.xml') -Force
    [System.IO.File]::WriteAllText((Join-Path $appDir 'service\etn-service.exe'), 'stub')
}

function Get-ServiceConfigText {
    $path = Join-Path $appDir 'service\etn-service.xml'
    if (Test-Path -LiteralPath $path) {
        return (Get-Content -LiteralPath $path -Raw -Encoding UTF8)
    }
    return ''
}

# Индексы строк журнала монотонно возрастают: каждый шаблон найден и стоит
# строго после предыдущего.
function Test-LogOrder {
    param([int[]]$Indices)
    if ($Indices.Count -eq 0) { return $false }
    if ($Indices[0] -lt 0) { return $false }
    for ($i = 1; $i -lt $Indices.Count; $i++) {
        if (($Indices[$i] -lt 0) -or ($Indices[$i] -le $Indices[$i - 1])) { return $false }
    }
    return $true
}

# A. Чистая машина: службы нет — установщик вызывает install с конфигом,
#    start (без ожидания RUNNING) и подтверждает готовность health-check-ом.
Reset-State
$paramsRegister = New-ParamsFile -Mode 'service' -Name 'service-register.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsRegister`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTHEALTH=ok'))
Add-Result -Name 'service-register:code' -Expected 0 -Actual $code
$configText = Get-ServiceConfigText
$configOk = ($configText -ne '') -and ($configText -notmatch '\{\{') -and
    ($configText -match ('value="' + [regex]::Escape($dataDir) + '"'))
Add-Result -Name 'service-register:config' -Expected 1 -Actual ([int][bool]$configOk) `
    -Note 'etn-service.xml подставлен: DATA_DIR каталога теста, плейсхолдеров нет'
$configDeploymentOk = $configText -match 'name="ETN_DEPLOYMENT" value="windows-service"'
Add-Result -Name 'service-register:deployment-env' -Expected 1 -Actual ([int][bool]$configDeploymentOk) `
    -Note 'после InstallServiceConfig ETN_DEPLOYMENT=windows-service на месте'
$installArgs = Test-LatestLogContains -Pattern 'exe=.*etn-service\.exe, config=.*service\\etn-service\.xml'
Add-Result -Name 'service-register:install-args' -Expected 1 -Actual ([int]$installArgs) `
    -Note 'install вызван с конфигом рядом с etn-service.exe'
$order = Get-LogPatternIndices -Patterns @(
    'etn-service.xml: DATA_DIR=',
    'Регистрация службы ETN:',
    'команда install',
    'команда start',
    'Health-check (тестовый режим): ok',
    'install.json записан')
Add-Result -Name 'service-register:log-order' -Expected 1 `
    -Actual ([int](Test-LogOrder $order)) -Note ($order -join ' < ')
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
Add-Result -Name 'service-register:install-json' -Expected 1 `
    -Actual ([int]($jsonText -match '"mode":"service"')) -Note 'mode=service'

# B. Сбой install: код 10 (файлы уже заменены — сбой выполнения), install.json
#    не пишется, запуска нет.
Reset-State
$paramsFail = New-ParamsFile -Mode 'service' -Name 'service-install-fail.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsFail`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTSERVICEINSTALL=fail', '/TESTHEALTH=ok'))
Add-Result -Name 'service-install-fail:code' -Expected 10 -Actual $code `
    -Note 'сбой регистрации после копирования — код 10'
Add-Result -Name 'service-install-fail:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба ETN не зарегистрирована: etn-service.exe install вернул ошибку')) `
    -Note 'причина в журнале'
Add-Result -Name 'service-install-fail:no-json' -Expected 0 `
    -Actual ([int](Test-Path (Join-Path $dataDir 'install.json'))) `
    -Note 'install.json не записан'
Add-Result -Name 'service-install-fail:no-start' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда start')) `
    -Note 'до запуска службы дело не дошло'

# C. Служба уже существует (WinSW 1073): повторная установка не падает.
Reset-State
$paramsExists = New-ParamsFile -Mode 'service' -Name 'service-install-exists.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsExists`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTSERVICEINSTALL=exists', '/TESTHEALTH=ok'))
Add-Result -Name 'service-install-exists:code' -Expected 0 -Actual $code
Add-Result -Name 'service-install-exists:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба уже существует \(код 1073\)')) `
    -Note '1073 трактуется как успех'
Add-Result -Name 'service-install-exists:start' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN: команда start принята'))

# C2. Служба уже есть И работает, а установщик всё же вызвал install (гонка
#     проверки реестра): 1073 — успех, start вызывается всегда, но на
#     работающей службе WinSW вернёт 1056 — тоже успех.
Reset-State
$paramsExistsRunning = New-ParamsFile -Mode 'service' -Name 'service-exists-running.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsExistsRunning`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTSERVICEINSTALL=exists', '/TESTSERVICESTATE=running', '/TESTHEALTH=ok'))
Add-Result -Name 'service-exists-running:code' -Expected 0 -Actual $code
Add-Result -Name 'service-exists-running:1073' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба уже существует \(код 1073\)')) `
    -Note '1073 разобран общей функцией — успех'
Add-Result -Name 'service-exists-running:start' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN: команда start принята')) `
    -Note 'start вызывается всегда, а не пропускается по «уже RUNNING»'
Add-Result -Name 'service-exists-running:no-running-wait' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'уже запущена \(RUNNING\)')) `
    -Note 'ожидания RUNNING больше нет'

# C2b. Гонка: реестр при проверке пуст, install вернул 1073 — служба появилась
#      между проверками. 1073 — успех только для СВОЕЙ службы: чужой ImagePath
#      останавливает установку кодом 10 (файлы уже заменены), start не зовётся.
Reset-State
$paramsRace = New-ParamsFile -Mode 'service' -Name 'service-install-race.ini'
$foreignRaceImage = Join-Path $workRoot 'foreign-race\etn-service.exe'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsRace`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTSERVICEINSTALL=exists', "/TESTSERVICEIMAGE=$foreignRaceImage",
    '/TESTHEALTH=ok'))
Add-Result -Name 'service-install-race:code' -Expected 10 -Actual $code `
    -Note '1073 для чужой службы — сбой после копирования'
Add-Result -Name 'service-install-race:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'уже зарегистрирована, но не может быть использована: .*другим путём')) `
    -Note 'причина называет чужую службу'
Add-Result -Name 'service-install-race:no-start' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда start')) `
    -Note 'чужую службу не запускаем'
Add-Result -Name 'service-install-race:no-json' -Expected 0 `
    -Actual ([int](Test-Path (Join-Path $dataDir 'install.json'))) `
    -Note 'install.json не записан'

# C3. start 1056 (служба уже запущена) — успех: готовность подтверждает health.
Reset-State
$paramsStartRunning = New-ParamsFile -Mode 'service' -Name 'service-start-1056.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsStartRunning`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTSERVICEINSTALL=exists', '/TESTSERVICESTART=1056', '/TESTHEALTH=ok'))
Add-Result -Name 'service-start-1056:code' -Expected 0 -Actual $code `
    -Note 'start уже работающей службы (1056) — успех'
Add-Result -Name 'service-start-1056:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба уже запущена \(код 1056\)'))

# C4. start 1061 после подтверждённой остановки — ошибка 10, install.json не
#     пишется: служба не приняла управление.
Reset-State
$paramsStartRefused = New-ParamsFile -Mode 'service' -Name 'service-start-1061.ini'
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsStartRefused`"", '/TESTELEVATED=1', '/TESTSERVICE=absent',
    '/TESTSERVICEINSTALL=exists', '/TESTSERVICESTART=1061', '/TESTHEALTH=ok'))
Add-Result -Name 'service-start-1061:code' -Expected 10 -Actual $code `
    -Note 'start 1061 — сбой выполнения после копирования'
Add-Result -Name 'service-start-1061:no-json' -Expected 0 `
    -Actual ([int](Test-Path (Join-Path $dataDir 'install.json'))) `
    -Note 'install.json не записан'

# D. Обновление с уже зарегистрированной службой: install не вызывается,
#    конфигурацию WinSW читает при старте; start вызван, готовность — health.
$null = New-UpdateFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @($nodeArg, '/TESTHEALTH=ok'))
Add-Result -Name 'service-repeat:code' -Expected 0 -Actual $code
Add-Result -Name 'service-repeat:skip-install' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда install')) `
    -Note 'уже зарегистрированная служба не перегистрируется'
Add-Result -Name 'service-repeat:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'уже зарегистрирована')) `
    -Note 'install не требуется'
Add-Result -Name 'service-repeat:running' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN: команда start принята')) `
    -Note 'после замены файлов start вызван, готовность подтверждает health'

# E. Ремонт той же версии: start вызывается всегда (служба была остановлена
#    перед проверкой? нет — ремонт без замены файлов службу не останавливает,
#    start на работающей службе даёт 1056/0 — успех).
$null = New-UpdateFixture -OldVersion $version
New-ServiceFixture
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$code = Invoke-Setup -Arguments ($silent + $updateArgs + @($nodeArg, '/TESTHEALTH=ok'))
Add-Result -Name 'service-repair:code' -Expected 0 -Actual $code
Add-Result -Name 'service-repair:start' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN: команда start принята')) `
    -Note 'start вызывается всегда, даже если служба уже работала'
Add-Result -Name 'service-repair:no-running-wait' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'уже запущена \(RUNNING\)'))

# F. Удаление: stop и uninstall вызываются в этом порядке (та же функция, что
#    в uninstaller — проба /TESTUNINSTALLSERVICE).
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTELEVATED=1', '/TESTSERVICE=present',
    '/TESTUNINSTALLSERVICE=1'))
Add-Result -Name 'service-uninstall:code' -Expected 0 -Actual $code
$order = Get-LogPatternIndices -Patterns @(
    'команда stop',
    'Служба ETN остановлена',
    'команда uninstall',
    'Служба ETN снята (uninstall)')
Add-Result -Name 'service-uninstall:log-order' -Expected 1 `
    -Actual ([int](Test-LogOrder $order)) -Note ($order -join ' < ')
Add-Result -Name 'service-uninstall:result' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'TESTUNINSTALLSERVICE result=ok'))

# G. Отказ uninstall: код 10 с причиной.
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTELEVATED=1', '/TESTSERVICE=present',
    '/TESTSERVICEUNINSTALL=fail', '/TESTUNINSTALLSERVICE=1'))
Add-Result -Name 'service-uninstall-fail:code' -Expected 10 -Actual $code
Add-Result -Name 'service-uninstall-fail:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'не удалось снять службу ETN \(etn-service.exe uninstall вернул ошибку\)')) `
    -Note 'причина отказа — в журнале'

# H. Отказ останова при удалении: код 10 с причиной.
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTELEVATED=1', '/TESTSERVICE=present',
    '/TESTSERVICESTOP=fail', '/TESTUNINSTALLSERVICE=1'))
Add-Result -Name 'service-uninstall-stop-fail:code' -Expected 10 -Actual $code
Add-Result -Name 'service-uninstall-stop-fail:reason' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'служба ETN не остановлена: не удалось остановить службу ETN')) `
    -Note 'служба не остановилась — снятие не выполняется'

# H2. uninstall вернул 1072 (помечена на удаление): exit 0 не доказывает
#     снятие — подтверждаем status=NonExistent; оставшийся ключ реестра —
#     предупреждение о перезагрузке, удаление программы не отменяется.
Reset-State
$code = Invoke-Setup -Arguments ($silent + @('/TESTELEVATED=1', '/TESTSERVICE=present',
    '/TESTSERVICEUNINSTALL=1072', '/TESTUNINSTALLSERVICE=1'))
Add-Result -Name 'service-uninstall-1072:code' -Expected 0 -Actual $code `
    -Note '1072 — успех после подтверждения status=NonExistent'
Add-Result -Name 'service-uninstall-1072:confirm' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'подтверждаем удаление через status')) `
    -Note '1072 подтверждается polling-ом status'
Add-Result -Name 'service-uninstall-1072:removed' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Служба ETN снята \(uninstall\)')) `
    -Note 'status дошёл до NonExistent'
Add-Result -Name 'service-uninstall-1072:reboot-hint' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'SCM завершит удаление после перезагрузки')) `
    -Note 'оставшийся ключ — предупреждение, а не отказ'

# I. Режим app: служба не регистрируется, сервер поднимает пользователь,
#    health не блокирует установку.
Reset-State
$paramsApp = New-ParamsFile -Mode 'app' -Name 'service-app.ini'
$closedPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsApp`"", '/TESTELEVATED=1', '/TESTSERVICE=absent') +
    @($fastHealth, "/TESTHEALTHURL=http://127.0.0.1:$closedPort"))
Add-Result -Name 'service-app:code' -Expected 0 -Actual $code
Add-Result -Name 'service-app:no-install' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда install')) `
    -Note 'режим app службу не регистрирует'
Add-Result -Name 'service-app:log' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Режим app: служба ETN не регистрируется'))
Add-Result -Name 'service-app:no-health' -Expected 1 `
    -Actual ([int](Test-LatestLogContains -Pattern 'Режим app: health-check не выполняется'))
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
Add-Result -Name 'service-app:install-json' -Expected 1 `
    -Actual ([int]($jsonText -match '"mode":"app"')) -Note 'mode=app в install.json'

# J. Переключение режима при обновлении: install.json (app) главнее файла
#    параметров (service) — режим сохраняется, служба не регистрируется.
$null = New-UpdateFixture
Write-InstallJson (New-InstallJson -ProductVersion '0.15.0' -Mode 'app')
$null = New-BackupTestDatabase -Path (Join-Path $dataDir '_system.db') -Values @('alpha')
$paramsSwitch = New-ParamsFile -Mode 'service' -Name 'service-mode-switch.ini'
$closedPort = Get-FreeTcpPort
$code = Invoke-Setup -Arguments ($silent + @('/PRIVILEGEDPHASE',
    "/PARAMS=`"$paramsSwitch`"", '/TESTELEVATED=1', '/TESTSERVICE=absent', $nodeArg) +
    @($fastHealth, "/TESTHEALTHURL=http://127.0.0.1:$closedPort"))
Add-Result -Name 'service-mode-kept:code' -Expected 0 -Actual $code
Add-Result -Name 'service-mode-kept:no-install' -Expected 0 `
    -Actual ([int](Test-LatestLogContains -Pattern 'команда install')) `
    -Note 'режим из install.json не переключается файлом параметров'
$jsonText = Get-Content -LiteralPath (Join-Path $dataDir 'install.json') -Raw
Add-Result -Name 'service-mode-kept:install-json' -Expected 1 `
    -Actual ([int]($jsonText -match '"mode":"app"')) -Note 'mode=app сохранён'

# --- 8b1f5980 (приёмка 0978b96a): настоящий деинсталлятор --------------------
# Тестовая сборка без TestUninstallable деинсталлятора не создаёт, а
# /TESTUNINSTALLSERVICE вызывает снятие из процесса установки, где GServerDir
# задан, — поэтому блокер «в деинсталляторе ServiceExePath пуст» ею не ловился.
# Здесь собирается установщик С деинсталлятором (отдельный AppId) и запускается
# настоящий unins000.exe с моделью службы: /TESTSERVICEREALFILE=1 включает
# проверку существования etn-service.exe, как в продуктовой ветке, а путь
# службы обязан быть {app}\service\etn-service.exe.
Write-Host '=== 8b1f5980: настоящий деинсталлятор ==='
$uninsPayload = Join-Path $workRoot 'payload-uninstall'
Copy-Item -LiteralPath $payloadDir -Destination $uninsPayload -Recurse -Force
# Заглушка принадлежит установке ([Files] service\*), поэтому деинсталлятор
# удалит её вместе с остальными файлами — следов на машине не остаётся.
[System.IO.File]::WriteAllText((Join-Path $uninsPayload 'service\etn-service.exe'), 'stub')
$uninsBuildDir = Join-Path $workRoot 'build-uninstall'
$uninsBuildArgs = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $buildScript,
    '-Version', $version,
    '-TestMode', '-TestUninstallMode',
    '-BaseFilename', 'ETN-Uninst',
    '-PayloadRoot', $uninsPayload,
    '-OutputDir', $uninsBuildDir,
    '-TestAppDir', $appDir,
    '-TestDataDir', $dataDir
)
if ($IsccPath) { $uninsBuildArgs += @('-IsccPath', $IsccPath) }
& $psExe @uninsBuildArgs
if ($LASTEXITCODE -ne 0) { throw "Сборка тестового установщика с деинсталлятором не удалась (код $LASTEXITCODE)." }
$uninsSetup = Join-Path $uninsBuildDir "ETN-Uninst-unins-test-$version.exe"
if (-not (Test-Path -LiteralPath $uninsSetup)) { throw "Тестовый установщик с деинсталлятором не найден: $uninsSetup" }
$testUninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' +
    '{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'

Reset-State
$paramsRealUninstall = New-ParamsFile -Mode 'service' -Name 'service-real-uninstall.ini'
try {
    $installCode = Invoke-Setup -Path $uninsSetup -Arguments ($silent + @('/PRIVILEGEDPHASE',
        "/PARAMS=`"$paramsRealUninstall`"", '/TESTELEVATED=1', '/TESTSERVICE=present',
        '/TESTHEALTH=ok'))
    Add-Result -Name 'service-real-uninstall:install-code' -Expected 0 -Actual $installCode
    $serviceExePath = Join-Path $appDir 'service\etn-service.exe'
    Add-Result -Name 'service-real-uninstall:exe-present' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $serviceExePath)) `
        -Note 'перед удалением etn-service.exe на месте'
    $uninsPath = Join-Path $appDir 'unins000.exe'
    Add-Result -Name 'service-real-uninstall:uninstaller' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $uninsPath)) `
        -Note 'настоящий деинсталлятор создан'
    $uninstallCode = Invoke-Uninstaller -Path $uninsPath -Arguments @('/VERYSILENT',
        '/SUPPRESSMSGBOXES', '/NORESTART', '/TESTSERVICE=present',
        '/TESTSERVICEREALFILE=1')
    Add-Result -Name 'service-real-uninstall:code' -Expected 0 -Actual $uninstallCode `
        -Note 'удаление завершено (снятие службы не отменило его)'
    Add-Result -Name 'service-real-uninstall:files-removed' -Expected 0 `
        -Actual ([int](-not (Wait-PathGone -Path (Join-Path $appDir 'server\dist\index.js')))) `
        -Note 'файлы программы удалены'
    Add-Result -Name 'service-real-uninstall:uninstaller-gone' -Expected 1 `
        -Actual ([int](Wait-PathGone -Path $uninsPath)) `
        -Note 'деинсталлятор удалил себя'
    # Журнал удаления (InitializeUninstall): путь службы, команды и признак
    # того, что etn-service.exe ещё существовал в момент stop/uninstall.
    $uninstallLog = Get-ChildItem -LiteralPath (Join-Path $dataDir 'logs') -Filter 'uninstall-*.log' `
        -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    $uninsText = ''
    if ($uninstallLog) { $uninsText = Get-Content -LiteralPath $uninstallLog.FullName -Raw }
    $stopLine = [regex]::Match($uninsText, '(?m)^.*команда stop — успех[^\r\n]*')
    $uninstallLine = [regex]::Match($uninsText, '(?m)^.*команда uninstall — успех[^\r\n]*')
    $expectedStopPath = 'exe=' + $serviceExePath
    Add-Result -Name 'service-real-uninstall:stop-path' -Expected 1 `
        -Actual ([int]($stopLine.Success -and $stopLine.Value.Contains($expectedStopPath))) `
        -Note $(if ($stopLine.Success) { $stopLine.Value } else { 'строки stop нет' })
    Add-Result -Name 'service-real-uninstall:uninstall-path' -Expected 1 `
        -Actual ([int]($uninstallLine.Success -and $uninstallLine.Value.Contains($expectedStopPath))) `
        -Note $(if ($uninstallLine.Success) { $uninstallLine.Value } else { 'строки uninstall нет' })
    Add-Result -Name 'service-real-uninstall:file-existed' -Expected 2 `
        -Actual ([int]([regex]::Matches($uninsText, 'exists=1').Count)) `
        -Note 'stop и uninstall выполнены до удаления файлов'
    $stopIndex = $uninsText.IndexOf('команда stop — успех')
    $uninstallIndex = $uninsText.IndexOf('команда uninstall — успех')
    Add-Result -Name 'service-real-uninstall:order' -Expected 1 `
        -Actual ([int](($stopIndex -ge 0) -and ($uninstallIndex -gt $stopIndex))) `
        -Note 'stop → uninstall'
    Add-Result -Name 'service-real-uninstall:removed' -Expected 1 `
        -Actual ([int]($uninsText.Contains('Служба ETN снята (uninstall)'))) `
        -Note 'служба снята в usUninstall'

    # 98ad5eec: настоящий деинсталлятор удаляет ярлыки клиента «только для меня».
    # Ярлыки лежат вне {app} (песочница теста), поэтому их исчезновение — работа
    # деинсталлятора по журналу [Icons], а не удаление каталога программы.
    Write-Host '=== 98ad5eec: деинсталлятор удаляет ярлыки клиента ==='
    Reset-State
    $installCode = Invoke-Setup -Path $uninsSetup -Arguments ($silent + @(
        '/TESTSELECT=client-user', '/TESTUSERINSTALL=1', '/TESTELEVATED=1'))
    Add-Result -Name 'client-real-uninstall:install-code' -Expected 0 -Actual $installCode
    $clientDesktopLnk = Join-Path $workRoot 'shortcuts\desktop\ETN.lnk'
    $clientMenuLnk = Join-Path $workRoot 'shortcuts\menu\ETN.lnk'
    Add-Result -Name 'client-real-uninstall:lnk-before' -Expected 2 `
        -Actual ([int]([int](Test-Path -LiteralPath $clientDesktopLnk) + [int](Test-Path -LiteralPath $clientMenuLnk))) `
        -Note 'оба ярлыка созданы установкой'
    $clientUninsPath = Join-Path $appDir 'unins000.exe'
    Add-Result -Name 'client-real-uninstall:uninstaller' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $clientUninsPath))
    $uninstallCode = Invoke-Uninstaller -Path $clientUninsPath -Arguments @('/VERYSILENT',
        '/SUPPRESSMSGBOXES', '/NORESTART')
    Add-Result -Name 'client-real-uninstall:code' -Expected 0 -Actual $uninstallCode
    Add-Result -Name 'client-real-uninstall:desktop-gone' -Expected 1 `
        -Actual ([int](Wait-PathGone -Path $clientDesktopLnk)) `
        -Note 'ярлык рабочего стола удалён'
    Add-Result -Name 'client-real-uninstall:menu-gone' -Expected 1 `
        -Actual ([int](Wait-PathGone -Path $clientMenuLnk)) `
        -Note 'ярлык меню «Пуск» удалён'
    Add-Result -Name 'client-real-uninstall:files-gone' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath (Join-Path $appDir 'ETN.exe'))) `
        -Note 'файлы клиента удалены'

    # a7394117: одна запись деинсталляции в машинном режиме. Причина (верификация
    # aa5af30c): GUI-админ-установка при PrivilegesRequired=lowest пишет запись
    # в HKCU (Inno остаётся в неадминистративном режиме), тихое /ALLUSERS-
    # обновление — в HKLM, прежняя запись остаётся: в «Программах и компонентах»
    # две строки. Прогон без прав администратора: машинная область моделируется
    # поддеревом HKCU (/TESTUNINSTROOT), /TESTINNOADMINMODE=1 означает
    # «Inno записал HKLM».
    Write-Host '=== a7394117: одна запись деинсталляции в машинном режиме ==='
    $uninstScopeRoot = 'Software\ETN-Test\Uninstall'
    $machineScopeKey = 'HKCU:\' + $uninstScopeRoot + '\Machine\' +
        '{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    $scopeProfilesRoot = 'HKCU:\' + $uninstScopeRoot + '\Profiles'
    $profileSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
    $profileRecord = $scopeProfilesRoot + '\' + $profileSid +
        '\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    $profileWowRecord = $scopeProfilesRoot + '\' + $profileSid +
        '\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    $systemProfileRecord = $scopeProfilesRoot + '\S-1-5-18' +
        '\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    $defaultProfileRecord = $scopeProfilesRoot + '\.DEFAULT' +
        '\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    $classesHiveRecord = $scopeProfilesRoot + '\S-1-5-21-1111111111-2222222222-3333333333-1001_Classes' +
        '\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    # 7dcbeb0c: легитимная per-user установка клиента «только для меня» живёт
    # в профиле пользователя со своим InstallLocation. Машинная установка не
    # должна её удалять. $userClientDir моделирует %LOCALAPPDATA%\Programs\ETN:
    # каталог заведомо другой, чем {app} тестовой сборки.
    $userClientDir = Join-Path $workRoot 'user-client'
    $profileUserSid = 'S-1-5-21-1111111111-2222222222-3333333333-1002'
    $profileUserRecord = $scopeProfilesRoot + '\' + $profileUserSid +
        '\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    # Запись без InstallLocation/UninstallString: принадлежность доказать
    # нельзя — удалять нельзя (иначе снесём чужую установку вслепую).
    $profileUnknownSid = 'S-1-5-21-1111111111-2222222222-3333333333-1003'
    $profileUnknownRecord = $scopeProfilesRoot + '\' + $profileUnknownSid +
        '\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}_is1'
    $scopeParams = New-ParamsFile -Mode 'service' -Name 'scope-uninstall.ini'
    function Reset-UninstallScope {
        foreach ($key in @($machineScopeKey, $testUninstallKey)) {
            if (Test-Path -LiteralPath $key) {
                Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        if (Test-Path -LiteralPath $scopeProfilesRoot) {
            Remove-Item -LiteralPath $scopeProfilesRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    # Значения записи машинной установки — как их пишет Inno: InstallLocation
    # с хвостовым слэшем, UninstallString в кавычках.
    function Set-MachineRecordValues([string]$Key) {
        New-ItemProperty -Path $Key -Name 'InstallLocation' -Value ($appDir + '\') `
            -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $Key -Name 'UninstallString' `
            -Value ('"' + (Join-Path $appDir 'unins000.exe') + '"') `
            -PropertyType String -Force | Out-Null
    }
    function Set-UserRecordValues([string]$Key) {
        New-ItemProperty -Path $Key -Name 'InstallLocation' -Value ($userClientDir + '\') `
            -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $Key -Name 'UninstallString' `
            -Value ('"' + (Join-Path $userClientDir 'unins000.exe') + '"') `
            -PropertyType String -Force | Out-Null
    }
    function New-MachineScopeRecord([switch]$UserLike) {
        $null = New-Item -Path $machineScopeKey -Force
        if ($UserLike) { Set-UserRecordValues $machineScopeKey }
        else { Set-MachineRecordValues $machineScopeKey }
    }
    # Модель загруженных профилей: HKEY_USERS в прогоне без прав администратора
    # не читается, поэтому обход HKU подменяется поддеревом HKCU (тот же
    # /TESTUNINSTROOT). Служебные SID и .DEFAULT должны остаться нетронутыми.
    function New-ProfileSandbox {
        foreach ($key in @($profileRecord, $profileWowRecord, $systemProfileRecord,
                $defaultProfileRecord, $classesHiveRecord, $profileUserRecord,
                $profileUnknownRecord)) {
            $null = New-Item -Path $key -Force
        }
        Set-MachineRecordValues $profileRecord
        Set-MachineRecordValues $profileWowRecord
        Set-UserRecordValues $profileUserRecord
    }
    Reset-State
    Reset-UninstallScope

    # 1. Элевированная GUI-установка: Inno пишет HKCU. Машинная запись прежней
    #    установки (модель) должна быть удалена — иначе она останется дублем.
    #    Профили пользователей в этой ветке не трогаются.
    New-MachineScopeRecord
    New-ProfileSandbox
    $installCode = Invoke-Setup -Path $uninsSetup -Arguments ($silent + @('/PRIVILEGEDPHASE',
        "/PARAMS=`"$scopeParams`"", '/TESTELEVATED=1', '/TESTSERVICE=present',
        '/TESTHEALTH=ok', '/TESTADMINMODE=1', "/TESTUNINSTROOT=$uninstScopeRoot"))
    Add-Result -Name 'uninst-scope:gui-admin-code' -Expected 0 -Actual $installCode
    Add-Result -Name 'uninst-scope:gui-admin-hkcu' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $testUninstallKey)) `
        -Note 'Inno записал HKCU (неадминистративный режим)'
    Add-Result -Name 'uninst-scope:gui-admin-hklm-removed' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath $machineScopeKey)) `
        -Note 'машинная запись прежней установки удалена'
    Add-Result -Name 'uninst-scope:gui-admin-profile-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $profileRecord)) `
        -Note 'в ветке удаления HKLM профили пользователей не трогаются'

    # 1b. Та же ветка, но в «машинной» области лежит запись per-user установки
    #     клиента (чужой InstallLocation). Удалять её нельзя (7dcbeb0c): иначе
    #     у пользователя пропадёт запись «ETN» из его HKCU, а файлы останутся.
    Reset-State
    New-MachineScopeRecord -UserLike
    $scopeParams = New-ParamsFile -Mode 'service' -Name 'scope-uninstall-foreign.ini'
    $foreignCode = Invoke-Setup -Path $uninsSetup -Arguments ($silent + @('/PRIVILEGEDPHASE',
        "/PARAMS=`"$scopeParams`"", '/TESTELEVATED=1', '/TESTSERVICE=present',
        '/TESTHEALTH=ok', '/TESTADMINMODE=1', "/TESTUNINSTROOT=$uninstScopeRoot"))
    Add-Result -Name 'uninst-scope:foreign-machine-code' -Expected 0 -Actual $foreignCode
    Add-Result -Name 'uninst-scope:foreign-machine-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $machineScopeKey)) `
        -Note 'запись per-user установки в «машинной» области не удалена'

    # 2. Тихое /ALLUSERS-обновление: Inno пишет HKLM (в модели — заранее
    #    созданный ключ песочницы), запись HKCU от GUI-админ-установки удаляется.
    #    Ключевое отличие: установщик запущен не тем пользователем (в жизни —
    #    служба LocalSystem), поэтому запись ищется в загруженных профилях
    #    HKEY_USERS (в прогоне — в песочнице профилей).
    #    Файл параметров удаляется установщиком после чтения (тест 22) —
    #    готовим новый, иначе привилегированная фаза получит пустой набор.
    New-MachineScopeRecord
    New-ProfileSandbox
    $scopeParams = New-ParamsFile -Mode 'service' -Name 'scope-uninstall-update.ini'
    $updateCode = Invoke-Setup -Path $uninsSetup -Arguments ($silent + @('/PRIVILEGEDPHASE',
        "/PARAMS=`"$scopeParams`"", '/TESTELEVATED=1', '/TESTSERVICE=present',
        '/TESTHEALTH=ok', '/TESTADMINMODE=1', '/TESTINNOADMINMODE=1',
        "/TESTUNINSTROOT=$uninstScopeRoot"))
    Add-Result -Name 'uninst-scope:allusers-code' -Expected 0 -Actual $updateCode
    Add-Result -Name 'uninst-scope:allusers-hkcu-removed' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath $testUninstallKey)) `
        -Note 'запись GUI-админ-установки (HKCU) удалена'
    Add-Result -Name 'uninst-scope:allusers-hklm' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $machineScopeKey)) `
        -Note 'машинная запись осталась'
    Add-Result -Name 'uninst-scope:one-record' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $testUninstallKey) + [int](Test-Path -LiteralPath $machineScopeKey)) `
        -Note 'в «Программах и компонентах» одна запись (HKCU+HKLM)'
    Add-Result -Name 'uninst-scope:profile-hkcu-removed' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath $profileRecord)) `
        -Note 'запись в чужом загруженном профиле удалена (аналог HKEY_USERS)'
    Add-Result -Name 'uninst-scope:profile-wow-removed' -Expected 0 `
        -Actual ([int](Test-Path -LiteralPath $profileWowRecord)) `
        -Note 'WOW6432Node-вариант в чужом профиле удалён'
    Add-Result -Name 'uninst-scope:profile-user-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $profileUserRecord)) `
        -Note 'per-user клиент в профиле пользователя сохранён (7dcbeb0c)'
    Add-Result -Name 'uninst-scope:profile-unknown-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $profileUnknownRecord)) `
        -Note 'запись без InstallLocation/UninstallString не удаляется'
    Add-Result -Name 'uninst-scope:system-profile-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $systemProfileRecord)) `
        -Note 'служебный профиль S-1-5-18 не трогается'
    Add-Result -Name 'uninst-scope:default-profile-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $defaultProfileRecord)) `
        -Note '.DEFAULT не трогается'
    Add-Result -Name 'uninst-scope:classes-hive-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $classesHiveRecord)) `
        -Note 'служебная ветка *_Classes не трогается'
    $scopeLogText = ''
    $scopeLog = Get-LatestLog
    if ($scopeLog) { $scopeLogText = Get-Content -LiteralPath $scopeLog.FullName -Raw }
    Add-Result -Name 'uninst-scope:log' -Expected 1 `
        -Actual ([int]($scopeLogText.Contains('Удалена запись деинсталляции прежней области'))) `
        -Note 'удаление записано в журнал установки'

    # 3. Режим «только для меня»: машинную запись не трогаем (прав на HKLM нет,
    #    запись пользователя остаётся единственной, как и было до исправления).
    Reset-State
    New-MachineScopeRecord
    New-ProfileSandbox
    $userCode = Invoke-Setup -Path $uninsSetup -Arguments ($silent + @(
        '/TESTSELECT=client-user', '/TESTUSERINSTALL=1', '/TESTELEVATED=1'))
    Add-Result -Name 'uninst-scope:user-mode-code' -Expected 0 -Actual $userCode
    Add-Result -Name 'uninst-scope:user-mode-machine-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $machineScopeKey)) `
        -Note 'в режиме «только для меня» машинная запись не удаляется'
    Add-Result -Name 'uninst-scope:user-mode-hkcu' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $testUninstallKey)) `
        -Note 'запись пользовательской установки на месте'
    Add-Result -Name 'uninst-scope:user-mode-profile-kept' -Expected 1 `
        -Actual ([int](Test-Path -LiteralPath $profileRecord)) `
        -Note 'в режиме «только для меня» профили пользователей не трогаются'
} finally {
    # Деинсталлятор при отказе (мутация) оставляет установку и запись в HKCU:
    # убираем за собой, чтобы прогон не оставлял следов.
    if (Test-Path -LiteralPath $testUninstallKey) {
        Remove-Item -LiteralPath $testUninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath 'HKCU:\Software\ETN-Test') {
        Remove-Item -LiteralPath 'HKCU:\Software\ETN-Test' -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $appDir) {
        Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction SilentlyContinue
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
