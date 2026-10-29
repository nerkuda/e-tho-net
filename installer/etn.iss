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
  #define AppDir "{commonpf}\ETN"
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

; Каталог программы фиксирован ADR 144bcdb0: %ProgramFiles%\ETN.
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

; --- Клиент (поставка 98ad5eec). «Для всех» ставится в {app}\client в
; --- привилегированной фазе; «только для меня» — в неэлевированной фазе
; --- (иначе {localappdata} указывает на профиль администратора).
#ifdef HaveClientPayload
Source: "{#ClientPayload}\*"; DestDir: "{app}\client"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientMachine
Source: "{#ClientPayload}\*"; DestDir: "{localappdata}\Programs\ETN"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientUser
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

  { Версия и пути }
  GProductVersion: String;
  GDataDir: String;
  GServerDir: String;
  GLogPath: String;
  GInstallJsonPath: String;
  GInstallJsonText: String;

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
    Такой файл трактуется как repair, а не как «не установлено». }
  GInstallJsonValid := (Schema = '1') and (GInstalledVersion <> '') and
    ((GInstalledMode = 'service') or (GInstalledMode = 'app'));
  if GInstallJsonValid and (GInstalledClientScope = 'null') then
    GInstalledClientScope := '';
end;

function ServerFilesPresent: Boolean;
begin
  Result := FileExists(GServerDir + '\server\package.json') and
    FileExists(GServerDir + '\server\dist\index.js');
end;

function DataDirPresent: Boolean;
begin
  Result := DirExists(GDataDir) and
    (FileExists(GDataDir + '\_system.db') or DirExists(GDataDir + '\networks'));
end;

function ClientFilesPresent: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\Programs\ETN\ETN.exe')) or
    FileExists(ExpandConstant('{commonpf}\ETN\client\ETN.exe')) or
    FileExists(ExpandConstant('{commonpf}\ETN\ETN.exe'));
end;

procedure DetectState;
begin
  GServerFilesPresent := ServerFilesPresent;
  GDataDirPresent := DataDirPresent;
  GClientFilesPresent := ClientFilesPresent;

  { Ручная установка 0.14.1 (git clone, без записи установки) распознаётся по
    каталогу данных: программа ставится, данные не трогаются, init не
    вызывается (686c5d76). }
  GAdoptExistingData := GDataDirPresent and not GInstallJsonValid;

  GBlockedDowngrade := GInstallJsonValid and
    (SemverCompare(GInstalledVersion, GProductVersion) > 0);

  if not GInstallJsonValid and not GServerFilesPresent and not GClientFilesPresent then
    GServerState := 'not-installed'
  else if not GInstallJsonValid or not GServerFilesPresent then
    GServerState := 'repair'
  else if SemverCompare(GInstalledVersion, GProductVersion) < 0 then
    GServerState := 'update-available'
  else if SemverCompare(GInstalledVersion, GProductVersion) = 0 then
    GServerState := 'repair'
  else
    GServerState := 'downgrade';

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
  if GInstalledMode <> '' then GServerMode := GInstalledMode;
  if GInstalledHost <> '' then GServerHost := GInstalledHost;
  if GInstalledPort <> '' then GServerPort := GInstalledPort;
  if JsonGetRaw(GInstallJsonText, 'firewall') <> '' then
    GServerFirewall := GInstalledFirewall;
end;

function ServerStateText: String;
begin
  if GServerState = 'not-installed' then
    Result := 'не установлен'
  else if GServerState = 'update-available' then
    Result := 'установлен ' + GInstalledVersion + ' — доступно обновление до ' + GProductVersion
  else if GServerState = 'repair' then
  begin
    if GInstallJsonValid then
      Result := 'установлен ' + GInstalledVersion + ' — переустановка (repair)'
    else if GAdoptExistingData then
      Result := 'найдены существующие данные (' + GDataDir + ') — будут подключены'
    else
      Result := 'установлен частично — будет восстановлен (repair)';
  end
  else
    Result := 'установлена более новая версия ' + GInstalledVersion +
      ' — понижение запрещено';
end;

function ClientStateText: String;
begin
  if GClientState = 'installed' then
    Result := 'клиент обнаружен на этом компьютере'
  else
    Result := 'не установлен';
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

{ Файл параметров для элевированной фазы: строка key=value, ASCII. }
function ParamsFilePath: String;
begin
  { Родитель пишет файл параметров во временный каталог своего экземпляра и
    передаёт путь дочернему через /PARAMS; дочерний читает именно его. }
  Result := ParamValue('PARAMS');
  if Result = '' then
    Result := ExpandConstant('{tmp}') + '\etn-install-params.ini';
end;

procedure WriteParamsFile;
var
  Lines: String;
begin
  Lines :=
    'server=' + IntToStr(Ord(GServerSelected)) + #13#10 +
    'client=' + IntToStr(Ord(GClientSelected)) + #13#10 +
    'client_scope=' + Pick(GClientScopeUser, 'user', 'machine') + #13#10 +
    'mode=' + GServerMode + #13#10 +
    'host=' + GServerHost + #13#10 +
    'port=' + GServerPort + #13#10 +
    'firewall=' + IntToStr(Ord(GServerFirewall)) + #13#10;
  SaveStringToFile(ParamsFilePath, Lines, False);
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
  WriteParamsFile;
  Args := '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ALLUSERS /PRIVILEGEDPHASE /PARAMS="' +
    ParamsFilePath + '"';
  LogLine('INFO', 'Повышение прав: перезапуск с параметрами ' + Args);
  if not ShellExec('runas', ExpandConstant('{srcexe}'), Args, '',
    SW_SHOWNORMAL, ewWaitUntilTerminated, Code) then
  begin
    LogLine('ERROR', 'Повышение прав отклонено (UAC): изменения не выполнялись');
    Result := -1;
    Exit;
  end;
  LogLine('INFO', 'Дочерний (элевированный) установщик завершился с кодом ' + IntToStr(Code));
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
    /PRIVILEGEDPHASE, либо GUI, запущенный сразу с правами администратора. }
  Result := GWorkAllowed and (GSilent or GPrivilegedPhase or GIsElevated);
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
  Result := GClientSelected and GWorkAllowed and GClientScopeUser;
end;

function BuildInstallJson: String;
var
  Scope: String;
begin
  if GClientSelected then
  begin
    if GClientScopeUser then Scope := 'user' else Scope := 'machine';
  end
  else if GInstalledClientScope <> '' then
    Scope := GInstalledClientScope
  else
    Scope := '';
  Result := '{' +
    '"schema":1,' +
    '"product_version":' + JsonString(GProductVersion) + ',' +
    '"mode":' + JsonString(GServerMode) + ',' +
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
    (GInstalledMode = GServerMode) and
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
  if ParamsUnchanged and (GInstalledAt <> '') then
  begin
    LogLine('INFO', 'install.json: параметры не изменились — файл не перезаписывается');
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

{ Health-check: в этой задаче — только точка вызова и контрактный код.
  Реальный опрос (GET /api/v1/health + версия) реализуется в bb063ac3;
  до появления службы (8b1f5980) проверка не выполняется. }
function ProbeHealth: Boolean;
var
  Code: Integer;
  Url: String;
begin
  if GTestHealth <> '' then
  begin
    Result := LowerCase(GTestHealth) = 'ok';
    LogLine('INFO', 'Health-check (тестовый режим): ' + GTestHealth);
    Exit;
  end;
  if not FileExists(GServerDir + '\service\etn-service.exe') then
  begin
    LogLine('INFO', 'Health-check: управление службой появится в bb063ac3 — проверка пропущена');
    Result := True;
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
    установки уйдёт в HKCU и станет невидимой для службы/других сеансов.
    Процесс уже элевирован, поэтому повторный запуск не показывает UAC. }
  if (not GTestMode) and (not IsAdminInstallMode) and (not ParamExists('ADMINMODE')) then
  begin
    LogLine('INFO', 'Перезапуск в административном режиме установки (/ALLUSERS)');
    if ShellExec(ExpandConstant('{srcexe}'),
      '/ALLUSERS /ADMINMODE /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVERONLY' +
      IfStr(ParamValue('PARAMS') <> '', ' /PARAMS="' + ParamValue('PARAMS') + '"', ''),
      '', '', SW_HIDE, ewWaitUntilTerminated, GChildResult) then
      ExitProcess(GChildResult);
    LogLine('WARN', 'Перезапуск в административном режиме не удался — продолжаем как есть');
  end;
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
  Экран компонентов (каркас; тексты и оформление — 112642a4)
  --------------------------------------------------------------------------- }
procedure UpdateComponentsState(Sender: TObject);
begin
  if GSilent then Exit;
  if GServerCheck <> nil then GServerSelected := GServerCheck.Checked;
  if GClientCheck <> nil then GClientSelected := GClientCheck.Checked;
  if GScopeUserRadio <> nil then GClientScopeUser := GScopeUserRadio.Checked;
  if GScopeUserRadio <> nil then GScopeUserRadio.Enabled := GClientSelected;
  if GScopeMachineRadio <> nil then GScopeMachineRadio.Enabled := GClientSelected;
  if GReasonLabel <> nil then
  begin
    if GBlockedDowngrade then
      GReasonLabel.Caption := 'Установлена более новая версия ' + GInstalledVersion +
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

  GScopeMachineRadio := TNewRadioButton.Create(GComponentsPage);
  GScopeMachineRadio.Parent := GComponentsPage.Surface;
  GScopeMachineRadio.Left := 20;
  GScopeMachineRadio.Top := GScopeUserRadio.Top + GScopeUserRadio.Height + 2;
  GScopeMachineRadio.Width := GComponentsPage.SurfaceWidth - 20;
  GScopeMachineRadio.Caption := 'Клиент: для всех пользователей компьютера';

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

  { По умолчанию отмечены уже установленные компоненты; на чистой машине
    ничего не отмечено и «Далее» неактивна с причиной (112642a4 уточнит
    оформление). }
  GServerCheck.Checked := (GServerState <> 'not-installed') and (GServerState <> 'downgrade');
  GClientCheck.Checked := GClientState = 'installed';
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
  LogLine('INFO', 'Журнал: ' + GLogPath);

  if GPrivilegedPhase then
    ReadParamsFile;

  LoadInstallJson;
  ApplyInstalledParams;
  DetectState;
  LogLine('INFO', 'Состояние: сервер=' + GServerState +
    ' (установлено: ' + IfStr(GInstalledVersion = '', '—', GInstalledVersion) +
    ', режим: ' + IfStr(GInstalledMode = '', '—', GInstalledMode) + ')' +
    '; клиент=' + GClientState +
    '; install.json=' + Pick(GInstallJsonValid, 'корректен',
      IfStr(GInstallJsonPresent, 'повреждён', 'нет')) +
    '; данные=' + Pick(GDataDirPresent, 'есть', 'нет'));

  if GSilent then
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
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  NeedsRestart := False;
  if GSilent or GPrivilegedPhase then Exit;
  if not GServerSelected then Exit;
  if GIsElevated then Exit;

  LogLine('INFO', 'Сервер требует прав администратора — повышение прав');
  GChildResult := RunElevatedChild;
  if GChildResult < 0 then
    Result := 'Для установки сервера нужны права администратора. Запрос UAC отклонён — ' +
      'изменения не выполнялись, выбор компонентов сохранён (вернитесь на шаг «Компоненты»). ' +
      'Журнал: ' + GLogPath
  else if GChildResult = EXIT_PRECONDITION then
    Result := 'Установка сервера не начата: не выполнено предусловие (код 20). Журнал: ' + GLogPath
  else if GChildResult <> EXIT_OK then
    Result := Format('Установка сервера завершилась сбоем (код %d). Журнал: %s', [GChildResult, GLogPath]);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if GSilent then
      LogLine('INFO', 'Silent server-only: установка файлов завершена');
    if GDoPrivilegedWork then
    begin
      { Порядок шагов — контракт bb063ac3: остановка службы, замена файлов,
        запуск, health-check; install.json пишется только после успешной
        проверки, иначе после отката файл врал бы о новой версии. }
      StopServiceIfRunning;
      StartServiceIfNeeded;
      if not ProbeHealth then
      begin
        GExitCode := EXIT_FAILED;
        LogLine('ERROR', 'Сбой выполнения: health-check не пройден (код 10)');
      end
      else if not WriteInstallJson then
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
  if (not GSilent) and (not GPrivilegedPhase) and GServerSelected and
     (GChildResult <> 0) then
    Result := NormalizeExitCode(GChildResult)
  else
    Result := NormalizeExitCode(GExitCode);
  if GLogPath <> '' then
    LogLine('INFO', 'Завершение: код возврата ' + IntToStr(Result));
end;
