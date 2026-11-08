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
