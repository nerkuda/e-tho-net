<#
.SYNOPSIS
    Статические проверки исходников установщика ETN (installer/etn.iss и build.ps1).

.DESCRIPTION
    Выделено из installer/tests/silent-codes.ps1 (задача 8789381a, этап 2):
    проверки .iss, клиента и ярлыков (98ad5eec) и UX-текстов (860def0d) не
    требуют запуска установщика. После удаления silent-codes (этап 6) они
    остаются здесь и продолжают проверять исходник. Проверки свежести payload
    (build:*) выделены в installer/tests/payload-freshness.ps1: они собирают
    установщик из фикстур и требуют Inno Setup 6.

    Результаты пишутся в список $script:StaticResults (объекты с полями
    Scenario/Expected/Actual/Ok/Note).

    Самостоятельный прогон (без установщика, ВМ и Inno Setup):

        pwsh installer/tests/iss-static.ps1

.NOTES
    -AssertNoHooks (этап 5): включён по умолчанию — в etn.iss не должно быть
    /TEST*-параметров и #ifdef TestMode/TestUninstallable, в build.ps1 —
    -TestMode и тестовых каталогов.
#>

$script:IssStaticDir = $PSScriptRoot

. (Join-Path $PSScriptRoot 'iss-guard.ps1')

# Общий счётчик результатов: задаёт вызывающий скрипт (или самостоятельный
# прогон ниже).
function Add-StaticResult {
    param([string]$Name, [bool]$Ok, [string]$Note = '')
    $target = Get-Variable -Name StaticResults -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if ($null -eq $target) {
        throw 'Add-StaticResult: $script:StaticResults не задан вызывающим скриптом.'
    }
    $target.Add([pscustomobject]@{ Scenario = $Name; Expected = 1; Actual = [int]$Ok; Ok = $Ok; Note = $Note })
    $mark = if ($Ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0}  {1,-28} {2}" -f $mark, $Name, $Note)
}

# --- 4dc117f5: контракт «текст в теле функции» после выноса в [CustomMessages]
# Текст UI-строки переехал в сообщение; проверка не ослаблена, а перенесена:
# в теле функции обязан остаться вызов ключа, а в значении сообщения — прежний
# текст (дословно, как его видел пользователь).
function Test-MessageCall {
    param([string]$Body, [string]$Key)
    return Test-IssCode -Text $Body -Pattern ([regex]::Escape("CustomMessage('$Key')"))
}

function Test-MessageContains {
    param([string]$Key, [string]$Text)
    $value = Get-IssCustomMessage -Text $issText -Name $Key
    return ($null -ne $value) -and $value.Contains($Text)
}

function Test-MessageTextInBody {
    param([string]$Body, [string]$Key, [string]$Text)
    return (Test-MessageCall -Body $Body -Key $Key) -and (Test-MessageContains -Key $Key -Text $Text)
}

# Текст отказа «сервер без прав администратора» для сторожа .iss
# (static:server-needs-admin-launch); тот же текст проверяется в E2E
# (GuiTexts.ServerNeedsAdmin), чтобы ожидаемые строки не разъехались.
function Get-IssServerNeedsAdminText {
    return 'Для установки сервера закройте установщик и запустите его от имени администратора (правый клик → Запуск от имени администратора).'
}

# Инвертированный сторож этапа 5 (8789381a): после удаления хуков в исходниках
# не должно остаться ни одного /TEST*-параметра, ни #ifdef TestMode, ни
# -TestMode в build.ps1. Пока хуки на месте, проверка не вызывается.
function Test-IssNoTestHooks {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $issPath = Join-Path $RepoRoot 'installer\etn.iss'
    $buildPath = Join-Path $RepoRoot 'installer\build.ps1'
    $issText = Get-Content -LiteralPath $issPath -Raw -Encoding UTF8
    $buildText = Get-Content -LiteralPath $buildPath -Raw -Encoding UTF8
    $problems = New-Object System.Collections.Generic.List[string]

    $testParam = Test-IssCode -Text $issText -Pattern "ParamValue\('TEST"
    if ($testParam) { $problems.Add("в [Code] читается /TEST-параметр (ParamValue('TEST...)") }

    $ifdefLines = @(Get-IssStrippedLines -Text $issText |
        Where-Object { $_ -match '^\s*#ifdef\s+(TestMode|TestUninstallable)\b' })
    if ($ifdefLines.Count -gt 0) {
        $problems.Add('#ifdef TestMode/TestUninstallable в etn.iss: ' + $ifdefLines.Count)
    }

    $testVars = @(Get-IssStrippedLines -Text $issText |
        Where-Object { $_ -match '\bGTest[A-Za-z]*\b' })
    if ($testVars.Count -gt 0) {
        $problems.Add('объявления/чтения GTest* в etn.iss: ' + $testVars.Count)
    }

    if (($buildText -match '\[switch\]\$TestMode\b') -or ($buildText -match '\$TestMode\b') -or
        ($buildText -match '\$TestAppDir\b') -or ($buildText -match '\$TestDataDir\b') -or
        ($buildText -match '\$TestUninstallMode\b')) {
        $problems.Add('-TestMode и тестовые каталоги в build.ps1')
    }

    return [pscustomobject]@{
        Ok      = ($problems.Count -eq 0)
        Message = if ($problems.Count -eq 0) {
            'хуков /TEST*, #ifdef TestMode/TestUninstallable, GTest* и -TestMode нет'
        } else {
            $problems -join '; '
        }
    }
}

# Выполнить все статические проверки исходников установщика.
function Invoke-IssStaticChecks {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [System.Collections.Generic.List[object]]$Results,
        [switch]$AssertNoHooks = $true
    )

    if ($null -ne $Results) { $script:StaticResults = $Results }

    $repoRoot = $RepoRoot
    $installerDir = Join-Path $repoRoot 'installer'
    $issPath = Join-Path $installerDir 'etn.iss'
    $buildScript = Join-Path $installerDir 'build.ps1'

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
        @{ Name = 'static:firewall-checkbox'; Pattern = [regex]::Escape("CustomMessage('EtnLanCheckbox')"); Note = 'чекбокс согласия — текст в [CustomMessages]' },
        @{ Name = 'static:firewall-uninstall'; Pattern = [regex]::Escape('CurUninstallStepChanged'); Note = 'правило удаляется при удалении программы' },
        @{ Name = 'static:display-name-validation'; Pattern = [regex]::Escape('function ValidDisplayName'); Note = 'display_name из /PARAMS проверяется (дефект 6)' },
        @{ Name = 'static:reason-file'; Pattern = [regex]::Escape('reason_file='); Note = 'причина отказа предусловия — родителю' },
        @{ Name = 'static:backup-entry'; Pattern = [regex]::Escape('function CreateDatabaseBackup(const Needed: Boolean): Boolean'); Note = 'бэкап: решение о необходимости передаёт вызывающий' },
        @{ Name = 'static:setup-mutex'; Pattern = [regex]::Escape('SetupMutex=ETNSetup'); Note = 'параллельный запуск установщика запрещён' },
        @{ Name = 'static:uninstall-scope-cleanup'; Pattern = [regex]::Escape('RemoveDuplicateUninstallRecord;'); Note = 'запись деинсталляции прежней области удаляется после установки (a7394117)' },
        @{ Name = 'static:uninstall-user-hives'; Pattern = [regex]::Escape("RegGetSubkeyNames(HKU, '', Names)"); Note = 'при /ALLUSERS запись ищется в загруженных профилях HKEY_USERS (a7394117)' },
        @{ Name = 'static:appid-single-source'; Pattern = [regex]::Escape("UNINSTALL_KEY_NAME = '{#ProductUninstallKey}';"); Note = 'имя ключа деинсталляции берётся из AppId, без второго литерала (a7394117)' },
        @{ Name = 'static:uninstall-record-owner'; Pattern = [regex]::Escape('if not IsMachineUninstallRecord(Root, SubKey) then'); Note = 'удаляется только запись машинной установки; per-user клиент сохраняется (7dcbeb0c)' },
        @{ Name = 'static:init-check'; Pattern = [regex]::Escape('init --check'); Note = 'критерий hasFirstUser через CLI' },
        @{ Name = 'static:key-out'; Pattern = [regex]::Escape('--key-out'); Note = 'ключ в защищённый файл' },
        @{ Name = 'static:env-data-dir'; Pattern = [regex]::Escape("SetEnvironmentVariableW('ETN_DATA_DIR'"); Note = 'окружение init' },
        @{ Name = 'static:env-port'; Pattern = [regex]::Escape("SetEnvironmentVariableW('ETN_PORT'"); Note = '' },
        @{ Name = 'static:env-host'; Pattern = [regex]::Escape("SetEnvironmentVariableW('ETN_HOST'"); Note = '' },
        @{ Name = 'static:icacls'; Pattern = [regex]::Escape('icacls.exe'); Note = 'ACL каталога ключа' },
        @{ Name = 'static:key-file'; Pattern = [regex]::Escape('primary-key.txt'); Note = 'защищённый временный файл ключа' },
        @{ Name = 'static:key-close-warning'; Pattern = [regex]::Escape("CustomMessage('EtnKeyNotSavedPrompt')"); Note = 'закрытие без подтверждения предупреждает' },
        @{ Name = 'static:init-once'; Pattern = [regex]::Escape('etn init не вызывается'); Note = 'повторная инициализация запрещена' }
    )
    foreach ($check in $staticChecks) {
        Add-StaticResult -Name $check.Name -Ok (Test-IssCode -Text $issText -Pattern $check.Pattern) -Note $check.Note
    }

    # 686c5d76: экран первичного ключа (перенос статических проверок из
    # init-key.ps1, этап 6 задачи 8789381a). Текст переехал в [CustomMessages]:
    # в теле экрана обязан остаться вызов, а прежний текст — в значении.
    $keyPageBody = Get-IssFunctionBody -Text $issText -Name 'CreateKeyPage'
    foreach ($pair in @(
            @{ Name = 'static:key-confirm'; Key = 'EtnKeySavedCheckbox'; Text = 'Я сохранил ключ' },
            @{ Name = 'static:key-warning'; Key = 'EtnKeyPageNote'; Text = 'Ключ показывается один раз' })) {
        $msgValue = Get-IssCustomMessage -Text $issText -Name $pair.Key
        $ok = (Test-IssCode -Text $keyPageBody -Pattern ([regex]::Escape("CustomMessage('$($pair.Key)')"))) -and
            ($null -ne $msgValue) -and $msgValue.Contains($pair.Text)
        Add-StaticResult -Name $pair.Name -Ok $ok -Note $pair.Key
    }
    # Значение ключа не пишется в журнал: ни одна строка кода LogLine не
    # содержит GPendingKey (комментарии не считаются — общий сторож).
    $keyInLog = Test-IssCode -Text $issText -Pattern 'LogLine\([^\r\n]*GPendingKey'
    Add-StaticResult -Name 'static:key-not-logged' -Ok (-not $keyInLog) -Note 'LogLine без GPendingKey'

    # f7887a35: журнал запуска не теряется. Четыре свойства обязательны вместе:
    # (1) имя файла уникально для запуска — уже существующий файл не
    # используется (метка времени до секунды + номер попытки);
    # (2) успех — результат записи, а не FileExists (SaveStringsToUTF8File
    # возвращает False, когда каталог закрыт ACL, — FileExists при этом уже
    # истинно на чужом файле, и журнал молча пропадал);
    # (3) факт записи подтверждается чтением файла назад;
    # (4) запись по ходу установки тоже проверяется — при отказе строка уходит
    # в журнал Inno, а не теряется.
    $tryInitBody = Get-IssFunctionBody -Text $issText -Name 'TryInitLog'
    $logProbeBody = Get-IssFunctionBody -Text $issText -Name 'LogProbeWritten'
    $logLineBody = Get-IssFunctionBody -Text $issText -Name 'LogLine'
    Add-StaticResult -Name 'static:log-unique-name' -Ok (
        (Test-IssCode -Text $tryInitBody -Pattern ([regex]::Escape('if FileExists(Candidate) then Continue'))) -and
        (Test-IssCode -Text $tryInitBody -Pattern ([regex]::Escape("Candidate := Dir + '\' + Base + '-' + IntToStr(N) + '.log'")))
    ) -Note 'своё имя на запуск: чужой файл не используется, номер попытки в имени'
    Add-StaticResult -Name 'static:log-write-result' -Ok (
        (Test-IssCode -Text $logProbeBody -Pattern ([regex]::Escape('if not SaveStringsToUTF8File(FileName, Lines, True) then Exit'))) -and
        (Test-IssCode -Text $logProbeBody -Pattern ([regex]::Escape('if not LoadStringsFromFile(FileName, Lines) then Exit'))) -and
        (Test-IssCode -Text $logProbeBody -Pattern ([regex]::Escape('Result := Lines[Count - 1] = Marker'))) -and
        (Test-IssCode -Text $tryInitBody -Pattern ([regex]::Escape('if not LogProbeWritten(Candidate, Marker) then Continue')))
    ) -Note 'успех — результат записи и чтения назад, а не FileExists'
    Add-StaticResult -Name 'static:log-append-result' -Ok (
        (Test-IssCode -Text $logLineBody -Pattern ([regex]::Escape('if not AppendUtf8Line(GLogPath, Line) then')))
    ) -Note 'неудачная дописка строки дублируется в журнал Inno'
    Add-StaticResult -Name 'static:log-name-attempts' -Ok (
        (Test-IssCode -Text $issText -Pattern ([regex]::Escape('LOG_NAME_ATTEMPTS = 100'))) -and
        (Test-IssCode -Text $tryInitBody -Pattern ([regex]::Escape('for N := 0 to LOG_NAME_ATTEMPTS - 1 do')))
    ) -Note 'число попыток имени — константа, цикл по ней'
    $initLogBody = Get-IssFunctionBody -Text $issText -Name 'InitLog'
    Add-StaticResult -Name 'static:log-fallback' -Ok (
        (Test-IssCode -Text $initLogBody -Pattern ([regex]::Escape("TryInitLog(GDataDir + '\logs', 'install',"))) -and
        (Test-IssCode -Text $initLogBody -Pattern ([regex]::Escape("TryInitLog(TempDir, 'install', 'ETN setup log')")))
    ) -Note 'каталог данных, затем %TEMP% — оба пути с проверкой записи'
    # Правило аналогов: журнал удаления строил имя так же и терялся бы так же.
    $uninsBody = Get-IssFunctionBody -Text $issText -Name 'InitializeUninstall'
    $uninsManualName = Test-IssCode -Text $uninsBody -Pattern ([regex]::Escape("'\uninstall-' +"))
    Add-StaticResult -Name 'static:uninstall-log-shared' -Ok (
        (Test-IssCode -Text $uninsBody -Pattern ([regex]::Escape("TryInitLog(GDataDir + '\logs', 'uninstall',"))) -and
        (Test-IssCode -Text $uninsBody -Pattern ([regex]::Escape("TryInitLog(ExpandConstant('{tmp}'), 'etn-uninstall',"))) -and
        (-not $uninsManualName)
    ) -Note 'журнал удаления — тот же TryInitLog, имя не собирается вручную'

    # a34f48da: снимок отката — перенос каталога, а не побайтовая копия. Копия
    # дерева серверной части занимала 8,5–18,9 с, а реальный этап «Снимок
    # отката» шёл 48–72 с в silent и больше 20 минут в GUI. Обязательные
    # свойства: перенос первым (копия — только запасной путь), неудачный
    # снимок возвращает уже перенесённое, откат возвращает снимок
    # переименованием, данные пользователя в снимок не попадают.
    $takeSnapshotBody = Get-IssFunctionBody -Text $issText -Name 'TakeSnapshot'
    $createSnapshotBody = Get-IssFunctionBody -Text $issText -Name 'CreateRollbackSnapshot'
    $undoMovesBody = Get-IssFunctionBody -Text $issText -Name 'UndoSnapshotMoves'
    $replaceBody = Get-IssFunctionBody -Text $issText -Name 'ReplaceTreeFromSnapshot'
    Add-StaticResult -Name 'static:snapshot-move-first' -Ok (
        (Test-IssCode -Text $takeSnapshotBody -Pattern ([regex]::Escape('if MoveFileExW(Src, Dest, 0) then'))) -and
        (Test-IssCode -Text $createSnapshotBody -Pattern ([regex]::Escape("TakeSnapshot(GServerDir + '\server', Dir + '\server', 'server',"))) -and
        (Test-IssCode -Text $createSnapshotBody -Pattern ([regex]::Escape("TakeSnapshot(GServerDir + '\service', Dir + '\service', 'service',")))
    ) -Note 'снимок server/service создаётся переносом каталога'
    Add-StaticResult -Name 'static:snapshot-no-copy-in-create' -Ok (
        -not (Test-IssCode -Text $createSnapshotBody -Pattern 'CopyTreeRec\(')
    ) -Note 'в создании снимка побайтовой копии нет — только TakeSnapshot'
    Add-StaticResult -Name 'static:snapshot-copy-fallback' -Ok (
        (Test-IssCode -Text $takeSnapshotBody -Pattern ([regex]::Escape('if not CopyTreeRec(Src, Dest) then')))
    ) -Note 'другой том/занятый файл: перенос не удался — прежняя копия остаётся'
    <# Неудачный снимок обязан вернуть перенесённые каталоги, но НЕ должен
      удалять каталог снимка, если возврат не удался: там единственная копия
      файлов сервера (замечание приёмки 1). Поэтому вызов — под условием, а
      DelTree идёт только после успешного возврата; флаг переноса снимается
      только подтверждённым возвратом. #>
    $undoGuards = @(Get-IssStrippedLines -Text $createSnapshotBody |
        Where-Object { $_ -match [regex]::Escape('if not UndoSnapshotMoves(Dir) then') })
    $undoBareCalls = @(Get-IssStrippedLines -Text $createSnapshotBody |
        Where-Object { $_ -match ('^\s*UndoSnapshotMoves\(Dir\);') })
    $delTreeAt = -1; $undoGuardAt = -1
    $createLines = @(Get-IssStrippedLines -Text $createSnapshotBody)
    for ($i = 0; $i -lt $createLines.Count; $i++) {
        if (($undoGuardAt -lt 0) -and ($createLines[$i] -match [regex]::Escape('if not UndoSnapshotMoves(Dir) then'))) { $undoGuardAt = $i }
        if (($delTreeAt -lt 0) -and ($createLines[$i] -match 'DelTree\(Dir')) { $delTreeAt = $i }
    }
    Add-StaticResult -Name 'static:snapshot-failure-undoes-moves' -Ok (
        ($undoGuards.Count -ge 2) -and ($undoBareCalls.Count -eq 0) -and
        (Test-IssCode -Text $undoMovesBody -Pattern ([regex]::Escape("MoveFileExW(Dir + '\server', GServerDir + '\server', 0)"))) -and
        (Test-IssCode -Text $undoMovesBody -Pattern ([regex]::Escape("MoveFileExW(Dir + '\service', GServerDir + '\service', 0)")))
    ) -Note ('неудачный снимок возвращает перенесённые каталоги под условием (вызовов: {0}, без условия: {1})' -f $undoGuards.Count, $undoBareCalls.Count)
    Add-StaticResult -Name 'static:snapshot-undo-keeps-snapshot' -Ok (
        ($undoGuardAt -ge 0) -and ($delTreeAt -gt $undoGuardAt) -and
        (Test-IssCode -Text $createSnapshotBody -Pattern ([regex]::Escape('каталог снимка НЕ удалён')))
    ) -Note 'при неудачном возврате каталог снимка не удаляется, путь сообщается в журнал'
    $undoServerResets = @(Get-IssStrippedLines -Text $undoMovesBody |
        Where-Object { $_ -match 'GSnapshotMovedServer := False;' })
    $undoServiceResets = @(Get-IssStrippedLines -Text $undoMovesBody |
        Where-Object { $_ -match 'GSnapshotMovedService := False;' })
    Add-StaticResult -Name 'static:snapshot-undo-keeps-flag' -Ok (
        (Test-IssCode -Text $undoMovesBody -Pattern ([regex]::Escape("LogLine('INFO', 'Снимок отката: server возвращён на место');"))) -and
        (Test-IssCode -Text $undoMovesBody -Pattern ([regex]::Escape("LogLine('INFO', 'Снимок отката: service возвращён на место');"))) -and
        (Test-IssCode -Text $undoMovesBody -Pattern ([regex]::Escape('Result := True;'))) -and
        (Test-IssCode -Text $undoMovesBody -Pattern ([regex]::Escape("LogLine('WARN', 'Снимок отката: server не удалось вернуть из ' + Dir);"))) -and
        ($undoServerResets.Count -eq 1) -and ($undoServiceResets.Count -eq 1) -and
        (@(Get-IssStrippedLines -Text $issText | Where-Object { $_ -match '^\s*function\s+UndoSnapshotMoves\b' }).Count -eq 1)
    ) -Note ('флаг переноса снимается только подтверждённым возвратом (сбросов server: {0}, service: {1})' -f $undoServerResets.Count, $undoServiceResets.Count)
    <# Каталог-приёмник создаётся ДО переноса: MoveFileExW не создаёт родителя, и
      без ForceDirectories(Dir) перенос молча падал в побайтовую копию (блокер
      приёмки 1). #>
    $dirCreateAt = -1; $firstSnapshotAt = -1
    for ($i = 0; $i -lt $createLines.Count; $i++) {
        if (($dirCreateAt -lt 0) -and ($createLines[$i] -match [regex]::Escape('if not ForceDirectories(Dir) then'))) { $dirCreateAt = $i }
        if (($firstSnapshotAt -lt 0) -and ($createLines[$i] -match 'TakeSnapshot\(')) { $firstSnapshotAt = $i }
    }
    Add-StaticResult -Name 'static:snapshot-dir-created' -Ok (
        ($dirCreateAt -ge 0) -and ($firstSnapshotAt -gt $dirCreateAt) -and
        (Test-IssCode -Text $createSnapshotBody -Pattern ([regex]::Escape('не удалось создать каталог снимка')))
    ) -Note ("каталог-приёмник создаётся до переноса (строка {0} < вызов снимка {1})" -f ($dirCreateAt + 1), ($firstSnapshotAt + 1))
    Add-StaticResult -Name 'static:rollback-restores-by-move' -Ok (
        (Test-IssCode -Text $replaceBody -Pattern ([regex]::Escape('Moved := MoveFileExW(Src, Dest, 0);'))) -and
        (Test-IssCode -Text $replaceBody -Pattern ([regex]::Escape('else if not CopyTreeRec(Src, Dest) then')))
    ) -Note 'откат файлов возвращает снимок переносом, копия — запасной путь'
    <# Ожидаемый каталог, которого нет в снимке, — потеря снимка: откат не должен
      удалять текущие файлы и «отчитываться успехом», ничего не вернув. #>
    $restoreBody = Get-IssFunctionBody -Text $issText -Name 'RestoreInstallFiles'
    <# Объявление функции разбито на две строки (Src, Dest, Tag; Expected), поэтому
      склеиваем строку объявления со следующей. #>
    $replaceDeclOk = $false
    $issDeclLines = @(Get-IssStrippedLines -Text $issText)
    for ($i = 0; $i -lt ($issDeclLines.Count - 1); $i++) {
        if ($issDeclLines[$i] -match '^\s*function\s+ReplaceTreeFromSnapshot\b') {
            $replaceDeclOk = (($issDeclLines[$i] + ' ' + $issDeclLines[$i + 1]) -match 'Expected:\s*Boolean')
            break
        }
    }
    Add-StaticResult -Name 'static:rollback-missing-expected' -Ok (
        $replaceDeclOk -and
        (Test-IssCode -Text $replaceBody -Pattern ([regex]::Escape('if Expected and (not DirExists(Src)) then'))) -and
        (Test-IssCode -Text $replaceBody -Pattern ([regex]::Escape('текущие файлы оставлены на месте'))) -and
        (Test-IssCode -Text $replaceBody -Pattern ([regex]::Escape('в снимке нет — так и было до обновления'))) -and
        (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape("GServerDir + '\server', 'server', GSnapshotHasServer)"))) -and
        (Test-IssCode -Text $restoreBody -Pattern ([regex]::Escape("GServerDir + '\service', 'service', GSnapshotHasService)")))
    ) -Note 'отсутствие ожидаемого каталога в снимке — ошибка отката, текущие файлы целы'
    Add-StaticResult -Name 'static:snapshot-excludes-user-data' -Ok (
        -not (Test-IssCode -Text $issText -Pattern '(CopyTreeRec|TakeSnapshot)\(GDataDir')
    ) -Note 'данные пользователя (БД, вложения) в снимок не копируются и не переносятся'
    <# Порядок фаз делает перенос безопасным: файлы нельзя переименовывать, пока
      служба работает. Остановка службы → бэкап БД → снимок, строго в этом
      порядке (иначе незакрытые файлы сервера блокируют перенос, а архив БД
      перестаёт соответствовать моменту остановки). #>
    $phaseLines = @(Get-IssStrippedLines -Text $issText)
    $stopAt = -1; $backupAt = -1; $snapshotAt = -1
    for ($i = 0; $i -lt $phaseLines.Count; $i++) {
        if (($stopAt -lt 0) -and ($phaseLines[$i] -match [regex]::Escape('if not StopServiceForUpdate(Reason, False) then'))) { $stopAt = $i }
        if (($backupAt -lt 0) -and ($phaseLines[$i] -match [regex]::Escape('if not CreateDatabaseBackup(True) then'))) { $backupAt = $i }
        if (($snapshotAt -lt 0) -and ($phaseLines[$i] -match [regex]::Escape('if not CreateRollbackSnapshot then'))) { $snapshotAt = $i }
    }
    Add-StaticResult -Name 'static:snapshot-after-service-stop' -Ok (
        ($stopAt -ge 0) -and ($backupAt -gt $stopAt) -and ($snapshotAt -gt $backupAt)
    ) -Note ("порядок фаз: остановка службы ({0}) → бэкап БД ({1}) → снимок ({2})" -f ($stopAt + 1), ($backupAt + 1), ($snapshotAt + 1))

    # Комментарии [Code] не вкладываются: `}` закрывает `{ ... }`, поэтому
    # `{app}` внутри такого комментария обрывает его и остаток строки
    # становится кодом — ISCC падает с синтаксической ошибкой, а построчный
    # сторож видит «код», которого нет. Ловится только компиляцией, поэтому
    # проверяем исходник (нашлось на a34f48da).
    $nestedComments = @(Test-IssNestedComment -Text $issText)
    Add-StaticResult -Name 'static:code-comments-flat' -Ok ($nestedComments.Count -eq 0) `
        -Note ($(if ($nestedComments.Count -eq 0) { 'комментарии [Code] без вложенных фигурных скобок' }
            else { $nestedComments -join '; ' }))

    # 4dc117f5: каждый CustomMessage('X') обязан быть определён — иначе Inno
    # бросает исключение в рантайме (до компиляции сторож дешевле); дубликат имени
    # в [CustomMessages] — ошибка компиляции.
    $customCallNames = New-Object System.Collections.Generic.List[string]
    foreach ($strippedLine in (Get-IssStrippedLines -Text $issText)) {
        foreach ($m in [regex]::Matches($strippedLine, "CustomMessage\('([A-Za-z0-9_]+)'\)")) {
            $callName = $m.Groups[1].Value
            if (-not $customCallNames.Contains($callName)) { $customCallNames.Add($callName) }
        }
    }
    $undefinedMessages = @($customCallNames | Where-Object {
            $null -eq (Get-IssCustomMessage -Text $issText -Name $_)
        })
    Add-StaticResult -Name 'static:custommessage-defined' -Ok ($undefinedMessages.Count -eq 0) `
        -Note ('вызовов: ' + $customCallNames.Count +
            $(if ($undefinedMessages.Count) { '; не определены: ' + ($undefinedMessages -join ', ') } else { '' }))
    $customNames = @(Get-IssCustomMessageNames -Text $issText)
    $duplicateMessages = @($customNames | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    Add-StaticResult -Name 'static:custommessage-unique' -Ok ($duplicateMessages.Count -eq 0) `
        -Note ('сообщений: ' + $customNames.Count +
            $(if ($duplicateMessages.Count) { '; дубликаты: ' + ($duplicateMessages -join ', ') } else { '' }))
    # 4dc117f5: финальный сторож — в [Code] не осталось UI-литералов. Журнальные
    # операторы (Log*) и метки операций инструмента БД остаются в коде по решению
    # пользователя; допускаются только технические форматы из allowlist.
    $uiLeft = @(Get-IssUiLiterals -Text $issText)
    Add-StaticResult -Name 'static:no-ui-literals' -Ok ($uiLeft.Count -eq 0) `
        -Note ('UI-литералы в [Code]: ' +
            $(if ($uiLeft.Count) { $uiLeft -join ' | ' } else { 'нет' }))

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

    # 112642a4: экраны, лицензия MIT, прогресс, экран ошибки и итоговая сводка.
    # Проверки — по телам функций: подстрочный поиск по всему файлу проходил бы на
    # закомментированной копии (дефект B2 приёмки 9b310991).
    $componentsBody = Get-IssFunctionBody -Text $issText -Name 'CreateComponentsPage'
    $licenseUi = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseCheck'))) -and
        (Test-MessageTextInBody -Body $componentsBody -Key 'EtnLicenseAccept' -Text 'Я принимаю условия лицензии MIT') -and
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
        @{ Name = 'Замена файлов сервера ETN'; Key = 'EtnStageServerFiles' },
        @{ Name = 'Подготовка каталогов данных'; Key = 'EtnStageDataDirs' },
        @{ Name = 'Настройка службы'; Key = 'EtnStageServiceConfig' },
        @{ Name = 'Регистрация службы ETN'; Key = 'EtnStageServiceRegister' },
        @{ Name = 'Правило брандмауэра'; Key = 'EtnStageFirewall' },
        @{ Name = 'Инициализация сервера'; Key = 'EtnStageInit' },
        @{ Name = 'Запуск службы ETN'; Key = 'EtnStageServiceStart' },
        @{ Name = 'Проверка работоспособности'; Key = 'EtnStageHealth' },
        @{ Name = 'Запись параметров установки'; Key = 'EtnStageParams' }
    )
    foreach ($stage in $stageNames) {
        Add-StaticResult -Name ('static:stage:' + $stage.Name) `
            -Ok (Test-MessageTextInBody -Body $stepBody -Key $stage.Key -Text $stage.Name) `
            -Note 'этап прогресса в CurStepChanged'
    }
    # Остановка службы перенесена в фазы обновления (bb063ac3): подпись этапа и
    # сам вызов живут в PrepareServerUpdate, который ssInstall вызывает до копирования.
    Add-StaticResult -Name 'static:stage:Остановка службы ETN' `
        -Ok (Test-MessageTextInBody -Body $updateBody -Key 'EtnStageStopService' -Text 'Остановка службы ETN') `
        -Note 'этап остановки службы в PrepareServerUpdate'
    $backupStageBody = Get-IssFunctionBody -Text $issText -Name 'CreateDatabaseBackup'
    Add-StaticResult -Name 'static:stage:backup' `
        -Ok (Test-MessageTextInBody -Body $backupStageBody -Key 'EtnStageBackup' -Text 'Резервная копия баз данных') `
        -Note 'этап бэкапа в CreateDatabaseBackup (вызовет bb063ac3)'

    $errorBody = Get-IssFunctionBody -Text $issText -Name 'ErrorMemoText'
    $backupPathBody = Get-IssFunctionBody -Text $issText -Name 'BackupPathForMessage'
    # Три ветки BackupPathForMessage (свежий архив, архив прошлых обновлений, архив
    # не создан) обязаны рендерить EtnBackupLine через FmtMessage, а не собирать
    # подпись из переменной напрямую.
    $backupLineCalls = [regex]::Matches($backupPathBody,
        "FmtMessage\s*\(\s*CustomMessage\s*\(\s*'EtnBackupLine'\s*\)")
    $backupLineOk = ($backupLineCalls.Count -ge 3)
    Add-StaticResult -Name 'static:error-page-backup-line' -Ok $backupLineOk `
        -Note ('вызовы EtnBackupLine в BackupPathForMessage: ' + $backupLineCalls.Count + ' из 3')
    $errorOk = (Test-IssCode -Text $errorBody -Pattern ([regex]::Escape('FailureReasonText'))) -and
        (Test-MessageTextInBody -Body $errorBody -Key 'EtnLogLine' -Text 'Журнал установки') -and
        (Test-IssCode -Text $errorBody -Pattern ([regex]::Escape('BackupPathForMessage('))) -and
        $backupLineOk -and
        (Test-MessageContains -Key 'EtnBackupLine' -Text 'Резервная копия баз данных') -and
        (Test-MessageTextInBody -Body $errorBody -Key 'EtnErrorNextStep' -Text 'Следующий шаг')
    Add-StaticResult -Name 'static:error-page-content' -Ok $errorOk `
        -Note 'экран ошибки: причина, журнал, бэкап и следующий шаг'
    $errorPageBody = Get-IssFunctionBody -Text $issText -Name 'CreateErrorPage'
    $errorButtons = (Test-MessageTextInBody -Body $errorPageBody -Key 'EtnButtonOpenLog' -Text 'Открыть журнал') -and
        (Test-MessageTextInBody -Body $errorPageBody -Key 'EtnButtonRetry' -Text 'Повторить установку') -and
        (Test-MessageTextInBody -Body $errorPageBody -Key 'EtnErrorPageTitle' -Text 'Установка не завершена') -and
        (Test-IssCode -Text $errorPageBody -Pattern ([regex]::Escape('GErrorPage := CreateCustomPage')))
    Add-StaticResult -Name 'static:error-page-buttons' -Ok $errorButtons `
        -Note 'экран ошибки: журнал, папка данных, повтор установки'

    $summaryBody = Get-IssFunctionBody -Text $issText -Name 'SummaryText'
    $summaryOk = (Test-MessageTextInBody -Body $summaryBody -Key 'EtnSummaryLocalAddress' -Text 'http://127.0.0.1:') -and
        (Test-MessageTextInBody -Body $summaryBody -Key 'EtnSummaryLanAddress' -Text 'Адрес в локальной сети') -and
        (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('DetectLanIp'))) -and
        (Test-MessageTextInBody -Body $summaryBody -Key 'EtnSummaryDataDir' -Text 'Каталог данных') -and
        (Test-MessageTextInBody -Body $summaryBody -Key 'EtnLogLine' -Text 'Журнал установки') -and
        (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('GKeyWasShown')))
    Add-StaticResult -Name 'static:summary-content' -Ok $summaryOk `
        -Note 'сводка: локальный и LAN-адрес, каталог данных, журнал, напоминание о ключе'
    $summaryLan = (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('if GServerFirewall then'))) -and
        (Test-IssCode -Text $summaryBody -Pattern ([regex]::Escape('GFirewallWarning')))
    Add-StaticResult -Name 'static:summary-lan-firewall' -Ok $summaryLan `
        -Note 'LAN-адрес только при открытом брандмауэре, предупреждение netsh — в сводке'
    $finishedBody = Get-IssFunctionBody -Text $issText -Name 'CreateFinishedControls'
    $finishedOk = (Test-IssCode -Text $finishedBody -Pattern ([regex]::Escape('WizardForm.FinishedPage'))) -and
        (Test-MessageTextInBody -Body $finishedBody -Key 'EtnButtonRunClient' -Text 'Запустить клиент') -and
        (Test-MessageTextInBody -Body $finishedBody -Key 'EtnButtonOpenDataDir' -Text 'Открыть папку данных') -and
        (Test-MessageTextInBody -Body $finishedBody -Key 'EtnButtonOpenLog' -Text 'Открыть журнал')
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
    $precheckBody = Get-IssFunctionBody -Text $issText -Name 'CheckServerEnvironment'
    $portBusyOk = (Test-IssCode -Text $precheckBody -Pattern ([regex]::Escape('GPortBusy := True'))) -and
        (Test-IssCode -Text $precheckBody -Pattern ([regex]::Escape('GPortBusy := False'))) -and
        (Test-IssCode -Text $nextBody -Pattern ([regex]::Escape('if GPortBusy then'))) -and
        (-not (Test-IssCode -Text $nextBody -Pattern ([regex]::Escape("Pos('занят'")))) -and
        (Test-MessageTextInBody -Body $nextBody -Key 'EtnPortFreeSuggestion' -Text 'Рядом свободен порт')
    Add-StaticResult -Name 'static:port-busy-flag' -Ok $portBusyOk `
        -Note 'подсказка свободного порта — по флагу CheckServerEnvironment, не по тексту причины (4dc117f5)'
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
             (Test-MessageTextInBody -Body $prepareBody -Key 'EtnNoChangesLogTail' -Text 'Изменения не выполнялись')) `
        -Note 'закрытие клиента и удаление старого клиента — на странице «Подготовка к установке», ошибка строкой (5b9743da)'
    Add-StaticResult -Name 'static:prepare-no-script-elevation' `
        -Ok ((Test-IssCode -Text $prepareBody -Pattern ([regex]::Escape('if not InPrivilegedContext then Exit'))) -and
             (-not ($prepareBody -match [regex]::Escape('RunElevatedChild'))) -and
             (-not ($prepareBody -match [regex]::Escape("ShellExec('runas'")))) `
        -Note 'PrepareToInstall не поднимает второй экземпляр: права даёт запуск от имени администратора или /ALLUSERS'
    Add-StaticResult -Name 'static:legacy-nsis-detect' `
        -Ok ((Test-IssCode -Text $issText -Pattern ([regex]::Escape("Pos('Uninstall ETN.exe', Cmd)"))) -and
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
             (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("Copy(Cmd, 1, P + Length('Uninstall ETN.exe'))"))) -and
             (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("Copy(Cmd, P + Length('Uninstall ETN.exe') + 1, Length(Cmd))"))) -and
             (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("Pos('/S', UpperCase(Rest)) = 0"))) -and
             (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("Rest := Trim(Rest + ' /S')"))) -and
             (Test-IssCode -Text $legacyArgsBody -Pattern ([regex]::Escape("Result := Rest + ' _?='"))) -and
             (-not ($legacyArgsBody -match [regex]::Escape('" _?='))) -and
             (-not ($legacyArgsBody -match '/VERYSILENT|/SUPPRESSMSGBOXES|/NORESTART'))) `
        -Note 'деинсталлятор старого клиента: /S и _?=<каталог> последним без кавычек; Inno-флаги /VERYSILENT и др. запрещены (грабли 25343551)'
    $legacyRunBody = Get-IssFunctionBody -Text $issText -Name 'RunLegacyUninstaller'
    Add-StaticResult -Name 'static:legacy-uninstall-waits' `
        -Ok ((Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape('ewWaitUntilTerminated'))) -and
             (Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape("while (Err = '') and (WaitedMs < LEGACY_GONE_WAIT_MS)"))) -and
             (Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape('Sleep(LEGACY_GONE_STEP_MS)'))) -and
             (Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape('LEGACY_GONE_WAIT_MS'))) -and
             (Test-IssCode -Text $legacyRunBody -Pattern ([regex]::Escape('RegKeyExists(GLegacyRoot, GLegacyKey)')))) `
        -Note 'установка ждёт деинсталлятор и исчезновение записи Uninstall (10 с, шаг 500 мс)'
    $legacyFindBody = Get-IssFunctionBody -Text $issText -Name 'FindLegacyClient'
    Add-StaticResult -Name 'static:legacy-search-roots' `
        -Ok ((Test-IssCode -Text $legacyFindBody -Pattern ([regex]::Escape('FindLegacyInRoot(HKCU, UNINSTALL_KEY)'))) -and
             (Test-IssCode -Text $legacyFindBody -Pattern ([regex]::Escape('FindLegacyInRoot(HKCU, UNINSTALL_KEY_WOW)'))) -and
             (Test-IssCode -Text $legacyFindBody -Pattern ([regex]::Escape('FindLegacyInRoot(HKLM64, UNINSTALL_KEY)'))) -and
             (Test-IssCode -Text $legacyFindBody -Pattern ([regex]::Escape('FindLegacyInRoot(HKLM32, UNINSTALL_KEY)'))) -and
             (-not (Test-IssCode -Text $legacyFindBody -Pattern ([regex]::Escape('FindLegacyInRoot(HKLM, '))))) `
        -Note 'явные корни: HKCU, HKCU+WOW6432Node, HKLM64, HKLM32; HKLM (дубль HKLM64) не используется'
    $legacyDetectBody = Get-IssFunctionBody -Text $issText -Name 'DetectLegacyClient'
    $legacyRemoveBody = Get-IssFunctionBody -Text $issText -Name 'RemoveLegacyBeforeInstall'
    # Запрещённые Inno-флаги проверяются и во всём пути удаления, а не только в
    # UninstallerArgs: деинсталлятору NSIS нужны /S + _?= (грабли 25343551).
    $legacyRemovalBodies = $legacyArgsBody + "`n" + $legacyRunBody + "`n" + $legacyRemoveBody
    Add-StaticResult -Name 'static:legacy-removal-no-inno-flags' `
        -Ok (-not ($legacyRemovalBodies -match '/VERYSILENT|/SUPPRESSMSGBOXES|/NORESTART')) `
        -Note 'в пути удаления старого клиента нет Inno-флагов /VERYSILENT/…: только /S и _?= (грабли 25343551)'
    $licenseVisible = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseCheck.Visible := LicensePromptNeeded'))) -and
        (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('GLicenseLink.Visible := LicensePromptNeeded')))
    Add-StaticResult -Name 'static:license-visible-rule' -Ok $licenseVisible `
        -Note 'чекбокс и ссылка лицензии привязаны к LicensePromptNeeded'
    $clientStateBody = Get-IssFunctionBody -Text $issText -Name 'ClientStateText'
    Add-StaticResult -Name 'static:client-state-selected' `
        -Ok (Test-IssCode -Text $clientStateBody -Pattern ([regex]::Escape('GLegacyClientFound and GClientSelected'))) `
        -Note 'обещание удалить старый клиент — только при выбранном клиенте'
    $legacyStateAt = $clientStateBody.IndexOf('GLegacyClientFound and GClientSelected')
    $installedStateAt = $clientStateBody.IndexOf("GClientState = 'installed'")
    Add-StaticResult -Name 'static:legacy-status-first' `
        -Ok (($legacyStateAt -ge 0) -and ($installedStateAt -ge 0) -and ($legacyStateAt -lt $installedStateAt)) `
        -Note 'статус «найден старый клиент … будет удалён» проверяется раньше «уже установлен» (124203d0)'
    # Ошибка 5b9743da: подпись клиента и причина неактивности «Далее» на экране
    # компонентов обязаны говорить одно и то же. Раньше в режиме «только для меня»
    # подпись предлагала «выберите клиент, чтобы заменить», а кнопка была неактивна
    # без видимой причины — экран противоречил сам себе.
    $reasonTextBody = Get-IssFunctionBody -Text $issText -Name 'ComponentsReasonText'
    Add-StaticResult -Name 'static:client-scope-reason-consistent' `
        -Ok ((Test-MessageTextInBody -Body $clientStateBody -Key 'EtnClientStateMachineNeedsAdmin' -Text 'нужны права') -and
             (Test-MessageTextInBody -Body $reasonTextBody -Key 'EtnReasonClientMachineNeedsAdmin' -Text 'нужны права') -and
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
    $explicitUserDir = $issText -match [regex]::Escape('#define ClientUserDir "{localappdata}\Programs\ETN"')
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
    $serverReason = Get-IssServerNeedsAdminText
    $serverReasonOk = (Test-MessageTextInBody -Body $serverReasonBody -Key 'EtnServerNeedsAdmin' -Text $serverReason) -and
        (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'SyncComponentsList') -Pattern ([regex]::Escape('ServerDescriptionRowText'))) -and
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
        (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'SyncComponentsList') -Pattern ([regex]::Escape('GComponentsList.ItemEnabled[COMP_ITEM_SERVER] := not GUserOnlyMode'))) -and
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
        (Test-MessageTextInBody -Body $scopeTextBody -Key 'EtnClientScopeUserCopyUpdate' -Text 'Найден клиент «только для меня»') -and
        (Test-MessageTextInBody -Body $scopeTextBody -Key 'EtnClientScopeUserCopyInstall' -Text 'Найден клиент «только для меня»')
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
    # Закрытие только своих процессов (замечание приёмки 98ad5eec): в продуктовой
    # ветке Get-Process фильтруется по каталогам возможных установок клиента
    # (ClientCloseRoots: выбранная область + второй вариант ADR 144bcdb0), иначе
    # ETN.exe другого пользователя приводит к 30+15 с и коду 20. Оба каталога нужны
    # и потому, что в привилегированной фазе {localappdata} — профиль того же
    # пользователя, а машинный клиент из Program Files тоже может работать
    # (905dec4c).
    $realPidsProduct = Get-IssFunctionBody -Text $issText -Name 'RealClientPids'
    $closeFilterOk = (Test-IssCode -Text $realPidsProduct -Pattern ([regex]::Escape('ClientPathCondition'))) -and
        (-not (Test-IssCode -Text $realPidsProduct -Pattern ([regex]::Escape('ClientCloseRoot(')))) -and
        (-not (Test-IssCode -Text $realPidsProduct -Pattern ([regex]::Escape("Get-Process -Name ''ETN''|ForEach-Object{`$_.Id}"))))
    $closeRootsBody = Get-IssFunctionBody -Text $issText -Name 'ClientCloseRoots'
    $closeRootsOk = (Test-IssCode -Text $closeRootsBody -Pattern ([regex]::Escape('{localappdata}'))) -and
        (Test-IssCode -Text $closeRootsBody -Pattern ([regex]::Escape('{commonpf}')))
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
    # Обновление: область клиента фиксирована — радиокнопок нет, область выводится
    # текстом в необязательной последней строке списка (ea8e223a, 4a66b7a5;
    # c4b68d78: строка области — group уровня 1).
    $updateStateBody = Get-IssFunctionBody -Text $issText -Name 'UpdateComponentsState'
    $scopeRowBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeRowNeeded'
    $scopeRowTextBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeRowText'
    $scopeLabelOk = (Test-IssCode -Text $scopeRowBody -Pattern ([regex]::Escape('ClientScopeFixed or GAdminMachineScope or GClientSelected'))) -and
        (Test-IssCode -Text $scopeRowTextBody -Pattern ([regex]::Escape('ClientScopeText'))) -and
        (Test-IssCode -Text (Get-IssFunctionBody -Text $issText -Name 'SyncComponentsList') -Pattern ([regex]::Escape('GComponentsList.ItemCaption[COMP_ITEM_CLIENT_SCOPE] := ClientScopeRowText'))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('GScopeUserRadio')))) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('GScopeMachineRadio'))))
    $scopeFixedBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeFixed'
    $scopeFixedOk = Test-IssCode -Text $scopeFixedBody -Pattern ([regex]::Escape("GClientState = 'installed'"))
    $scopeTextBody = Get-IssFunctionBody -Text $issText -Name 'ClientScopeText'
    # Формулировка пользователя (ошибка 860def0d, n5): вариант установки и что
    # сделать, чтобы получить другой, — без термина «область установки».
    # После задачи 4dc117f5 тексты живут в [CustomMessages]: фразы проверяем по
    # значениям сообщений экрана области, а тело функции — по вызову нужного ключа.
    $scopeMsgKeys = @('EtnClientScopeAdmin', 'EtnClientScopeUserCopyUpdate',
        'EtnClientScopeUserCopyInstall', 'EtnClientScopeMachineNeedsAdmin',
        'EtnClientScopeUserOnlyUpdate', 'EtnClientScopeUser', 'EtnClientScopeMachine')
    $scopeMsgFlat = (@($scopeMsgKeys | ForEach-Object { Get-IssCustomMessage -Text $issText -Name $_ }) -join ' ')
    $scopeTextOk = ($scopeMsgFlat -match [regex]::Escape('Клиент установлен в варианте «только для меня»')) -and
        ($scopeMsgFlat -match [regex]::Escape('Клиент установлен в варианте «для всех пользователей»')) -and
        ($scopeMsgFlat -match [regex]::Escape('Запуск от имени администратора')) -and
        ($scopeMsgFlat -match [regex]::Escape('обычным двойным кликом')) -and
        (-not ($scopeMsgFlat -match [regex]::Escape('в диалоге режима'))) -and
        (-not ($scopeMsgFlat -match [regex]::Escape('удалите клиента и выполните установку заново'))) -and
        (-not ($scopeMsgFlat -match [regex]::Escape('область установки'))) -and
        (Test-IssCode -Text $scopeTextBody -Pattern ([regex]::Escape("CustomMessage('EtnClientScopeUser')"))) -and
        (Test-IssCode -Text $scopeTextBody -Pattern ([regex]::Escape("CustomMessage('EtnClientScopeMachine')")))
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
    $serverDescBody = Get-IssFunctionBody -Text $issText -Name 'ServerDescriptionRowText'
    $clientDescBody = Get-IssFunctionBody -Text $issText -Name 'ClientDescriptionRowText'
    $componentsTextOk = (Test-MessageTextInBody -Body $serverDescBody -Key 'EtnServerDescription' `
            -Text 'Сервер хранит графовые базы знаний') -and
        (Test-MessageTextInBody -Body $clientDescBody -Key 'EtnClientDescription' `
            -Text 'Клиент — окно для работы с базами') -and
        (Test-MessageTextInBody -Body $clientDescBody -Key 'EtnClientInstallDirSuffix' `
            -Text 'Каталог установки: ') -and
        (Test-MessageTextInBody -Body $scopeRowTextBody -Key 'EtnClientScopeRowUserOnly' `
            -Text 'Режим «только для меня»: клиент ставится в ваш профиль') -and
        (Test-IssCode -Text $scopeRowTextBody -Pattern ([regex]::Escape('ClientScopeText')))
    Add-StaticResult -Name 'static:components-descriptions' -Ok $componentsTextOk `
        -Note 'что такое сервер и клиент, каталог установки и чем различаются области — group-строки списка'

    # c4b68d78: ручной раскладки нет — экран на TNewCheckListBox, список получает
    # остаток высоты от фиксированного нижнего блока и прокручивается сам. Список
    # обновляется на месте (SetCaption сохраняет чек-состояние), а запрещённые
    # операции, рассинхронизирующие FStateList, сторожатся здесь же.
    $layoutBottomBody = Get-IssFunctionBody -Text $issText -Name 'LayoutComponentsBottom'
    $syncListBody = Get-IssFunctionBody -Text $issText -Name 'SyncComponentsList'
    $readyComponents = Get-IssFunctionBody -Text $issText -Name 'CreateComponentsPage'
    $listOk = (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('LayoutComponentsPage')) -IniComments)) -and
        (-not (Test-IssCode -Text $issText -Pattern ([regex]::Escape('FitComponentsPage')) -IniComments)) -and
        (Test-IssCode -Text $issText -Pattern ([regex]::Escape('TNewCheckListBox'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.AddCheckBox'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.AddGroup'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.OnClickCheck := @ComponentsChanged'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.ShowLines := False'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.BorderStyle := bsNone'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.MinItemHeight := ScaleY(22)'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsList.Offset := ScaleX(4)'))) -and
        (Test-IssCode -Text $layoutBottomBody -Pattern ([regex]::Escape('GServerAltLink.Top'))) -and
        (Test-IssCode -Text $layoutBottomBody -Pattern ([regex]::Escape('GComponentsList.Height := Y'))) -and
        (Test-IssCode -Text $layoutBottomBody -Pattern ([regex]::Escape('Y := GServerAltLink.Top - ScaleY(8)'))) -and
        (Test-IssCode -Text $syncListBody -Pattern ([regex]::Escape('$018E'))) -and
        (Test-IssCode -Text $syncListBody -Pattern ([regex]::Escape('$0197'))) -and
        (Test-IssCode -Text $syncListBody -Pattern ([regex]::Escape('GComponentsList.ItemIndex := SavedIndex')))
    Add-StaticResult -Name 'static:components-relayout' -Ok $listOk `
        -Note 'TNewCheckListBox вместо ручной раскладки: список получает остаток высоты, прокрутка и выделение сохраняются'

    # Запрещённые операции TNewCheckListBox: Items.Add/AddSubItem/SubItems и запись
    # ItemLevel/State рассинхронизируют внутренний FStateList — строка состояния
    # перестаёт соответствовать пункту. Items.Delete разрешён только для последней
    # (необязательной) строки области клиента.
    $forbiddenListApi = @('.Items.Add', 'AddSubItem', 'SubItems', '.ItemLevel :=', '.State :=')
    $listApiBad = @()
    foreach ($api in $forbiddenListApi) {
        if (Test-IssCode -Text $issText -Pattern ([regex]::Escape($api)) -IniComments) { $listApiBad += $api }
    }
    Add-StaticResult -Name 'static:components-list-api' -Ok ($listApiBad.Count -eq 0) `
        -Note ('запрещённые операции списка отсутствуют: ' + $(if ($listApiBad.Count -eq 0) { 'да' } else { $listApiBad -join ', ' }))

    $readyOk = (Test-IssCode -Text $componentsBody -Pattern ([regex]::Escape('not GComponentsReady'))) -and
        (Test-IssCode -Text $readyComponents -Pattern ([regex]::Escape('GComponentsReady := True')))
    Add-StaticResult -Name 'static:components-init-guard' -Ok $readyOk `
        -Note 'программная установка Checked не снимает выбор клиента (OnClick до готовности экрана)'

    $adminBody = Get-IssFunctionBody -Text $issText -Name 'CreateAdminPage'
    $adminOk = (Test-MessageTextInBody -Body $adminBody -Key 'EtnAdminPageIntro' `
            -Text 'Первый пользователь станет администратором ETN. Задайте его логин и отображаемое имя, а после установки сервера получите ключ для входа.') -and
        (Test-IssCode -Text $adminBody -Pattern ([regex]::Escape('GAdminHintLabel.WordWrap := True'))) -and
        (Test-IssCode -Text $adminBody -Pattern ([regex]::Escape('FitLabel(GAdminHintLabel)')))
    Add-StaticResult -Name 'static:admin-texts' -Ok $adminOk `
        -Note 'подзаголовок — дословно формулировка пользователя; подсказка с переносом и пересчётом'

    $modeBody = Get-IssFunctionBody -Text $issText -Name 'ServerModeText'
    $modeOk = (Test-MessageTextInBody -Body $modeBody -Key 'EtnModeService' `
            -Text 'автоматический запуск в режиме службы Windows') -and
        (Test-MessageTextInBody -Body $modeBody -Key 'EtnModeApp' `
            -Text 'ручной запуск сервера как обычного приложения') -and
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
    $serverDescRowBody = Get-IssFunctionBody -Text $issText -Name 'ServerDescriptionRowText'
    $uacOk = (-not (Test-IssCode -Text $readyMemoBody -Pattern ([regex]::Escape('Windows запросит права администратора')))) -and
        (Test-IssCode -Text $readyMemoBody -Pattern ([regex]::Escape('if GUserOnlyMode then'))) -and
        (Test-IssCode -Text $serverDescRowBody -Pattern ([regex]::Escape('if GUserOnlyMode then'))) -and
        (Test-IssCode -Text $serverDescRowBody -Pattern ([regex]::Escape('Result := ServerUnavailableReason'))) -and
        (Test-MessageContains -Key 'EtnServerNeedsAdmin' -Text 'Запуск от имени администратора') -and
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



    if ($AssertNoHooks) {
        $hookGuard = Test-IssNoTestHooks -RepoRoot $repoRoot
        Add-StaticResult -Name 'static:no-test-hooks' -Ok $hookGuard.Ok -Note $hookGuard.Message
    } else {
        Write-Host '--- static:no-test-hooks пропущен: активируется после удаления хуков (этап 5) ---'
    }
}

# Самостоятельный прогон: dot-source оставляет только определения функций.
if ($MyInvocation.InvocationName -ne '.') {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $results = New-Object System.Collections.Generic.List[object]
    $script:StaticResults = $results
    Write-Host '=== Статические проверки исходников установщика ==='
    Invoke-IssStaticChecks -RepoRoot $repoRoot -Results $results -AssertNoHooks
    $failed = @($results | Where-Object { -not $_.Ok })
    Write-Host ''
    Write-Host ("Статика: {0} проверок, провалов {1}" -f $results.Count, $failed.Count)
    if ($failed.Count -gt 0) {
        foreach ($item in $failed) { Write-Host ("FAIL  {0}" -f $item.Scenario) }
        exit 1
    }
    exit 0
}
