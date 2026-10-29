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

# --- Сторож статических проверок ---------------------------------------------
# Поиск идёт по НЕПУСТЫМ строкам без комментария. Прежний подстрочный поиск по
# всему тексту проходил на закомментированной строке (`; GScopeUserRadio.OnClick
# := ...`) — дефект приёмки каркаса (9b310991). В Inno `;` — комментарий только
# в начале строки (в параметрах секций он разделитель), поэтому строка
# считается комментарием, если после Trim начинается с ';'.
function Test-IssCode {
    param([string]$Text, [string]$Pattern)
    foreach ($line in ($Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '') { continue }
        if ($trimmed.StartsWith(';')) { continue }
        if ($trimmed -match $Pattern) { return $true }
    }
    return $false
}

function Add-StaticResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $script:results.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $markText = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-28} {2}" -f $markText, $Name, $Note)
}

Write-Host '=== Статические проверки .iss ==='
$issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8

# Сторож самопроверяется: закомментированный код НЕ считается, рабочий — считается.
$commentSample = "; GScopeUserRadio.OnClick := @UpdateComponentsState;"
$codeSample = "  GScopeUserRadio.OnClick := @UpdateComponentsState;"
$onClickPattern = [regex]::Escape('GScopeUserRadio.OnClick := @UpdateComponentsState;')
Add-StaticResult -Name 'static-guard:ignores-comments' `
    -Ok (-not (Test-IssCode -Text $commentSample -Pattern $onClickPattern)) `
    -Note 'закомментированный OnClick не считается кодом'
Add-StaticResult -Name 'static-guard:finds-code' `
    -Ok (Test-IssCode -Text $codeSample -Pattern $onClickPattern) `
    -Note 'рабочий OnClick находится'

$msgBoxMatches = [regex]::Matches($issText, '(?<!Suppressible)MsgBox\s*\(')
if ($msgBoxMatches.Count -gt 0) {
    $script:results.Add([pscustomobject]@{ Scenario = 'static:no-msgbox'; Expected = 0; Actual = $msgBoxMatches.Count; Ok = $false; Note = 'MsgBox в .iss' })
    Write-Host ("FAIL  static:no-msgbox              найдено MsgBox: {0}" -f $msgBoxMatches.Count)
} else {
    $script:results.Add([pscustomobject]@{ Scenario = 'static:no-msgbox'; Expected = 0; Actual = 0; Ok = $true; Note = '' })
    Write-Host 'OK    static:no-msgbox              MsgBox в .iss нет'
}
foreach ($required in @('/SUPPRESSMSGBOXES', '/NORESTART', 'SERVERONLY', 'GetCustomSetupExitCode')) {
    $present = Test-IssCode -Text $issText -Pattern ([regex]::Escape($required))
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
    @{ Name = 'static:radio-onclick-user'; Pattern = [regex]::Escape('GScopeUserRadio.OnClick := @UpdateComponentsState;'); Note = 'радиокнопка «только для меня»' },
    @{ Name = 'static:radio-onclick-machine'; Pattern = [regex]::Escape('GScopeMachineRadio.OnClick := @UpdateComponentsState;'); Note = 'радиокнопка «для всех»' },
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
    @{ Name = 'static:reason-file'; Pattern = [regex]::Escape('reason_file='); Note = 'причина отказа предусловия — родителю' }
)
foreach ($check in $staticChecks) {
    Add-StaticResult -Name $check.Name -Ok (Test-IssCode -Text $issText -Pattern $check.Pattern) -Note $check.Note
}
# Поля выбора каталога данных быть не должно (ADR 144bcdb0): проверка на
# отсутствие страницы, а не на наличие.
Add-StaticResult -Name 'static:no-datadir-choice' `
    -Ok (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('CreateInputDirPage')))) `
    -Note 'нет страницы выбора каталога данных'
# Замечание 3: тестовый хук health-check не должен попадать в продуктовую сборку.
$hookUnderIfdef = [regex]::IsMatch($issText, '#ifdef\s+TestMode\s*\r?\n\s*if GTestHealth')
Add-StaticResult -Name 'static:health-hook-ifdef' -Ok $hookUnderIfdef -Note 'хук /TESTHEALTH под #ifdef TestMode'

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
