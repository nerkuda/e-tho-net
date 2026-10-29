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
;   686c5d76 — etn init, экран ключа, критерий «уже инициализирован»;
;   98ad5eec — поставка клиента (область установки, ярлыки, закрытие ETN.exe).
;
; Сборка: installer/build.ps1 (передаёт /DMyAppVersion из server/package.json).
; Проверка silent-контракта: installer/tests/silent-codes.ps1.
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
;   /TESTHEALTH — только в тестовой сборке (installer/tests/silent-codes.ps1).
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
  GClientCheck: TNewCheckBox;
  GClientStateLabel: TNewStaticText;
  GScopeUserRadio: TNewRadioButton;
  GScopeMachineRadio: TNewRadioButton;
  GDataNoteLabel: TNewStaticText;
  GReasonLabel: TNewStaticText;

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

procedure InitLog;
var
  TempDir: String;
begin
  GLogPath := '';
  { Основной путь по контракту: %ProgramData%\ETN\logs. }
  if TryInitLog(GDataDir + '\logs') then Exit;
  { Fallback по контракту: %TEMP%. }
  TempDir := GetEnv('TEMP');
  if TempDir = '' then TempDir := GetEnv('TMP');
  if TryInitLog(TempDir) then
    LogLine('WARN', 'Каталог ' + GDataDir + '\logs недоступен — журнал в %TEMP%')
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

{ Файл параметров для элевированной фазы: строки key=value, ASCII.
  UAC может запустить дочерний процесс с учётными данными ДРУГОГО
  администратора — профиль и %TEMP% тогда чужие, поэтому файл кладётся в
  общий каталог (%ProgramData%\ETN\.install, при недоступности — %PUBLIC%).
  Секреты в командной строке не передаются: только путь к файлу. }
function NewParamsFilePath: String;
var
  Dir: String;
begin
#ifdef TestMode
  Dir := GDataDir + '\.install';
#else
  Dir := ExpandConstant('{commonappdata}\ETN\.install');
#endif
  if not ForceDirectories(Dir) then
  begin
    Dir := GetEnv('PUBLIC');
    if (Dir = '') or (not ForceDirectories(Dir)) then
      Dir := ExpandConstant('{tmp}');
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

procedure WriteParamsFile;
var
  Lines: String;
begin
  if GParamsPath = '' then
    GParamsPath := NewParamsFilePath;
  Lines :=
    'server=' + IntToStr(Ord(GServerSelected)) + #13#10 +
    'client=' + IntToStr(Ord(GClientSelected)) + #13#10 +
    'client_scope=' + Pick(GClientScopeUser, 'user', 'machine') + #13#10 +
    'mode=' + GServerMode + #13#10 +
    'host=' + GServerHost + #13#10 +
    'port=' + GServerPort + #13#10 +
    'firewall=' + IntToStr(Ord(GServerFirewall)) + #13#10;
  if not SaveStringToFile(GParamsPath, Lines, False) then
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
  else
    LogLine('INFO', 'параметр ' + K + '=' + V);
end;

procedure ReadParamsFile;
var
  Text: String;
  I, StartPos: Integer;
begin
  if not FileExists(ParamsFilePath) then
  begin
    LogLine('WARN', 'Файл параметров не найден: ' + ParamsFilePath);
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
  Args: String;
  Code: Integer;
begin
  Result := -1;
  GChildResult := -1;
  GParamsPath := '';
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
    Result := -1;
    Exit;
  end;
  LogLine('INFO', 'Дочерний (элевированный) установщик завершился с кодом ' + IntToStr(Code));
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
  DataDirFromJson: String;
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
  GSkipCopy := (SemverCompare(GInstalledVersion, GProductVersion) = 0);
  if GSkipCopy then
    LogLine('INFO', 'Установлена та же версия ' + GProductVersion + ': файлы не заменяются');
end;

{ ---------------------------------------------------------------------------
  Предусловия привилегированной фазы — внутреннего запуска с /PRIVILEGEDPHASE
  (дочерний процесс GUI-установки и клиента «для всех» поднимает себя сам).
  Это НЕ silent-самообновление: install.json, файлы и служба не требуются —
  проверяются только права, каталог, данные и порт.
  --------------------------------------------------------------------------- }
procedure ValidatePrivilegedPhasePreconditions;
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
  if GServerSelected and (not PortValid(GServerPort)) then
    FailPrecondition('некорректный порт: "' + GServerPort + '"');
  if (GServerSelected or (GClientSelected and (not GClientScopeUser))) and
     (not DirWritable(GServerDir)) then
    FailPrecondition('каталог программы недоступен для записи: ' + GServerDir);
  if GServerSelected and (not DirWritable(GDataDir)) then
    FailPrecondition('каталог данных недоступен для записи: ' + GDataDir);
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

  GClientCheck := TNewCheckBox.Create(GComponentsPage);
  GClientCheck.Parent := GComponentsPage.Surface;
  GClientCheck.Left := 0;
  GClientCheck.Top := GServerStateLabel.Top + GServerStateLabel.Height + 14;
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
  События установщика
  --------------------------------------------------------------------------- }
function InitializeSetup: Boolean;
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
  GParamsPath := '';
  GProductVersion := '{#MyAppVersion}';
  GDataDir := ExpandConstant('{#DataDir}');
  GServerDir := ExpandConstant('{#AppDir}');
  GSilent := WizardSilent;
  GServerOnly := ParamExists('SERVERONLY');
  GPrivilegedPhase := ParamExists('PRIVILEGEDPHASE');
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
#endif

  InitLog;
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

  if GPrivilegedPhase then
    ReadParamsFile;

  LoadInstallJson;
  ApplyInstalledParams;
  DetectState;
  LogLine('INFO', 'Состояние: сервер=' + GServerState +
    ' (установлено: ' + IfStr(GInstalledVersion = '', '—', GInstalledVersion) +
    ', версия файлов: ' + IfStr(GFilesVersion = '', '—', GFilesVersion) +
    ', режим: ' + IfStr(GInstalledMode = '', '—', GInstalledMode) + ')' +
    '; клиент=' + GClientState +
    '; install.json=' + Pick(GInstallJsonValid, 'корректен',
      IfStr(GInstallJsonPresent, 'повреждён', 'нет')) +
    '; данные=' + Pick(GDataDirPresent, 'есть', 'нет'));

  { Выбор компонентов по умолчанию: в привилегированной фазе выбор пришёл из
    файла параметров и не пересчитывается. }
  if not GPrivilegedPhase then
    ApplyDefaultSelection;

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
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if GSilent then Exit;
  if (GComponentsPage <> nil) and (CurPageID = GComponentsPage.ID) then
    UpdateComponentsState(nil);
end;

{ Подтверждение перед установкой: двухфазное повышение прав.
  До этого момента на диск не пишется ничего, кроме временного файла
  параметров; при отказе UAC частичных файлов не остаётся. }
{ Подтверждение перед установкой: двухфазное повышение прав.
  До этого момента на диск не пишется ничего, кроме временного файла
  параметров; при отказе UAC частичных файлов не остаётся. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  if GSilent or GPrivilegedPhase then Exit;
  if not NeedElevation then Exit;
  { Уже элевированный процесс пишет в Program Files сам, но только в
    административном режиме установки; иначе нужен дочерний /ALLUSERS. }
  if GIsElevated and IsAdminInstallMode then Exit;

  LogLine('INFO', 'Выбранным компонентам нужны права администратора — повышение прав');
  GChildResult := RunElevatedChild;
  if GChildResult < 0 then
    Result := 'Для выбранных компонентов нужны права администратора. Запрос UAC отклонён — ' +
      'изменения не выполнялись, выбор сохранён. Журнал: ' + GLogPath
  else if GChildResult = EXIT_PRECONDITION then
    Result := 'Установка не начата: не выполнено предусловие (код 20). Журнал: ' + GLogPath
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
        запуск, health-check; install.json пишется только после успешной
        проверки, иначе после отката файл врал бы о новой версии. }
      StopServiceIfRunning;
      StartServiceIfNeeded;
      HealthOk := ProbeHealth;
      if not HealthOk then
      begin
        GExitCode := EXIT_FAILED;
        LogLine('ERROR', 'Сбой выполнения: health-check не пройден (код 10)');
      end;
    end;
    if HealthOk and NeedInstallRecord then
    begin
      if not WriteInstallJson then
      begin
        GExitCode := EXIT_FAILED;
        LogLine('ERROR', 'Сбой выполнения: install.json не записан (код 10)');
      end;
    end;
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
