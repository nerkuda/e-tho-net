; ============================================================================
; installer/etn.iss — комбинированный установщик ETN для Windows
;
; Задача a1211915 (0.15.1): каркас установщика, определение состояния машины,
; параметры установки (install.json), двухфазное повышение прав (UAC) и
; silent server-only режим для самообновления сервера.
;
; Зоны соседних задач (не реализуются здесь, оставлены точки вызова):
;   8b1f5980 — поставка сервера (Node, prod-node_modules, WinSW, служба);
;   bb063ac3 — остановка службы, бэкап, health-check, откат;
;   112642a4 — экраны, лицензия, прогресс, итоговая сводка, тексты;
;   98ad5eec — поставка клиента (область установки, ярлыки, закрытие ETN.exe).
;
; Задача 686c5d76 (0.15.1) — первичная инициализация и экран ключа:
;   * «уже инициализирован» — критерий hasFirstUser(), а не наличие
;     _system.db (база от прерванной попытки доинициализируется);
;   * init вызывается в привилегированной фазе: node.exe server\dist\cli.js
;     init --username <логин> --key-out <защищённый файл>; в окружение
;     процесса выставляются ETN_DATA_DIR, ETN_PORT, ETN_HOST;
;   * ключ пишется в %ProgramData%\ETN\.install\primary-key.txt, каталог
;     ограничивается icacls (SYSTEM, администраторы, пользователь,
;     запустивший установщик); в журнал и install.json ключ не попадает;
;   * экран ключа — после установки, до итоговой сводки: копирование,
;     «Я сохранил ключ» разблокирует «Далее», «Назад» недоступен; закрытие
;     без подтверждения удаляет временный файл;
;   * сбой после init до показа ключа: файл остаётся, повторный запуск
;     показывает ключ оттуда;
;   * silent: init не вызывается никогда, отсутствие администратора — код 10.
;
; Задача 9b310991 (0.15.1) — каталог данных, порт, брандмауэр и предпроверки:
;   * каталог данных фиксирован %ProgramData%\ETN (ADR 144bcdb0), поля выбора
;     в 0.15.1 нет; сервер получает его через ETN_DATA_DIR; каталог программы —
;     {autopf}\ETN (Program Files в машинной установке), служебные файлы
;     службы — {app}\service (ADR db60302a);
;   * экран «Параметры сервера»: порт (по умолчанию 4321) и чекбокс
;     «Разрешить подключения с других компьютеров в локальной сети»;
;   * чекбокс — единственный источник ETN_HOST: включён — 0.0.0.0,
;     выключен — 127.0.0.1 (отдельного поля хоста нет);
;   * предпроверки до любых изменений: занятость порта, запись в каталоги
;     данных и программы, свободное место, права администратора; при неудаче —
;     понятная причина, запуск не начинается, частичных файлов нет;
;   * правило брандмауэра Windows для порта создаётся только при согласии
;     (чекбокс), удаляется при отключении и при удалении программы; профили —
;     domain и private, публичные сети правилом не открываются;
;   * установщик подставляет в {app}\service\etn-service.xml значения вместо
;     {{DATA_DIR}}, {{PORT}}, {{HOST}} и создаёт каталог журнала службы
;     (WinSW сам его не создаёт); до подстановки службу не регистрировать;
;   * при обновлении порт, хост, режим и каталог данных фиксированы — берутся
;     из install.json, поля на экране только показывают значения;
;   * установка только клиента серверных каталогов и правила не создаёт.
;
; Сборка: installer/build.ps1 (передаёт /DMyAppVersion из server/package.json).
; Проверка silent-контракта и предпроверок: installer/tests/silent-codes.ps1.
; Проверка init и ключа: installer/tests/init-key.ps1.
; Проверка подстановки шаблона и запуска поставки: installer/tests/service-config.ps1.
;
; Контракт silent server-only режима (постоянный комментарий задачи):
;   ETN-Setup-<версия>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY
;   коды возврата: 0 — успех; 10 — сбой выполнения; 20 — предусловие
;   не выполнено. Иные коды Inno контрактом не являются (потребитель
;   трактует их как 10). Ни одного MsgBox: только SuppressibleMsgBox и журнал
;   %ProgramData%\ETN\logs\install-YYYYMMDD-HHmmss.log (fallback %TEMP%).
;
; Внутренние режимы запуска (не для пользователя):
;   /PRIVILEGEDPHASE — дочерняя элевированная фаза GUI-установки (сервер и
;   клиент «для всех»); silent-предусловия самообновления к ней НЕ применяются,
;   проверяются только права, каталог программы, каталог данных и порт;
;   /TESTSTATE, /TESTSELECT, /TESTRECORD, /TESTELEVATED, /TESTSERVICE,
;   /TESTHEALTH, /TESTPARAMS, /TESTDATADIR, /TESTPORT, /TESTMINFREE,
;   /TESTFIREWALL, /TESTPRECHECK — только в тестовой сборке
;   (installer/tests/silent-codes.ps1, init-key.ps1, service-config.ps1).
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
  #pragma message "MyAppVersion не задан (/DMyAppVersion): собирайте через installer/build.ps1 — версия установщика 0.0.0-dev"
#endif

; Каталог подготовленного payload (поставка 8b1f5980 и 98ad5eec).
; По умолчанию — installer/payload; тестовый прогон молчания передаёт
; /DPayloadRoot=<installer/tests/fixtures/payload>.
#ifdef PayloadRoot
  #define PayloadDir PayloadRoot
#else
  #define PayloadDir AddBackslash(SourcePath) + "payload"
#endif
#define PayloadPrefix AddBackslash(PayloadDir)

; Тестовый режим (только для installer/tests/silent-codes.ps1): изолированные
; каталог программы и каталог данных + хуки /TESTELEVATED, /TESTSERVICE,
; /TESTHEALTH. В обычной сборке эти хуки в код не попадают (#ifdef TestMode).
#ifdef TestMode
  #define AppDir TestAppDir
  #define DataDir TestDataDir
#else
  ; Каталог программы выбирается по режиму установки: обычный запуск идёт без
  ; прав администратора, и {autopf} — каталог пользователя
  ; (%LOCALAPPDATA%\Programs\ETN). Машинная установка (Program Files) возможна
  ; только в привилегированной фазе — дочерний процесс с /ALLUSERS. Жёсткий
  ; {commonpf} здесь недопустим: неэлевированный экземпляр не сможет создать
  ; каталог и записать деинсталлятор (Error 5: Отказано в доступе).
  #define AppDir "{autopf}\ETN"
  #define DataDir "{commonappdata}\ETN"
#endif

; --- Проверки наличия payload на этапе компиляции ---------------------------
; Секции [Files] добавляются только для реально подготовленных каталогов:
; установщик компилируется и до задачи 8b1f5980, а пропуск payload виден
; предупреждением компилятору.
#define ServerPayload PayloadPrefix + "server"
#define NodePayload PayloadPrefix + "node"
#define ServicePayload PayloadPrefix + "service"
#define ClientPayload PayloadPrefix + "client"

#define HaveServerPayload
#if !FileExists(AddBackslash(ServerPayload) + "package.json")
  #undef HaveServerPayload
  #pragma message "ПРЕДУПРЕЖДЕНИЕ: в payload нет server\package.json — секции [Files] сервера пропущены (поставка: задача 8b1f5980)"
#endif

#define HaveNodePayload
#if !FileExists(AddBackslash(NodePayload) + "node.exe")
  #undef HaveNodePayload
  #pragma message "ПРЕДУПРЕЖДЕНИЕ: в payload нет node\node.exe — рантайм Node не поставляется (задача 8b1f5980)"
#endif

#define HaveServicePayload
#if !FileExists(AddBackslash(ServicePayload) + "etn-service.xml")
  #undef HaveServicePayload
  #pragma message "ПРЕДУПРЕЖДЕНИЕ: в payload нет service\etn-service.xml — шаблон службы не поставляется (задача 8b1f5980)"
#endif

#define HaveClientPayload
#if !DirExists(ClientPayload)
  #undef HaveClientPayload
  #pragma message "ПРЕДУПРЕЖДЕНИЕ: в payload нет client\ — файлы клиента не поставляются (задача 98ad5eec)"
#endif

; ============================================================================
[Setup]
; Идентификатор продукта: по нему Inno ведёт запись установки и обновление
; поверх прежней версии. Менять нельзя — иначе повторный запуск не увидит
; предыдущую установку.
AppId={{6D7E1C2A-4B9A-4E7C-9F3D-2A5B8C1E4F70}
AppName=ETN
AppVersion={#MyAppVersion}
AppVerName=ETN {#MyAppVersion}
AppPublisher=ETN
AppPublisherURL=https://github.com/nerkuda/e-tho-net
AppSupportURL=https://github.com/nerkuda/e-tho-net/issues
AppUpdatesURL=https://github.com/nerkuda/e-tho-net/releases

; Каталог программы: имя ETN фиксировано (ADR 144bcdb0), расположение — по
; режиму установки ({autopf}\ETN: %LOCALAPPDATA%\Programs\ETN без прав
; администратора, %ProgramFiles%\ETN в привилегированной фазе с /ALLUSERS).
; Каталог данных — %ProgramData%\ETN (поля выбора в 0.15.1 нет).
DefaultDirName={#AppDir}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
LicenseFile=..\LICENSE

; Сборка идёт от обычного пользователя: установщик сам повышает права только
; там, где это нужно (сервер / клиент «для всех»), через перезапуск копии
; с /ALLUSERS и ShellExec('runas') — см. [Code].
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

OutputDir=..\release
OutputBaseFilename=ETN-Setup
Compression=lzma2
SolidCompression=yes
#ifdef TestMode
; Тестовая сборка не создаёт деинсталлятор и запись установки в реестре:
; прогон silent-codes.ps1 не должен оставлять следов на машине.
Uninstallable=no
#endif
WizardStyle=modern
UninstallDisplayName=ETN {#MyAppVersion}
SetupLogging=yes
UsePreviousAppDir=no
UsePreviousTasks=no

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
; --- Сервер (поставка 8b1f5980). DestDir — {app}\server, точка запуска службы
; --- node.exe server\dist\index.js; версия — server\package.json.
#ifdef HaveServerPayload
Source: "{#ServerPayload}\package.json"; DestDir: "{app}\server"; Flags: ignoreversion; Check: InstallServerPayload
Source: "{#ServerPayload}\dist\*"; DestDir: "{app}\server\dist"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallServerPayload
Source: "{#ServerPayload}\migrations\*"; DestDir: "{app}\server\migrations"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Check: InstallServerPayload
Source: "{#ServerPayload}\node_modules\*"; DestDir: "{app}\server\node_modules"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Check: InstallServerPayload
#endif

#ifdef HaveNodePayload
Source: "{#NodePayload}\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallServerPayload
#endif

#ifdef HaveServicePayload
Source: "{#ServicePayload}\*"; DestDir: "{app}\service"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallServerPayload
#endif

; --- Клиент (поставка 98ad5eec). «Для всех» ставится в {app}\client
; --- привилегированной фазой; «только для меня» — в неэлевированной фазе
; --- и в тот же {app}, который при обычном запуске указывает на профиль
; --- пользователя (иначе {localappdata} элевированного процесса может
; --- оказаться профилем другого администратора).
#ifdef HaveClientPayload
Source: "{#ClientPayload}\*"; DestDir: "{app}\client"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientMachine
Source: "{#ClientPayload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientUser
#endif

[Run]
; Точки вызова службы (8b1f5980) и запуска клиента (98ad5eec) намеренно не
; заполнены: их поведение — зона соседних задач.

; ============================================================================
[Code]

const
  SERVICE_NAME = 'ETN';
  EXIT_OK = 0;
  EXIT_FAILED = 10;
  EXIT_PRECONDITION = 20;
  MOVEFILE_REPLACE_EXISTING = 1;
  MOVEFILE_WRITE_THROUGH = 8;
  { Правило брандмауэра: имя постоянное (удаление ищет по имени, а не по
    порту), профили — домен и частная сеть; публичные сети правилом не
    открываются (требование 15a1d3e4). }
  FIREWALL_RULE_NAME = 'ETN Server';
  FIREWALL_PROFILES = 'domain,private';
  { Минимум свободного места: Node, сервер, prod-зависимости и миграции
    занимают единицы сотен мегабайт; 300 МБ — порог предпроверки. }
  MIN_FREE_SPACE_BYTES = 314572800;
  MIN_PORT = 1;
  MAX_PORT = 65535;

var
  { Режим запуска }
  GSilent: Boolean;
  GServerOnly: Boolean;
  GPrivilegedPhase: Boolean;
  GIsElevated: Boolean;
  GTestMode: Boolean;
  GTestHealth: String;
  GTestElevated: String;
  GTestService: String;
  GTestState: String;
  GTestSelect: String;
  GTestRecord: String;
  GTestParams: String;
  GTestGui: String;
  { Тестовые хуки задачи 686c5d76 (только в тестовой сборке). }
  GTestInit: String;
  GTestNodeExe: String;
  GTestLogin: String;
  GTestKeyState: String;
  GTestFailAfterInit: String;
  GTestKeyAck: String;
  GTestKeyClose: String;
  { Тестовые хуки задачи 9b310991 (только в тестовой сборке): подмена каталога
    данных, порта, порога свободного места, режима брандмауэра и прогон
    предпроверок без окон. }
  GTestDataDir: String;
  GTestPort: String;
  GTestMinFree: String;
  GTestFirewall: String;
  GTestPrecheck: String;
  GTestResult: String;

  { Первичная инициализация и ключ }
  GAdminLogin: String;
  GAdminDisplayName: String;
  GOriginalUser: String;
  GFirstUserChecked: Boolean;
  GFirstUserPresent: Boolean;
  GInitAttempted: Boolean;
  GPendingKey: String;
  GPendingKeyPrevious: Boolean;
  GKeyBeforeInstall: String;

  { Версия и пути }
  GProductVersion: String;
  GDataDir: String;
  GServerDir: String;
  GLogPath: String;
  GInstallJsonPath: String;
  GInstallJsonText: String;
  { Файл параметров привилегированной фазы: создаётся родителем в общем
    каталоге, путь передаётся дочернему через /PARAMS. }
  GParamsPath: String;

  { Выбор компонентов и параметры }
  GServerSelected: Boolean;
  GClientSelected: Boolean;
  GClientScopeUser: Boolean;
  GServerMode: String;
  GServerHost: String;
  GServerPort: String;
  GServerFirewall: Boolean;

  { Состояние машины }
  GInstallJsonPresent: Boolean;
  GInstallJsonValid: Boolean;
  GServerFilesPresent: Boolean;
  GDataDirPresent: Boolean;
  GClientFilesPresent: Boolean;
  GInstallerRecordPresent: Boolean;
  GFilesVersion: String;
  GInstalledVersion: String;
  GInstalledMode: String;
  GInstalledDataDir: String;
  GInstalledHost: String;
  GInstalledPort: String;
  GInstalledFirewall: Boolean;
  GInstalledClientScope: String;
  GInstalledAt: String;
  GServerState: String;
  GClientState: String;
  GAdoptExistingData: Boolean;
  GBlockedDowngrade: Boolean;
  GWorkAllowed: Boolean;
  GSkipCopy: Boolean;

  { Результат }
  GExitCode: Integer;
  GChildResult: Integer;

  { Экран компонентов }
  GComponentsPage: TWizardPage;
  GServerCheck: TNewCheckBox;
  GServerStateLabel: TNewStaticText;
  GInitStateLabel: TNewStaticText;
  GClientCheck: TNewCheckBox;
  GClientStateLabel: TNewStaticText;
  GScopeUserRadio: TNewRadioButton;
  GScopeMachineRadio: TNewRadioButton;
  GDataNoteLabel: TNewStaticText;
  GReasonLabel: TNewStaticText;

  { Экраны администратора и ключа }
  GAdminPage: TWizardPage;
  GAdminLoginLabel: TNewStaticText;
  GAdminLoginEdit: TNewEdit;
  GAdminHintLabel: TNewStaticText;
  GAdminErrorLabel: TNewStaticText;
  GKeyPage: TWizardPage;
  GKeyValueEdit: TNewEdit;
  GKeyCopyButton: TNewButton;
  GKeyCopiedLabel: TNewStaticText;
  GKeyWarningLabel: TNewStaticText;
  GKeyPreviousLabel: TNewStaticText;
  GKeyConfirmCheck: TNewCheckBox;

  { Экран «Параметры сервера» (9b310991): порт, чекбокс локальной сети и
    фиксированный каталог данных. Оформление и полный набор текстов — 112642a4. }
  GServerParamsPage: TWizardPage;
  GPortLabel: TNewStaticText;
  GPortEdit: TNewEdit;
  GPortHintLabel: TNewStaticText;
  GFirewallCheck: TNewCheckBox;
  GFirewallNoteLabel: TNewStaticText;
  GDataDirInfoLabel: TNewStaticText;
  GServerParamsNoteLabel: TNewStaticText;
  GPortErrorLabel: TNewStaticText;
  { Обновление поверх установки: порт, хост и режим фиксированы install.json. }
  GParamsLocked: Boolean;
  { Строки журнала, записанные до создания журнала (чтение файла параметров
    привилегированной фазы идёт раньше: от него зависит выбор компонентов и
    место журнала). Выводятся сразу после InitLog. }
  GDeferredLog: String;
  { Файл причины отказа предусловия: дочерняя (элевированная) фаза пишет
    причину, родитель читает и показывает её в сообщении об ошибке. }
  GReasonFile: String;
  GChildReason: String;
  { Правило брандмауэра существовало до удаления программы (ставится в
    CurUninstallStepChanged). }
  GUninstallFirewallRule: Boolean;

{ ---------------------------------------------------------------------------
  Вспомогательные функции: строки, время, коды.
  --------------------------------------------------------------------------- }
function Pick(const Value: Boolean; const TrueValue, FalseValue: String): String;
begin
  if Value then Result := TrueValue else Result := FalseValue;
end;

function IfStr(const Condition: Boolean; const TrueValue, FalseValue: String): String;
begin
  if Condition then Result := TrueValue else Result := FalseValue;
end;

function NowIso: String;
begin
  Result := GetDateTimeString('yyyy-mm-dd"T"hh:nn:ss', '-', ':');
end;

function HexVal(C: Char): Integer;
begin
  if (C >= '0') and (C <= '9') then Result := Ord(C) - Ord('0')
  else if (C >= 'a') and (C <= 'f') then Result := Ord(C) - Ord('a') + 10
  else if (C >= 'A') and (C <= 'F') then Result := Ord(C) - Ord('A') + 10
  else Result := 0;
end;

{ ---------------------------------------------------------------------------
  Внешние функции Win32: атомарная замена файла (temp + rename) и аварийный
  выход с контрактным кодом до любых изменений на диске.
  --------------------------------------------------------------------------- }
function MoveFileExW(lpExistingFileName: String; lpNewFileName: String;
  dwFlags: Cardinal): Boolean; external 'MoveFileExW@kernel32.dll stdcall';
procedure ExitProcess(uExitCode: Cardinal); external 'ExitProcess@kernel32.dll stdcall';
{ Окружение для дочерних процессов (etn init): Inno Exec не принимает env,
  а SetEnvironmentVariableW меняет окружение самого установщика — его
  наследуют все запускаемые процессы (node.exe, служба через WinSW не нужна:
  у неё env из шаблона etn-service.xml). }
function SetEnvironmentVariableW(lpName, lpValue: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

{ ---------------------------------------------------------------------------
  Командная строка
  --------------------------------------------------------------------------- }
function ParamExists(const Name: String): Boolean;
var
  I: Integer;
  P, N: String;
begin
  Result := False;
  N := '/' + UpperCase(Name);
  for I := 1 to ParamCount do
  begin
    P := UpperCase(ParamStr(I));
    if (P = N) or (Copy(P, 1, Length(N) + 1) = N + '=') then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function ParamValue(const Name: String): String;
var
  I: Integer;
  P, N: String;
begin
  Result := '';
  N := '/' + UpperCase(Name) + '=';
  for I := 1 to ParamCount do
  begin
    P := ParamStr(I);
    if Copy(UpperCase(P), 1, Length(N)) = N then
    begin
      Result := Copy(P, Length(N) + 1, Length(P));
      Exit;
    end;
  end;
end;

{ ---------------------------------------------------------------------------
  Журнал установщика: UTF-8 (с BOM в начале файла — его добавляет первая
  запись), по строке на событие, без MsgBox. Значения «секретных» параметров
  (ключ, токен, пароль) в журнал не попадают никогда.
  --------------------------------------------------------------------------- }
function RedactLine(const S: String): String;
var
  P: Integer;
  K: String;
begin
  Result := S;
  P := Pos('=', S);
  if P <= 0 then Exit;
  K := LowerCase(Copy(S, 1, P - 1));
  if (Pos('key', K) > 0) or (Pos('secret', K) > 0) or
     (Pos('token', K) > 0) or (Pos('password', K) > 0) then
    Result := Copy(S, 1, P) + '***';
end;

procedure AppendUtf8Line(const FileName, Text: String);
var
  Lines: TArrayOfString;
begin
  SetArrayLength(Lines, 1);
  Lines[0] := Text;
  SaveStringsToUTF8File(FileName, Lines, True);
end;

procedure LogLine(const Level, Msg: String);
begin
  if GLogPath = '' then Exit;
  AppendUtf8Line(GLogPath,
    GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + '  [' + Level + ']  ' +
    RedactLine(Msg));
end;

{ Запись в журнал до его создания: строки копятся в буфере и выводятся после
  InitLog (файл параметров привилегированной фазы читается раньше — от него
  зависит, создавать ли каталог данных под журнал). }
procedure LogOrDefer(const Level, Msg: String);
begin
  if GLogPath = '' then
    GDeferredLog := GDeferredLog + Level + '|' + RedactLine(Msg) + #10
  else
    LogLine(Level, Msg);
end;

procedure FlushDeferredLog;
var
  I, StartPos, P: Integer;
  Line, Level, Msg: String;
begin
  if GDeferredLog = '' then Exit;
  StartPos := 1;
  for I := 1 to Length(GDeferredLog) do
    if GDeferredLog[I] = #10 then
    begin
      Line := Copy(GDeferredLog, StartPos, I - StartPos);
      StartPos := I + 1;
      P := Pos('|', Line);
      if P > 0 then
      begin
        Level := Copy(Line, 1, P - 1);
        Msg := Copy(Line, P + 1, Length(Line));
        LogLine(Level, Msg);
      end;
    end;
  if StartPos <= Length(GDeferredLog) then
  begin
    Line := Copy(GDeferredLog, StartPos, Length(GDeferredLog) - StartPos + 1);
    P := Pos('|', Line);
    if P > 0 then
    begin
      Level := Copy(Line, 1, P - 1);
      Msg := Copy(Line, P + 1, Length(Line));
      LogLine(Level, Msg);
    end;
  end;
  GDeferredLog := '';
end;

function TryInitLog(const Dir: String): Boolean;
var
  Candidate: String;
begin
  Result := False;
  if Dir = '' then Exit;
  if not ForceDirectories(Dir) then Exit;
  Candidate := Dir + '\install-' +
    GetDateTimeString('yyyymmdd-hhnnss', '-', '-') + '.log';
  AppendUtf8Line(Candidate, 'ETN setup log');
  if not FileExists(Candidate) then Exit;
  GLogPath := Candidate;
  Result := True;
end;

{ Журнал установщика по контракту — %ProgramData%\ETN\logs, но этот каталог
  создаётся только серверной установкой: установка только клиента серверных
  каталогов не создаёт (9b310991). В тестовой сборке каталог теста — песочница,
  журнал пишется туда всегда (кроме подмены /TESTDATADIR). }
function DataDirLogAllowed: Boolean;
begin
  Result := GServerSelected or GServerOnly or (GServerState <> 'not-installed');
#ifdef TestMode
  if GTestDataDir = '' then Result := True;
#endif
end;

procedure InitLog;
var
  TempDir: String;
begin
  GLogPath := '';
  { Основной путь по контракту: %ProgramData%\ETN\logs. }
  if DataDirLogAllowed and TryInitLog(GDataDir + '\logs') then Exit;
  { Fallback по контракту: %TEMP%. }
  TempDir := GetEnv('TEMP');
  if TempDir = '' then TempDir := GetEnv('TMP');
  if TryInitLog(TempDir) then
    LogLine('WARN', 'Журнал в %TEMP%: каталог ' + GDataDir + '\logs не используется')
  else
    GLogPath := '';
end;

{ ---------------------------------------------------------------------------
  JSON: плоский объект схемы v1. Запись — только ASCII (не-ASCII символы
  экранируются как \uXXXX), поэтому файл остаётся корректным UTF-8 без BOM
  при записи через ANSI-функцию SaveStringToFile.
  --------------------------------------------------------------------------- }
function HexDigit(N: Integer): String;
begin
  if N < 10 then Result := Chr(Ord('0') + N)
  else Result := Chr(Ord('a') + N - 10);
end;

function Hex4(Value: Integer): String;
begin
  Result := HexDigit((Value shr 12) and 15) + HexDigit((Value shr 8) and 15) +
    HexDigit((Value shr 4) and 15) + HexDigit(Value and 15);
end;

function JsonEscape(const S: String): String;
var
  I, C: Integer;
  R: String;
begin
  R := '';
  for I := 1 to Length(S) do
  begin
    C := Ord(S[I]);
    if S[I] = '"' then
      R := R + '\"'
    else if S[I] = '\' then
      R := R + '\\'
    else if C < 32 then
      R := R + '\u' + Hex4(C)
    else if C > 126 then
      R := R + '\u' + Hex4(C)
    else
      R := R + S[I];
  end;
  Result := R;
end;

function JsonString(const S: String): String;
begin
  Result := '"' + JsonEscape(S) + '"';
end;

function JsonUnescape(const S: String): String;
var
  I, C: Integer;
  R: String;
begin
  R := '';
  I := 1;
  while I <= Length(S) do
  begin
    if S[I] = '\' then
    begin
      if I = Length(S) then
      begin
        R := R + '\';
        Break;
      end;
      case S[I + 1] of
        '"': begin R := R + '"'; I := I + 2; end;
        '\': begin R := R + '\'; I := I + 2; end;
        '/': begin R := R + '/'; I := I + 2; end;
        'n': begin R := R + #10; I := I + 2; end;
        'r': begin R := R + #13; I := I + 2; end;
        't': begin R := R + #9; I := I + 2; end;
        'u':
          begin
            C := 0;
            if I + 5 <= Length(S) then
            begin
              C := HexVal(S[I + 2]) * 4096 + HexVal(S[I + 3]) * 256 +
                   HexVal(S[I + 4]) * 16 + HexVal(S[I + 5]);
              I := I + 6;
            end
            else
              I := I + 2;
            if (C > 0) and (C <= 65535) then
              R := R + Chr(C);
          end;
      else
      begin
        R := R + S[I];
        I := I + 1;
      end;
      end;
    end
    else
    begin
      R := R + S[I];
      I := I + 1;
    end;
  end;
  Result := R;
end;

{ Возвращает значение ключа плоского JSON-объекта или '' если ключа нет.
  Строки разворачиваются, остальные значения (число/bool/null) — как есть. }
function JsonGetRaw(const Json, Key: String): String;
var
  Needle: String;
  P, I, StartPos: Integer;
begin
  Result := '';
  Needle := '"' + Key + '"';
  P := Pos(Needle, Json);
  if P <= 0 then Exit;
  I := P + Length(Needle);
  while (I <= Length(Json)) and (Json[I] <> ':') do I := I + 1;
  if I > Length(Json) then Exit;
  I := I + 1;
  while (I <= Length(Json)) and ((Json[I] = ' ') or (Json[I] = #9) or
        (Json[I] = #13) or (Json[I] = #10)) do I := I + 1;
  if I > Length(Json) then Exit;
  if Json[I] = '"' then
  begin
    StartPos := I + 1;
    I := StartPos;
    while I <= Length(Json) do
    begin
      if Json[I] = '\' then
        I := I + 2
      else if Json[I] = '"' then
        Break
      else
        I := I + 1;
    end;
    if I > Length(Json) then Exit;
    Result := JsonUnescape(Copy(Json, StartPos, I - StartPos));
  end
  else
  begin
    StartPos := I;
    while (I <= Length(Json)) and (Json[I] <> ',') and (Json[I] <> '}') and
          (Json[I] <> #13) and (Json[I] <> #10) do I := I + 1;
    Result := Trim(Copy(Json, StartPos, I - StartPos));
  end;
end;

{ ---------------------------------------------------------------------------
  Версии: числовое сравнение до 4 компонент, суффикс pre-release отбрасывается.
  --------------------------------------------------------------------------- }
function VerPart(const S: String; Index: Integer): Integer;
var
  I, Value, Part: Integer;
  C: Char;
  Done: Boolean;
begin
  Value := 0;
  Part := 0;
  Done := False;
  for I := 1 to Length(S) do
  begin
    if Done then Break;
    C := S[I];
    if C = '-' then
      Done := True
    else if C = '.' then
    begin
      Part := Part + 1;
      if Part > Index then Done := True;
    end
    else if (C >= '0') and (C <= '9') then
    begin
      if Part = Index then
        Value := Value * 10 + (Ord(C) - Ord('0'));
    end
    else
      Done := True;
  end;
  Result := Value;
end;

function SemverCompare(const A, B: String): Integer;
var
  I, PA, PB: Integer;
begin
  Result := 0;
  for I := 0 to 3 do
  begin
    PA := VerPart(A, I);
    PB := VerPart(B, I);
    if PA < PB then
    begin
      Result := -1;
      Exit;
    end;
    if PA > PB then
    begin
      Result := 1;
      Exit;
    end;
  end;
end;

{ ---------------------------------------------------------------------------
  Состояние машины
  --------------------------------------------------------------------------- }
function ReadTextFile(const FileName: String): String;
var
  Text: AnsiString;
begin
  Text := '';
  if not FileExists(FileName) then
  begin
    Result := '';
    Exit;
  end;
  LoadStringFromFile(FileName, Text);
  Result := Text;
end;

procedure LoadInstallJson;
var
  Schema: String;
begin
  GInstallJsonPresent := False;
  GInstallJsonValid := False;
  GInstalledVersion := '';
  GInstalledMode := '';
  GInstalledDataDir := '';
  GInstalledHost := '';
  GInstalledPort := '';
  GInstalledClientScope := '';
  GInstalledAt := '';
  GInstalledFirewall := False;
  GInstallJsonPath := GDataDir + '\install.json';
  if not FileExists(GInstallJsonPath) then Exit;
  GInstallJsonPresent := True;
  GInstallJsonText := ReadTextFile(GInstallJsonPath);
  if GInstallJsonText = '' then Exit;
  Schema := JsonGetRaw(GInstallJsonText, 'schema');
  GInstalledVersion := JsonGetRaw(GInstallJsonText, 'product_version');
  GInstalledMode := JsonGetRaw(GInstallJsonText, 'mode');
  GInstalledDataDir := JsonGetRaw(GInstallJsonText, 'data_dir');
  GInstalledHost := JsonGetRaw(GInstallJsonText, 'host');
  GInstalledPort := JsonGetRaw(GInstallJsonText, 'port');
  GInstalledClientScope := JsonGetRaw(GInstallJsonText, 'client_scope');
  GInstalledAt := JsonGetRaw(GInstallJsonText, 'installed_at');
  GInstalledFirewall := LowerCase(JsonGetRaw(GInstallJsonText, 'firewall')) = 'true';
  { Повреждённым считаем файл, у которого нет схемы v1, версии или mode.
    Такой файл трактуется как repair, а не как «не установлено».
    mode=client — установка только клиента «для всех»: область клиента
    сохраняется, чтобы повторный запуск не поставил вторую per-user копию. }
  GInstallJsonValid := (Schema = '1') and (GInstalledVersion <> '') and
    ((GInstalledMode = 'service') or (GInstalledMode = 'app') or
     (GInstalledMode = 'client'));
  if GInstallJsonValid and (GInstalledClientScope = 'null') then
    GInstalledClientScope := '';
end;

function MachineAppDir: String;
begin
#ifdef TestMode
  { В тестовой сборке реальная машинная установка на этой машине не должна
    влиять на состояние: каталоги изолированы. }
  Result := '';
#else
  Result := ExpandConstant('{commonpf}\ETN');
#endif
end;

function ServerFilesAt(const Dir: String): Boolean;
begin
  Result := (Dir <> '') and FileExists(Dir + '\server\package.json') and
    FileExists(Dir + '\server\dist\index.js');
end;

function ServerFilesPresent: Boolean;
begin
  Result := ServerFilesAt(GServerDir) or ServerFilesAt(MachineAppDir);
end;

{ Каталог, в котором реально лежат файлы сервера: в неэлевированном экземпляре
  каталог программы — это профиль пользователя, а машинная установка лежит в
  Program Files. }
function ServerFilesDir: String;
begin
  if ServerFilesAt(GServerDir) then
    Result := GServerDir
  else if ServerFilesAt(MachineAppDir) then
    Result := MachineAppDir
  else
    Result := '';
end;

function ServerFilesVersion: String;
var
  Dir: String;
begin
  Result := '';
  Dir := ServerFilesDir;
  if Dir = '' then Exit;
  Result := JsonGetRaw(ReadTextFile(Dir + '\server\package.json'), 'version');
end;

function DataDirPresent: Boolean;
begin
  Result := DirExists(GDataDir) and
    (FileExists(GDataDir + '\_system.db') or DirExists(GDataDir + '\networks'));
end;

function ClientFilesPresent: Boolean;
var
  MachineDir: String;
begin
  MachineDir := MachineAppDir;
  Result := FileExists(GServerDir + '\ETN.exe') or
    FileExists(GServerDir + '\client\ETN.exe');
  if not Result and (MachineDir <> '') then
    Result := FileExists(MachineDir + '\client\ETN.exe') or
      FileExists(MachineDir + '\ETN.exe');
end;

{ Запись установки Inno: машина целиком (HKLM/HKLM64) пишется только
  привилегированной фазой; запись HKCU относится к клиенту «только для меня»
  и о сервере ничего не говорит. В тестовой сборке реестр не читается. }
function MachineInstallRecordPresent: Boolean;
var
  Key: String;
begin
  Result := False;
#ifdef TestMode
  if GTestRecord = '1' then Result := True;
  Exit;
#endif
  Key := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' +
    '{6D7E1C2A-4B9A-4E7C-9F3D-2A5B8C1E4F70}_is1';
  Result := RegKeyExists(HKLM, Key) or RegKeyExists(HKLM64, Key);
end;

procedure DetectState;
begin
  GServerFilesPresent := ServerFilesPresent;
  GDataDirPresent := DataDirPresent;
  GClientFilesPresent := ClientFilesPresent;
  GFilesVersion := ServerFilesVersion;
  GInstallerRecordPresent := MachineInstallRecordPresent;

  GBlockedDowngrade :=
    (GInstallJsonValid and (SemverCompare(GInstalledVersion, GProductVersion) > 0)) or
    ((not GInstallJsonValid) and GServerFilesPresent and (GFilesVersion <> '') and
     (SemverCompare(GFilesVersion, GProductVersion) > 0));

  if GInstallJsonValid then
  begin
    { install.json — запись установщика: файлы должны соответствовать ей.
      Сверка версии в server\package.json отличает «актуальная версия» от
      «ремонт»: файлы чужие/недописанные — repair, совпали — installed. }
    if GInstalledMode = 'client' then
    begin
      { Запись о клиенте «для всех» без сервера: сервер не установлен. }
      if GServerFilesPresent then
        GServerState := 'repair'
      else
        GServerState := 'not-installed';
    end
    else if not GServerFilesPresent then
      GServerState := 'repair'
    else if (GFilesVersion <> '') and (GFilesVersion <> GInstalledVersion) then
      GServerState := 'repair'
    else if SemverCompare(GInstalledVersion, GProductVersion) < 0 then
      GServerState := 'update-available'
    else if SemverCompare(GInstalledVersion, GProductVersion) > 0 then
      GServerState := 'downgrade'
    else
      GServerState := 'installed';
  end
  else if GServerFilesPresent then
  begin
    { Файлы без записи установки: ручная/частичная установка или удалённый
      install.json. Понижение по версии файлов запрещаем и здесь. }
    if GBlockedDowngrade then
      GServerState := 'downgrade'
    else
      GServerState := 'repair';
  end
  else if GDataDirPresent then
    { Ручная установка 0.14.1 (git clone, без записи установки): данные есть,
      файлов поставки и install.json нет — «подключить существующие данные»;
      программа ставится, данные не трогаются, init не вызывается (686c5d76). }
    GServerState := 'adopt'
  else if GInstallerRecordPresent and (not GClientFilesPresent) then
    { Запись установки в HKLM есть, а файлов и конфигурации нет — установка
      сервера разрушена (repair), а не «не установлено». Машинный клиент пишет
      ту же запись, поэтому при найденных файлах клиента это не сервер. }
    GServerState := 'repair'
  else
    GServerState := 'not-installed';

  GAdoptExistingData := GServerState = 'adopt';

  if GClientFilesPresent then
    GClientState := 'installed'
  else
    GClientState := 'not-installed';
end;

{ При обновлении/ремонте режим и параметры берутся из install.json: обновление
  не меняет режим службы и настройки подключения (8b1f5980, TP установщика). }
procedure ApplyInstalledParams;
begin
  if not GInstallJsonValid then Exit;
  { mode=client — запись только о клиенте: режим сервера из неё не берём. }
  if (GInstalledMode = 'service') or (GInstalledMode = 'app') then
    GServerMode := GInstalledMode;
  if GInstalledHost <> '' then GServerHost := GInstalledHost;
  if GInstalledPort <> '' then GServerPort := GInstalledPort;
  if JsonGetRaw(GInstallJsonText, 'firewall') <> '' then
    GServerFirewall := GInstalledFirewall;
end;

function ServerVersionText: String;
begin
  if GInstalledVersion <> '' then
    Result := GInstalledVersion
  else
    Result := GFilesVersion;
end;

function ServerStateText: String;
begin
  if GServerState = 'not-installed' then
    Result := 'не установлен'
  else if GServerState = 'adopt' then
    Result := 'найдены существующие данные (' + GDataDir +
      ') — будут подключены без изменения данных'
  else if GServerState = 'installed' then
    Result := 'установлен ' + ServerVersionText + ' — актуальная версия'
  else if GServerState = 'update-available' then
    Result := 'установлен ' + GInstalledVersion + ' — доступно обновление до ' + GProductVersion
  else if GServerState = 'repair' then
  begin
    if GInstallJsonValid then
      Result := 'установлен ' + GInstalledVersion + ' — переустановка (repair)'
    else if GServerFilesPresent then
      Result := 'файлы найдены без записи установки — установка будет восстановлена (repair)'
    else
      Result := 'установлен частично — будет восстановлен (repair)';
  end
  else
    Result := 'установлена более новая версия ' + ServerVersionText +
      ' — понижение запрещено';
end;

function ClientStateText: String;
begin
  if GClientState = 'installed' then
    Result := 'клиент обнаружен на этом компьютере'
  else
    Result := 'не установлен';
end;

{ Сервер считается присутствующим, если о нём есть запись установщика,
  файлы поставки, каталог данных (adopt) или машинная запись установки без
  клиента (разрушенная установка — её надо чинить, а не ставить с нуля). }
function ServerWasInstalled: Boolean;
begin
  { mode=client — запись только о клиенте «для всех»: сервера она не касается. }
  Result := (GInstallJsonValid and (GInstalledMode <> 'client')) or
    GServerFilesPresent or GAdoptExistingData or
    (GInstallerRecordPresent and (not GClientFilesPresent));
end;

{ Начальный выбор компонентов (требование c4ae07c7, сценарии 83cf6011 и
  80d62367): ETN нет вовсе — отмечены оба компонента; хотя бы один установлен —
  только установленные, отсутствующие сняты. Понижение сервера не отмечается. }
procedure ApplyDefaultSelection;
begin
  GServerSelected := (GServerState <> 'downgrade') and ServerWasInstalled;
  GClientSelected := GClientState = 'installed';

  if (GServerState = 'not-installed') and (not GBlockedDowngrade) and
     (not GServerSelected) and (not GClientSelected) then
  begin
    { Чистая машина: по умолчанию ставится всё. }
    GServerSelected := True;
    GClientSelected := True;
  end;

  { Область клиента: «только для меня»; если клиент уже стоит «для всех»
    (install.json, client_scope=machine) — сохраняем машинную область. }
  GClientScopeUser := GInstalledClientScope <> 'machine';
end;

{ ---------------------------------------------------------------------------
  Первичная инициализация (etn init) и первичный API-ключ — задача 686c5d76.
  --------------------------------------------------------------------------- }

{ Каталог временного ключа: общий каталог данных, подкаталог .install.
  Права ограничиваются icacls до записи ключа (см. HardenKeyDir). }
function KeyInstallDir: String;
begin
  Result := GDataDir + '\.install';
end;

function KeyFilePath: String;
begin
  Result := KeyInstallDir + '\primary-key.txt';
end;

{ Окружение дочерних процессов: init и любые вызовы node получают те же
  ETN_DATA_DIR/ETN_PORT/ETN_HOST, что и служба. }
procedure ApplyServerEnv;
begin
  SetEnvironmentVariableW('ETN_DATA_DIR', GDataDir);
  SetEnvironmentVariableW('ETN_PORT', GServerPort);
  SetEnvironmentVariableW('ETN_HOST', GServerHost);
end;

{ Ограничение доступа к каталогу ключа: только SYSTEM, администраторы и
  пользователь, запустивший установщик (он читает ключ после элевации, даже
  если UAC подтвердил другой администратор). Наследование снимается: иначе
  ключ унаследует права %ProgramData% (чтение — все пользователи). }
function HardenKeyDir: Boolean;
var
  Args, User: String;
  Code: Integer;
begin
  Result := False;
  if not ForceDirectories(KeyInstallDir) then
  begin
    LogLine('ERROR', 'Не удалось создать каталог для ключа: ' + KeyInstallDir);
    Exit;
  end;
  User := GOriginalUser;
  if User = '' then User := GetUserNameString;
  Args := '"' + KeyInstallDir + '" /inheritance:r /grant:r ' +
    '"*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "' + User + ':(OI)(CI)F"';
  if Exec(ExpandConstant('{sys}\icacls.exe'), Args, '', SW_HIDE,
    ewWaitUntilTerminated, Code) and (Code = 0) then
  begin
    LogLine('INFO', 'Доступ к каталогу ключа ограничен: ' + KeyInstallDir);
    Result := True;
    Exit;
  end;
  LogLine('ERROR', 'icacls не ограничил доступ к ' + KeyInstallDir +
    ' (код ' + IntToStr(Code) + '): ключ в такой каталог не пишется');
end;

{ Путь к node.exe поставки; в тестовой сборке подменяется /TESTNODEEXE. }
function ServerNodeExe(const ServerDir: String): String;
begin
  Result := ServerDir + '\node\node.exe';
#ifdef TestMode
  if GTestNodeExe <> '' then Result := GTestNodeExe;
#endif
end;

function ServerCliPath(const ServerDir: String): String;
begin
  Result := ServerDir + '\server\dist\cli.js';
end;

function ValidAdminLogin(const Login: String): Boolean;
begin
  Result := (Trim(Login) <> '') and (Pos('"', Login) = 0) and
    (Pos(#10, Login) = 0) and (Pos(#13, Login) = 0);
end;

{ Отображаемое имя приходит из файла параметров (не из экрана) и попадает в
  командную строку etn init в кавычках — проверяется по тем же правилам, что
  логин: непустое после Trim, без кавычек и переводов строк. }
function ValidDisplayName(const Name: String): Boolean;
begin
  Result := (Trim(Name) <> '') and (Pos('"', Name) = 0) and
    (Pos(#10, Name) = 0) and (Pos(#13, Name) = 0);
end;

{ `etn init --check`: 0 — администратор есть, 1 — нет, 2 — проверить не
  удалось, -1 — проверка невозможна (нет файлов/не запустился процесс). }
function RunCliCheck(const ServerDir: String): Integer;
var
  Node, Cli, Args: String;
  Code: Integer;
begin
  Result := -1;
  if ServerDir = '' then Exit;
  Node := ServerNodeExe(ServerDir);
  Cli := ServerCliPath(ServerDir);
  if (not FileExists(Node)) or (not FileExists(Cli)) then
  begin
    LogLine('WARN', 'Проверка инициализации невозможна: нет ' + Node + ' или ' + Cli);
    Exit;
  end;
  Args := '"' + Cli + '" init --check';
  if not Exec(Node, Args, ServerDir, SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    LogLine('WARN', 'Проверка инициализации: не удалось запустить ' + Node);
    Exit;
  end;
  Result := Code;
end;

{ Критерий «уже инициализирован» — hasFirstUser(), а не наличие _system.db:
  база от прерванной попытки должна доинициализироваться. }
procedure ResolveFirstUserState;
var
  Dir: String;
  Code: Integer;
begin
  GFirstUserChecked := False;
  GFirstUserPresent := False;
  Dir := ServerFilesDir;
  if Dir = '' then
  begin
    LogLine('INFO', 'Файлы сервера не найдены: первый администратор отсутствует (первая установка)');
    Exit;
  end;
#ifdef TestMode
  if GTestInit <> 'real' then
  begin
    LogLine('INFO', 'TESTINIT не задан: проверка hasFirstUser пропущена (тестовый режим)');
    Exit;
  end;
#endif
  ApplyServerEnv;
  Code := RunCliCheck(Dir);
  if Code = 0 then
  begin
    GFirstUserChecked := True;
    GFirstUserPresent := True;
  end
  else if Code = 1 then
  begin
    GFirstUserChecked := True;
    GFirstUserPresent := False;
  end
  else
    LogLine('WARN', 'Проверка hasFirstUser не удалась (код ' + IntToStr(Code) +
      '): состояние инициализации неизвестно');
  LogLine('INFO', 'hasFirstUser: ' + Pick(GFirstUserPresent, 'есть', 'нет') +
    ' (проверено: ' + Pick(GFirstUserChecked, 'да', 'нет') + ')');
end;

{ Прочитать ключ из защищённого файла во внутреннюю переменную. В журнал и
  install.json значение не попадает никогда — только длина. }
procedure LoadPendingKey;
var
  Text: String;
begin
  GPendingKey := '';
  if not FileExists(KeyFilePath) then Exit;
  Text := Trim(ReadTextFile(KeyFilePath));
  if Text = '' then Exit;
  GPendingKey := Text;
end;

function IsSilentServerOnly: Boolean;
begin
  Result := GSilent and GServerOnly;
end;

{ Единственная точка вызова etn init. Работает в привилегированной фазе:
  файлы сервера уже скопированы, права администратора есть. Повторно init
  не вызывается: критерий — hasFirstUser. }
procedure EnsureFirstUser;
var
  Dir, Node, Cli, Args: String;
  Code: Integer;
begin
  if not GServerSelected then Exit;
  if GFirstUserPresent then
  begin
    LogLine('INFO', 'etn init не вызывается: первый администратор уже есть');
    Exit;
  end;
  if not GFirstUserChecked then
  begin
    ResolveFirstUserState;
    if GFirstUserPresent then
    begin
      LogLine('INFO', 'etn init не вызывается: первый администратор уже есть (проверка в привилегированной фазе)');
      Exit;
    end;
  end;
  if IsSilentServerOnly then
  begin
    LogLine('INFO', 'Silent: etn init не вызывается никогда — нужен ручной режим');
    Exit;
  end;
#ifdef TestMode
  if GTestInit <> 'real' then
  begin
    LogLine('INFO', 'TESTINIT не задан: etn init не вызывается (тестовый режим)');
    Exit;
  end;
#endif
  if GAdminLogin = '' then GAdminLogin := GOriginalUser;
  if not ValidAdminLogin(GAdminLogin) then
  begin
    GExitCode := EXIT_FAILED;
    LogLine('ERROR', 'Сбой: etn init отменён — недопустимый логин администратора (код 10)');
    Exit;
  end;
  GAdminLogin := Trim(GAdminLogin);
  GAdminDisplayName := Trim(GAdminDisplayName);
  if (GAdminDisplayName <> '') and (not ValidDisplayName(GAdminDisplayName)) then
  begin
    GExitCode := EXIT_FAILED;
    LogLine('ERROR', 'Сбой: etn init отменён — недопустимое отображаемое имя ' +
      'администратора (кавычки и переводы строк запрещены; код 10)');
    Exit;
  end;
  Dir := ServerFilesDir;
  Node := ServerNodeExe(Dir);
  Cli := ServerCliPath(Dir);
  if (Dir = '') or (not FileExists(Node)) or (not FileExists(Cli)) then
  begin
    GExitCode := EXIT_FAILED;
    LogLine('ERROR', 'Сбой: etn init невозможен — нет ' + Node + ' или ' + Cli + ' (код 10)');
    Exit;
  end;
  if not HardenKeyDir then
  begin
    GExitCode := EXIT_FAILED;
    LogLine('ERROR', 'Сбой: etn init отменён — каталог ключа не защищён (код 10)');
    Exit;
  end;
  { Ключ от предыдущей попытки больше не действителен: init выдаст новый. }
  if FileExists(KeyFilePath) then DeleteFile(KeyFilePath);
  ApplyServerEnv;
  Args := '"' + Cli + '" init --username "' + GAdminLogin + '"';
  if GAdminDisplayName <> '' then
    Args := Args + ' --display-name "' + GAdminDisplayName + '"';
  Args := Args + ' --key-out "' + KeyFilePath + '"';
  GInitAttempted := True;
  LogLine('INFO', 'etn init: запуск (данные ' + GDataDir + ', порт ' + GServerPort +
    ', хост ' + GServerHost + ')');
  if not Exec(Node, Args, Dir, SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    GExitCode := EXIT_FAILED;
    LogLine('ERROR', 'Сбой: etn init не запустился (' + Node + '), код 10');
    Exit;
  end;
  if Code = 0 then
  begin
    GFirstUserChecked := True;
    GFirstUserPresent := True;
    LoadPendingKey;
    GPendingKeyPrevious := False;
    if GPendingKey = '' then
    begin
      GExitCode := EXIT_FAILED;
      LogLine('ERROR', 'Сбой: etn init завершился, но файл ключа пуст: ' + KeyFilePath + ' (код 10)');
    end
    else
      LogLine('INFO', 'etn init выполнен; ключ сохранён в защищённый файл (в журнал не пишется)');
    Exit;
  end;
  LogLine('ERROR', 'etn init завершился сбоем (код ' + IntToStr(Code) + ')');
  { Сработать мог запрет повторной инициализации: если администратор уже есть,
    установка продолжается без нового ключа. }
  ResolveFirstUserState;
  if GFirstUserPresent then
    LogLine('WARN', 'Первый администратор уже существует: etn init не требуется')
  else
  begin
    GExitCode := EXIT_FAILED;
    LogLine('ERROR', 'Сбой: сервер не инициализирован (код 10)');
  end;
end;

{ В silent etn init не вызывается никогда. Отсутствие администратора после
  старта — код 10: сервер без администратора не стартует, нужен ручной режим. }
function SilentAdminPresent: Boolean;
begin
  Result := False;
  ResolveFirstUserState;
#ifdef TestMode
  if GTestInit <> 'real' then
  begin
    LogLine('INFO', 'TESTINIT не задан: проверка администратора в silent пропущена (тестовый режим)');
    Result := True;
    Exit;
  end;
#endif
  Result := GFirstUserChecked and GFirstUserPresent;
  if not Result then
    LogLine('ERROR', 'Первичная инициализация не выполнена: нет первого администратора ' +
      '(ручной режим: etn init --username <логин>)');
end;

function InitStateText: String;
begin
  if GFirstUserPresent then
    Result := 'Сервер уже инициализирован — init не повторяется, новый ключ установщик ' +
      'не выдаёт (перевыпуск — в клиенте).'
  else if GPendingKey <> '' then
    Result := 'Найден ключ от предыдущего запуска установщика — он будет показан после установки.'
  else
    Result := '';
end;

{ ---------------------------------------------------------------------------
  Повышение прав
  --------------------------------------------------------------------------- }
function IsElevatedNow: Boolean;
begin
  Result := IsAdmin;
#ifdef TestMode
  { Тестовый хук: имитация элевированного процесса в прогоне
    installer/tests/silent-codes.ps1 (в обычной сборке кода нет). }
  if (not Result) and (GTestElevated = '1') then
  begin
    LogLine('WARN', 'TESTELEVATED=1: проверка прав администратора подменена (тестовый режим)');
    Result := True;
  end;
#endif
end;

function ServiceRegistered: Boolean;
begin
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\' + SERVICE_NAME);
#ifdef TestMode
  if GTestService = 'present' then
  begin
    LogLine('WARN', 'TESTSERVICE=present: наличие службы подменено (тестовый режим)');
    Result := True;
  end
  else if GTestService = 'absent' then
  begin
    LogLine('WARN', 'TESTSERVICE=absent: наличие службы подменено (тестовый режим)');
    Result := False;
  end;
#endif
end;

{ Проверка записи в каталог пробным файлом. ForceDirectories для уже
  существующего каталога возвращает True независимо от прав (дефект приёмки
  каркаса): каталог может существовать и быть недоступным на запись —
  например %ProgramData%\ETN\.install, созданный другим администратором.
  Поэтому каждый кандидат проверяется реальной записью файла. }
function ProbeWritableDir(const Dir: String): Boolean;
var
  Probe: String;
begin
  Result := False;
  if Dir = '' then Exit;
  if not ForceDirectories(Dir) then Exit;
  Probe := Dir + '\.etn-write-probe';
  Result := SaveStringToFile(Probe, 'probe', False);
  if Result then DeleteFile(Probe);
end;

{ Файл параметров для элевированной фазы: строки key=value, ASCII.
  UAC может запустить дочерний процесс с учётными данными ДРУГОГО
  администратора — профиль и %TEMP% тогда чужие, поэтому файл кладётся в
  общий каталог. Кандидаты по порядку: %ProgramData%\ETN\.install (только для
  серверной установки), %PUBLIC%, %TEMP%. Каждый проверяется записью пробного
  файла; секреты в командной строке не передаются — только путь к файлу. }
function NewParamsFilePath: String;
var
  Dir: String;
begin
  Result := '';
  if GServerSelected then
  begin
#ifdef TestMode
    Dir := GDataDir + '\.install';
#else
    Dir := ExpandConstant('{commonappdata}\ETN\.install');
#endif
    if not ProbeWritableDir(Dir) then
    begin
      LogLine('WARN', 'Каталог параметров недоступен на запись: ' + Dir);
      Dir := '';
    end;
  end
  else
    Dir := '';
  if Dir = '' then
  begin
    Dir := GetEnv('PUBLIC');
    if not ProbeWritableDir(Dir) then
    begin
      if Dir <> '' then
        LogLine('WARN', 'Общий каталог недоступен на запись: ' + Dir);
      Dir := ExpandConstant('{tmp}');
      if not ProbeWritableDir(Dir) then
      begin
        LogLine('ERROR', 'Нет каталога для файла параметров (проверены .install, %PUBLIC%, %TEMP%)');
        Result := '';
        Exit;
      end;
    end;
  end;
  Result := Dir + '\params-' + GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.json';
end;

function ParamsFilePath: String;
begin
  { Дочерний получает путь через /PARAMS; в остальных случаях — путь,
    вычисленный родителем и сохранённый в GParamsPath. }
  Result := ParamValue('PARAMS');
  if Result = '' then Result := GParamsPath;
  if Result = '' then
    Result := ExpandConstant('{tmp}') + '\etn-install-params.ini';
end;

function ParamsText(const ReasonPath: String): String;
begin
  Result :=
    'server=' + IntToStr(Ord(GServerSelected)) + #13#10 +
    'client=' + IntToStr(Ord(GClientSelected)) + #13#10 +
    'client_scope=' + Pick(GClientScopeUser, 'user', 'machine') + #13#10 +
    'mode=' + GServerMode + #13#10 +
    'host=' + GServerHost + #13#10 +
    'port=' + GServerPort + #13#10 +
    'firewall=' + IntToStr(Ord(GServerFirewall)) + #13#10 +
    'login=' + GAdminLogin + #13#10 +
    'display_name=' + GAdminDisplayName + #13#10 +
    'original_user=' + GOriginalUser + #13#10 +
    'reason_file=' + ReasonPath + #13#10;
end;

procedure WriteParamsFile;
var
  Lines: String;
begin
  if GParamsPath = '' then
    GParamsPath := NewParamsFilePath;
  if GParamsPath = '' then
  begin
    LogLine('ERROR', 'Файл параметров: нет ни одного каталога, доступного на запись');
    Exit;
  end;
  if GReasonFile = '' then
    GReasonFile := ExtractFileDir(GParamsPath) + '\reason-' +
      GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.txt';
  Lines := ParamsText(GReasonFile);
  if SaveStringToFile(GParamsPath, Lines, False) then Exit;
  { Проба записи могла соврать (каталог отобрали между пробой и записью):
    пробуем %TEMP% явно, а не сдаёмся с путём, в который нельзя писать. }
  LogLine('WARN', 'Файл параметров не записан в ' + GParamsPath + ' — пробую %TEMP%');
  GParamsPath := ExpandConstant('{tmp}') + '\params-' +
    GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.json';
  GReasonFile := ExpandConstant('{tmp}') + '\reason-' +
    GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.txt';
  if SaveStringToFile(GParamsPath, ParamsText(GReasonFile), False) then Exit;
  LogLine('ERROR', 'Не удалось записать файл параметров: ' + GParamsPath);
end;

procedure ApplyParamLine(const Line: String);
var
  P: Integer;
  K, V: String;
begin
  P := Pos('=', Line);
  if P <= 0 then Exit;
  K := LowerCase(Trim(Copy(Line, 1, P - 1)));
  V := Trim(Copy(Line, P + 1, Length(Line)));
  if K = 'server' then GServerSelected := V = '1'
  else if K = 'client' then GClientSelected := V = '1'
  else if K = 'client_scope' then GClientScopeUser := V <> 'machine'
  else if K = 'mode' then GServerMode := V
  else if K = 'host' then GServerHost := V
  else if K = 'port' then GServerPort := V
  else if K = 'firewall' then GServerFirewall := V = '1'
  else if K = 'login' then GAdminLogin := V
  else if K = 'display_name' then GAdminDisplayName := V
  else if K = 'original_user' then GOriginalUser := V
  else if K = 'reason_file' then GReasonFile := V
  else
    LogOrDefer('INFO', 'параметр ' + K + '=' + V);
end;

procedure ReadParamsFile;
var
  Text: String;
  I, StartPos: Integer;
begin
  if not FileExists(ParamsFilePath) then
  begin
    LogOrDefer('WARN', 'Файл параметров не найден: ' + ParamsFilePath);
    Exit;
  end;
  Text := ReadTextFile(ParamsFilePath);
  StartPos := 1;
  for I := 1 to Length(Text) do
    if (Text[I] = #10) then
    begin
      ApplyParamLine(Trim(Copy(Text, StartPos, I - StartPos)));
      StartPos := I + 1;
    end;
  if StartPos <= Length(Text) then
    ApplyParamLine(Trim(Copy(Text, StartPos, Length(Text) - StartPos + 1)));
end;

{ Перезапуск себя с повышением прав (UAC): как только пользователь согласился,
  родительский экземпляр ждёт код возврата дочернего и возвращает его сам.
  Отказ UAC — ShellExec вернёт False. }
function RunElevatedChild: Integer;
var
  Args, ReasonText: String;
  Raw: AnsiString;
  Code: Integer;
begin
  Result := -1;
  GChildResult := -1;
  GChildReason := '';
  GParamsPath := '';
  GReasonFile := '';
  WriteParamsFile;
  if (GParamsPath = '') or (not FileExists(GParamsPath)) then
  begin
    LogLine('ERROR', 'Файл параметров не создан — повышение прав отменено');
    Exit;
  end;
  Args := '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /PRIVILEGEDPHASE /PARAMS="' +
    GParamsPath + '"';
  LogLine('INFO', 'Повышение прав: перезапуск (файл параметров ' + GParamsPath + ')');
  if not ShellExec('runas', ExpandConstant('{srcexe}'), Args, '',
    SW_SHOWNORMAL, ewWaitUntilTerminated, Code) then
  begin
    LogLine('ERROR', 'Повышение прав отклонено (UAC): изменения не выполнялись');
    DeleteFile(GParamsPath);
    DeleteFile(GReasonFile);
    Result := -1;
    Exit;
  end;
  LogLine('INFO', 'Дочерний (элевированный) установщик завершился с кодом ' + IntToStr(Code));
  { Причина отказа предусловия — из файла, который записал дочерний процесс:
    сообщение об ошибке должно называть причину, а не отправлять в журнал. }
  if Code = EXIT_PRECONDITION then
  begin
    { Причина — UTF-8: файл читают и установщик (сообщение пользователю), и
      тесты, независимо от системной кодовой страницы. }
    ReasonText := '';
    if FileExists(GReasonFile) and LoadStringFromFile(GReasonFile, Raw) then
      ReasonText := Utf8Decode(Raw);
    GChildReason := Trim(ReasonText);
    DeleteFile(GReasonFile);
  end;
  { Файл параметров удаляется после использования: в общем каталоге он
    оставаться не должен (дочерний мог не успеть удалить его сам). }
  DeleteFile(GParamsPath);
  GChildResult := Code;
  Result := Code;
end;

{ ---------------------------------------------------------------------------
  Установка и параметры
  --------------------------------------------------------------------------- }
function InPrivilegedContext: Boolean;
begin
  { Привилегированная фаза — та, что пишет в каталог программы и каталог
    данных: silent (предусловие — уже элевирован), дочерняя копия с
    /PRIVILEGEDPHASE, либо административный режим установки (autopf =
    Program Files). Элевированный, но не административный процесс пишет в
    профиль пользователя и привилегированной фазой не считается — иначе
    сервер попал бы и в Program Files (дочерний), и в профиль (родитель). }
  Result := GWorkAllowed and
    (GSilent or GPrivilegedPhase or (GIsElevated and IsAdminInstallMode));
end;

{ Права администратора нужны серверу и клиенту «для всех пользователей»;
  клиент «только для меня» ставится без повышения прав. }
function NeedElevation: Boolean;
begin
  Result := GServerSelected or (GClientSelected and (not GClientScopeUser));
end;

function GDoPrivilegedWork: Boolean;
begin
  Result := GServerSelected and InPrivilegedContext;
end;

function InstallServerPayload: Boolean;
begin
  Result := GDoPrivilegedWork and not GSkipCopy;
end;

function InstallClientMachine: Boolean;
begin
  Result := GClientSelected and InPrivilegedContext and not GClientScopeUser;
end;

function InstallClientUser: Boolean;
begin
  { «Только для меня» ставится только неэлевированной фазой: в дочернем
    привилегированном процессе autopf и localappdata могут указывать на
    профиль другого администратора. }
  Result := GClientSelected and GWorkAllowed and GClientScopeUser and
    (not GPrivilegedPhase);
end;

{ Режим для install.json: выбран сервер — его режим; сервер не выбран, но
  есть запись серверной установки — сохраняем её режим; иначе установка только
  клиента «для всех» (mode=client), чтобы область клиента восстанавливалась. }
function EffectiveInstallMode: String;
begin
  if GServerSelected then
    Result := GServerMode
  else if GInstallJsonValid and (GInstalledMode <> 'client') then
    Result := GInstalledMode
  else if GClientSelected then
    Result := 'client'
  else
    Result := GServerMode;
end;

function BuildInstallJson: String;
var
  Scope, Mode: String;
begin
  if GClientSelected then
  begin
    if GClientScopeUser then Scope := 'user' else Scope := 'machine';
  end
  else if GInstalledClientScope <> '' then
    Scope := GInstalledClientScope
  else
    Scope := '';
  Mode := EffectiveInstallMode;
  Result := '{' +
    '"schema":1,' +
    '"product_version":' + JsonString(GProductVersion) + ',' +
    '"mode":' + JsonString(Mode) + ',' +
    '"data_dir":' + JsonString(GDataDir) + ',' +
    '"host":' + JsonString(GServerHost) + ',' +
    '"port":' + GServerPort + ',' +
    '"firewall":' + Pick(GServerFirewall, 'true', 'false') + ',' +
    '"client_scope":' + Pick(Scope <> '', JsonString(Scope), 'null') + ',' +
    '"installed_at":' + JsonString(IfStr(GInstalledAt = '', NowIso, GInstalledAt)) + ',' +
    '"last_log":' + JsonString(GLogPath) +
    '}' + #13#10;
end;

function ParamsUnchanged: Boolean;
begin
  Result := GInstallJsonValid and
    (GInstalledVersion = GProductVersion) and
    (GInstalledMode = EffectiveInstallMode) and
    (GInstalledDataDir = GDataDir) and
    (GInstalledHost = GServerHost) and
    (GInstalledPort = GServerPort) and
    (GInstalledFirewall = GServerFirewall) and
    ((not GClientSelected) or
     ((GClientScopeUser and (GInstalledClientScope = 'user')) or
      ((not GClientScopeUser) and (GInstalledClientScope = 'machine'))));
end;

{ Атомарная запись: temp + MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH). }
function WriteInstallJson: Boolean;
var
  Content, Tmp: String;
begin
  Result := False;
  Content := BuildInstallJson;
  { last_log обновляется каждый запуск — это единственное поле, которое
    пишется всегда: по нему ищут журнал последней попытки установки. Пропуск
    записи возможен только когда не изменились ни параметры, ни путь журнала. }
  if ParamsUnchanged and (GInstalledAt <> '') and (GLogPath <> '') and
     (JsonGetRaw(GInstallJsonText, 'last_log') = GLogPath) then
  begin
    LogLine('INFO', 'install.json: параметры и журнал не изменились — файл не перезаписывается');
    Result := True;
    Exit;
  end;
  Tmp := GInstallJsonPath + '.tmp';
  { Журнал установки клиента пишется в %TEMP%, поэтому каталог данных может не
    существовать; но запись установки машинного клиента (install.json) живёт в
    нём — каталог создаётся перед записью. Подкаталоги сервера (logs\service,
    backups) при этом не создаются (9b310991). }
  if not ForceDirectories(ExtractFileDir(GInstallJsonPath)) then
  begin
    LogLine('ERROR', 'install.json: не удалось создать каталог ' + ExtractFileDir(GInstallJsonPath));
    Exit;
  end;
  if not SaveStringToFile(Tmp, Content, False) then
  begin
    LogLine('ERROR', 'install.json: не удалось записать временный файл ' + Tmp);
    Exit;
  end;
  if not MoveFileExW(Tmp, GInstallJsonPath,
    MOVEFILE_REPLACE_EXISTING or MOVEFILE_WRITE_THROUGH) then
  begin
    LogLine('ERROR', 'install.json: не удалось заменить ' + GInstallJsonPath);
    DeleteFile(Tmp);
    Exit;
  end;
  GInstallJsonText := Content;
  LogLine('INFO', 'install.json записан: ' + GInstallJsonPath);
  Result := True;
end;

{ Health-check: fail-closed — успех объявляется только при подтверждённом
  запуске сервера. Управление службой (WinSW) и опрос GET /api/v1/health —
  зона bb063ac3; в этой задаче точки вызова и коды. }
function ProbeHealth: Boolean;
var
  Code: Integer;
  Url: String;
begin
  Result := False;
#ifdef TestMode
  if GTestHealth <> '' then
  begin
    Result := LowerCase(GTestHealth) = 'ok';
    LogLine('INFO', 'Health-check (тестовый режим): ' + GTestHealth);
    Exit;
  end;
#endif
  if not FileExists(GServerDir + '\service\etn-service.exe') then
  begin
    LogLine('ERROR', 'Health-check не выполнен: служба не найдена (' +
      GServerDir + '\service\etn-service.exe)');
    Exit;
  end;
  Url := 'http://127.0.0.1:' + GServerPort + '/api/v1/health';
  Result := Exec('curl.exe', '-fsS --max-time 10 ' + Url, '', SW_HIDE,
    ewWaitUntilTerminated, Code) and (Code = 0);
  LogLine('INFO', 'Health-check ' + Url + ': ' + Pick(Result, 'успех', 'сбой'));
end;

{ Остановка/запуск службы — зона bb063ac3 (WinSW). Точки вызова: здесь. }
procedure StopServiceIfRunning;
begin
  if ServiceRegistered then
    LogLine('INFO', 'Остановка службы: точка вызова bb063ac3 (пока не реализована)');
end;

procedure StartServiceIfNeeded;
begin
  if ServiceRegistered then
    LogLine('INFO', 'Запуск службы: точка вызова bb063ac3 (пока не реализована)');
end;

{ ---------------------------------------------------------------------------
  Предусловия silent server-only
  --------------------------------------------------------------------------- }
procedure FailPrecondition(const Reason: String);
begin
  GExitCode := EXIT_PRECONDITION;
  GWorkAllowed := False;
  LogLine('ERROR', 'Предусловие не выполнено: ' + Reason);
  LogLine('ERROR', 'Код возврата 20: изменения не выполнялись.');
  { Причина отказа пишется в отдельный файл: родительский (неэлевированный)
    экземпляр показывает её в сообщении вместо «смотрите журнал» (9b310991).
    Кодировка UTF-8: причину читают и установщик, и тесты — кириллица не
    должна зависеть от системной кодовой страницы. }
  if GReasonFile <> '' then
    SaveStringToFile(GReasonFile, Utf8Encode(Reason), False);
  { Немедленный выход до записи хоть чего-нибудь в каталог программы и данных.
    GetCustomSetupExitCode в Inno не вызывается, если Setup завершается до
    мастера, поэтому контрактный код отдаётся напрямую. }
  ExitProcess(EXIT_PRECONDITION);
end;

function SilentDataDirWritable: Boolean;
var
  Probe: String;
begin
  Result := False;
  if not ForceDirectories(GDataDir) then Exit;
  Probe := GDataDir + '\.etn-install-write-probe';
  if not SaveStringToFile(Probe, 'probe', False) then Exit;
  DeleteFile(Probe);
  Result := True;
end;

function PortValid(const S: String): Boolean;
var
  V: Integer;
begin
  V := StrToIntDef(Trim(S), -1);
  Result := (V >= 1) and (V <= 65535) and (Trim(S) = IntToStr(V));
end;

{ Право записи в каталог: существующий каталог проверяется пробным файлом,
  отсутствующий — пробой в родительском (создавать каталог на этапе
  предусловий нельзя: при отказе он остался бы пустым). }
function DirWritable(const Dir: String): Boolean;
var
  Parent, Probe: String;
begin
  Result := False;
  if Dir = '' then Exit;
  if DirExists(Dir) then
    Probe := Dir + '\.etn-install-write-probe'
  else
  begin
    Parent := ExtractFileDir(Dir);
    if Parent = '' then Exit;
    Probe := Parent + '\.etn-install-write-probe';
  end;
  Result := SaveStringToFile(Probe, 'probe', False);
  if Result then DeleteFile(Probe);
end;

{ ---------------------------------------------------------------------------
  Каталог данных, порт и брандмауэр — задача 9b310991.
  --------------------------------------------------------------------------- }

{ Адрес привязки выводится из чекбокса «Разрешить подключения с других
  компьютеров» (решение задачи): включён — 0.0.0.0, выключен — 127.0.0.1.
  Отдельного поля хоста в 0.15.1 нет: чекбокс — единственный источник истины
  и для ETN_HOST, и для правила брандмауэра. }
procedure SyncHostFromFirewall;
begin
  if GServerFirewall then
    GServerHost := '0.0.0.0'
  else
    GServerHost := '127.0.0.1';
end;

function XmlEscape(const S: String): String;
var
  I: Integer;
  R: String;
begin
  R := '';
  for I := 1 to Length(S) do
  begin
    if S[I] = '&' then R := R + '&amp;'
    else if S[I] = '<' then R := R + '&lt;'
    else if S[I] = '>' then R := R + '&gt;'
    else if S[I] = '"' then R := R + '&quot;'
    else if S[I] = '''' then R := R + '&apos;'
    else R := R + S[I];
  end;
  Result := R;
end;

{ Проверка занятости порта. PowerShell пробует занять порт на 0.0.0.0 тем же
  способом, что и сервер: так ловятся и чужие процессы, и зарезервированные
  диапазоны Hyper-V, и TIME_WAIT — netstat их не показывает. Порт, занятый
  собственным сервисом ETN (обновление поверх работающей установки), ошибкой
  не считается: службу останавливает привилегированная фаза (bb063ac3).
  Возвращает 0 — свободен (или держит служба ETN), 1 — занят, 2 — проверить
  не удалось. }
function ServerPortStatus(const Port: String): Integer;
var
  Script, Args: String;
  Code: Integer;
begin
  Result := 2;
  Script :=
    '$ErrorActionPreference=''SilentlyContinue'';' +
    '$port=' + Port + ';$own=0;' +
    'try{$s=Get-CimInstance Win32_Service|Where-Object{$_.Name -eq ''ETN''}|' +
    'Select-Object -First 1;if($s){$own=[int]$s.ProcessId}}catch{};' +
    'try{$l=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Any,$port);' +
    '$l.Start();$l.Stop();exit 0}catch{};' +
    'if($own -gt 0){try{$p=Get-NetTCPConnection -LocalPort $port -State Listen|' +
    'Select-Object -First 1 -ExpandProperty OwningProcess;' +
    'if([int]$p -eq $own){exit 0}}catch{}};' +
    'exit 1';
  Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Args, '',
    SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    LogLine('WARN', 'Проверка порта ' + Port + ': PowerShell не запустился');
    Exit;
  end;
  if Code = 0 then
    Result := 0
  else if Code = 1 then
    Result := 1
  else
    LogLine('WARN', 'Проверка порта ' + Port + ': PowerShell вернул код ' + IntToStr(Code));
end;

{ Свободное место на диске каталога. GetSpaceOnDisk64 требует существующий
  каталог: поднимаемся к ближайшему существующему предку. }
function ExistingAncestor(const Dir: String): String;
var
  Cur: String;
  I: Integer;
begin
  Cur := Dir;
  for I := 1 to 32 do
  begin
    if (Cur = '') or DirExists(Cur) then Break;
    Cur := ExtractFileDir(Cur);
  end;
  if (Cur <> '') and DirExists(Cur) then
    Result := Cur
  else
    Result := ExtractFileDrive(Dir) + '\';
end;

{ Порог свободного места; в тестовой сборке подменяется /TESTMINFREE.
  Переменная объявлена всегда: пустая секция var в продуктовой сборке не
  компилируется (Inno требует хотя бы одно объявление). }
function MinFreeSpaceBytes: Int64;
var
  TestValue: String;
begin
  Result := MIN_FREE_SPACE_BYTES;
#ifdef TestMode
  TestValue := ParamValue('TESTMINFREE');
  if TestValue <> '' then
  begin
    Result := StrToInt64Def(TestValue, MIN_FREE_SPACE_BYTES);
    LogLine('WARN', 'TESTMINFREE=' + TestValue + ': порог свободного места подменён (тестовый режим)');
  end;
#endif
end;

function FreeSpaceEnough(const Dir: String; var FreeBytes: Int64): Boolean;
var
  ProbeDir: String;
  Total: Int64;
begin
  Result := False;
  ProbeDir := ExistingAncestor(Dir);
  if not GetSpaceOnDisk64(ProbeDir, FreeBytes, Total) then
  begin
    LogLine('WARN', 'Не удалось узнать свободное место на диске ' + ProbeDir);
    FreeBytes := 0;
    Exit;
  end;
  Result := FreeBytes >= MinFreeSpaceBytes;
end;

function FormatMegabytes(const Bytes: Int64): String;
begin
  Result := IntToStr(Bytes div 1048576) + ' МБ';
end;

{ Полная предпроверка серверного окружения — до замены файлов. Возвращает ''
  при успехе и понятную причину отказа иначе. ForGui — проверка на экране
  параметров до элевации: запись в каталоги данных и программы проверяет
  только элевированный процесс (иначе отказ по правам был бы ложным), остальное
  проверяется всегда. }
function CheckServerEnvironment(const ForGui: Boolean): String;
var
  Status: Integer;
  FreeBytes: Int64;
  ElevatedWrite: Boolean;
begin
  Result := '';
  if not PortValid(GServerPort) then
  begin
    Result := 'некорректный порт "' + GServerPort + '": допустимо число от ' +
      IntToStr(MIN_PORT) + ' до ' + IntToStr(MAX_PORT);
    Exit;
  end;
  Status := ServerPortStatus(GServerPort);
  if Status = 1 then
  begin
    Result := 'порт ' + GServerPort + ' занят другим приложением: укажите ' +
      'свободный порт в «Параметры сервера»';
    Exit;
  end;
  if Status = 2 then
  begin
    Result := 'не удалось проверить занятость порта ' + GServerPort +
      ': проверьте порт вручную';
    Exit;
  end;
  { Каталог данных фиксирован; путь, занятый файлом, не станет каталогом ни
    под каким пользователем — это ошибка и для GUI. }
  if FileExists(GDataDir) and (not DirExists(GDataDir)) then
  begin
    Result := 'путь каталога данных занят файлом: ' + GDataDir +
      ' — освободите путь и повторите установку';
    Exit;
  end;
  ElevatedWrite := (not ForGui) or GIsElevated;
  if GServerSelected and ElevatedWrite then
  begin
    if not DirWritable(GDataDir) then
    begin
      Result := 'каталог данных недоступен для записи: ' + GDataDir +
        ' (нужны права администратора)';
      Exit;
    end;
    if not DirWritable(GServerDir) then
    begin
      Result := 'каталог программы недоступен для записи: ' + GServerDir;
      Exit;
    end;
  end;
  { Свободное место нужно и для программы, и для данных: проверяется диск
    каталога данных и диск каталога программы (при разных дисках они разные). }
  if GServerSelected and (not FreeSpaceEnough(GDataDir, FreeBytes)) then
  begin
    Result := 'недостаточно свободного места для каталога данных ' + GDataDir +
      ': свободно ' + FormatMegabytes(FreeBytes) + ', нужно не менее ' +
      FormatMegabytes(MinFreeSpaceBytes);
    Exit;
  end;
  if ElevatedWrite and (not FreeSpaceEnough(GServerDir, FreeBytes)) then
  begin
    Result := 'недостаточно свободного места для каталога программы ' + GServerDir +
      ': свободно ' + FormatMegabytes(FreeBytes) + ', нужно не менее ' +
      FormatMegabytes(MinFreeSpaceBytes);
    Exit;
  end;
end;

{ Каталоги, которые установщик обязан создать до старта службы: WinSW открывает
  файлы журнала на запись и сам каталог не создаёт; серверу нужны logs и
  backups внутри каталога данных (ADR 144bcdb0). }
function EnsureServerDirs: Boolean;
begin
  Result := False;
  if not ForceDirectories(GDataDir) then
  begin
    LogLine('ERROR', 'Не удалось создать каталог данных: ' + GDataDir);
    Exit;
  end;
  if not ForceDirectories(GDataDir + '\logs') then
  begin
    LogLine('ERROR', 'Не удалось создать каталог журналов: ' + GDataDir + '\logs');
    Exit;
  end;
  if not ForceDirectories(GDataDir + '\logs\service') then
  begin
    LogLine('ERROR', 'Не удалось создать каталог журнала службы: ' +
      GDataDir + '\logs\service');
    Exit;
  end;
  if not ForceDirectories(GDataDir + '\backups') then
  begin
    LogLine('ERROR', 'Не удалось создать каталог бэкапов: ' + GDataDir + '\backups');
    Exit;
  end;
  LogLine('INFO', 'Каталоги данных готовы: ' + GDataDir +
    ' (logs, logs\service, backups)');
  Result := True;
end;

{ Подстановка значений в шаблон службы: service\etn-service.xml каталога
  программы. Файл читается и пишется как байты UTF-8 (Utf8Decode/Utf8Encode) —
  кириллица в шаблоне не портится независимо от системной кодовой страницы.
  Пока в файле остаются плейсхолдеры, службу регистрировать нельзя
  (ADR db60302a). }
function InstallServiceConfig: Boolean;
var
  Path, Text: String;
  Raw: AnsiString;
  Replaced: Integer;
begin
  Result := False;
  Path := GServerDir + '\service\etn-service.xml';
  if not FileExists(Path) then
  begin
    LogLine('ERROR', 'Нет шаблона службы: ' + Path + ' — служба не настроена');
    Exit;
  end;
  if not LoadStringFromFile(Path, Raw) then
  begin
    LogLine('ERROR', 'Не удалось прочитать шаблон службы: ' + Path);
    Exit;
  end;
  Text := Utf8Decode(Raw);
  Replaced := 0;
  Replaced := Replaced + StringChangeEx(Text, '{{DATA_DIR}}', XmlEscape(GDataDir), True);
  Replaced := Replaced + StringChangeEx(Text, '{{PORT}}', XmlEscape(GServerPort), True);
  Replaced := Replaced + StringChangeEx(Text, '{{HOST}}', XmlEscape(GServerHost), True);
  if Pos('{{', Text) > 0 then
  begin
    LogLine('ERROR', 'В шаблоне службы остались неподставленные плейсхолдеры: ' + Path);
    Exit;
  end;
  if not SaveStringToFile(Path, Utf8Encode(Text), False) then
  begin
    LogLine('ERROR', 'Не удалось записать конфигурацию службы: ' + Path);
    Exit;
  end;
  LogLine('INFO', 'etn-service.xml: DATA_DIR=' + GDataDir + ', PORT=' + GServerPort +
    ', HOST=' + GServerHost + ' (замен ' + IntToStr(Replaced) + ')');
  Result := True;
end;

{ Правило брандмауэра Windows. netsh — системная утилита, отдельного API нет;
  профили domain,private (публичные сети правилом не открываются). }
function RunNetsh(const Args: String): Boolean;
var
  Code: Integer;
begin
  Result := False;
#ifdef TestMode
  if LowerCase(GTestFirewall) <> 'real' then
  begin
    LogLine('INFO', 'FIREWALL (тестовый режим, без изменений): netsh ' + Args);
    Result := True;
    Exit;
  end;
#endif
  if not Exec(ExpandConstant('{sys}\netsh.exe'), Args, '', SW_HIDE,
    ewWaitUntilTerminated, Code) then
  begin
    LogLine('WARN', 'netsh не запустился: ' + Args);
    Exit;
  end;
  if Code <> 0 then
  begin
    LogLine('WARN', 'netsh вернул код ' + IntToStr(Code) + ': ' + Args);
    Exit;
  end;
  Result := True;
end;

procedure RemoveFirewallRule;
begin
  if not RunNetsh('advfirewall firewall delete rule name="' + FIREWALL_RULE_NAME + '"') then
    LogLine('INFO', 'Правило брандмауэра не удалено (возможно, его не было): ' + FIREWALL_RULE_NAME)
  else
    LogLine('INFO', 'Правило брандмауэра удалено: ' + FIREWALL_RULE_NAME);
end;

{ Приведение правила к выбранному состоянию: всегда сначала удаление (порт мог
  измениться при обновлении), затем создание при включённом чекбоксе. Ошибка
  netsh не отменяет установку: сервер работает локально, причина в журнале. }
procedure ApplyFirewallRule;
begin
  if not GServerSelected then Exit;
  RemoveFirewallRule;
  if not GServerFirewall then
  begin
    LogLine('INFO', 'Брандмауэр: подключения с других компьютеров запрещены (порт ' +
      GServerPort + ' не открывается)');
    Exit;
  end;
  if RunNetsh('advfirewall firewall add rule name="' + FIREWALL_RULE_NAME +
    '" dir=in action=allow protocol=TCP localport=' + GServerPort +
    ' profile=' + FIREWALL_PROFILES + ' enable=yes') then
    LogLine('INFO', 'Правило брандмауэра создано: TCP ' + GServerPort +
      ', профили ' + FIREWALL_PROFILES)
  else
    LogLine('ERROR', 'Правило брандмауэра не создано: TCP ' + GServerPort +
      ' — подключения с других компьютеров могут быть недоступны');
end;

{ Удаление программы: правило брандмауэра удаляется вместе с ней. Решение
  принимается до удаления файлов (usUninstall): install.json с firewall=true
  или найденные файлы сервера означают, что правило могло быть создано. }
function UninstallFirewallRuleWanted: Boolean;
var
  Path, Text: String;
begin
  Result := False;
  Path := ExpandConstant('{commonappdata}\ETN\install.json');
  if FileExists(Path) then
  begin
    Text := ReadTextFile(Path);
    if (JsonGetRaw(Text, 'firewall') = 'true') and
       ((JsonGetRaw(Text, 'mode') = 'service') or (JsonGetRaw(Text, 'mode') = 'app')) then
    begin
      Result := True;
      Exit;
    end;
  end;
  Result := FileExists(ExpandConstant('{app}\server\dist\index.js'));
end;

{ Перезапуск в административном режиме установки: нужен, чтобы деинсталлятор и
  запись установки легли в машинные места (HKLM и Program Files), а не в
  профиль пользователя. Процесс уже элевирован — повторный UAC не показывается;
  маркер /ADMINMODE защищает от бесконечного перезапуска. }
procedure RelaunchAdminInstallMode(const ExtraArgs: String);
begin
  if GTestMode or IsAdminInstallMode or ParamExists('ADMINMODE') then Exit;
  LogLine('INFO', 'Перезапуск в административном режиме установки (/ALLUSERS)');
  if ShellExec(ExpandConstant('{srcexe}'), '/ALLUSERS /ADMINMODE' + ExtraArgs,
    '', '', SW_HIDE, ewWaitUntilTerminated, GChildResult) then
    ExitProcess(GChildResult);
  LogLine('WARN', 'Перезапуск в административном режиме не удался — продолжаем как есть');
end;

procedure ValidateSilentPreconditions;
var
  DataDirFromJson, Reason: String;
begin
  LogLine('INFO', 'Silent server-only: проверка предусловий');
  if ParamExists('SERVERONLY') = False then
    FailPrecondition('/VERYSILENT без /SERVERONLY: тихая установка клиента запрещена');
  if not GIsElevated then
    FailPrecondition('процесс не элевирован: нужны права администратора');
  { Установщик должен работать в административном режиме, иначе запись
    установки уйдёт в HKCU и станет невидимой для службы/других сеансов. }
  RelaunchAdminInstallMode(' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY' +
    IfStr(ParamValue('PARAMS') <> '', ' /PARAMS="' + ParamValue('PARAMS') + '"', ''));
  if not GInstallJsonPresent then
    FailPrecondition('нет ' + GInstallJsonPath + ' — сервер не устанавливался установщиком');
  if not GInstallJsonValid then
    FailPrecondition('install.json повреждён: нет schema=1, product_version или mode');
  if GInstalledMode <> 'service' then
    FailPrecondition('режим "' + GInstalledMode +
      '": в 0.15.1 самообновление поддерживается только для службы; приложение обновляется вручную');
  if not GServerFilesPresent then
    FailPrecondition('файлы сервера не найдены в ' + GServerDir + '\server');
  if not ServiceRegistered then
    FailPrecondition('служба ' + SERVICE_NAME + ' не зарегистрирована');
  DataDirFromJson := GInstalledDataDir;
  if (DataDirFromJson <> '') and (CompareText(DataDirFromJson, GDataDir) <> 0) then
    FailPrecondition('install.json указывает каталог данных ' + DataDirFromJson +
      ', в 0.15.1 он фиксирован: ' + GDataDir);
  if GBlockedDowngrade then
    FailPrecondition('понижение версии запрещено: установлена ' + GInstalledVersion +
      ', установщик ' + GProductVersion);
  if not SilentDataDirWritable then
    FailPrecondition('каталог данных недоступен для записи: ' + GDataDir);

  GServerSelected := True;
  GClientSelected := False;
  { Предпроверки окружения до замены файлов: порт, запись в каталоги, место.
    Порт, занятый собственной службой, ошибкой не считается — её остановит
    привилегированная фаза (bb063ac3). }
  Reason := CheckServerEnvironment(False);
  if Reason <> '' then
    FailPrecondition(Reason);

  GSkipCopy := (SemverCompare(GInstalledVersion, GProductVersion) = 0);
  if GSkipCopy then
    LogLine('INFO', 'Установлена та же версия ' + GProductVersion + ': файлы не заменяются');
end;

{ ---------------------------------------------------------------------------
  Предусловия привилегированной фазы — внутреннего запуска с /PRIVILEGEDPHASE
  (дочерний процесс GUI-установки и клиента «для всех» поднимает себя сам).
  Это НЕ silent-самообновление: install.json, файлы и служба не требуются —
  проверяются только права, каталог, данные, порт и свободное место.
  --------------------------------------------------------------------------- }
procedure ValidatePrivilegedPhasePreconditions;
var
  Reason: String;
begin
  LogLine('INFO', 'Привилегированная фаза: проверка предусловий');
  if not GSilent then
    FailPrecondition('/PRIVILEGEDPHASE допустим только с /VERYSILENT');
  if not GIsElevated then
    FailPrecondition('привилегированная фаза запущена без прав администратора');
  RelaunchAdminInstallMode(' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /PRIVILEGEDPHASE' +
    IfStr(ParamValue('PARAMS') <> '', ' /PARAMS="' + ParamValue('PARAMS') + '"', ''));
  if (not GServerSelected) and (not GClientSelected) then
    FailPrecondition('не выбран ни один компонент: файл параметров пуст или повреждён');
  if GBlockedDowngrade then
    FailPrecondition('понижение версии запрещено: установлена ' + ServerVersionText +
      ', установщик ' + GProductVersion);
  { Каталог программы нужен и клиенту «для всех»: файлы клиента ставятся
    в каталог программы. }
  if (GClientSelected and (not GClientScopeUser)) and (not GServerSelected) and
     (not DirWritable(GServerDir)) then
    FailPrecondition('каталог программы недоступен для записи: ' + GServerDir);
  if GServerSelected then
  begin
    Reason := CheckServerEnvironment(False);
    if Reason <> '' then
      FailPrecondition(Reason);
  end;
  LogLine('INFO', 'Привилегированная фаза: предусловия выполнены');
end;

{ ---------------------------------------------------------------------------
  Экран компонентов (каркас; тексты и оформление — 112642a4)
  --------------------------------------------------------------------------- }
{ Единая точка чтения выбора: вызывается обработчиками OnClick всех контролов
  (чекбоксы компонентов и радиокнопки области клиента) и тестовым хуком
  /TESTSELECT. Область клиента читается с радиокнопок — без обработчика на них
  выбор «для всех» не влиял бы на элевацию (NeedElevation). }
procedure ApplySelection(const ServerChecked, ClientChecked,
  MachineScopeChecked: Boolean);
begin
  GServerSelected := ServerChecked;
  GClientSelected := ClientChecked;
  GClientScopeUser := not MachineScopeChecked;
end;

procedure UpdateComponentsState(Sender: TObject);
begin
  if GSilent then Exit;
  if (GServerCheck <> nil) and (GClientCheck <> nil) and (GScopeMachineRadio <> nil) then
    ApplySelection(GServerCheck.Checked, GClientCheck.Checked, GScopeMachineRadio.Checked);
  if GScopeUserRadio <> nil then GScopeUserRadio.Enabled := GClientSelected;
  if GScopeMachineRadio <> nil then GScopeMachineRadio.Enabled := GClientSelected;
  if GReasonLabel <> nil then
  begin
    if GBlockedDowngrade then
      GReasonLabel.Caption := 'Установлена более новая версия ' + ServerVersionText +
        ' — понижение запрещено. Доступна только отмена.'
    else if (not GServerSelected) and (not GClientSelected) then
      GReasonLabel.Caption := 'Выберите хотя бы один компонент.'
    else if GServerSelected and GBlockedDowngrade then
      GReasonLabel.Caption := 'Сервер: установлена более новая версия — понижение запрещено.'
    else
      GReasonLabel.Caption := '';
  end;
  if WizardForm <> nil then
    WizardForm.NextButton.Enabled :=
      (not GBlockedDowngrade) and (GServerSelected or GClientSelected);
end;

procedure CreateComponentsPage;
begin
  GComponentsPage := CreateCustomPage(wpLicense,
    'Компоненты ETN',
    'Выберите, что установить или обновить на этом компьютере.');

  GServerCheck := TNewCheckBox.Create(GComponentsPage);
  GServerCheck.Parent := GComponentsPage.Surface;
  GServerCheck.Left := 0;
  GServerCheck.Top := 0;
  GServerCheck.Width := GComponentsPage.SurfaceWidth;
  GServerCheck.Caption := 'Сервер ETN';
  GServerCheck.OnClick := @UpdateComponentsState;

  GServerStateLabel := TNewStaticText.Create(GComponentsPage);
  GServerStateLabel.Parent := GComponentsPage.Surface;
  GServerStateLabel.Left := 20;
  GServerStateLabel.Top := GServerCheck.Top + GServerCheck.Height + 2;
  GServerStateLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GServerStateLabel.Caption := ServerStateText;

  { «Сервер уже инициализирован» / «найден ключ от прошлого запуска» (686c5d76). }
  GInitStateLabel := TNewStaticText.Create(GComponentsPage);
  GInitStateLabel.Parent := GComponentsPage.Surface;
  GInitStateLabel.Left := 20;
  GInitStateLabel.Top := GServerStateLabel.Top + GServerStateLabel.Height + 2;
  GInitStateLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GInitStateLabel.Caption := InitStateText;

  GClientCheck := TNewCheckBox.Create(GComponentsPage);
  GClientCheck.Parent := GComponentsPage.Surface;
  GClientCheck.Left := 0;
  GClientCheck.Top := GInitStateLabel.Top + GInitStateLabel.Height + 14;
  GClientCheck.Width := GComponentsPage.SurfaceWidth;
  GClientCheck.Caption := 'Клиент ETN';
  GClientCheck.OnClick := @UpdateComponentsState;

  GClientStateLabel := TNewStaticText.Create(GComponentsPage);
  GClientStateLabel.Parent := GComponentsPage.Surface;
  GClientStateLabel.Left := 20;
  GClientStateLabel.Top := GClientCheck.Top + GClientCheck.Height + 2;
  GClientStateLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GClientStateLabel.Caption := ClientStateText;

  GScopeUserRadio := TNewRadioButton.Create(GComponentsPage);
  GScopeUserRadio.Parent := GComponentsPage.Surface;
  GScopeUserRadio.Left := 20;
  GScopeUserRadio.Top := GClientStateLabel.Top + GClientStateLabel.Height + 6;
  GScopeUserRadio.Width := GComponentsPage.SurfaceWidth - 20;
  GScopeUserRadio.Caption := 'Клиент: только для меня (без прав администратора)';
  GScopeUserRadio.Checked := True;
  GScopeUserRadio.OnClick := @UpdateComponentsState;

  GScopeMachineRadio := TNewRadioButton.Create(GComponentsPage);
  GScopeMachineRadio.Parent := GComponentsPage.Surface;
  GScopeMachineRadio.Left := 20;
  GScopeMachineRadio.Top := GScopeUserRadio.Top + GScopeUserRadio.Height + 2;
  GScopeMachineRadio.Width := GComponentsPage.SurfaceWidth - 20;
  GScopeMachineRadio.Caption := 'Клиент: для всех пользователей компьютера';
  GScopeMachineRadio.OnClick := @UpdateComponentsState;

  GDataNoteLabel := TNewStaticText.Create(GComponentsPage);
  GDataNoteLabel.Parent := GComponentsPage.Surface;
  GDataNoteLabel.Left := 0;
  GDataNoteLabel.Top := GScopeMachineRadio.Top + GScopeMachineRadio.Height + 14;
  GDataNoteLabel.Width := GComponentsPage.SurfaceWidth;
  GDataNoteLabel.Caption := 'Каталог данных сервера: ' + GDataDir + ' (в 0.15.1 фиксирован)';

  GReasonLabel := TNewStaticText.Create(GComponentsPage);
  GReasonLabel.Parent := GComponentsPage.Surface;
  GReasonLabel.Left := 0;
  GReasonLabel.Top := GDataNoteLabel.Top + GDataNoteLabel.Height + 14;
  GReasonLabel.Width := GComponentsPage.SurfaceWidth;
  GReasonLabel.Caption := '';
  GReasonLabel.Font.Color := clRed;

  { Начальный выбор вычислен в ApplyDefaultSelection (чистая машина — оба
    компонента, частичная — только установленные); здесь он лишь переносится
    в контролы. Тексты и оформление — 112642a4. }
  GServerCheck.Checked := GServerSelected;
  GClientCheck.Checked := GClientSelected;
  GScopeUserRadio.Checked := GClientScopeUser;
  GScopeMachineRadio.Checked := not GClientScopeUser;
  UpdateComponentsState(nil);
end;

{ ---------------------------------------------------------------------------
  Экран администратора (686c5d76): единственное поле — логин первого
  администратора. Оформление и полный экран сервера — 112642a4.
  --------------------------------------------------------------------------- }
procedure CreateAdminPage;
begin
  GAdminPage := CreateCustomPage(GComponentsPage.ID, 'Администратор сервера',
    'Логин первого администратора ETN. Пароль не задаётся: вход по API-ключу, ' +
    'который будет показан после установки.');

  GAdminLoginLabel := TNewStaticText.Create(GAdminPage);
  GAdminLoginLabel.Parent := GAdminPage.Surface;
  GAdminLoginLabel.Left := 0;
  GAdminLoginLabel.Top := 0;
  GAdminLoginLabel.Width := GAdminPage.SurfaceWidth;
  GAdminLoginLabel.Caption := 'Логин администратора:';

  GAdminLoginEdit := TNewEdit.Create(GAdminPage);
  GAdminLoginEdit.Parent := GAdminPage.Surface;
  GAdminLoginEdit.Left := 0;
  GAdminLoginEdit.Top := GAdminLoginLabel.Top + GAdminLoginLabel.Height + 4;
  GAdminLoginEdit.Width := GAdminPage.SurfaceWidth;
  GAdminLoginEdit.Text := GAdminLogin;

  GAdminHintLabel := TNewStaticText.Create(GAdminPage);
  GAdminHintLabel.Parent := GAdminPage.Surface;
  GAdminHintLabel.Left := 0;
  GAdminHintLabel.Top := GAdminLoginEdit.Top + GAdminLoginEdit.Height + 8;
  GAdminHintLabel.Width := GAdminPage.SurfaceWidth;
  GAdminHintLabel.Caption := 'Логин используется один раз — при первичной инициализации ' +
    'сервера. Если сервер уже инициализирован, логин не меняется.';

  GAdminErrorLabel := TNewStaticText.Create(GAdminPage);
  GAdminErrorLabel.Parent := GAdminPage.Surface;
  GAdminErrorLabel.Left := 0;
  GAdminErrorLabel.Top := GAdminHintLabel.Top + GAdminHintLabel.Height + 8;
  GAdminErrorLabel.Width := GAdminPage.SurfaceWidth;
  GAdminErrorLabel.Caption := '';
  GAdminErrorLabel.Font.Color := clRed;
end;

{ ---------------------------------------------------------------------------
  Экран «Параметры сервера» (9b310991): порт, чекбокс подключений с других
  компьютеров и фиксированный каталог данных. Тексты и оформление полного
  экрана — зона 112642a4; здесь функциональный минимум.
  --------------------------------------------------------------------------- }
procedure FirewallCheckClick(Sender: TObject);
begin
  if (GFirewallCheck = nil) or GParamsLocked then Exit;
  GServerFirewall := GFirewallCheck.Checked;
  SyncHostFromFirewall;
  if GFirewallNoteLabel <> nil then
  begin
    if GServerFirewall then
      GFirewallNoteLabel.Caption := 'Будет создано правило брандмауэра Windows для порта ' +
        'сервера (профили «домен» и «частная сеть»). Сервер будет доступен с других ' +
        'компьютеров локальной сети.'
    else
      GFirewallNoteLabel.Caption := 'Сервер будет доступен только с этого компьютера ' +
        '(127.0.0.1). Подключения с других компьютеров локальной сети работать не будут.';
  end;
end;

procedure UpdateServerParamsState;
begin
  if GParamsLocked then
  begin
    if GServerParamsNoteLabel <> nil then
      GServerParamsNoteLabel.Caption := 'Сервер уже установлен: при обновлении порт, ' +
        'доступ по локальной сети и каталог данных не меняются.';
  end
  else if GServerParamsNoteLabel <> nil then
    GServerParamsNoteLabel.Caption := '';
  FirewallCheckClick(nil);
end;

procedure CreateServerParamsPage;
begin
  GServerParamsPage := CreateCustomPage(GAdminPage.ID, 'Параметры сервера',
    'Порт сервера и доступ с других компьютеров. Каталог данных фиксирован ' +
    'и переживает обновление.');

  GPortLabel := TNewStaticText.Create(GServerParamsPage);
  GPortLabel.Parent := GServerParamsPage.Surface;
  GPortLabel.Left := 0;
  GPortLabel.Top := 0;
  GPortLabel.Width := GServerParamsPage.SurfaceWidth;
  GPortLabel.Caption := 'Порт сервера (по умолчанию 4321):';

  GPortEdit := TNewEdit.Create(GServerParamsPage);
  GPortEdit.Parent := GServerParamsPage.Surface;
  GPortEdit.Left := 0;
  GPortEdit.Top := GPortLabel.Top + GPortLabel.Height + 4;
  GPortEdit.Width := ScaleX(120);
  GPortEdit.Text := GServerPort;

  GPortHintLabel := TNewStaticText.Create(GServerParamsPage);
  GPortHintLabel.Parent := GServerParamsPage.Surface;
  GPortHintLabel.Left := GPortEdit.Width + 12;
  GPortHintLabel.Top := GPortEdit.Top + ScaleY(4);
  GPortHintLabel.Width := GServerParamsPage.SurfaceWidth - GPortEdit.Width - 12;
  GPortHintLabel.Caption := 'Порт должен быть свободен: занятость проверяется до установки.';

  GFirewallCheck := TNewCheckBox.Create(GServerParamsPage);
  GFirewallCheck.Parent := GServerParamsPage.Surface;
  GFirewallCheck.Left := 0;
  GFirewallCheck.Top := GPortEdit.Top + GPortEdit.Height + ScaleY(16);
  GFirewallCheck.Width := GServerParamsPage.SurfaceWidth;
  GFirewallCheck.Caption := 'Разрешить подключения с других компьютеров в локальной сети';
  GFirewallCheck.Checked := GServerFirewall;
  GFirewallCheck.OnClick := @FirewallCheckClick;

  GFirewallNoteLabel := TNewStaticText.Create(GServerParamsPage);
  GFirewallNoteLabel.Parent := GServerParamsPage.Surface;
  GFirewallNoteLabel.Left := 20;
  GFirewallNoteLabel.Top := GFirewallCheck.Top + GFirewallCheck.Height + 2;
  GFirewallNoteLabel.Width := GServerParamsPage.SurfaceWidth - 20;
  GFirewallNoteLabel.Caption := '';

  GDataDirInfoLabel := TNewStaticText.Create(GServerParamsPage);
  GDataDirInfoLabel.Parent := GServerParamsPage.Surface;
  GDataDirInfoLabel.Left := 0;
  GDataDirInfoLabel.Top := GFirewallNoteLabel.Top + GFirewallNoteLabel.Height + ScaleY(16);
  GDataDirInfoLabel.Width := GServerParamsPage.SurfaceWidth;
  GDataDirInfoLabel.Caption := 'Каталог данных: ' + GDataDir +
    ' (в 0.15.1 фиксирован, не меняется при обновлении и удалении программы)';

  GServerParamsNoteLabel := TNewStaticText.Create(GServerParamsPage);
  GServerParamsNoteLabel.Parent := GServerParamsPage.Surface;
  GServerParamsNoteLabel.Left := 0;
  GServerParamsNoteLabel.Top := GDataDirInfoLabel.Top + GDataDirInfoLabel.Height + ScaleY(8);
  GServerParamsNoteLabel.Width := GServerParamsPage.SurfaceWidth;
  GServerParamsNoteLabel.Caption := '';

  GPortErrorLabel := TNewStaticText.Create(GServerParamsPage);
  GPortErrorLabel.Parent := GServerParamsPage.Surface;
  GPortErrorLabel.Left := 0;
  GPortErrorLabel.Top := GServerParamsNoteLabel.Top + GServerParamsNoteLabel.Height + ScaleY(8);
  GPortErrorLabel.Width := GServerParamsPage.SurfaceWidth;
  GPortErrorLabel.Caption := '';
  GPortErrorLabel.Font.Color := clRed;
end;

procedure CopyKeyClick(Sender: TObject);
var
  Code: Integer;
begin
  { Копирование через clip.exe: ключ не попадает в командную строку (только
    путь к защищённому файлу), буфер обмена получает его из файла. }
  if (GPendingKey = '') or (not FileExists(KeyFilePath)) then Exit;
  if Exec(ExpandConstant('{cmd}'), '/c clip < "' + KeyFilePath + '"', '',
    SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0) then
    GKeyCopiedLabel.Caption := 'Скопировано в буфер обмена'
  else
    GKeyCopiedLabel.Caption := 'Не удалось скопировать — выделите ключ и нажмите Ctrl+C';
end;

procedure UpdateKeyPageState(Sender: TObject);
begin
  if (WizardForm <> nil) and (GKeyPage <> nil) and
     (WizardForm.CurPageID = GKeyPage.ID) then
    WizardForm.NextButton.Enabled := GKeyConfirmCheck.Checked;
end;

{ Экран первичного API-ключа: после установки, до итоговой сводки. Ключ
  берётся из защищённого файла (в журнал не пишется). }
procedure CreateKeyPage;
begin
  GKeyPage := CreateCustomPage(wpInstalling, 'Первичный API-ключ',
    'Сохраните ключ: он показывается один раз и восстановить его нельзя.');

  GKeyValueEdit := TNewEdit.Create(GKeyPage);
  GKeyValueEdit.Parent := GKeyPage.Surface;
  GKeyValueEdit.Left := 0;
  GKeyValueEdit.Top := 0;
  GKeyValueEdit.Width := GKeyPage.SurfaceWidth;
  GKeyValueEdit.ReadOnly := True;
  GKeyValueEdit.Font.Name := 'Consolas';
  GKeyValueEdit.Font.Size := 14;
  GKeyValueEdit.Text := '';

  GKeyCopyButton := TNewButton.Create(GKeyPage);
  GKeyCopyButton.Parent := GKeyPage.Surface;
  GKeyCopyButton.Left := 0;
  GKeyCopyButton.Top := GKeyValueEdit.Top + GKeyValueEdit.Height + 8;
  GKeyCopyButton.Width := ScaleX(140);
  GKeyCopyButton.Caption := 'Скопировать';
  GKeyCopyButton.OnClick := @CopyKeyClick;

  GKeyCopiedLabel := TNewStaticText.Create(GKeyPage);
  GKeyCopiedLabel.Parent := GKeyPage.Surface;
  GKeyCopiedLabel.Left := GKeyCopyButton.Width + 12;
  GKeyCopiedLabel.Top := GKeyCopyButton.Top + 10;
  GKeyCopiedLabel.Width := GKeyPage.SurfaceWidth - GKeyCopyButton.Width - 12;
  GKeyCopiedLabel.Caption := '';

  GKeyWarningLabel := TNewStaticText.Create(GKeyPage);
  GKeyWarningLabel.Parent := GKeyPage.Surface;
  GKeyWarningLabel.Left := 0;
  GKeyWarningLabel.Top := GKeyCopyButton.Top + GKeyCopyButton.Height + 14;
  GKeyWarningLabel.Width := GKeyPage.SurfaceWidth;
  GKeyWarningLabel.Caption := 'Ключ показывается один раз. Восстановить нельзя — только ' +
    'выпустить новый. Сохраните его в надёжном месте.';

  GKeyPreviousLabel := TNewStaticText.Create(GKeyPage);
  GKeyPreviousLabel.Parent := GKeyPage.Surface;
  GKeyPreviousLabel.Left := 0;
  GKeyPreviousLabel.Top := GKeyWarningLabel.Top + GKeyWarningLabel.Height + 6;
  GKeyPreviousLabel.Width := GKeyPage.SurfaceWidth;
  GKeyPreviousLabel.Caption := 'Ключ получен при предыдущем запуске установщика ' +
    '(после сбоя) и сохранён в защищённом файле.';
  GKeyPreviousLabel.Visible := False;

  GKeyConfirmCheck := TNewCheckBox.Create(GKeyPage);
  GKeyConfirmCheck.Parent := GKeyPage.Surface;
  GKeyConfirmCheck.Left := 0;
  GKeyConfirmCheck.Top := GKeyPreviousLabel.Top + GKeyPreviousLabel.Height + 14;
  GKeyConfirmCheck.Width := GKeyPage.SurfaceWidth;
  GKeyConfirmCheck.Caption := 'Я сохранил ключ';
  GKeyConfirmCheck.Checked := False;
  GKeyConfirmCheck.OnClick := @UpdateKeyPageState;
end;

{ ---------------------------------------------------------------------------
  События установщика
  --------------------------------------------------------------------------- }
function InitializeSetup: Boolean;
var
  Reason: String;
begin
  GExitCode := EXIT_OK;
  GChildResult := 0;
  GWorkAllowed := True;
  GServerSelected := False;
  GClientSelected := False;
  GClientScopeUser := True;
  GServerMode := 'service';
  GServerHost := '0.0.0.0';
  GServerPort := '4321';
  GServerFirewall := True;
  GSkipCopy := False;
  GTestMode := False;
  GTestHealth := '';
  GTestElevated := '';
  GTestService := '';
  GTestState := '';
  GTestSelect := '';
  GTestRecord := '';
  GTestParams := '';
  GTestGui := '';
  GTestInit := '';
  GTestNodeExe := '';
  GTestLogin := '';
  GTestKeyState := '';
  GTestFailAfterInit := '';
  GTestKeyAck := '';
  GTestKeyClose := '';
  { Хуки 9b310991 (только тестовая сборка; сброс — чтобы в продуктовой сборке
    переменные не выглядели неиспользуемыми). }
  GTestDataDir := '';
  GTestPort := '';
  GTestMinFree := '';
  GTestFirewall := '';
  GTestPrecheck := '';
  GTestResult := '';
  GAdminLogin := '';
  GAdminDisplayName := '';
  GFirstUserChecked := False;
  GFirstUserPresent := False;
  GInitAttempted := False;
  GPendingKey := '';
  GPendingKeyPrevious := False;
  GKeyBeforeInstall := '';
  GParamsPath := '';
  GReasonFile := '';
  GChildReason := '';
  GDeferredLog := '';
  GParamsLocked := False;
  GUninstallFirewallRule := False;
  GProductVersion := '{#MyAppVersion}';
  GDataDir := ExpandConstant('{#DataDir}');
  GServerDir := ExpandConstant('{#AppDir}');
  GSilent := WizardSilent;
  GServerOnly := ParamExists('SERVERONLY');
  GPrivilegedPhase := ParamExists('PRIVILEGEDPHASE');
  { Пользователь, запустивший установщик: ему (помимо SYSTEM и администраторов)
    разрешается доступ к файлу ключа — элевированный дочерний процесс может
    работать под другой учётной записью администратора. }
  GOriginalUser := GetEnv('USERNAME');
  if GOriginalUser = '' then GOriginalUser := GetUserNameString;
  GAdminLogin := GOriginalUser;
#ifdef TestMode
  GTestMode := True;
  GTestHealth := ParamValue('TESTHEALTH');
  GTestElevated := ParamValue('TESTELEVATED');
  GTestService := ParamValue('TESTSERVICE');
  GTestState := ParamValue('TESTSTATE');
  GTestSelect := ParamValue('TESTSELECT');
  GTestRecord := ParamValue('TESTRECORD');
  GTestParams := ParamValue('TESTPARAMS');
  GTestGui := ParamValue('TESTGUIMODE');
  GTestInit := ParamValue('TESTINIT');
  GTestNodeExe := ParamValue('TESTNODEEXE');
  GTestLogin := ParamValue('TESTLOGIN');
  GTestKeyState := ParamValue('TESTKEYSTATE');
  GTestFailAfterInit := ParamValue('TESTFAILAFTERINIT');
  GTestKeyAck := ParamValue('TESTKEYACK');
  GTestKeyClose := ParamValue('TESTKEYCLOSE');
  GTestDataDir := ParamValue('TESTDATADIR');
  GTestPort := ParamValue('TESTPORT');
  GTestMinFree := ParamValue('TESTMINFREE');
  GTestFirewall := ParamValue('TESTFIREWALL');
  GTestPrecheck := ParamValue('TESTPRECHECK');
  GTestResult := ParamValue('TESTRESULT');
  { Подмена каталога данных для предпроверок (путь, занятый файлом,
    недоступный диск): журнал при этом остаётся в обычном каталоге теста. }
  if GTestDataDir <> '' then
    GDataDir := GTestDataDir;
#endif

  if GPrivilegedPhase then
    ReadParamsFile;

  LoadInstallJson;
  ApplyInstalledParams;
  DetectState;

  { Выбор компонентов по умолчанию: в привилегированной фазе выбор пришёл из
    файла параметров и не пересчитывается. }
  if not GPrivilegedPhase then
    ApplyDefaultSelection;

  { Журнал создаётся после того, как известен выбор компонентов: установка
    только клиента не должна создавать каталог %ProgramData%\ETN (9b310991). }
  InitLog;
  FlushDeferredLog;
  GIsElevated := IsElevatedNow;
  LogLine('INFO', 'ETN Setup ' + GProductVersion + ': запуск');
  LogLine('INFO', 'Режим: silent=' + Pick(GSilent, 'да', 'нет') +
    ', serveronly=' + Pick(GServerOnly, 'да', 'нет') +
    ', privileged_phase=' + Pick(GPrivilegedPhase, 'да', 'нет') +
    ', elevated=' + Pick(GIsElevated, 'да', 'нет') +
    ', admin_install_mode=' + Pick(IsAdminInstallMode, 'да', 'нет'));
  LogLine('INFO', 'Каталог программы: ' + GServerDir + '; каталог данных: ' + GDataDir);
  LogLine('INFO', 'Inno: autopf=' + ExpandConstant('{autopf}') +
    '; admin_install_mode=' + Pick(IsAdminInstallMode, 'да', 'нет'));
  LogLine('INFO', 'Журнал: ' + GLogPath);
  LogLine('INFO', 'Состояние: сервер=' + GServerState +
    ' (установлено: ' + IfStr(GInstalledVersion = '', '—', GInstalledVersion) +
    ', версия файлов: ' + IfStr(GFilesVersion = '', '—', GFilesVersion) +
    ', режим: ' + IfStr(GInstalledMode = '', '—', GInstalledMode) + ')' +
    '; клиент=' + GClientState +
    '; install.json=' + Pick(GInstallJsonValid, 'корректен',
      IfStr(GInstallJsonPresent, 'повреждён', 'нет')) +
    '; данные=' + Pick(GDataDirPresent, 'есть', 'нет'));

  { Чекбокс «Разрешить подключения с других компьютеров» — единственный
    источник ETN_HOST; при обновлении значения пришли из install.json. }
  SyncHostFromFirewall;
  ApplyServerEnv;
  ResolveFirstUserState;
  LoadPendingKey;
  GKeyBeforeInstall := GPendingKey;
  GPendingKeyPrevious := GPendingKey <> '';
  { Обновление серверной установки: порт, хост, режим и каталог данных
    фиксированы install.json — на экране только показываются. }
  GParamsLocked := GInstallJsonValid and
    ((GInstalledMode = 'service') or (GInstalledMode = 'app'));
  LogLine('INFO', 'Ключ в защищённом файле: ' +
    Pick(GPendingKey <> '', 'есть (показ после установки)', 'нет'));
  LogLine('INFO', 'Параметры сервера: порт ' + GServerPort + ', хост ' + GServerHost +
    ', брандмауэр ' + Pick(GServerFirewall, 'включён', 'выключен') +
    ', каталог данных ' + GDataDir);

#ifdef TestMode
  if GTestLogin <> '' then
    GAdminLogin := GTestLogin;
#endif

#ifdef TestMode
  { /TESTSELECT подменяет выбор компонентов через ту же ApplySelection, которой
    пользуются обработчики OnClick экрана компонентов (проверка условия
    элевации и содержимого файла параметров без вывода окон). }
  if GTestSelect = 'server' then
    ApplySelection(True, False, False)
  else if GTestSelect = 'client-machine' then
    ApplySelection(False, True, True)
  else if GTestSelect = 'client-user' then
    ApplySelection(False, True, False);

  { Наблюдаемость состояний и галочек без вывода окон: тестовый прогон
    фиксирует вычисленное состояние в журнале и завершается без изменений. }
  if GTestState = '1' then
  begin
    { /TESTGUIMODE=1 — имитация GUI-запуска: в silent-прогоне термин GSilent
      всегда делает контекст привилегированным, а проверяется сценарий
      «запуск от имени администратора» в неадминистративном режиме. }
    if GTestGui = '1' then
    begin
      LogLine('INFO', 'TESTGUIMODE=1: silent-термин контекста отключён (тестовый режим)');
      GSilent := False;
    end;
    LogLine('INFO', 'TESTSTATE server_state=' + GServerState +
      ' client_state=' + GClientState +
      ' server_files=' + Pick(GServerFilesPresent, '1', '0') +
      ' data_dir=' + Pick(GDataDirPresent, '1', '0') +
      ' record=' + Pick(GInstallerRecordPresent, '1', '0') +
      ' files_version=' + IfStr(GFilesVersion = '', '-', GFilesVersion) +
      ' downgrade=' + Pick(GBlockedDowngrade, '1', '0') +
      ' default_server=' + Pick(GServerSelected, '1', '0') +
      ' default_client=' + Pick(GClientSelected, '1', '0') +
      ' client_scope=' + Pick(GClientScopeUser, 'user', 'machine') +
      ' need_elevation=' + Pick(NeedElevation, '1', '0') +
      ' in_privileged_context=' + Pick(InPrivilegedContext, '1', '0'));
    ExitProcess(EXIT_OK);
  end;

  { Проверка файла параметров: путь, содержимое (область клиента) и удаление
    после чтения. }
  if GTestParams = '1' then
  begin
    WriteParamsFile;
    LogLine('INFO', 'TESTPARAMS path=' + GParamsPath +
      ' scope=' + Pick(GClientScopeUser, 'user', 'machine'));
    ReadParamsFile;
    if GParamsPath <> '' then DeleteFile(GParamsPath);
    LogLine('INFO', 'TESTPARAMS deleted=' + Pick(not FileExists(GParamsPath), '1', '0'));
    ExitProcess(EXIT_OK);
  end;

  { /TESTPORT — подмена порта для предпроверок без файла параметров. }
  if GTestPort <> '' then
  begin
    GServerPort := GTestPort;
    LogLine('WARN', 'TESTPORT=' + GTestPort + ': порт подменён (тестовый режим)');
  end;

  { /TESTPRECHECK=1 — прогон предпроверок без окон: та же функция, что вызывают
    экран параметров сервера и привилегированная фаза. Результат — в журнале и
    в файле /TESTRESULT (тест читает причину отказа). }
  if GTestPrecheck = '1' then
  begin
    Reason := CheckServerEnvironment(True);
    LogLine('INFO', 'TESTPRECHECK result=' + IfStr(Reason = '', 'ok', Reason));
    if GTestResult <> '' then
      SaveStringToFile(GTestResult, Utf8Encode(Reason), False);
    if Reason = '' then
      ExitProcess(EXIT_OK)
    else
      ExitProcess(EXIT_PRECONDITION);
  end;
#endif

  if GPrivilegedPhase then
  begin
    ValidatePrivilegedPhasePreconditions;
    { Файл параметров больше не нужен: в общем каталоге он оставаться не должен.
      Удаляется после предусловий — перезапуск в административном режиме
      (/ADMINMODE) ещё передаёт путь дочернему процессу. }
    if ParamValue('PARAMS') <> '' then
      DeleteFile(ParamValue('PARAMS'));
  end
  else if GSilent then
    ValidateSilentPreconditions
  else if GServerOnly then
  begin
    { /SERVERONLY в GUI скрывает выбор компонентов и оставляет только сервер. }
    GServerSelected := True;
    GClientSelected := False;
  end;

  Result := True;
end;

procedure InitializeWizard;
begin
  if GSilent then Exit;
  CreateComponentsPage;
  CreateAdminPage;
  CreateServerParamsPage;
  CreateKeyPage;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  { /SERVERONLY в GUI: выбор компонентов скрыт, остаётся только сервер. }
  if GServerOnly then
  begin
    if (PageID = wpSelectComponents) or
       ((GComponentsPage <> nil) and (PageID = GComponentsPage.ID)) then
      Result := True;
  end;
  { Лицензия — только первая установка: если на машине уже есть сервер или
    клиент, экран лицензии не показывается. }
  if PageID = wpLicense then
    Result := (GServerState <> 'not-installed') or (GClientState = 'installed');
  { Каталог программы фиксирован ADR 144bcdb0. }
  if PageID = wpSelectDir then
    Result := True;
  { Логин администратора нужен только серверу, который ещё не инициализирован
    (критерий — hasFirstUser, а не наличие _system.db). }
  if (GAdminPage <> nil) and (PageID = GAdminPage.ID) then
    Result := (not GServerSelected) or GFirstUserPresent;
  { Параметры сервера (порт, брандмауэр) — только при установке сервера. }
  if (GServerParamsPage <> nil) and (PageID = GServerParamsPage.ID) then
    Result := not GServerSelected;
  { Экран ключа — только когда ключ реально есть: после init в этом запуске
    или из защищённого файла предыдущей попытки. }
  if (GKeyPage <> nil) and (PageID = GKeyPage.ID) then
    Result := GPendingKey = '';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if GSilent then Exit;
  if (GComponentsPage <> nil) and (CurPageID = GComponentsPage.ID) then
  begin
    if GInitStateLabel <> nil then GInitStateLabel.Caption := InitStateText;
    UpdateComponentsState(nil);
  end;
  if (GAdminPage <> nil) and (CurPageID = GAdminPage.ID) then
  begin
    if (GAdminLoginEdit <> nil) and (GAdminLoginEdit.Text = '') then
      GAdminLoginEdit.Text := GAdminLogin;
    if GAdminErrorLabel <> nil then GAdminErrorLabel.Caption := '';
    if WizardForm <> nil then
      WizardForm.NextButton.Enabled := Trim(GAdminLoginEdit.Text) <> '';
  end;
  if (GServerParamsPage <> nil) and (CurPageID = GServerParamsPage.ID) then
  begin
    { Параметры приходят из install.json (обновление) или из умолчаний
      (4321, подключения разрешены). При обновлении поля только показывают
      значения: изменить их нельзя. }
    if GPortEdit <> nil then
    begin
      GPortEdit.Text := GServerPort;
      GPortEdit.ReadOnly := GParamsLocked;
      if (not GParamsLocked) and (WizardForm <> nil) then
        WizardForm.ActiveControl := GPortEdit;
    end;
    if GFirewallCheck <> nil then
    begin
      GFirewallCheck.Checked := GServerFirewall;
      GFirewallCheck.Enabled := not GParamsLocked;
    end;
    if GPortErrorLabel <> nil then GPortErrorLabel.Caption := '';
    UpdateServerParamsState;
  end;
  if (GKeyPage <> nil) and (CurPageID = GKeyPage.ID) then
  begin
    if GKeyValueEdit <> nil then GKeyValueEdit.Text := GPendingKey;
    if GKeyCopiedLabel <> nil then GKeyCopiedLabel.Caption := '';
    if GKeyPreviousLabel <> nil then GKeyPreviousLabel.Visible := GPendingKeyPrevious;
    if GKeyConfirmCheck <> nil then GKeyConfirmCheck.Checked := False;
    { «Назад» на экране ключа недоступен: ключ уже создан, вернуться к выбору
      компонентов нельзя. «Далее» разблокирует только «Я сохранил ключ». }
    if WizardForm <> nil then
    begin
      WizardForm.BackButton.Visible := False;
      WizardForm.NextButton.Enabled := False;
    end;
  end;
  if CurPageID = wpFinished then
    if WizardForm <> nil then
      WizardForm.NextButton.Enabled := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Reason, PortText: String;
begin
  Result := True;
  if (GServerParamsPage <> nil) and (CurPageID = GServerParamsPage.ID) then
  begin
    if GParamsLocked then Exit;
    PortText := Trim(GPortEdit.Text);
    GServerPort := PortText;
    SyncHostFromFirewall;
    Reason := CheckServerEnvironment(True);
    if Reason <> '' then
    begin
      { Ошибка окружения — до запуска установки: экран остаётся открытым,
        фокус на поле порта (сценарий «порт 4321 занят»). }
      if GPortErrorLabel <> nil then GPortErrorLabel.Caption := Reason;
      if WizardForm <> nil then WizardForm.ActiveControl := GPortEdit;
      LogLine('WARN', 'Экран параметров сервера: ' + Reason);
      Result := False;
      Exit;
    end;
    if GPortErrorLabel <> nil then GPortErrorLabel.Caption := '';
    LogLine('INFO', 'Экран параметров сервера: порт ' + GServerPort + ', хост ' +
      GServerHost + ', брандмауэр ' + Pick(GServerFirewall, 'включён', 'выключен'));
  end;
  if (GAdminPage <> nil) and (CurPageID = GAdminPage.ID) then
  begin
    GAdminLogin := Trim(GAdminLoginEdit.Text);
    if not ValidAdminLogin(GAdminLogin) then
    begin
      if GAdminErrorLabel <> nil then
        GAdminErrorLabel.Caption := 'Логин обязателен и не должен содержать кавычек и переводов строк.';
      Result := False;
      Exit;
    end;
  end;
  if (GKeyPage <> nil) and (CurPageID = GKeyPage.ID) then
  begin
    { «Далее» неактивна без чекбокса; проверка дублируется на случай
      программного перехода. }
    if (GKeyConfirmCheck = nil) or (not GKeyConfirmCheck.Checked) then
    begin
      Result := False;
      Exit;
    end;
    { Подтверждение получено — временный файл с ключом больше не нужен. }
    if DeleteFile(KeyFilePath) then
      LogLine('INFO', 'Временный файл ключа удалён после подтверждения')
    else
      LogLine('WARN', 'Не удалось удалить временный файл ключа: ' + KeyFilePath);
    GPendingKey := '';
  end;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if (GKeyPage <> nil) and (CurPageID = GKeyPage.ID) and (GPendingKey <> '') then
  begin
    { Закрытие без подтверждения: предупредить и удалить временный файл.
      Отказ — остаться на экране ключа. }
    if SuppressibleMsgBox('Ключ не сохранён. Восстановить его нельзя — только ' +
        'выпустить новый. Временный файл с ключом будет удалён. Закрыть установщик?',
        mbConfirmation, MB_YESNO, IDNO) <> IDYES then
    begin
      Cancel := False;
      Exit;
    end;
    if DeleteFile(KeyFilePath) then
      LogLine('INFO', 'Экран ключа закрыт без подтверждения: временный файл ключа удалён')
    else
      LogLine('WARN', 'Экран ключа закрыт без подтверждения, но файл не удалён: ' + KeyFilePath);
    GPendingKey := '';
    Cancel := True;
  end;
end;

{ Подтверждение перед установкой: двухфазное повышение прав.
  До этого момента на диск не пишется ничего, кроме временного файла
  параметров; при отказе UAC частичных файлов не остаётся. }
{ Подтверждение перед установкой: двухфазное повышение прав.
  До этого момента на диск не пишется ничего, кроме временного файла
  параметров; при отказе UAC частичных файлов не остаётся. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Reason: String;
begin
  Result := '';
  NeedsRestart := False;
  if GSilent or GPrivilegedPhase then Exit;
  if not NeedElevation then Exit;
  { Уже элевированный процесс пишет в Program Files сам, но только в
    административном режиме установки; иначе нужен дочерний /ALLUSERS. }
  if GIsElevated and IsAdminInstallMode then
  begin
    { Этот экземпляр — сам себе привилегированная фаза: предпроверки окружения
      выполняются здесь, до замены файлов (9b310991). }
    if GServerSelected then
    begin
      Reason := CheckServerEnvironment(False);
      if Reason <> '' then
      begin
        LogLine('ERROR', 'Установка не начата: ' + Reason);
        Result := 'Установка не начата: ' + Reason + '. Изменения не выполнялись. ' +
          'Журнал: ' + GLogPath;
      end;
    end;
    Exit;
  end;

  LogLine('INFO', 'Выбранным компонентам нужны права администратора — повышение прав');
  GChildResult := RunElevatedChild;
  if GChildResult < 0 then
    Result := 'Для выбранных компонентов нужны права администратора. Запрос UAC отклонён — ' +
      'изменения не выполнялись, выбор сохранён. Журнал: ' + GLogPath
  else if GChildResult = EXIT_PRECONDITION then
  begin
    if GChildReason = '' then
      Result := 'Установка не начата: не выполнено предусловие (код 20). Журнал: ' + GLogPath
    else
      Result := 'Установка не начата: ' + GChildReason + '. Изменения не выполнялись. ' +
        'Порт и доступ по локальной сети можно изменить в «Параметры сервера». ' +
        'Журнал: ' + GLogPath;
  end
  else if GChildResult <> EXIT_OK then
    Result := Format('Установка завершилась сбоем (код %d). Журнал: %s', [GChildResult, GLogPath]);
end;

{ Запись установки нужна и для машинного клиента без сервера: иначе повторный
  запуск не узнает область клиента и поставит вторую per-user копию. }
function NeedInstallRecord: Boolean;
begin
  Result := InPrivilegedContext and
    (GServerSelected or (GClientSelected and (not GClientScopeUser)));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  HealthOk: Boolean;
begin
  if CurStep = ssPostInstall then
  begin
    if GSilent then
      LogLine('INFO', 'Silent server-only: установка файлов завершена');
    HealthOk := True;
    if GDoPrivilegedWork then
    begin
      { Порядок шагов — контракт bb063ac3: остановка службы, замена файлов,
        инициализация (только первая установка), запуск, health-check;
        install.json пишется только после успешной проверки, иначе после
        отката файл врал бы о новой версии. }
      StopServiceIfRunning;
      { Каталог данных и подкаталоги, которые обязаны существовать до старта
        службы (WinSW каталог журнала не создаёт) — 9b310991. }
      if GServerSelected then
      begin
        if not EnsureServerDirs then
        begin
          GExitCode := EXIT_FAILED;
          LogLine('ERROR', 'Сбой выполнения: каталог данных не подготовлен (код 10)');
        end;
        { Подстановка шаблона службы до регистрации/запуска: пока в
          etn-service.xml плейсхолдеры, службу запускать нельзя (ADR db60302a). }
        if (GExitCode = EXIT_OK) and (not InstallServiceConfig) then
        begin
          GExitCode := EXIT_FAILED;
          LogLine('ERROR', 'Сбой выполнения: конфигурация службы не подготовлена (код 10)');
        end;
        { Правило брандмауэра — по чекбоксу; ошибка netsh не отменяет
          установку (сервер работает локально), причина в журнале. }
        if GExitCode = EXIT_OK then
          ApplyFirewallRule;
      end;
      { Инициализация — до запуска службы: сервер без администратора не
        стартует. Вызывается один раз: критерий hasFirstUser (686c5d76). }
      if GServerSelected then
        EnsureFirstUser;
#ifdef TestMode
      if (GTestFailAfterInit = '1') and GInitAttempted and (GPendingKey <> '') then
      begin
        LogLine('ERROR', 'TESTFAILAFTERINIT: имитация сбоя после etn init до показа ключа');
        ExitProcess(EXIT_FAILED);
      end;
#endif
      StartServiceIfNeeded;
      HealthOk := ProbeHealth;
      if not HealthOk then
      begin
        GExitCode := EXIT_FAILED;
        LogLine('ERROR', 'Сбой выполнения: health-check не пройден (код 10)');
      end;
      { Silent: init не вызывался; без администратора сервер не работает —
        код 10, нужен ручной режим. }
      if HealthOk and IsSilentServerOnly then
      begin
        if not SilentAdminPresent then
        begin
          GExitCode := EXIT_FAILED;
          LogLine('ERROR', 'Сбой выполнения: сервер не инициализирован (код 10)');
        end;
      end;
    end;
    if HealthOk and (GExitCode = EXIT_OK) and NeedInstallRecord then
    begin
      if not WriteInstallJson then
      begin
        GExitCode := EXIT_FAILED;
        LogLine('ERROR', 'Сбой выполнения: install.json не записан (код 10)');
      end;
    end;
    { Ключ мог создать дочерний (элевированный) процесс: читаем защищённый
      файл после установки, чтобы показать его на экране ключа. }
    if GServerSelected then
      LoadPendingKey;
    if GPendingKey <> GKeyBeforeInstall then
      GPendingKeyPrevious := False
    else
      GPendingKeyPrevious := GPendingKey <> '';
#ifdef TestMode
    { Наблюдаемость без GUI: состояние ключа в журнале (значение ключа —
      никогда), подтверждение и закрытие экрана без подтверждения. }
    if GTestKeyState = '1' then
    begin
      LogLine('INFO', 'INITSTATE checked=' + Pick(GFirstUserChecked, '1', '0') +
        ' hasfirstuser=' + Pick(GFirstUserPresent, '1', '0') +
        ' init_attempted=' + Pick(GInitAttempted, '1', '0') +
        ' pending=' + Pick(GPendingKey <> '', '1', '0') +
        ' keylen=' + IntToStr(Length(GPendingKey)) +
        ' previous=' + Pick(GPendingKeyPrevious, '1', '0') +
        ' exitcode=' + IntToStr(GExitCode));
      if GTestKeyAck = '1' then
      begin
        DeleteFile(KeyFilePath);
        LogLine('INFO', 'INITACK deleted=' + Pick(not FileExists(KeyFilePath), '1', '0'));
        GPendingKey := '';
      end;
      if GTestKeyClose = '1' then
      begin
        DeleteFile(KeyFilePath);
        LogLine('INFO', 'INITCLOSE deleted=' + Pick(not FileExists(KeyFilePath), '1', '0') +
          ' warning=1');
        GPendingKey := '';
      end;
      ExitProcess(GExitCode);
    end;
#endif
  end;
end;

function NormalizeExitCode(const Code: Integer): Integer;
begin
  if (Code = EXIT_OK) or (Code = EXIT_FAILED) or (Code = EXIT_PRECONDITION) then
    Result := Code
  else
    Result := EXIT_FAILED;
end;

function GetCustomSetupExitCode: Integer;
begin
  { Дочерний (привилегированный) экземпляр отдаёт свой код сам; родитель
    транслирует код дочернего — в том числе когда выбран только клиент
    «для всех» (сервер при этом не выбран). }
  if (not GSilent) and (not GPrivilegedPhase) and (GChildResult <> 0) then
    Result := NormalizeExitCode(GChildResult)
  else
    Result := NormalizeExitCode(GExitCode);
  if GLogPath <> '' then
    LogLine('INFO', 'Завершение: код возврата ' + IntToStr(Result));
end;

{ Удаление программы: правило брандмауэра удаляется вместе с ней (требование
  15a1d3e4, задача 9b310991). Решение принимается в usUninstall — до того,
  как Inno удалит файлы и install.json; само удаление правила — в
  usPostUninstall, когда файлов программы уже нет. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    GUninstallFirewallRule := UninstallFirewallRuleWanted;
    Log('Правило брандмауэра будет удалено: ' + IntToStr(Ord(GUninstallFirewallRule)));
  end
  else if (CurUninstallStep = usPostUninstall) and GUninstallFirewallRule then
  begin
    if RunNetsh('advfirewall firewall delete rule name="' + FIREWALL_RULE_NAME + '"') then
      Log('Правило брандмауэра удалено: ' + FIREWALL_RULE_NAME)
    else
      Log('Правило брандмауэра не удалено (возможно, его не было): ' + FIREWALL_RULE_NAME);
  end;
end;
