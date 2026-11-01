; ============================================================================
; installer/etn.iss — комбинированный установщик ETN для Windows
;
; Задача a1211915 (0.15.1): каркас установщика, определение состояния машины,
; параметры установки (install.json), двухфазное повышение прав (UAC) и
; silent server-only режим для самообновления сервера.
;
; Зоны соседних задач (не реализуются здесь, оставлены точки вызова):
;   8b1f5980 — поставка сервера (Node, prod-node_modules, WinSW, служба);
;   112642a4 — экраны, лицензия, прогресс, итоговая сводка, тексты;
;   98ad5eec — поставка клиента (область установки, ярлыки, закрытие ETN.exe).
;
; Задача bb063ac3 (0.15.1) — обновление сервера установщиком:
;   * порядок фаз закреплён в CurStepChanged(ssInstall) ДО копирования файлов:
;     остановка службы WinSW с ожиданием реальной остановки, бэкап БД
;     (ce3ab836), снимок отката, затем копирование файлов;
;   * остановка до копирования обязательна: занятые node.exe, better-sqlite3
;     и файлы сервера иначе не заменить;
;   * бэкап берётся только при смене версии (ремонт той же версии — без
;     архива); неудачный бэкап отменяет обновление до замены файлов, служба
;     поднимается обратно (сценарий bc7cc846, код 10);
;   * снимок отката — %ProgramData%\ETN\.install\rollback\<timestamp> с копией
;     server и service (данные не копируются); после успешного обновления
;     удаляется, при отказе остаётся точкой ручного восстановления;
;   * после копирования: настройка службы, запуск, расширенный health-check
;     (GET /api/v1/health → 200, status=ok, db=ok, версия = целевая;
;     GET /api/v1/version → version и api; бюджет 60 с, повтор каждые 2 с);
;   * неудача health-check: остановка службы, возврат файлов из снимка,
;     восстановление БД из архива (с удалением WAL/SHM), запуск прежней
;     версии, повторная проверка, код 10; в журнале отдельно «Откат выполнен»
;     либо «Откат не выполнен, архив: <путь>»;
;   * install.json пишется только после успешного health-check — иначе после
;     отката файл врал бы о новой версии;
;   * коды: 20 — предусловие (занятый порт, режим app, служба не остановилась,
;     служба не перешла в RUNNING); 10 — сбой выполнения, включая неудачный
;     бэкап и неудачный откат.
;
; Задача ce3ab836 (0.15.1) — бэкап баз данных перед заменой файлов:
;   * CreateDatabaseBackup(Needed) — вызывающий (bb063ac3) передаёт решение:
;     при смене версии Needed = True, при ремонте той же версии False;
;   * архив — каталог backups\<YYYYMMDD-HHmmss> каталога данных с копиями
;     _system.db и networks\<uuid>\data.db; без вложений и без zip;
;   * перед копированием WAL-база чекпойнтится через node.exe и
;     better-sqlite3 поставки; если чекпойнт не удался, копируется и файл -wal;
;   * каждая копия проходит PRAGMA integrity_check (не ok — архив неудачный и
;     удаляется, обновление отменяется);
;   * хранятся три последних архива; четвёртый удаляет самый старый, ошибка
;     удаления обновление не отменяет (только WARN); чужие файлы и каталоги
;     в backups не трогаются.
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
; Задача 112642a4 (0.15.1) — экраны, лицензия, прогресс, сводка и ошибки:
;   * экран компонентов — первый экран и приветствие: подписи компонентов
;     зависят от состояния, описания сервера/клиента, ссылка на другие
;     варианты установки сервера;
;   * лицензия MIT — чекбокс «Я принимаю условия лицензии MIT» с локальным
;     текстом (файл LICENSE извлекается из установщика, интернет не нужен);
;     показывается только при первой установке (нет ни сервера, ни клиента),
;     без принятия «Далее» неактивна с причиной (требование d75b7988);
;   * понижение версии — сообщение и только «Отмена»;
;   * старый NSIS-клиент (electron-builder) — предупреждение и удаление его
;     деинсталлятором перед установкой нового клиента;
;   * прогресс — подпись текущего этапа в StatusLabel страницы установки
;     (остановка службы, резервная копия, замена файлов, инициализация,
;     запуск, health-check); этапы выполняет тот процесс, который их делает —
;     при двухфазном UAC это привилегированная фаза (её этапы в журнале);
;   * экран ошибки — причина, путь к журналу, путь к резервной копии и
;     следующий шаг; кнопки «Открыть журнал» и «Повторить»;
;   * итоговая сводка — что установлено, адрес сервера (локальный и LAN при
;     открытом брандмауэре), каталог данных, журнал, бэкап, напоминание
;     сохранить ключ; кнопки «Запустить клиент», «Открыть папку данных»,
;     «Открыть журнал»;
;   * отказ UAC — объяснение и возврат на экран компонентов с сохранённым
;     выбором (попытка повышения прав выполняется на экране готовности, где
;     «Назад» ещё доступна);
;   * занятый порт — фокус на поле порта и подсказка свободного значения.
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
;   * служба ETN регистрируется WinSW (etn-service.exe install) после записи
;     конфигурации и до запуска; уже зарегистрированная служба не
;     перегистрируется (WinSW 2.12.0 вернул бы 1073), сбой регистрации —
;     код 20 с причиной; запуск ждёт подтверждённого RUNNING, затем health;
;     служба не перешла в RUNNING за бюджет — тоже код 20 с причиной;
;   * при удалении программы служба останавливается и снимается
;     (etn-service.exe uninstall) до удаления файлов; отказ отменяет удаление
;     с причиной; деинсталлятор не вызывает InitializeSetup — путь к службе и
;     журнал удаления берутся из {app}/{commonappdata} и install.json;
;     режим app службу не регистрирует и удаление не трогает;
;   * при обновлении порт, хост, режим и каталог данных фиксированы — берутся
;     из install.json, поля на экране только показывают значения;
;   * установка только клиента серверных каталогов и правила не создаёт.
;
; Сборка: installer/build.ps1 (передаёт /DMyAppVersion из server/package.json).
; Проверка silent-контракта и предпроверок: installer/tests/silent-codes.ps1.
; Проверка init и ключа: installer/tests/init-key.ps1.
; Проверка подстановки шаблона и запуска поставки: installer/tests/staged-app.ps1.
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
;   /TESTFIREWALL, /TESTPRECHECK, /TESTSERVICENAME, /TESTOWNSERVICEPID,
;   /TESTSERVICECMD, /TESTSERVICESTATE, /TESTSERVICESTOP, /TESTSERVICESTART,
;   /TESTSERVICEWAIT, /TESTSERVICEINSTALL, /TESTSERVICEUNINSTALL,
;   /TESTSERVICEREALFILE, /TESTUNINSTALLSERVICE, /TESTHEALTHURL,
;   /TESTHEALTHWAIT, /TESTHEALTHSTEP, /TESTROLLBACK — только в тестовой сборке
;   (installer/tests/silent-codes.ps1, init-key.ps1, staged-app.ps1).
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
#if !FileExists(AddBackslash(ClientPayload) + "ETN.exe")
  #undef HaveClientPayload
  #pragma message "ПРЕДУПРЕЖДЕНИЕ: в payload нет client\ETN.exe — файлы клиента не поставляются (задача 98ad5eec)"
#endif

; Ярлыки клиента (задача 98ad5eec): рабочий стол и меню «Пуск». В тестовой
; сборке каталоги уводятся в песочницу теста: прогон silent-codes.ps1 не
; должен трогать настоящий рабочий стол и меню «Пуск» пользователя.
#ifdef TestMode
  #define ShortcutDesktopDir ExtractFileDir(TestAppDir) + "\shortcuts\desktop"
  #define ShortcutMenuDir ExtractFileDir(TestAppDir) + "\shortcuts\menu"
#else
  #define ShortcutDesktopDir "{autodesktop}"
  #define ShortcutMenuDir "{autoprograms}\ETN"
#endif

; ============================================================================
[Setup]
; Идентификатор продукта: по нему Inno ведёт запись установки и обновление
; поверх прежней версии. Менять нельзя — иначе повторный запуск не увидит
; предыдущую установку.
#ifdef TestUninstallable
; Проба настоящего деинсталлятора (installer/tests/silent-codes.ps1, приёмка
; 8b1f5980): у тестовой установки отдельный AppId, чтобы запись установки и
; удаление не касались продуктовой установки на машине. Определяется только
; вместе с TestMode (см. Uninstallable ниже).
AppId={{B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E}
#else
AppId={{6D7E1C2A-4B9A-4E7C-9F3D-2A5B8C1E4F70}
#endif
AppName=ETN
AppVersion={#MyAppVersion}
AppVerName=ETN {#MyAppVersion}
AppPublisher=ETN
; Строка авторских прав: та же, что в VERSIONINFO клиентского exe
; (client/electron-builder.yml, copyright). AppPublisher остаётся ETN.
AppCopyright=© 2026 В. Зайцев (aka Nerkuda)
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
; Первый экран — собственный экран компонентов с приветствием и лицензией
; (требование d75b7988): стандартные страницы приветствия и лицензии Inno не
; используются. Текст лицензии — локальный файл LICENSE в [Files] (dontcopy),
; открывается ссылкой на экране компонентов.
DisableWelcomePage=yes

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
; Тестовая сборка по умолчанию не создаёт деинсталлятор и запись установки в
; реестре: прогон silent-codes.ps1 не должен оставлять следов на машине.
; /DTestUninstallable=1 (только вместе с -TestMode) включает деинсталлятор для
; пробы настоящего удаления с моделью службы (приёмка 8b1f5980): у такой
; сборки отдельный AppId — см. [Setup].
#ifndef TestUninstallable
Uninstallable=no
#endif
#endif
WizardStyle=modern
UninstallDisplayName=ETN {#MyAppVersion}
SetupLogging=yes
UsePreviousAppDir=no
UsePreviousTasks=no

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Files]
; --- Лицензия (MIT): текст открывается локально со ссылки на экране
; --- компонентов; в установку не копируется (dontcopy).
Source: "..\LICENSE"; Flags: dontcopy noencryption

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

[Icons]
; Ярлыки клиента (задача 98ad5eec): рабочий стол и меню «Пуск». Цель зависит
; от области установки — «для всех» ставится в {app}\client привилегированной
; фазой, «только для меня» — в {app} неэлевированной фазы (профиль
; пользователя). Каталоги ярлыков заданы через #define: в тестовой сборке они
; уведены в песочницу. Созданные ярлыки Inno удаляет деинсталлятором сам
; (записи [Icons] попадают в журнал удаления) — отдельного кода не нужно.
#ifdef HaveClientPayload
Name: "{#ShortcutMenuDir}\ETN"; Filename: "{app}\client\ETN.exe"; WorkingDir: "{app}\client"; IconFilename: "{app}\client\ETN.exe"; Comment: "ETN — графовые базы знаний"; Check: InstallClientMachine
Name: "{#ShortcutMenuDir}\ETN"; Filename: "{app}\ETN.exe"; WorkingDir: "{app}"; IconFilename: "{app}\ETN.exe"; Comment: "ETN — графовые базы знаний"; Check: InstallClientUser
Name: "{#ShortcutDesktopDir}\ETN"; Filename: "{app}\client\ETN.exe"; WorkingDir: "{app}\client"; IconFilename: "{app}\client\ETN.exe"; Check: InstallClientMachine
Name: "{#ShortcutDesktopDir}\ETN"; Filename: "{app}\ETN.exe"; WorkingDir: "{app}"; IconFilename: "{app}\ETN.exe"; Check: InstallClientUser
#endif

[Run]
; Точки вызова службы (8b1f5980) живут в [Code]: регистрация — в ssPostInstall
; после записи etn-service.xml, снятие — в CurUninstallStepChanged(usUninstall)
; до удаления файлов. Запуск клиента после установки (98ad5eec) здесь не
; выполняется: его предлагает кнопка итоговой сводки.

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
  { Бэкап БД перед обновлением (ce3ab836): хранятся три последних архива. }
  BACKUPS_KEEP = 3;
  { Длина имени каталога архива: YYYYMMDD-HHmmss (15 символов). }
  BACKUP_DIR_NAME_LEN = 15;
  { Остановка службы WinSW (bb063ac3): после etn-service.exe stop состояние
    опрашивается раз в 250 мс, бюджет — 60 с (stoptimeout в шаблоне службы
    30 с, остальное — запас на медленную остановку node.exe). }
  SERVICE_STOP_WAIT_MS = 60000;
  { Запуск службы WinSW (8b1f5980): после etn-service.exe start ждём перехода
    в RUNNING тем же опросом sc query. Бюджет — 60 с: Node стартует и открывает
    порт до health-check, который идёт следующим шагом. }
  SERVICE_START_WAIT_MS = 60000;
  SERVICE_STOP_STEP_MS = 250;
  { WinSW 2.12.0 при install существующей службы возвращает код
    ERROR_SERVICE_EXISTS (1073): повторная установка не должна падать. }
  ERROR_SERVICE_EXISTS = 1073;
  { Health-check после запуска новой версии (требование 0a79d9de): бюджет
    60 с, повтор каждые 2 с. Тело ответа разбирается, а не только код. }
  HEALTH_WAIT_MS = 60000;
  HEALTH_STEP_MS = 2000;
  { Ветка реестра с записями «Программы и компоненты»: по ней ищется старый
    клиент electron-builder (NSIS) и запись установки Inno. }
  UNINSTALL_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';
  { Ожидание исчезновения записи Uninstall после удаления старого клиента:
    деинсталлятор NSIS с _?= завершается синхронно, но старая версия могла
    проигнорировать параметр и удалять в фоне — запись исчезает с задержкой.
    Опрос — раз в 250 мс, общий бюджет — 2 минуты (112642a4). }
  LEGACY_GONE_WAIT_MS = 120000;
  LEGACY_GONE_STEP_MS = 250;
  { Закрытие запущенного клиента (задача 98ad5eec): сначала мягко (taskkill
    без /F — WM_CLOSE, Electron завершает процесс сам), ожидание выхода 30 с;
    только после таймаута — принудительно (/F /T) и ожидание ещё 15 с.
    Опрос — раз в 250 мс, как у службы и старого клиента. Если процесс не
    завершился и после /F — установка останавливается кодом 20 с причиной. }
  CLIENT_CLOSE_WAIT_MS = 30000;
  CLIENT_KILL_WAIT_MS = 15000;
  CLIENT_POLL_STEP_MS = 250;

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
  { /TESTLAYOUT=1 (ошибка 860def0d): снять раскладку экранов без окон — тест
    проверяет, что подписи не обрезаны (Height не «дельта» AdjustHeight) и не
    налезают друг на друга. }
  GTestLayout: String;
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
  { Хук задачи ce3ab836: прямой прогон бэкапа БД без фаз установки
    (/TESTBACKUP=1|skip); объявлен всегда, сбрасывается в InitializeSetup. }
  GTestBackup: String;
  { Хук задачи 112642a4: подмена найденного старого NSIS-клиента
    (/TESTLEGACY=<версия>|machine:<версия>); в обычной сборке кода нет. }
  GTestLegacy: String;
  { Хук 112642a4 (дефект приёмки): подставной деинсталлятор старого клиента.
    /TESTLEGACYCMD=<exe + аргументы> — вместо реестра и настоящего NSIS-
    деинсталлятора запускается эта команда; /TESTLEGACYSTUCK=<мс> — запись
    Uninstall считается неудалённой указанное время после запуска;
    /TESTLEGACYWAIT=<мс> — бюджет ожидания её исчезновения;
    /TESTLEGACYARGS=1 — вывести вычисленные аргументы деинсталлятора
    (проверка _?= на пути с пробелами). }
  GTestLegacyCmd: String;
  GTestLegacyStuck: String;
  GTestLegacyWait: String;
  GTestLegacyArgs: String;
  { Хуки задачи 98ad5eec: модель запущенного клиента без реальных процессов и
    реальная проверка с фильтром по каталогу. /TESTCLIENTPIDS=<pid,...> —
    процессы считаются запущенными; /TESTCLIENTGONE=<мс> — через сколько
    «выйдут» после мягкого закрытия (по умолчанию сразу); /TESTCLIENTSOFT=none
    — мягкое закрытие не помогает; /TESTCLIENTFORCE=fail — принудительное не
    помогает (код 20); /TESTCLIENTWAIT=<мс> — бюджет ожидания мягкого
    закрытия; /TESTCLIENTREAL=1 — настоящий опрос Get-Process и taskkill,
    /TESTCLIENTPATH=<каталог> — только процессы из этого каталога (по
    умолчанию — каталог программы тестового прогона, чтобы прогон не трогал
    клиент пользователя). }
  GTestClientPids: String;
  GTestClientGone: String;
  GTestClientSoft: String;
  GTestClientForce: String;
  GTestClientWait: String;
  GTestClientReal: String;
  GTestClientPath: String;
  { Состояние модели: процесс ещё жив, мягкое закрытие уже запрошено и момент
    «выхода» после него. }
  GTestClientRunning: Boolean;
  GTestClientSoftIssued: Boolean;
  GTestClientGoneAt: Integer;
  { Пользователь отказался закрывать клиент (отличает отказ от технической
    неудачи: техническую неудачу в родительском процессе исправит попытка в
    привилегированной фазе, отказ — нет). }
  GClientCloseRefused: Boolean;
  { /TESTUSERINSTALL=1 — прогон установки клиента «только для меня» без окон:
    снимает silent-термин для проверки копирования неэлевированной фазой
    (silent-контракт клиент не ставит). }
  GTestUserInstall: String;
  { B3: поведенческие пробы ветки «своя служба» — подмена имени службы для
    CIM-запроса и PID, который считается PID службы (проверка потомков). }
  GTestServiceName: String;
  GTestOwnServicePid: String;
  { Тестовые хуки bb063ac3: служба и health-check без реальной службы Windows
    и без настоящего сервера — подмена исполняемого файла службы, её состояния
    и команд, базового URL health-check, бюджетов ожидания и сбоя отката. }
  GTestServiceCmd: String;
  GTestServiceState: String;
  GTestServiceStop: String;
  GTestServiceStart: String;
  GTestServiceWait: String;
  { Хуки 8b1f5980: регистрация и снятие службы без настоящей службы Windows —
    сбой install/uninstall, отказ уже существующей службы (1073), прямой прогон
    снятия при удалении, а также смоделированное состояние «зарегистрирована/
    работает», которое меняют команды install/uninstall/start/stop. }
  GTestServiceInstall: String;
  GTestServiceUninstall: String;
  GTestUninstallService: String;
  GTestServiceRegistered: Boolean;
  GTestServiceRunning: Boolean;
  { /TESTSERVICEREALFILE=1 — модель службы дополнительно проверяет наличие
    etn-service.exe, как продуктовая ветка RunServiceCommand: проба настоящего
    деинсталлятора ловит путь, вычисленный из пустого GServerDir (приёмка
    4151edf6). /TESTSERVICESTART=pending|<pending-stuck> — смоделированный
    START_PENDING в первых опросах состояния (2) или до таймаута. }
  GTestServiceRealFile: String;
  GTestServicePendingPolls: Integer;
  GTestHealthUrl: String;
  GTestHealthWait: String;
  GTestHealthStep: String;
  GTestRollback: String;

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
  { netsh не создал правило брандмауэра: установка продолжается, но на
    финальном экране GUI показывается предупреждение (в silent — только
    журнал). Флаг ставится в ApplyFirewallRule. }
  GFirewallWarning: Boolean;

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
  { Архив БД, созданный последним вызовом CreateDatabaseBackup ('' — архива
    нет). Вызывающему нужен путь для сообщения об отказе/откате. Откат БД
    восстанавливает только из него: LatestBackupDir — архив прошлых
    обновлений, для автоматического отката он не годится (bb063ac3). }
  GLastBackupDir: String;
  { Причина неудачного бэкапа — для сообщения (сценарий bc7cc846: причина,
    требуемый объём, путь к журналу). }
  GBackupReason: String;
  { Снимок отката текущего обновления (.install\rollback\<timestamp>) и
    последняя причина сбоя health-check для журнала и экрана ошибки. }
  GLastRollbackDir: String;
  GHealthReason: String;

  { Экран компонентов }
  GComponentsPage: TWizardPage;
  GServerCheck: TNewCheckBox;
  GServerStateLabel: TNewStaticText;
  { Что такое сервер и что такое клиент, чем области установки клиента
    отличаются (договорённость ТП; ошибка 860def0d, п.2). }
  GServerHintLabel: TNewStaticText;
  GServerAltLink: TNewLinkLabel;
  GClientCheck: TNewCheckBox;
  GClientStateLabel: TNewStaticText;
  GClientHintLabel: TNewStaticText;
  GScopeHintLabel: TNewStaticText;
  GScopeUserRadio: TNewRadioButton;
  GScopeMachineRadio: TNewRadioButton;
  { Область клиента при обновлении фиксирована: вместо радиокнопок
    показывается текст (ea8e223a, 4a66b7a5; замечание приёмки 98ad5eec). }
  GScopeFixedLabel: TNewStaticText;
  GDataNoteLabel: TNewStaticText;
  GReasonLabel: TNewStaticText;
  { Лицензия MIT (112642a4): чекбокс и ссылка на локальный текст; показываются
    только при первой установке (нет ни сервера, ни клиента). }
  GLicenseCheck: TNewCheckBox;
  GLicenseLink: TNewLinkLabel;
  GLicenseAccepted: Boolean;
  { Уведомление, оставленное после возврата на экран компонентов (отказ UAC,
    ошибка удаления старого клиента): показывается вместо обычной причины и
    сбрасывается при изменении выбора. }
  GComponentsNotice: String;
  { Экран компонентов построен и начальный выбор перенесён в контролы. До этого
    обработчики Checked (Inno вызывает OnClick и при программной установке
    Checked) не должны читать ещё не заполненные контролы (ошибка 860def0d). }
  GComponentsReady: Boolean;
  GDowngradeWarned: Boolean;

  { Прогресс установки: подпись текущего этапа на странице установки. }
  GInstallStage: String;

  { Ошибка установки: причина для экрана ошибки и итоговой сводки. }
  GFailureReason: String;
  GErrorPage: TWizardPage;
  GErrorMemo: TNewMemo;
  GErrorOpenLogButton: TNewButton;
  GErrorRetryButton: TNewButton;
  GErrorOpenDataButton: TNewButton;

  { Итоговая сводка на странице завершения. }
  GSummaryMemo: TNewMemo;
  GSummaryRunButton: TNewButton;
  GSummaryDataButton: TNewButton;
  GSummaryLogButton: TNewButton;
  GKeyWasShown: Boolean;
  GLanIp: String;
  GLanIpChecked: Boolean;

  { Старый клиент, установленный NSIS-установщиком electron-builder. }
  GLegacyClientFound: Boolean;
  GLegacyClientVersion: String;
  GLegacyClientMachine: Boolean;

  { Повышение прав на экране готовности: попытка уже выполнена в этом проходе
    (PrepareToInstall не должен запускать дочерний процесс второй раз). }
  GChildRanThisPass: Boolean;

  { Экраны администратора и ключа }
  GAdminPage: TWizardPage;
  GAdminLoginLabel: TNewStaticText;
  GAdminLoginEdit: TNewEdit;
  GAdminDisplayLabel: TNewStaticText;
  GAdminDisplayEdit: TNewEdit;
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

{ Подогнать высоту подписи под перенос текста. Внимание: AdjustHeight сам
  выставляет Height по тексту и ВОЗВРАЩАЕТ РАЗНИЦУ (Inno: Height - OldHeight);
  присваивать её Height нельзя — подпись сжимается до полосы в несколько
  пикселей и текст обрезается, а на экране «мелькают остатки» (ошибка 860def0d,
  п.1: обрезанные подсказки на всех экранах). }
procedure FitLabel(Lbl: TNewStaticText);
var
  Delta: Integer;
begin
  if Lbl = nil then Exit;
  Delta := Lbl.AdjustHeight;
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
  if GLogPath = '' then
  begin
    { Журнал установщика ещё не создан (InitializeSetup) или это
      деинсталлятор, где InitializeSetup не вызывается и свой журнал создать
      не удалось: строка уходит в журнал Inno (Log), иначе причина отказа
      снятия службы при удалении теряется. }
    Log(RedactLine(Msg));
    Exit;
  end;
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
  begin
    if GClientSelected then
      Result := 'клиент уже установлен — при обновлении он будет заменён'
    else
      Result := 'клиент уже установлен; выберите клиент, чтобы заменить его';
  end
  else if GLegacyClientFound and GClientSelected then
    { Компактно: длинный текст выталкивал нижние подписи за поверхность
      страницы (ошибка 860def0d, п.1). }
    Result := 'найден клиент ETN ' + GLegacyClientVersion +
      ' от старого установщика (NSIS' +
      IfStr(GLegacyClientMachine, ', для всех пользователей', '') +
      ') — перед установкой он будет удалён'
  else if GLegacyClientFound then
    Result := 'найден клиент ETN ' + GLegacyClientVersion +
      ' от старого установщика (NSIS' +
      IfStr(GLegacyClientMachine, ', для всех пользователей', '') +
      '); при установке только сервера он не затрагивается'
  else
    Result := 'не установлен';
end;

{ Область установки клиента при обновлении фиксирована: менять её нельзя
  (ea8e223a, 4a66b7a5 — иначе на машине остались бы файлы и ярлыки старой
  области). Радиокнопки в этом состоянии только сбивают с толку: они видны и
  выглядят доступными, хотя выбор уже сделан (замечание приёмки 98ad5eec),
  поэтому вместо них выводится текст. }
function ClientScopeFixed: Boolean;
begin
  Result := GClientState = 'installed';
end;

function ClientScopeRadiosVisible: Boolean;
begin
  Result := not ClientScopeFixed;
end;

function ClientScopeText: String;
begin
  { Формулировка пользователя (ошибка 860def0d, n5): прямо говорит, в каком
    варианте клиент уже установлен и что сделать, чтобы получить другой, —
    без термина «область установки». }
  if GClientScopeUser then
    Result := 'Клиент установлен в варианте «только для меня». Для установки ' +
      '«для всех» удалите клиента и выполните установку заново.'
  else
    Result := 'Клиент установлен в варианте «для всех пользователей». Для установки ' +
      '«только для меня» удалите клиента и выполните установку заново.';
end;

{ Понятное название режима запуска сервера (ошибка 860def0d, n6): «service» и
  «app» — внутренние значения install.json, обычному пользователю они ничего не
  говорят. Неизвестное значение показываем как есть, чтобы не соврать. }
function ServerModeText(const Mode: String): String;
begin
  if Mode = 'service' then
    Result := 'автоматический запуск в режиме службы Windows'
  else if Mode = 'app' then
    Result := 'ручной запуск сервера как обычного приложения'
  else
    Result := Mode;
end;

{ ---------------------------------------------------------------------------
  Лицензия MIT (112642a4, требование d75b7988).
  --------------------------------------------------------------------------- }
{ Лицензия запрашивается только при первой установке: на машине нет ни
  установленного сервера, ни клиента. Состояние adopt (данные без программы)
  программой не считается — лицензия показывается. }
function LicensePromptNeeded: Boolean;
begin
  Result := ((GServerState = 'not-installed') or (GServerState = 'adopt')) and
    (GClientState <> 'installed');
end;

procedure OpenLocalLicense(Sender: TObject; const Link: String;
  LinkType: TSysLinkType);
var
  Code: Integer;
begin
  { Текст лицензии лежит в самом установщике ([Files] dontcopy) и
    распаковывается во временный каталог: интернет не нужен. }
  try
    ExtractTemporaryFile('LICENSE');
  except
    LogLine('ERROR', 'Не удалось извлечь текст лицензии LICENSE из установщика');
    SuppressibleMsgBox('Не удалось открыть текст лицензии. Он находится в файле ' +
      'LICENSE рядом с установщиком.', mbError, MB_OK, IDOK);
    Exit;
  end;
  if not ShellExec('open', ExpandConstant('{tmp}\LICENSE'), '', '',
    SW_SHOWNORMAL, ewNoWait, Code) then
    SuppressibleMsgBox('Не удалось открыть текст лицензии во временном каталоге: ' +
      ExpandConstant('{tmp}\LICENSE'), mbError, MB_OK, IDOK);
end;

{ ---------------------------------------------------------------------------
  Старый клиент NSIS (electron-builder): обнаружение и удаление (112642a4).
  --------------------------------------------------------------------------- }
{ Признак записи electron-builder/NSIS: DisplayName начинается с «ETN » и
  UninstallString указывает на «Uninstall ETN.exe». Запись самого Inno
  (суффикс _is1) исключается: её удаляет штатный деинсталлятор. }
function IsLegacyClientKey(const SubKeyName, DisplayName,
  UninstallCmd: String): Boolean;
begin
  Result := False;
  if Pos('_is1', SubKeyName) > 0 then Exit;
  if Pos('ETN', DisplayName) <> 1 then Exit;
  if Pos('Uninstall ETN.exe', UninstallCmd) <= 0 then Exit;
  Result := True;
end;

function FindLegacyClientInRoot(const Root: Integer; const UninstallKey: String;
  var Version, UninstallCmd, SubKeyName: String): Boolean;
var
  Names: TArrayOfString;
  I: Integer;
  Key, DisplayName, Cmd, Ver: String;
begin
  Result := False;
  SubKeyName := '';
  if not RegGetSubkeyNames(Root, UninstallKey, Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
  begin
    Key := UninstallKey + '\' + Names[I];
    DisplayName := '';
    Cmd := '';
    if not RegQueryStringValue(Root, Key, 'DisplayName', DisplayName) then Continue;
    if not RegQueryStringValue(Root, Key, 'UninstallString', Cmd) then Continue;
    if not IsLegacyClientKey(Names[I], DisplayName, Cmd) then
      Continue;
    Ver := '';
    RegQueryStringValue(Root, Key, 'DisplayVersion', Ver);
    Version := Ver;
    UninstallCmd := Cmd;
    SubKeyName := Names[I];
    Result := True;
    Exit;
  end;
end;

{ Ищет старый клиент: сначала запись текущего пользователя (HKCU), затем
  машинную (HKLM64/HKLM). IsMachine=True — запись «для всех пользователей».
  Root и SubKeyName — где именно найдена запись: по ним удаление убеждается,
  что после деинсталлятора она действительно исчезла (112642a4). }
function FindLegacyClientEx(var Version, UninstallCmd: String;
  var IsMachine: Boolean; var Root: Integer; var SubKeyName: String): Boolean;
begin
  Version := '';
  UninstallCmd := '';
  IsMachine := False;
  Root := 0;
  SubKeyName := '';
  Result := FindLegacyClientInRoot(HKCU, UNINSTALL_KEY, Version, UninstallCmd,
    SubKeyName);
  if Result then
  begin
    Root := HKCU;
    Exit;
  end;
  Result := FindLegacyClientInRoot(HKLM64, UNINSTALL_KEY, Version, UninstallCmd,
    SubKeyName);
  if Result then
  begin
    Root := HKLM64;
    IsMachine := True;
    Exit;
  end;
  Result := FindLegacyClientInRoot(HKLM, UNINSTALL_KEY, Version, UninstallCmd,
    SubKeyName);
  if Result then
  begin
    Root := HKLM;
    IsMachine := True;
  end;
end;

function FindLegacyClient(var Version, UninstallCmd: String;
  var IsMachine: Boolean): Boolean;
var
  Root: Integer;
  SubKeyName: String;
begin
  Result := FindLegacyClientEx(Version, UninstallCmd, IsMachine, Root, SubKeyName);
end;

{ Путь к exe из командной строки деинсталлятора: строка в кавычках или до
  первого пробела. }
function UninstallerExe(const Cmd: String): String;
var
  P: Integer;
begin
  Result := Trim(Cmd);
  if (Result <> '') and (Result[1] = '"') then
  begin
    P := Pos('"', Copy(Result, 2, Length(Result)));
    if P > 0 then
      Result := Copy(Result, 2, P - 1)
    else
      Result := Copy(Result, 2, Length(Result));
  end
  else
  begin
    P := Pos(' ', Result);
    if P > 0 then Result := Copy(Result, 1, P - 1);
  end;
end;

{ Аргументы деинсталлятора без пути: сохраняются (/currentuser, /allusers),
  добавляется /S — тихий режим NSIS — и _?=<каталог деинсталлятора>.
  Без _?= NSIS-деинсталлятор копирует себя в %TEMP%, запускает копию и сразу
  возвращает управление: установщик продолжил бы копирование файлов, пока
  удаление ещё идёт, и фоновый деинсталлятор снёс бы только что скопированное
  (дефект приёмки 112642a4). _?= обязан быть последним параметром и не
  заключается в кавычки — даже если путь содержит пробелы (документация NSIS,
  раздел 3.2.2). }
function UninstallerArgs(const Cmd: String): String;
var
  Exe: String;
  Rest: String;
begin
  Exe := UninstallerExe(Cmd);
  Rest := Trim(Cmd);
  if (Rest <> '') and (Rest[1] = '"') then
    Rest := Trim(Copy(Rest, Length(Exe) + 3, Length(Rest)))
  else
    Rest := Trim(Copy(Rest, Length(Exe) + 1, Length(Rest)));
  if Pos('/S', UpperCase(Rest)) = 0 then
    Rest := Trim(Rest + ' /S');
  Result := Rest + ' _?=' + ExtractFileDir(Exe);
end;

{ Запись Uninstall удаляемого клиента ещё существует? В тестовом режиме
  (/TESTLEGACYSTUCK=<мс>) запись считается существующей, пока не истекло
  заданное время ожидания: ElapsedMs — сколько уже прошло по шагам опроса.
  Так цикл ожидания проверяется без настоящего NSIS-деинсталлятора. }
function LegacyRecordGone(const Root: Integer; const SubKeyName: String;
  const ElapsedMs: Integer): Boolean;
begin
  Result := True;
#ifdef TestMode
  if GTestMode and (GTestLegacyCmd <> '') then
  begin
    Result := ElapsedMs >= StrToIntDef(GTestLegacyStuck, 0);
    Exit;
  end;
#endif
  if Root = 0 then Exit;
  Result := not RegKeyExists(Root, UNINSTALL_KEY + '\' + SubKeyName);
end;

function LegacyGoneWaitMs: Integer;
begin
  Result := LEGACY_GONE_WAIT_MS;
#ifdef TestMode
  if GTestMode and (GTestLegacyWait <> '') then
    Result := StrToIntDef(GTestLegacyWait, Result);
#endif
end;

{ Ждёт исчезновения записи Uninstall после деинсталлятора: даже с _?= старая
  версия могла вернуть управление раньше фактического конца удаления.
  Возвращает True, когда записи нет (или удалять было нечего). }
function WaitLegacyRecordGone(const Root: Integer; const SubKeyName: String;
  const WaitMs: Integer; var WaitedMs: Integer): Boolean;
begin
  WaitedMs := 0;
  if LegacyRecordGone(Root, SubKeyName, WaitedMs) then
  begin
    Result := True;
    Exit;
  end;
  while WaitedMs < WaitMs do
  begin
    Sleep(LEGACY_GONE_STEP_MS);
    WaitedMs := WaitedMs + LEGACY_GONE_STEP_MS;
    if LegacyRecordGone(Root, SubKeyName, WaitedMs) then
    begin
      Result := True;
      Exit;
    end;
  end;
  Result := LegacyRecordGone(Root, SubKeyName, WaitedMs);
end;

function RunLegacyUninstaller(const Cmd, Version: String; const Root: Integer;
  const SubKeyName: String): Boolean;
var
  Exe, Args: String;
  Code, WaitedMs: Integer;
begin
  Result := False;
  Exe := UninstallerExe(Cmd);
  if (Exe = '') or (not FileExists(Exe)) then
  begin
    LogLine('ERROR', 'Старый клиент ETN ' + Version + ': деинсталлятор не найден: ' + Exe);
    Exit;
  end;
  Args := UninstallerArgs(Cmd);
  LogLine('INFO', 'Старый клиент ETN ' + Version + ': запуск деинсталлятора ' +
    Exe + ' ' + Args);
  { ewWaitUntilTerminated + _?=: деинсталлятор работает из своего каталога и
    не возвращает управление до фактического конца удаления. }
  if not Exec(Exe, Args, ExtractFileDir(Exe), SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    LogLine('ERROR', 'Старый клиент ETN ' + Version + ': деинсталлятор не запустился');
    Exit;
  end;
  if Code <> 0 then
  begin
    LogLine('ERROR', 'Старый клиент ETN ' + Version +
      ': деинсталлятор вернул код ' + IntToStr(Code));
    Exit;
  end;
  if not WaitLegacyRecordGone(Root, SubKeyName, LegacyGoneWaitMs, WaitedMs) then
  begin
    LogLine('ERROR', 'Старый клиент ETN ' + Version +
      ': запись Uninstall не исчезла за ' + IntToStr(LegacyGoneWaitMs) +
      ' мс после деинсталлятора');
    Exit;
  end;
  LogLine('INFO', 'Старый клиент ETN ' + Version + ' удалён (ожидание записи ' +
    IntToStr(WaitedMs) + ' мс)');
  Result := True;
end;

#ifdef TestMode
{ Подставной деинсталлятор (дефект приёмки 112642a4): та же последовательность
  «запустить и дождаться, проверить код, дождаться исчезновения записи», но
  команда задана хуком /TESTLEGACYCMD — на машине разработчика настоящий
  NSIS-клиент не удаляется. }
function RunLegacyTestRemoval(var Reason: String): Boolean;
var
  Exe, Args: String;
  Code, WaitedMs: Integer;
begin
  Result := False;
  Reason := '';
  Exe := UninstallerExe(GTestLegacyCmd);
  Args := Trim(Copy(GTestLegacyCmd, Length(Exe) + 1, Length(GTestLegacyCmd)));
  LogLine('INFO', 'TESTLEGACYCMD: подставной деинсталлятор запущен: ' + Exe + ' ' + Args);
  if not Exec(Exe, Args, '', SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Reason := 'не удалось удалить старый клиент ETN: подставной деинсталлятор ' +
      'не запустился (' + Exe + ').';
    LogLine('ERROR', 'TESTLEGACYCMD result=fail reason=start');
    Exit;
  end;
  LogLine('INFO', 'TESTLEGACYCMD: подставной деинсталлятор завершился, код ' +
    IntToStr(Code));
  if Code <> 0 then
  begin
    Reason := 'не удалось удалить старый клиент ETN его деинсталлятором (код ' +
      IntToStr(Code) + '). Удалите его вручную в «Программы и компоненты» ' +
      'и повторите установку.';
    LogLine('ERROR', 'TESTLEGACYCMD result=fail exit_code=' + IntToStr(Code));
    Exit;
  end;
  if not WaitLegacyRecordGone(0, 'TEST', LegacyGoneWaitMs, WaitedMs) then
  begin
    Reason := 'старый клиент ETN не удалён: запись установки не исчезла за ' +
      IntToStr(LegacyGoneWaitMs) + ' мс после деинсталлятора. Удалите его ' +
      'вручную в «Программы и компоненты» и повторите установку.';
    LogLine('ERROR', 'TESTLEGACYCMD result=fail wait_ms=' + IntToStr(WaitedMs) +
      ' exit_code=' + IntToStr(Code));
    Exit;
  end;
  LogLine('INFO', 'TESTLEGACYCMD result=ok wait_ms=' + IntToStr(WaitedMs) +
    ' exit_code=' + IntToStr(Code));
  Result := True;
end;
#endif

{ Удаляет найденные старые клиенты в доступной области (IncludeMachine —
  только в элевированном процессе). Возвращает True, если удалять было нечего
  или удаление прошло успешно. }
function RemoveLegacyClients(const IncludeMachine: Boolean;
  var FailReason: String): Boolean;
var
  Version, Cmd, SubKeyName: String;
  IsMachine: Boolean;
  Root: Integer;
begin
  Result := True;
  FailReason := '';
  if not FindLegacyClientEx(Version, Cmd, IsMachine, Root, SubKeyName) then Exit;
  if IsMachine and (not IncludeMachine) then
  begin
    FailReason := 'старый клиент ETN ' + Version +
      ' установлен для всех пользователей: для его удаления нужны права ' +
      'администратора. Выберите установку клиента «Для всех пользователей» ' +
      'или удалите старую версию вручную в «Программы и компоненты».';
    Result := False;
    Exit;
  end;
  if not RunLegacyUninstaller(Cmd, Version, Root, SubKeyName) then
  begin
    FailReason := 'не удалось удалить старый клиент ETN ' + Version +
      ' его деинсталлятором. Удалите его вручную в «Программы и компоненты» ' +
      'и повторите установку.';
    Result := False;
  end;
end;

{ Состояние старого клиента для экрана компонентов: запись установщика
  electron-builder (NSIS) ищется до первого показа экрана. Silent и
  привилегированная фаза ничего не показывают — им состояние не нужно. }
procedure DetectLegacyClient;
var
  Cmd: String;
begin
  GLegacyClientFound := False;
  GLegacyClientVersion := '';
  GLegacyClientMachine := False;
#ifdef TestMode
  if GTestMode then
  begin
    if GTestLegacy <> '' then
    begin
      GLegacyClientFound := True;
      if Pos('machine:', LowerCase(GTestLegacy)) = 1 then
      begin
        GLegacyClientMachine := True;
        GLegacyClientVersion := Copy(GTestLegacy, 9, Length(GTestLegacy));
      end
      else
        GLegacyClientVersion := GTestLegacy;
      LogLine('WARN', 'TESTLEGACY=' + GTestLegacy +
        ': старый клиент NSIS подменён (тестовый режим)');
    end;
    Exit;
  end;
#endif
  if GSilent or GPrivilegedPhase then Exit;
  Cmd := '';
  if FindLegacyClient(GLegacyClientVersion, Cmd, GLegacyClientMachine) then
  begin
    GLegacyClientFound := True;
    LogLine('INFO', 'Найден старый клиент ETN ' + GLegacyClientVersion +
      ' (NSIS, ' + Pick(GLegacyClientMachine, 'для всех пользователей',
      'для текущего пользователя') + ') — будет удалён перед установкой');
  end;
end;

{ Удаление старого клиента перед установкой нового (только при выбранном
  клиенте). В неэлевированном процессе удаляется запись текущего пользователя;
  машинную запись удаляет привилегированная фаза — в GUI её вызов идёт до
  показа экрана готовности. Возвращает False только когда удаление обязательно
  и не удалось. }
function RemoveLegacyBeforeInstall(const Elevated: Boolean;
  var Reason: String): Boolean;
var
  Version, Cmd: String;
  IsMachine: Boolean;
begin
  Result := True;
  Reason := '';
  { Старый клиент удаляется только когда клиент выбран: установка одного
    сервера чужой клиент не трогает. Проверка стоит до тестовой ветки, чтобы
    /TESTLEGACYCMD повторял реальный маршрут. }
  if not GClientSelected then Exit;
  { Тестовая сборка не должна запускать деинсталлятор настоящего клиента на
    машине разработчика: удаление выполняется только через подставную команду
    /TESTLEGACYCMD; без неё удаление не выполняется. }
#ifdef TestMode
  if GTestMode then
  begin
    if GTestLegacyCmd <> '' then
      Result := RunLegacyTestRemoval(Reason);
    Exit;
  end;
#endif
  if not FindLegacyClient(Version, Cmd, IsMachine) then Exit;
  if IsMachine and (not Elevated) then
  begin
    LogLine('INFO', 'Старый клиент ETN ' + Version + ' установлен для всех ' +
      'пользователей: удаление выполнит привилегированная фаза');
    Exit;
  end;
  if IsMachine then
    Result := RemoveLegacyClients(True, Reason)
  else
    Result := RemoveLegacyClients(False, Reason);
  if Result then
    GLegacyClientFound := False;
end;

{ ---------------------------------------------------------------------------
  Закрытие запущенного клиента (задача 98ad5eec).
  --------------------------------------------------------------------------- }
{ Список PID из вывода PowerShell: только цифры, через запятую. }
function PidsFromText(const Text: String): String;
var
  I: Integer;
  Token: String;
begin
  Result := '';
  Token := '';
  for I := 1 to Length(Text) do
  begin
    if (Text[I] >= '0') and (Text[I] <= '9') then
      Token := Token + Text[I]
    else
    begin
      if Token <> '' then
      begin
        if Result <> '' then Result := Result + ',';
        Result := Result + Token;
        Token := '';
      end;
    end;
  end;
  if Token <> '' then
  begin
    if Result <> '' then Result := Result + ',';
    Result := Result + Token;
  end;
end;

{ Каталог установки клиента по области: «только для меня» — профиль
  пользователя (%LOCALAPPDATA%\Programs\ETN), «для всех» — Program Files.
  Показывается на экране компонентов и ограничивает поиск запущенного клиента:
  каталог фиксирован ADR 144bcdb0, но область установки пользователь выбирает
  сам. }
function ClientInstallPath: String;
begin
#ifdef TestMode
  Result := GServerDir;
#else
  if GClientScopeUser then
    Result := ExpandConstant('{localappdata}') + '\Programs\ETN'
  else
    Result := ExpandConstant('{commonpf}') + '\ETN';
#endif
end;

{ Каталог, процессы которого заменяет этот экземпляр установщика: закрываем
  только клиента из своей области установки. Get-Process по имени ETN.exe без
  фильтра закрывал любые процессы ETN.exe на машине — при per-user установке
  это живой клиент другого пользователя: 30+15 с ожидания и код 20 (замечание
  приёмки 98ad5eec). В привилегированной фазе пользовательский клиент не
  устанавливается, а каталог локальных приложений там — профиль администратора:
  чужие профили не трогаем. }
function ClientCloseRoot: String;
begin
  Result := '';
  if GClientScopeUser and GPrivilegedPhase then Exit;
  Result := ClientInstallPath;
end;

{ Настоящий опрос: Get-Process по имени ETN.exe, но только процессы из каталога
  установки (Product: ClientCloseRoot; TestMode: /TESTCLIENTPATH, по умолчанию
  каталог программы тестового прогона) — чужой клиент не трогается. PowerShell
  получает скрипт в двойных кавычках: внутри только одинарные (грабли B3
  приёмки 9b310991). }
function RealClientPids: String;
var
  Script, Args, OutFile, OutFileLiteral, Filter: String;
  Code: Integer;
  Raw: AnsiString;
begin
  Result := '';
  OutFile := ExpandConstant('{tmp}') + '\etn-client-pids.txt';
  DeleteFile(OutFile);
  OutFileLiteral := OutFile;
  StringChangeEx(OutFileLiteral, '''', '''''', True);
  Filter := '';
#ifdef TestMode
  { Тестовая сборка может задать каталог явно (/TESTCLIENTPATH); иначе —
    общий продуктовый фильтр по области установки (в тестовой сборке это
    каталог программы теста). }
  Filter := GTestClientPath;
#endif
  if Filter = '' then
    Filter := ClientCloseRoot;
  if Filter = '' then
  begin
    LogLine('INFO', 'Клиент ETN: процессов вне области установки не ищем — закрывать нечего');
    Exit;
  end;
  { Префикс с завершающим '\': иначе 'C:\Program Files\ETN' совпал бы с
    'C:\Program Files\ETN2\ETN.exe'. }
  if Copy(Filter, Length(Filter), 1) <> '\' then
    Filter := Filter + '\';
  StringChangeEx(Filter, '''', '''''', True);
  Script :=
    '$ids=@(Get-Process -Name ''ETN''|ForEach-Object{$p=$_;$path='''';' +
    'try{$path=$p.Path}catch{};' +
    'if($path.StartsWith(''' + Filter + ''',' +
    '[System.StringComparison]::OrdinalIgnoreCase)){$p.Id}});' +
    '[IO.File]::WriteAllText(''' + OutFileLiteral + ''',($ids -join [Environment]::NewLine))';
  Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Args, '',
    SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    LogLine('WARN', 'Клиент ETN: не удалось запустить PowerShell для поиска процессов');
    Exit;
  end;
  Raw := '';
  if FileExists(OutFile) and LoadStringFromFile(OutFile, Raw) then
    Result := PidsFromText(Utf8Decode(Raw));
  DeleteFile(OutFile);
end;

{ Процессы клиента, которые нужно закрыть. В тестовой сборке — модель:
  реальные процессы машины не трогаются, если не задан /TESTCLIENTREAL=1. }
function ClientPidsRunning: String;
begin
#ifdef TestMode
  if GTestClientPids <> '' then
  begin
    if GTestClientRunning then
      Result := GTestClientPids
    else
      Result := '';
    Exit;
  end;
  { Без /TESTCLIENTREAL=1 тестовая сборка процессы машины не опрашивает и не
    закрывает: только модель /TESTCLIENTPIDS. }
  if GTestClientReal <> '1' then
  begin
    Result := '';
    Exit;
  end;
#endif
  Result := RealClientPids;
end;

function ClientCloseWaitMs: Integer;
begin
  Result := CLIENT_CLOSE_WAIT_MS;
#ifdef TestMode
  if GTestClientWait <> '' then
    Result := StrToIntDef(GTestClientWait, CLIENT_CLOSE_WAIT_MS);
#endif
end;

{ Ожидание выхода процессов: опрос раз в 250 мс, бюджет WaitMs. В модели
  момент выхода задаёт /TESTCLIENTGONE — время отсчитывается от мягкого
  закрытия, реальный Sleep не нужен (прогон не длится 30 секунд). }
function WaitClientProcessesGone(const WaitMs: Integer; var WaitedMs: Integer): Boolean;
var
  Elapsed: Integer;
begin
  Elapsed := 0;
  repeat
    if ClientPidsRunning = '' then
    begin
      WaitedMs := Elapsed;
      Result := True;
      Exit;
    end;
    if Elapsed >= WaitMs then Break;
#ifdef TestMode
    if GTestClientPids = '' then
      Sleep(CLIENT_POLL_STEP_MS);
    if (GTestClientPids <> '') and GTestClientSoftIssued and
       (GTestClientSoft <> 'none') and
       (Elapsed + CLIENT_POLL_STEP_MS >= GTestClientGoneAt) then
      GTestClientRunning := False;
#else
    Sleep(CLIENT_POLL_STEP_MS);
#endif
    Elapsed := Elapsed + CLIENT_POLL_STEP_MS;
  until False;
  WaitedMs := Elapsed;
  Result := False;
end;

{ Один PID из списка и остаток списка. }
function TakePid(var List: String): String;
var
  P: Integer;
begin
  P := Pos(',', List);
  if P > 0 then
  begin
    Result := Copy(List, 1, P - 1);
    List := Copy(List, P + 1, Length(List) - P);
  end
  else
  begin
    Result := List;
    List := '';
  end;
end;

function RunTaskkill(const Params: String; const Soft: Boolean): Boolean;
var
  Code: Integer;
begin
  Code := -1;
  Result := Exec(ExpandConstant('{sys}\taskkill.exe'), Params, '', SW_HIDE,
    ewWaitUntilTerminated, Code) and (Code = 0);
  LogLine(Pick(Result, 'INFO', 'WARN'), 'Клиент ETN: taskkill ' +
    IfStr(Soft, 'без /F', '/F') + ' ' + Params + ' — код ' + IntToStr(Code));
end;

procedure SoftCloseClientPids(const Pids: String);
var
  Rest, Pid: String;
begin
#ifdef TestMode
  if GTestClientPids <> '' then
  begin
    GTestClientSoftIssued := True;
    LogLine('INFO', 'Клиент ETN: мягкое закрытие (модель, PID ' + Pids + ')');
    Exit;
  end;
#endif
  Rest := Pids;
  while Rest <> '' do
  begin
    Pid := TakePid(Rest);
    if Pid <> '' then
      RunTaskkill('/PID ' + Pid, True);
  end;
end;

procedure ForceCloseClientPids(const Pids: String);
var
  Rest, Pid: String;
begin
#ifdef TestMode
  if GTestClientPids <> '' then
  begin
    LogLine('WARN', 'Клиент ETN: принудительное закрытие (модель, PID ' + Pids + ')');
    if GTestClientForce <> 'fail' then
      GTestClientRunning := False;
    Exit;
  end;
#endif
  Rest := Pids;
  while Rest <> '' do
  begin
    Pid := TakePid(Rest);
    if Pid <> '' then
      RunTaskkill('/F /PID ' + Pid + ' /T', False);
  end;
end;

{ Закрытие запущенного клиента перед заменой файлов. Interactive — показать
  пользователю предупреждение и спросить согласие (только GUI). Возвращает
  False с причиной, если клиент не закрыт: вызывающий останавливает установку
  кодом 20, файлы не заменяются. }
function CloseRunningClient(const Interactive: Boolean; var Reason: String): Boolean;
var
  Pids, Remaining: String;
  WaitedMs: Integer;
begin
  Result := True;
  Reason := '';
  GClientCloseRefused := False;
  Pids := ClientPidsRunning;
  if Pids = '' then
  begin
    LogLine('INFO', 'Клиент ETN: запущенных процессов не найдено');
    Exit;
  end;
  LogLine('INFO', 'Клиент ETN: запущено процессов ETN.exe — ' + Pids);
  if Interactive and (not GSilent) then
  begin
    if SuppressibleMsgBox('Клиент ETN запущен. Чтобы заменить файлы, его нужно ' +
        'закрыть — несохранённые данные могут быть потеряны.' + #13#10#13#10 +
        'Закрыть клиент и продолжить установку?',
        mbConfirmation, MB_YESNO, IDYES) <> IDYES then
    begin
      LogLine('WARN', 'Клиент ETN: пользователь отказался закрывать клиент');
      Reason := 'клиент ETN не закрыт: пользователь отказался закрыть запущенный клиент';
      GClientCloseRefused := True;
      Result := False;
      Exit;
    end;
  end;
  LogLine('INFO', 'Клиент ETN: мягкое закрытие (taskkill без /F)');
  SoftCloseClientPids(Pids);
  if WaitClientProcessesGone(ClientCloseWaitMs, WaitedMs) then
  begin
    LogLine('INFO', 'Клиент ETN: закрыт мягко за ' + IntToStr(WaitedMs) + ' мс');
    Exit;
  end;
  Remaining := ClientPidsRunning;
  LogLine('WARN', 'Клиент ETN: за ' + IntToStr(ClientCloseWaitMs) +
    ' мс не закрылся — принудительное закрытие (taskkill /F)' +
    IfStr(Remaining = '', '', ', PID ' + Remaining));
  ForceCloseClientPids(Remaining);
  if WaitClientProcessesGone(CLIENT_KILL_WAIT_MS, WaitedMs) then
  begin
    LogLine('INFO', 'Клиент ETN: принудительно закрыт за ' + IntToStr(WaitedMs) + ' мс');
    Exit;
  end;
  Reason := 'клиент ETN не закрыт: процессы ETN.exe не завершились даже после ' +
    'принудительного закрытия';
  LogLine('ERROR', Reason);
  Result := False;
end;

{ ---------------------------------------------------------------------------
  Прогресс и ошибки установки (112642a4).
  --------------------------------------------------------------------------- }
procedure SetInstallStage(const Stage: String);
begin
  GInstallStage := Stage;
  { Этап пишется в журнал всегда: при двухфазном UAC видимый процесс —
    родительский, а привилегированная фаза silent; журнал остаётся
    единственным следом каждого этапа. }
  LogLine('INFO', 'Этап: ' + Stage);
  if GSilent then Exit;
  if (WizardForm <> nil) and (WizardForm.StatusLabel <> nil) then
  begin
    WizardForm.StatusLabel.Caption := Stage;
    WizardForm.StatusLabel.Update;
    if WizardForm.FilenameLabel <> nil then
      WizardForm.FilenameLabel.Caption := '';
    WizardForm.Update;
  end;
end;

procedure WriteReasonFile(const Text: String);
begin
  { Причина отказа — родителю в двухфазном UAC. Файл тот же, что у
    предусловий (GReasonFile), и читается по любому ненулевому коду дочернего
    процесса. Перезаписывается после отката: родитель должен увидеть не
    только причину, но и итог отката (bb063ac3). }
  if GReasonFile <> '' then
    SaveStringToFile(GReasonFile, Utf8Encode(Text), False);
end;

{ Сбой после замены файлов с нестандартным кодом контракта (8b1f5980:
  регистрация службы — код 20). В отличие от FailPrecondition не выходит
  немедленно: вызывающий доводит установку до общего пути — откат (если снимок
  есть), причина в файл для родителя, install.json не пишется. }
procedure FailInstallWithCode(const Code: Integer; const Reason: String);
begin
  GExitCode := Code;
  if GFailureReason = '' then GFailureReason := Reason;
  LogLine('ERROR', 'Сбой: ' + Reason + ' (код ' + IntToStr(Code) + ')');
  { Причина сбоя — родителю в двухфазном UAC: иначе он покажет только код.
    После отката файл перезаписывается полным текстом (WriteReasonFile). }
  WriteReasonFile(Reason);
end;

procedure FailInstall(const Reason: String);
begin
  FailInstallWithCode(EXIT_FAILED, Reason);
end;

{ ---------------------------------------------------------------------------
  Пути для итоговой сводки и экрана ошибки (112642a4).
  --------------------------------------------------------------------------- }
function ClientExePath: String;
begin
  Result := '';
  if FileExists(GServerDir + '\ETN.exe') then
    Result := GServerDir + '\ETN.exe'
  else if FileExists(GServerDir + '\client\ETN.exe') then
    Result := GServerDir + '\client\ETN.exe'
  else if (MachineAppDir <> '') and
    FileExists(MachineAppDir + '\client\ETN.exe') then
    Result := MachineAppDir + '\client\ETN.exe'
  else if (MachineAppDir <> '') and FileExists(MachineAppDir + '\ETN.exe') then
    Result := MachineAppDir + '\ETN.exe';
end;

{ Каталог установки клиента по области: «только для меня» — профиль
  пользователя (%LOCALAPPDATA%\Programs\ETN), «для всех» — Program Files.
  Определена рядом с поиском запущенного клиента: по ней ограничивается
  закрытие процессов ETN.exe. }
procedure OpenPath(const Path: String);
var
  Code: Integer;
begin
  if Path = '' then Exit;
  if not ShellExec('open', Path, '', '', SW_SHOWNORMAL, ewNoWait, Code) then
    SuppressibleMsgBox('Не удалось открыть: ' + Path + #13#10 +
      'Путь можно скопировать из поля на экране.', mbError, MB_OK, IDOK);
end;

procedure OpenServerOptions(Sender: TObject; const Link: String;
  LinkType: TSysLinkType);
begin
  OpenPath('https://github.com/nerkuda/e-tho-net/blob/main/docs/userdocs/install.md');
end;

{ Первый IPv4-адрес машины в локальной сети. Нужен для адреса в итоговой
  сводке при открытом брандмауэре; если узнать не удалось — пустая строка,
  сводка покажет только локальный адрес. }
function DetectLanIp: String;
var
  Script, Args, OutFile, OutFileLiteral: String;
  Code: Integer;
  Raw: AnsiString;
begin
  Result := '';
  if GLanIpChecked then
  begin
    Result := GLanIp;
    Exit;
  end;
  GLanIpChecked := True;
  OutFile := ExpandConstant('{tmp}') + '\etn-lan-ip.txt';
  OutFileLiteral := OutFile;
  StringChangeEx(OutFileLiteral, '''', '''''', True);
  { Внутри скрипта только одинарные кавычки: -Command передаётся в двойных
    (см. ServerPortStatus, дефект B3 приёмки 9b310991). Виртуальные адаптеры
    (Hyper-V, VMware/VirtualBox, VPN/TAP/WireGuard, Tailscale/ZeroTier)
    исключаются: их адрес не виден другим компьютерам сети (замечание приёмки
    112642a4). Если физических адресов не осталось, берётся лучший из всех —
    иначе на машине с единственным виртуальным адаптером сводка теряла бы
    адрес вовсе. }
  Script :=
    '$ErrorActionPreference=''SilentlyContinue'';' +
    '$all=Get-NetIPAddress -AddressFamily IPv4|' +
    'Where-Object{$_.IPAddress -notlike ''127.*'' -and ' +
    '$_.IPAddress -notlike ''169.254.*''};' +
    '$phys=$all|Where-Object{' +
    '$_.InterfaceAlias -notmatch ''vEthernet|Loopback|VPN|TAP|Tun|Tailscale|ZeroTier'' -and ' +
    '$_.InterfaceDescription -notmatch ' +
    '''Hyper-V|Virtual|VMware|VirtualBox|VPN|TAP|Tun|WireGuard|Tailscale|ZeroTier|Loopback''};' +
    '$ip=$phys|Sort-Object InterfaceMetric|Select-Object -First 1 -ExpandProperty IPAddress;' +
    'if(-not $ip){$ip=$all|Sort-Object InterfaceMetric|Select-Object -First 1 -ExpandProperty IPAddress};' +
    'if($ip){[IO.File]::WriteAllText(''' + OutFileLiteral + ''',$ip)}';
  Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + Script + '"';
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Args, '',
    SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0) and FileExists(OutFile) then
  begin
    Raw := '';
    if LoadStringFromFile(OutFile, Raw) then
      Result := Trim(Utf8Decode(Raw));
    DeleteFile(OutFile);
  end;
  if Result = '' then
    LogLine('WARN', 'Не удалось определить IPv4-адрес машины для итоговой сводки');
  GLanIp := Result;
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
  ETN_DATA_DIR/ETN_PORT/ETN_HOST, что и служба. ETN_DEPLOYMENT здесь не
  выставляется: он описывает тип запуска, а не раскладку, и задаётся ровно в
  одном месте — шаблоном службы service\etn-service.xml (windows-service).
  Иначе app-режим унаследовал бы чужой режим (ошибка e375123f). }
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
#ifdef TestMode
  { Настоящая служба рабочей машины не читается: состояние задаёт хук
    /TESTSERVICE=present|absent, дальше его меняют смоделированные команды
    install/uninstall. Без хука тестовая сборка службу не видит и не трогает. }
  Result := (GTestService <> '') and GTestServiceRegistered;
#else
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\' + SERVICE_NAME);
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
  { Причина отказа — из файла, который записал дочерний процесс: сообщение
    об ошибке должно называть причину, а не отправлять в журнал. }
  if Code <> 0 then
  begin
    { Причина — UTF-8: файл читают и установщик (сообщение пользователю), и
      тесты, независимо от системной кодовой страницы. Пишется и предусловием
      (код 20), и сбоем (код 10) — родитель покажет причину, а не только код. }
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

{ ---------------------------------------------------------------------------
  Служба ETN (WinSW) — остановка и запуск, задача bb063ac3.

  Служба останавливается до копирования файлов: иначе занятые node.exe,
  better-sqlite3 и файлы сервера не заменить. После команды stop состояние
  опрашивается через sc query, пока служба не окажется STOPPED: WinSW мог
  вернуть управление раньше фактической остановки дочернего node.exe.
  В тестовой сборке управление службой подменяется хуками — настоящая служба
  Windows не нужна.
  --------------------------------------------------------------------------- }
(* Каталог программы для операций со службой. В деинсталляторе Inno не вызывает
  InitializeSetup, и GServerDir остаётся пустым, поэтому путь берётся из {app}
  по месту — как в UninstallFirewallRuleWanted. Раньше путь вычислялся только
  из GServerDir, и снятие службы при удалении не работало (блокер приёмки
  4151edf6). В установке каталог уже вычислен (GServerDir = {app}), а
  ExpandConstant('{app}') до инициализации мастера недоступен — пробу снятия
  (/TESTUNINSTALLSERVICE) вызывает InitializeSetup. *)
function ServiceDir: String;
begin
  Result := GServerDir;
  if Result = '' then
    Result := ExpandConstant('{app}');
end;

function ServiceExePath: String;
begin
  Result := ServiceDir + '\service\etn-service.exe';
#ifdef TestMode
  if GTestServiceCmd <> '' then Result := GTestServiceCmd;
#endif
end;

{ Вывод sc query по службе. В тестовом режиме — подмена состояния:
  /TESTSERVICESTATE=running|stopped (статическое состояние: команды его не
  меняют — проверка «служба не остановилась»); без этой подмены состояние ведёт
  флаг смоделированных команд start/stop (у /TESTSERVICE=present — RUNNING, как
  у работающей службы; stop переводит в STOPPED). Без /TESTSERVICE тестовая
  сборка службу не видит (ServiceRegistered = False), поэтому команды и это
  состояние не запрашиваются. }
function ServiceStateOutput: String;
var
  Args, OutFile: String;
  Code: Integer;
begin
  Result := '';
#ifdef TestMode
  if GTestServiceState = 'running' then
  begin
    Result := 'STATE : 4  RUNNING';
    Exit;
  end;
  if GTestServiceState = 'stopped' then
  begin
    Result := 'STATE : 1  STOPPED';
    Exit;
  end;
  if GTestService <> '' then
  begin
    if GTestServiceRunning then
    begin
      { Смоделированный START_PENDING: реальный SCM держит его, пока служба
        стартует; RUNNING приходит только следующим опросом. }
      if GTestServicePendingPolls <> 0 then
      begin
        if GTestServicePendingPolls > 0 then
          GTestServicePendingPolls := GTestServicePendingPolls - 1;
        Result := 'STATE : 2  START_PENDING';
        Exit;
      end;
      Result := 'STATE : 4  RUNNING';
    end
    else
      Result := 'STATE : 1  STOPPED';
    Exit;
  end;
#endif
  OutFile := ExpandConstant('{tmp}') + '\etn-service-state.txt';
  DeleteFile(OutFile);
  Args := '/c sc query ' + SERVICE_NAME + ' > "' + OutFile + '" 2>&1';
  if not Exec(ExpandConstant('{cmd}'), Args, '', SW_HIDE,
    ewWaitUntilTerminated, Code) then Exit;
  if FileExists(OutFile) then
    Result := UpperCase(ReadTextFile(OutFile));
end;

function ServiceStoppedNow: Boolean;
var
  S: String;
begin
  S := ServiceStateOutput;
  Result := (Pos('STOPPED', S) > 0) and (Pos('RUNNING', S) = 0) and
    (Pos('STOP_PENDING', S) = 0) and (Pos('START_PENDING', S) = 0);
end;

{ Служба в состоянии RUNNING: START_PENDING/STOP_PENDING не считаются —
  запуск ещё не подтверждён, health-check идти не должен. }
function ServiceRunningNow: Boolean;
var
  S: String;
begin
  S := ServiceStateOutput;
  Result := (Pos('RUNNING', S) > 0) and (Pos('STOPPED', S) = 0) and
    (Pos('START_PENDING', S) = 0) and (Pos('STOP_PENDING', S) = 0);
end;

function ServiceStopWaitMs: Integer;
begin
  Result := SERVICE_STOP_WAIT_MS;
#ifdef TestMode
  if GTestServiceWait <> '' then
    Result := StrToIntDef(GTestServiceWait, Result);
#endif
end;

function ServiceStartWaitMs: Integer;
begin
  Result := SERVICE_START_WAIT_MS;
#ifdef TestMode
  if GTestServiceWait <> '' then
    Result := StrToIntDef(GTestServiceWait, Result);
#endif
end;

{ Ждём реальной остановки: опрос раз в SERVICE_STOP_STEP_MS до бюджета. }
function WaitServiceStopped: Boolean;
var
  Waited: Integer;
begin
  Result := ServiceStoppedNow;
  if Result then Exit;
  Waited := 0;
  while Waited < ServiceStopWaitMs do
  begin
    Sleep(SERVICE_STOP_STEP_MS);
    Waited := Waited + SERVICE_STOP_STEP_MS;
    if ServiceStoppedNow then
    begin
      Result := True;
      Exit;
    end;
  end;
  Result := ServiceStoppedNow;
end;

{ Ждём подтверждённого RUNNING после start (8b1f5980): WinSW возвращает
  управление раньше, чем SCM переводит службу в RUNNING, а health-check по
  ещё не слушающему серверу дал бы ложный сбой и откат. }
function WaitServiceRunning: Boolean;
var
  Waited: Integer;
begin
  Result := ServiceRunningNow;
  if Result then Exit;
  Waited := 0;
  while Waited < ServiceStartWaitMs do
  begin
    Sleep(SERVICE_STOP_STEP_MS);
    Waited := Waited + SERVICE_STOP_STEP_MS;
    if ServiceRunningNow then
    begin
      Result := True;
      Exit;
    end;
  end;
  Result := ServiceRunningNow;
end;

{ Разбор кода возврата команды WinSW — общий для продуктовой ветки и модели
  службы (поведенческий тест 1073 обязан проверять тот же код, что выполняется
  на машине). WinSW 2.12.0: install существующей службы возвращает
  ERROR_SERVICE_EXISTS (1073). Служба уже зарегистрирована — цель достигнута,
  повторная установка не падает. }
function ServiceCommandResult(const Verb: String; const Code: Integer): Boolean;
begin
  Result := False;
  if Code <> 0 then
  begin
    if (Verb = 'install') and (Code = ERROR_SERVICE_EXISTS) then
    begin
      LogLine('INFO', 'Служба: install — служба уже существует (код ' +
        IntToStr(Code) + '), регистрация не требуется');
      Result := True;
      Exit;
    end;
    LogLine('WARN', 'Служба: команда ' + Verb + ' вернула код ' +
      IntToStr(Code));
    Exit;
  end;
  LogLine('INFO', 'Служба: команда ' + Verb + ' выполнена');
  Result := True;
end;

{ Команда WinSW: install, uninstall, stop, start. Код возврата команды —
  успех/неудача; install существующей службы (1073) — не ошибка: повторная
  установка обязана проходить (8b1f5980, разбор — ServiceCommandResult).

  В тестовой сборке настоящая служба рабочей машины не трогается никогда.
  Хук /TESTSERVICE=present|absent включает модель: команды не выполняются, их
  результат и состояние службы ведут флаги GTestServiceRegistered/Running
  (install/uninstall меняют регистрацию, start/stop — состояние), а сбои
  задаются хуками /TESTSERVICEINSTALL=fail|exists, /TESTSERVICEUNINSTALL=fail,
  /TESTSERVICESTOP=fail, /TESTSERVICESTART=fail|pending|pending-stuck. Без
  /TESTSERVICE команда тоже не выполняется (изоляция тестов от машины), но
  состояние службы остаётся «не зарегистрирована». /TESTSERVICEREALFILE=1
  добавляет проверку наличия etn-service.exe, как в продуктовой ветке: проба
  настоящего деинсталлятора (приёмка 4151edf6) должна падать, если путь к
  службе вычислен неверно. }
function RunServiceCommand(const Verb: String): Boolean;
var
  Code: Integer;
begin
  Result := False;
#ifdef TestMode
  if (GTestService <> '') and (GTestServiceRealFile = '1') and
     (not FileExists(ServiceExePath)) then
  begin
    LogLine('ERROR', 'Служба: нет ' + ServiceExePath + ' — команда ' + Verb +
      ' не выполнена');
    Exit;
  end;
  if GTestService <> '' then
  begin
    if (Verb = 'stop') and (GTestServiceStop = 'fail') then
    begin
      LogLine('WARN', 'Служба (тестовый режим): stop не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'start') and (GTestServiceStart = 'fail') then
    begin
      LogLine('WARN', 'Служба (тестовый режим): start не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'install') and (GTestServiceInstall = 'fail') then
    begin
      LogLine('WARN', 'Служба (тестовый режим): install не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'uninstall') and (GTestServiceUninstall = 'fail') then
    begin
      LogLine('WARN', 'Служба (тестовый режим): uninstall не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'install') and (GTestServiceInstall = 'exists') then
    begin
      GTestServiceRegistered := True;
      Result := ServiceCommandResult(Verb, ERROR_SERVICE_EXISTS);
      Exit;
    end;
    if Verb = 'install' then
      GTestServiceRegistered := True
    else if Verb = 'uninstall' then
    begin
      GTestServiceRegistered := False;
      GTestServiceRunning := False;
      GTestServicePendingPolls := 0;
    end
    else if Verb = 'start' then
    begin
      GTestServiceRunning := True;
      if GTestServiceStart = 'pending' then
        GTestServicePendingPolls := 2
      else if GTestServiceStart = 'pending-stuck' then
        GTestServicePendingPolls := -1
      else
        GTestServicePendingPolls := 0;
    end
    else if Verb = 'stop' then
    begin
      GTestServiceRunning := False;
      GTestServicePendingPolls := 0;
    end;
    LogLine('INFO', 'Служба (тестовый режим): команда ' + Verb +
      ' — успех (exe=' + ServiceExePath + ', config=' + ServiceDir +
      '\service\etn-service.xml, exists=' + Pick(FileExists(ServiceExePath), '1', '0') + ')');
    Result := True;
    Exit;
  end;
  LogLine('WARN', 'Служба (тестовый режим, /TESTSERVICE не задан): команда ' +
    Verb + ' не выполняется — тестовая сборка не трогает службы машины');
  Result := True;
  Exit;
#endif
  if not FileExists(ServiceExePath) then
  begin
    LogLine('ERROR', 'Служба: нет ' + ServiceExePath + ' — команда ' + Verb +
      ' не выполнена');
    Exit;
  end;
  LogLine('INFO', 'Служба: ' + ServiceExePath + ' ' + Verb +
    ' (конфигурация: ' + ServiceDir + '\service\etn-service.xml, exists=1)');
  if not Exec(ServiceExePath, Verb, ExtractFileDir(ServiceExePath), SW_HIDE,
    ewWaitUntilTerminated, Code) then
  begin
    LogLine('WARN', 'Служба: не удалось запустить ' + ServiceExePath +
      ' ' + Verb);
    Exit;
  end;
  Result := ServiceCommandResult(Verb, Code);
end;

{ Остановка перед заменой файлов. False — служба осталась работать (или её
  состояние не удалось подтвердить): обновление не начинается, код 20.
  Причина возвращается вызывающему для журнала и сообщения. }
function StopServiceForUpdate(var Reason: String): Boolean;
begin
  Result := True;
  Reason := '';
  if not ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' не зарегистрирована — ' +
      'останавливать нечего');
    Exit;
  end;
  LogLine('INFO', 'Остановка службы ' + SERVICE_NAME);
  if ServiceStoppedNow then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' уже остановлена');
    Exit;
  end;
  if not RunServiceCommand('stop') then
  begin
    Reason := 'не удалось остановить службу ' + SERVICE_NAME +
      ' (etn-service.exe stop вернул ошибку)';
    Result := False;
    Exit;
  end;
  if not WaitServiceStopped then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' не остановилась за ' +
      IntToStr(ServiceStopWaitMs) + ' мс';
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ' остановлена');
end;

{ Запуск службы после замены файлов (и повторно — при откате) с ожиданием
  подтверждённого RUNNING (8b1f5980). Уже запущенная служба не запускается
  второй раз. Неудача не выдумывается: вызывающий решает, провал это или
  повод перейти к health. }
function StartServiceIfNeeded: Boolean;
begin
  Result := True;
  if not ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' не зарегистрирована — ' +
      'запускать нечего');
    Exit;
  end;
  if ServiceRunningNow then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ': уже запущена (RUNNING)');
    Exit;
  end;
  if not RunServiceCommand('start') then
  begin
    LogLine('ERROR', 'Служба ' + SERVICE_NAME + ': команда start не выполнена');
    Result := False;
    Exit;
  end;
  if not WaitServiceRunning then
  begin
    LogLine('ERROR', 'Служба ' + SERVICE_NAME + ': не перешла в RUNNING за ' +
      IntToStr(ServiceStartWaitMs) + ' мс');
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ': запущена (RUNNING)');
end;

{ Регистрация службы WinSW (8b1f5980): выполняется после подстановки
  etn-service.xml и до запуска. WinSW install читает etn-service.xml рядом с
  etn-service.exe — из него берутся точка запуска, стартовый режим, recovery и
  учётная запись. Режим app службу не регистрирует: сервер запускает
  пользователь.

  Повторная установка: уже зарегистрированную службу не перегистрируем — WinSW
  2.12.0 вернул бы ERROR_SERVICE_EXISTS (1073), а конфигурацию WinSW читает при
  каждом старте, поэтому изменённые DATA_DIR/PORT/HOST применяются без install.

  False — служба не зарегистрирована; вызывающий отказывает установке кодом 20
  с этой причиной (карточка 8b1f5980). }
function RegisterServiceIfNeeded(var Reason: String): Boolean;
var
  Config: String;
begin
  Result := True;
  Reason := '';
  if GServerMode = 'app' then
  begin
    LogLine('INFO', 'Режим app: служба ' + SERVICE_NAME + ' не регистрируется — ' +
      'сервер запускает пользователь');
    Exit;
  end;
  Config := ServiceDir + '\service\etn-service.xml';
  if not FileExists(Config) then
  begin
    Reason := 'конфигурация службы не найдена: ' + Config;
    Result := False;
    Exit;
  end;
  if ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' уже зарегистрирована — ' +
      'install не требуется');
    Exit;
  end;
  LogLine('INFO', 'Регистрация службы ' + SERVICE_NAME + ': ' + ServiceExePath +
    ' install (конфигурация: ' + Config + ')');
  if not RunServiceCommand('install') then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' не зарегистрирована: ' +
      'etn-service.exe install вернул ошибку (конфигурация: ' + Config + ')';
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ' зарегистрирована (install)');
end;

{ Снятие службы при удалении программы (8b1f5980): stop + uninstall строго до
  удаления файлов (usUninstall). Служба, оставшаяся в SCM с путём в удалённый
  каталог, ломает повторную установку и висит в списке служб. False — служба
  осталась: удаление программы отменяется, причина возвращается вызывающему. }
function RemoveServiceOnUninstall(var Reason: String): Boolean;
begin
  Result := True;
  Reason := '';
  if not ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' не зарегистрирована — ' +
      'снимать нечего');
    Exit;
  end;
  if not StopServiceForUpdate(Reason) then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' не остановлена: ' + Reason;
    Result := False;
    Exit;
  end;
  if not RunServiceCommand('uninstall') then
  begin
    Reason := 'не удалось снять службу ' + SERVICE_NAME +
      ' (etn-service.exe uninstall вернул ошибку)';
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ' снята (uninstall)');
end;

{ ---------------------------------------------------------------------------
  Health-check (требование 0a79d9de): GET /api/v1/health → 200, status=ok,
  db=ok, version = целевая; GET /api/v1/version → version = целевая, api=v1.
  Тело разбирается, а не только HTTP-код; бюджет 60 с, повтор каждые 2 с.
  --------------------------------------------------------------------------- }
function HealthBaseUrl: String;
begin
  Result := 'http://127.0.0.1:' + GServerPort;
#ifdef TestMode
  if GTestHealthUrl <> '' then Result := GTestHealthUrl;
#endif
end;

function HealthWaitMs: Integer;
begin
  Result := HEALTH_WAIT_MS;
#ifdef TestMode
  if GTestHealthWait <> '' then
    Result := StrToIntDef(GTestHealthWait, Result);
#endif
end;

function HealthStepMs: Integer;
begin
  Result := HEALTH_STEP_MS;
#ifdef TestMode
  if GTestHealthStep <> '' then
    Result := StrToIntDef(GTestHealthStep, Result);
#endif
end;

{ Один GET через curl.exe с телом в файл. -f: HTTP >= 400 — код 22, тело не
  считается ответом. Пояснение причины — в Detail. }
function HttpGetBody(const Url, BodyFile, What: String;
  var Detail: String): Boolean;
var
  Code: Integer;
begin
  Result := False;
  DeleteFile(BodyFile);
  if not Exec('curl.exe', '-fsS --max-time 5 -o "' + BodyFile + '" "' + Url + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Detail := What + ': curl.exe не запустился';
    Exit;
  end;
  if Code <> 0 then
  begin
    if Code = 22 then
      Detail := What + ': HTTP-ошибка (ответ не 2xx)'
    else if Code = 7 then
      Detail := What + ': соединение отклонено'
    else if Code = 28 then
      Detail := What + ': таймаут'
    else
      Detail := What + ': сетевой сбой (curl ' + IntToStr(Code) + ')';
    Exit;
  end;
  if not FileExists(BodyFile) then
  begin
    Detail := What + ': пустой ответ';
    Exit;
  end;
  Result := True;
end;

{ Одна попытка расширенного health-check. RequireTargetVersion=False нужен
  после отката: прежняя версия обязана отвечать, но её версия — не целевая. }
function CheckHealthOnce(const RequireTargetVersion: Boolean;
  var Detail: String): Boolean;
var
  Base, Body, Status, Db, Api, Ver: String;
begin
  Result := False;
  Detail := '';
  Base := HealthBaseUrl;
  if not HttpGetBody(Base + '/api/v1/health',
    ExpandConstant('{tmp}') + '\etn-health.json', 'GET /api/v1/health', Detail) then Exit;
  Body := ReadTextFile(ExpandConstant('{tmp}') + '\etn-health.json');
  Status := LowerCase(JsonGetRaw(Body, 'status'));
  Db := LowerCase(JsonGetRaw(Body, 'db'));
  if Status <> 'ok' then
  begin
    Detail := 'health: status=' + IfStr(Status = '', '<нет>', Status) +
      ' вместо ok';
    Exit;
  end;
  if Db <> 'ok' then
  begin
    Detail := 'health: db=' + IfStr(Db = '', '<нет>', Db) + ' вместо ok';
    Exit;
  end;
  if not RequireTargetVersion then
  begin
    Result := True;
    Exit;
  end;
  Ver := JsonGetRaw(Body, 'version');
  if Ver <> GProductVersion then
  begin
    Detail := 'health: версия ' + IfStr(Ver = '', '<нет>', Ver) +
      ' вместо ' + GProductVersion;
    Exit;
  end;
  if not HttpGetBody(Base + '/api/v1/version',
    ExpandConstant('{tmp}') + '\etn-version.json', 'GET /api/v1/version', Detail) then Exit;
  Body := ReadTextFile(ExpandConstant('{tmp}') + '\etn-version.json');
  Ver := JsonGetRaw(Body, 'version');
  if Ver <> GProductVersion then
  begin
    Detail := 'version: версия ' + IfStr(Ver = '', '<нет>', Ver) +
      ' вместо ' + GProductVersion;
    Exit;
  end;
  Api := JsonGetRaw(Body, 'api');
  if Api <> 'v1' then
  begin
    Detail := 'version: api=' + IfStr(Api = '', '<нет>', Api) + ' вместо v1';
    Exit;
  end;
  Result := True;
end;

{ Health-check: fail-closed — успех объявляется только при подтверждённом
  запуске сервера целевой версии. Хук /TESTHEALTH=ok|fail подменяет весь
  опрос (тестовая сборка); /TESTHEALTHURL направляет запросы на подставной
  HTTP-сервер, чтобы разбор тела проверялся по-настоящему. }
function ProbeHealth(const RequireTargetVersion: Boolean): Boolean;
var
  Elapsed: Integer;
begin
  Result := False;
  GHealthReason := '';
#ifdef TestMode
  if GTestHealth <> '' then
  begin
    Result := LowerCase(GTestHealth) = 'ok';
    if not Result then GHealthReason := 'тестовый режим: ' + GTestHealth;
    LogLine('INFO', 'Health-check (тестовый режим): ' + GTestHealth);
    Exit;
  end;
#endif
  if not FileExists(ServiceExePath) then
  begin
    GHealthReason := 'служба не найдена (' + ServiceExePath + ')';
    LogLine('ERROR', 'Health-check не выполнен: ' + GHealthReason);
    Exit;
  end;
  Elapsed := 0;
  while True do
  begin
    if CheckHealthOnce(RequireTargetVersion, GHealthReason) then
    begin
      LogLine('INFO', 'Health-check ' + HealthBaseUrl + ': успех');
      Result := True;
      Exit;
    end;
    if Elapsed >= HealthWaitMs then Break;
    Sleep(HealthStepMs);
    Elapsed := Elapsed + HealthStepMs;
  end;
  LogLine('ERROR', 'Health-check ' + HealthBaseUrl + ': сбой — ' + GHealthReason);
end;

{ Применим ли health-check в этом режиме. В режиме app службу никто не
  запускает (её нет): сервер поднимает пользователь, поэтому опрос HTTP
  гарантированно истёк бы и обновление уходило в откат (замечание приёмки
  bb063ac3). }
function HealthCheckApplicable: Boolean;
begin
  Result := GServerMode <> 'app';
end;

{ ---------------------------------------------------------------------------
  Бэкап баз данных перед заменой файлов — задача ce3ab836.

  Функция создаёт архив и проверяет его, но НЕ решает, нужен ли бэкап:
  решение передаёт вызывающий (bb063ac3): Needed = True при смене версии,
  False при ремонте той же версии. Остановку службы, откат и health-check
  выполняет вызывающий. Архив создаётся после остановки службы и до замены
  файлов, поэтому в каталогах баз может остаться журнал WAL.
  --------------------------------------------------------------------------- }

{ Строка только из цифр: имя каталога архива и его суффикс. }
function IsAllDigits(const S: String): Boolean;
var
  I: Integer;
begin
  Result := S <> '';
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
    begin
      Result := False;
      Exit;
    end;
end;

{ Имя каталога архива: YYYYMMDD-HHmmss; суффикс -N — если два архива попали
  в одну секунду (быстрый повтор в тестах). Такой каталог тоже считается
  своим архивом и участвует в ротации. }
function IsBackupDirName(const Name: String): Boolean;
var
  Tail: String;
begin
  Result := False;
  if Length(Name) < BACKUP_DIR_NAME_LEN then Exit;
  if Name[9] <> '-' then Exit;
  if not IsAllDigits(Copy(Name, 1, 8)) then Exit;
  if not IsAllDigits(Copy(Name, 10, 6)) then Exit;
  if Length(Name) = BACKUP_DIR_NAME_LEN then
  begin
    Result := True;
    Exit;
  end;
  Tail := Copy(Name, BACKUP_DIR_NAME_LEN + 1, Length(Name) - BACKUP_DIR_NAME_LEN);
  Result := (Length(Tail) > 1) and (Tail[1] = '-') and
    IsAllDigits(Copy(Tail, 2, Length(Tail) - 1));
end;

function IsRealSubdir(const FindRec: TFindRec): Boolean;
begin
  Result := ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and
    (FindRec.Name <> '.') and (FindRec.Name <> '..');
end;

{ Есть ли хотя бы одна база сети: networks\<uuid>\data.db. }
function HasNetworkDatabases(const DataDir: String): Boolean;
var
  Root: String;
  FindRec: TFindRec;
begin
  Result := False;
  Root := DataDir + '\networks';
  if not DirExists(Root) then Exit;
  if not FindFirst(Root + '\*', FindRec) then Exit;
  try
    repeat
      if IsRealSubdir(FindRec) and
         FileExists(Root + '\' + FindRec.Name + '\data.db') then
      begin
        Result := True;
        Exit;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

function CountBackupDirs(const BackupsDir: String): Integer;
var
  FindRec: TFindRec;
begin
  Result := 0;
  if not FindFirst(BackupsDir + '\*', FindRec) then Exit;
  try
    repeat
      if IsRealSubdir(FindRec) and IsBackupDirName(FindRec.Name) then
        Result := Result + 1;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ Объём баз данных, которые копирует архив: _system.db и
  networks\<uuid>\data.db. Нужен сообщению о неудачном бэкапе (bc7cc846:
  причина + требуемый объём + путь к журналу). }
function DatabaseBackupSizeBytes: Int64;
var
  NetworksDir, Src: String;
  FindRec: TFindRec;
  Size, Total: Int64;
begin
  Total := 0;
  Src := GDataDir + '\_system.db';
  if FileExists(Src) and FileSize64(Src, Size) then Total := Total + Size;
  NetworksDir := GDataDir + '\networks';
  if DirExists(NetworksDir) and FindFirst(NetworksDir + '\*', FindRec) then
  begin
    try
      repeat
        if IsRealSubdir(FindRec) then
        begin
          Src := NetworksDir + '\' + FindRec.Name + '\data.db';
          if FileExists(Src) and FileSize64(Src, Size) then Total := Total + Size;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  Result := Total;
end;

function FormatSizeBytes(const Bytes: Int64): String;
begin
  if Bytes >= 1073741824 then
    Result := Format('%.1f ГБ', [Bytes / 1073741824.0])
  else if Bytes >= 1048576 then
    Result := Format('%.1f МБ', [Bytes / 1048576.0])
  else
    Result := IntToStr((Bytes + 1023) div 1024) + ' КБ';
end;

{ Самый старый архив по имени (имена — нумерованные метки времени, поэтому
  сравнение строк совпадает с хронологией). Текущий архив исключается: его
  удалять нельзя даже при переводе часов назад. }
function OldestBackupDirName(const BackupsDir, Exclude: String): String;
var
  FindRec: TFindRec;
begin
  Result := '';
  if not FindFirst(BackupsDir + '\*', FindRec) then Exit;
  try
    repeat
      if IsRealSubdir(FindRec) and IsBackupDirName(FindRec.Name) and
         (CompareText(FindRec.Name, Exclude) <> 0) then
        if (Result = '') or (CompareText(FindRec.Name, Result) < 0) then
          Result := FindRec.Name;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ Самый свежий архив по имени: нужен итоговой сводке и экрану ошибки, чтобы
  показать реальный путь резервной копии (в двухфазном UAC архив создаёт
  дочерний процесс — родитель знает о нём только через каталог архивов). }
function LatestBackupDirName(const BackupsDir: String): String;
var
  FindRec: TFindRec;
begin
  Result := '';
  if not FindFirst(BackupsDir + '\*', FindRec) then Exit;
  try
    repeat
      if IsRealSubdir(FindRec) and IsBackupDirName(FindRec.Name) then
        if (Result = '') or (CompareText(FindRec.Name, Result) > 0) then
          Result := FindRec.Name;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

function LatestBackupDir: String;
var
  Name: String;
begin
  Result := '';
  Name := LatestBackupDirName(GDataDir + '\backups');
  if Name <> '' then
    Result := GDataDir + '\backups\' + Name;
end;

{ Ротация: пока архивов больше трёх, удаляется самый старый. Чужие файлы и
  каталоги (имена не по формату архива) не считаются и не трогаются. Ошибка
  удаления обновление не отменяет — только предупреждение в журнал. }
procedure RotateBackupArchives(const BackupsDir, CurrentName: String);
var
  Oldest: String;
begin
  while CountBackupDirs(BackupsDir) > BACKUPS_KEEP do
  begin
    Oldest := OldestBackupDirName(BackupsDir, CurrentName);
    if Oldest = '' then Break;
    if DelTree(BackupsDir + '\' + Oldest, True, True, True) then
      LogLine('INFO', 'Бэкап БД: старый архив удалён: ' + Oldest)
    else
    begin
      LogLine('WARN', 'Бэкап БД: не удалось удалить старый архив ' + Oldest +
        ' — обновление продолжается, архив оставлен');
      Break;
    end;
  end;
end;

{ Новое имя архива; суффикс -2, -3 при совпадении секунды. }
function NewBackupArchiveName(const BackupsDir: String): String;
var
  Base: String;
  N: Integer;
begin
  Base := GetDateTimeString('yyyymmdd-hhnnss', '-', '-');
  Result := Base;
  N := 2;
  while DirExists(BackupsDir + '\' + Result) do
  begin
    Result := Base + '-' + IntToStr(N);
    N := N + 1;
  end;
end;

{ Чекпойнт WAL перед копированием: после остановки службы в -wal могут лежать
  закоммиченные страницы. PRAGMA wal_checkpoint(TRUNCATE) переносит их в
  основной файл, и архив остаётся самодостаточным файлом базы — без
  дополнительных файлов журнала. busy_timeout=0: служба остановлена, ждать
  нечего; busy=1 означает, что журнал удерживает кто-то ещё. }
function CheckpointDatabase(const NodeExe, ServerDir, DbPath: String): Boolean;
var
  Script, Args: String;
  Code: Integer;
begin
  Result := False;
  if not FileExists(NodeExe) then Exit;
  Script :=
    'try{' +
    'const Database=require(''better-sqlite3'');' +
    'const db=new Database(process.argv[1]);' +
    'db.pragma(''busy_timeout=0'');' +
    'const j=String(db.pragma(''journal_mode'')[0].journal_mode||'''');' +
    'if(j.toLowerCase()!==''wal''){db.close();process.exit(0)}' +
    'const r=db.pragma(''wal_checkpoint(TRUNCATE)'');' +
    'db.close();' +
    'process.exit((r.length>0&&Number(r[0].busy)!==0)?1:0)' +
    '}catch(e){console.error(String(e&&e.stack||e));process.exit(2)}';
  Args := '-e "' + Script + '" "' + DbPath + '"';
  if not Exec(NodeExe, Args, ServerDir, SW_HIDE, ewWaitUntilTerminated, Code) then Exit;
  Result := Code = 0;
  if Result then
    LogLine('INFO', 'Бэкап БД: checkpoint WAL выполнен: ' + DbPath)
  else
    LogLine('WARN', 'Бэкап БД: checkpoint WAL не выполнен (код ' + IntToStr(Code) +
      '): копируется файл журнала: ' + DbPath);
end;

{ Проверка целостности копии через PRAGMA integrity_check. node.exe и
  node_modules берутся из установленной поставки: рабочей директорией служит
  каталог server, поэтому require находит better-sqlite3 поставки. }
function VerifyDatabaseIntegrity(const NodeExe, ServerDir, DbPath: String): Boolean;
var
  Script, Args: String;
  Code: Integer;
begin
  Result := False;
  if not FileExists(NodeExe) then
  begin
    LogLine('ERROR', 'Бэкап БД: нет node.exe поставки: ' + NodeExe +
      ' — целостность архива не проверить');
    Exit;
  end;
  Script :=
    'try{' +
    'const Database=require(''better-sqlite3'');' +
    'const db=new Database(process.argv[1]);' +
    'const rows=db.pragma(''integrity_check'');' +
    'db.close();' +
    'const ok=rows.length===1&&String(rows[0].integrity_check)===''ok'';' +
    'if(!ok){console.error(''integrity_check: ''+JSON.stringify(rows));process.exit(1)}' +
    '}catch(e){console.error(String(e&&e.stack||e));process.exit(2)}';
  Args := '-e "' + Script + '" "' + DbPath + '"';
  if not Exec(NodeExe, Args, ServerDir, SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    LogLine('ERROR', 'Бэкап БД: не удалось запустить проверку целостности: ' + NodeExe);
    Exit;
  end;
  if Code <> 0 then
  begin
    LogLine('ERROR', 'Бэкап БД: integrity_check не пройден: ' + DbPath +
      ' (код ' + IntToStr(Code) + ')');
    Exit;
  end;
  LogLine('INFO', 'Бэкап БД: integrity_check ok: ' + DbPath);
  Result := True;
end;

{ Копия базы в каталог архива. Если чекпойнт не удался, рядом с базой
  копируется -wal: SQLite применит журнал при открытии, и снимок останется
  согласованным. Файл -shm не копируется — он транзитный и создаётся SQLite
  заново. }
function CopyDatabaseFile(const Src, DestDir: String; const WithWal: Boolean): Boolean;
var
  Dest: String;
begin
  Result := False;
  if not ForceDirectories(DestDir) then
  begin
    LogLine('ERROR', 'Бэкап БД: не удалось создать каталог архива ' + DestDir);
    Exit;
  end;
  Dest := DestDir + '\' + ExtractFileName(Src);
  if not CopyFile(Src, Dest, False) then
  begin
    LogLine('ERROR', 'Бэкап БД: не удалось скопировать ' + Src + ' в ' + Dest);
    Exit;
  end;
  if WithWal and FileExists(Src + '-wal') then
  begin
    if not CopyFile(Src + '-wal', Dest + '-wal', False) then
    begin
      LogLine('ERROR', 'Бэкап БД: не удалось скопировать журнал ' + Src + '-wal');
      Exit;
    end;
    LogLine('INFO', 'Бэкап БД: вместе с базой скопирован WAL: ' + Src + '-wal');
  end;
  Result := True;
end;

{ Одна база: чекпойнт (по возможности), копия, integrity_check копии. }
function BackupDatabase(const Src, DestDir, NodeExe, ServerDir: String): Boolean;
var
  WithWal: Boolean;
begin
  WithWal := not CheckpointDatabase(NodeExe, ServerDir, Src);
  if not CopyDatabaseFile(Src, DestDir, WithWal) then
  begin
    Result := False;
    Exit;
  end;
  Result := VerifyDatabaseIntegrity(NodeExe, ServerDir,
    DestDir + '\' + ExtractFileName(Src));
end;

{ Копирование всех баз в архив: _system.db и networks\<uuid>\data.db.
  Возвращает False на первой ошибке; Count — число скопированных баз. }
function CopyDatabasesInto(const ArchiveDir: String; var Count: Integer): Boolean;
var
  NodeExe, ServerDir, NetworksDir, Src, DestDir: String;
  FindRec: TFindRec;
begin
  Result := False;
  Count := 0;
  NodeExe := ServerNodeExe(GServerDir);
  ServerDir := GServerDir + '\server';
  Src := GDataDir + '\_system.db';
  if FileExists(Src) then
  begin
    if not BackupDatabase(Src, ArchiveDir, NodeExe, ServerDir) then Exit;
    Count := Count + 1;
  end;
  NetworksDir := GDataDir + '\networks';
  if DirExists(NetworksDir) then
  begin
    if FindFirst(NetworksDir + '\*', FindRec) then
    begin
      try
        repeat
          if IsRealSubdir(FindRec) then
          begin
            Src := NetworksDir + '\' + FindRec.Name + '\data.db';
            if FileExists(Src) then
            begin
              DestDir := ArchiveDir + '\networks\' + FindRec.Name;
              if not BackupDatabase(Src, DestDir, NodeExe, ServerDir) then Exit;
              Count := Count + 1;
            end;
          end;
        until not FindNext(FindRec);
      finally
        FindClose(FindRec);
      end;
    end;
  end;
  Result := Count > 0;
  if not Result then
    LogLine('ERROR', 'Бэкап БД: не найдено ни одной базы для архивации');
end;

{ Точка входа бэкапа. Needed — решение вызывающего (смена версии или ремонт).
  Возвращает True, когда архив создан и проверен либо бэкап не требуется;
  False — архива нет, обновление обязано остановиться до замены файлов. }
function CreateDatabaseBackup(const Needed: Boolean): Boolean;
var
  BackupsDir, ArchiveName, ArchiveDir: String;
  Copied: Integer;
begin
  Result := False;
  GLastBackupDir := '';
  GBackupReason := '';
  if not Needed then
  begin
    LogLine('INFO', 'Бэкап БД: смена версии не требуется (ремонт) — архив не создаётся');
    Result := True;
    Exit;
  end;
  if (not FileExists(GDataDir + '\_system.db')) and
     (not HasNetworkDatabases(GDataDir)) then
  begin
    LogLine('WARN', 'Бэкап БД: в ' + GDataDir +
      ' нет баз данных — архив не создаётся, обновление продолжается');
    Result := True;
    Exit;
  end;
  BackupsDir := GDataDir + '\backups';
  { Этап прогресса: подпись на странице установки (112642a4). В silent
    записывается только в журнал. }
  SetInstallStage('Резервная копия баз данных…');
  if not ForceDirectories(BackupsDir) then
  begin
    GBackupReason := 'каталог архивов не создан: ' + BackupsDir +
      ' (нет прав или свободного места)';
    LogLine('ERROR', 'Бэкап БД: не удалось создать каталог архивов ' + BackupsDir +
      ' (нет прав или места) — обновление отменяется');
    Exit;
  end;
  ArchiveName := NewBackupArchiveName(BackupsDir);
  ArchiveDir := BackupsDir + '\' + ArchiveName;
  if not ForceDirectories(ArchiveDir) then
  begin
    GBackupReason := 'каталог архива не создан: ' + ArchiveDir +
      ' (нет прав или свободного места)';
    LogLine('ERROR', 'Бэкап БД: не удалось создать каталог архива ' + ArchiveDir +
      ' (нет прав или места) — обновление отменяется');
    Exit;
  end;
  LogLine('INFO', 'Бэкап БД: создаётся архив ' + ArchiveDir);
  if not CopyDatabasesInto(ArchiveDir, Copied) then
  begin
    GBackupReason := 'копирование или проверка целостности баз не удалось: ' +
      ArchiveDir;
    if DelTree(ArchiveDir, True, True, True) then
      LogLine('ERROR', 'Бэкап БД: неудачный архив удалён: ' + ArchiveDir)
    else
      LogLine('WARN', 'Бэкап БД: неудачный архив не удалось удалить: ' + ArchiveDir);
    Exit;
  end;
  GLastBackupDir := ArchiveDir;
  LogLine('INFO', 'Бэкап БД: архив создан: ' + GLastBackupDir +
    ' (баз: ' + IntToStr(Copied) + ')');
  RotateBackupArchives(BackupsDir, ArchiveName);
  Result := True;
end;

{ ---------------------------------------------------------------------------
  Снимок отката и восстановление — задача bb063ac3.

  Снимок — единственная резервная копия программы для отката: каталог
  %ProgramData%\ETN\.install\rollback\<timestamp> с копиями server и service
  (данные не копируются — для них есть архив ce3ab836). Создаётся до
  копирования файлов; после успешного обновления удаляется вместе со старыми
  снимками, при отказе остаётся единственной точкой ручного восстановления
  до следующего успешного обновления (замечание приёмки: старые снимки не
  накапливаются).
  --------------------------------------------------------------------------- }
function RollbackRoot: String;
begin
  Result := GDataDir + '\.install\rollback';
end;

{ Рекурсивная копия каталога (в Inno нет готовой): раскладка установки —
  только каталоги и файлы, символических ссылок нет. }
function CopyTreeRec(const Src, Dest: String): Boolean;
var
  FindRec: TFindRec;
  S, D: String;
begin
  Result := False;
  if not DirExists(Src) then
  begin
    Result := True;
    Exit;
  end;
  if not ForceDirectories(Dest) then
  begin
    LogLine('ERROR', 'Копия каталога: не удалось создать ' + Dest);
    Exit;
  end;
  if not FindFirst(Src + '\*', FindRec) then
  begin
    { Пустой каталог: FindFirst не нашёл ни одного элемента. }
    Result := True;
    Exit;
  end;
  try
    repeat
      if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
      begin
        S := Src + '\' + FindRec.Name;
        D := Dest + '\' + FindRec.Name;
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        begin
          if not CopyTreeRec(S, D) then Exit;
        end
        else if not CopyFile(S, D, False) then
        begin
          LogLine('ERROR', 'Копия каталога: не удалось скопировать ' + S + ' в ' + D);
          Exit;
        end;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
  Result := True;
end;

function NewRollbackDirName(const Root: String): String;
var
  Base: String;
  N: Integer;
begin
  Base := GetDateTimeString('yyyymmdd-hhnnss', '-', '-');
  Result := Base;
  N := 2;
  while DirExists(Root + '\' + Result) do
  begin
    Result := Base + '-' + IntToStr(N);
    N := N + 1;
  end;
end;

{ Удаление старых снимков отката: хранится только копия текущего запуска
  (её заменяет следующий снимок), после успеха — ни одной (замечание приёмки
  bb063ac3). Чужие каталоги (имя не по формату снимка) не трогаются. }
procedure CleanupRollbackSnapshotsExcept(const KeepDir: String);
var
  Root, Dir: String;
  FindRec: TFindRec;
begin
  Root := RollbackRoot;
  if not DirExists(Root) then Exit;
  if not FindFirst(Root + '\*', FindRec) then Exit;
  try
    repeat
      if IsRealSubdir(FindRec) and IsBackupDirName(FindRec.Name) then
      begin
        Dir := Root + '\' + FindRec.Name;
        if CompareText(Dir, KeepDir) <> 0 then
        begin
          if DelTree(Dir, True, True, True) then
            LogLine('INFO', 'Снимок отката: старый удалён: ' + Dir)
          else
            LogLine('WARN', 'Снимок отката: не удалось удалить старый ' + Dir);
        end;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ Снимок перед заменой файлов. False — копию сделать не удалось: файлы
  заменять нельзя, обновление останавливается. Неудачный (частичный) снимок
  удаляется, старые снимки — тоже: остаётся только копия этого запуска. }
function CreateRollbackSnapshot: Boolean;
var
  Dir, Name: String;
begin
  Result := False;
  GLastRollbackDir := '';
  if not GServerFilesPresent then
  begin
    LogLine('INFO', 'Снимок отката: файлов сервера нет — копировать нечего');
    Result := True;
    Exit;
  end;
  SetInstallStage('Снимок отката…');
  if not ForceDirectories(RollbackRoot) then
  begin
    LogLine('ERROR', 'Снимок отката: не удалось создать каталог ' + RollbackRoot);
    Exit;
  end;
  Name := NewRollbackDirName(RollbackRoot);
  Dir := RollbackRoot + '\' + Name;
  if not CopyTreeRec(GServerDir + '\server', Dir + '\server') then
  begin
    LogLine('ERROR', 'Снимок отката: не удалось скопировать ' + GServerDir +
      '\server в ' + Dir);
    DelTree(Dir, True, True, True);
    Exit;
  end;
  if not CopyTreeRec(GServerDir + '\service', Dir + '\service') then
  begin
    LogLine('ERROR', 'Снимок отката: не удалось скопировать ' + GServerDir +
      '\service в ' + Dir);
    DelTree(Dir, True, True, True);
    Exit;
  end;
  GLastRollbackDir := Dir;
  LogLine('INFO', 'Снимок отката: создан ' + GLastRollbackDir);
  { Снимок один: копия прошлого обновления больше не нужна. }
  CleanupRollbackSnapshotsExcept(GLastRollbackDir);
  Result := True;
end;

{ Подмена каталога программы содержимым снимка. Копирование поверх оставляло
  бы файлы новой версии (dist\cli.js, новые миграции, новые зависимости), и
  прежняя версия применила бы их к восстановленной БД. Поэтому старый каталог
  сначала переименовывается рядом (или удаляется, если переименовать нельзя),
  и только затем на его место копируется снимок — состав файлов совпадает со
  снимком побайтово (замечание приёмки bb063ac3). }
function ReplaceTreeFromSnapshot(const Src, Dest, Tag: String): Boolean;
var
  OldDir: String;
  Swapped: Boolean;
begin
  Result := False;
  OldDir := Dest + '.rollback-' + Tag;
  Swapped := False;
  if DirExists(Dest) then
  begin
    { Хвост прошлой неудачной подмены — убрать, иначе переименование не пройдёт. }
    if DirExists(OldDir) and (not DelTree(OldDir, True, True, True)) then
    begin
      LogLine('ERROR', 'Откат файлов: не удалось удалить ' + OldDir +
        ' перед возвратом ' + Dest);
      Exit;
    end;
    { MoveFileExW — переименование каталога в пределах тома; цель рядом,
      поэтому том тот же. }
    Swapped := MoveFileExW(Dest, OldDir, 0);
    if not Swapped then
    begin
      LogLine('WARN', 'Откат файлов: ' + Dest +
        ' не переименован — удаляется напрямую');
      if not DelTree(Dest, True, True, True) then
      begin
        LogLine('ERROR', 'Откат файлов: не удалось удалить ' + Dest +
          ' перед возвратом из снимка');
        Exit;
      end;
    end;
  end;
  if DirExists(Src) then
  begin
    if not CopyTreeRec(Src, Dest) then
    begin
      LogLine('ERROR', 'Откат файлов: не удалось вернуть ' + Dest + ' из снимка' +
        IfStr(Swapped, '; прежний каталог сохранён как ' + OldDir, ''));
      Exit;
    end;
  end;
  if Swapped and DirExists(OldDir) then
  begin
    if not DelTree(OldDir, True, True, True) then
      LogLine('WARN', 'Откат файлов: не удалось удалить ' + OldDir +
        ' (файлы новой версии) — удалите вручную');
  end;
  Result := True;
end;

{ Возврат файлов программы из снимка. Служба к этому моменту остановлена:
  иначе занятые файлы не перезаписать. Каталоги server и service подменяются
  целиком: файл, которого не было в снимке, после отката отсутствует. }
function RestoreInstallFiles: Boolean;
begin
  Result := False;
#ifdef TestMode
  if LowerCase(GTestRollback) = 'fail' then
  begin
    LogLine('ERROR', 'TESTROLLBACK=fail: восстановление файлов имитирует сбой');
    Exit;
  end;
#endif
  if GLastRollbackDir = '' then
  begin
    LogLine('INFO', 'Откат файлов: снимка нет');
    Result := True;
    Exit;
  end;
  if not ReplaceTreeFromSnapshot(GLastRollbackDir + '\server',
    GServerDir + '\server', 'server') then
  begin
    LogLine('ERROR', 'Откат файлов: не удалось вернуть ' + GServerDir + '\server');
    Exit;
  end;
  if not ReplaceTreeFromSnapshot(GLastRollbackDir + '\service',
    GServerDir + '\service', 'service') then
  begin
    LogLine('ERROR', 'Откат файлов: не удалось вернуть ' + GServerDir + '\service');
    Exit;
  end;
  LogLine('INFO', 'Откат файлов: файлы возвращены из ' + GLastRollbackDir);
  Result := True;
end;

{ Восстановление БД из архива ce3ab836: _system.db и networks\<uuid>\data.db.
  Только из архива ЭТОГО запуска (GLastBackupDir). LatestBackupDir — самый
  свежий архив прошлых обновлений: он не отражает состояние базы на момент
  остановки службы, и подставлять его в автоматический откат нельзя (потеря
  данных, блокер приёмки bb063ac3). Журналы WAL/SHM текущих файлов удаляются
  до копирования — иначе SQLite применил бы записи неудачного запуска поверх
  восстановленной копии. }
function RestoreDatabaseFromBackup: Boolean;
var
  Archive, Src, Dest, NetworksDir: String;
  FindRec: TFindRec;
begin
  Result := False;
  Archive := GLastBackupDir;
  if Archive = '' then
  begin
    LogLine('WARN', 'Откат БД: архив в этом запуске не создавался — база ' +
      'оставлена как есть; изменения, сделанные после остановки службы, ' +
      'восстановить невозможно');
    Result := True;
    Exit;
  end;
  Src := Archive + '\_system.db';
  Dest := GDataDir + '\_system.db';
  DeleteFile(Dest + '-wal');
  DeleteFile(Dest + '-shm');
  if FileExists(Src) then
  begin
    if not CopyFile(Src, Dest, False) then
    begin
      LogLine('ERROR', 'Откат БД: не удалось вернуть ' + Src + ' в ' + Dest);
      Exit;
    end;
  end;
  NetworksDir := Archive + '\networks';
  if DirExists(NetworksDir) and FindFirst(NetworksDir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') and
           ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) then
        begin
          Src := NetworksDir + '\' + FindRec.Name + '\data.db';
          Dest := GDataDir + '\networks\' + FindRec.Name + '\data.db';
          DeleteFile(Dest + '-wal');
          DeleteFile(Dest + '-shm');
          if FileExists(Src) then
          begin
            if not ForceDirectories(ExtractFileDir(Dest)) then
            begin
              LogLine('ERROR', 'Откат БД: не удалось создать ' +
                ExtractFileDir(Dest));
              Exit;
            end;
            if not CopyFile(Src, Dest, False) then
            begin
              LogLine('ERROR', 'Откат БД: не удалось вернуть ' + Src + ' в ' + Dest);
              Exit;
            end;
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  LogLine('INFO', 'Откат БД: база восстановлена из ' + Archive);
  Result := True;
end;

{ Откат после неудачного обновления: остановить службу, вернуть файлы из
  снимка, восстановить БД из архива этого запуска, запустить прежнюю версию
  и повторить health-check (без требования целевой версии — работает же
  прежняя). Возвращает True, когда файлы и БД восстановлены; причина неудачи
  отката дописывается в GFailureReason вместе с путями к архиву, снимку и
  журналу и прямым указанием, что записи после остановки службы теряются
  (сценарий ed2e42df). }
function RollbackAfterFailure: Boolean;
var
  Reason, Archive, Detail: String;
  FilesOk, DbOk: Boolean;
begin
  Result := False;
  if GLastRollbackDir = '' then
  begin
    LogLine('INFO', 'Откат не требуется: снимка нет (первая установка или ' +
      'ремонт без замены файлов)');
    Exit;
  end;
  SetInstallStage('Откат обновления…');
  LogLine('WARN', 'Откат: начинается (' + GFailureReason + ')');
  { Служба могла успеть запуститься на новой версии (health-check не прошёл):
    перед возвратом файлов её нужно остановить снова. }
  StopServiceForUpdate(Reason);
  FilesOk := RestoreInstallFiles;
  DbOk := RestoreDatabaseFromBackup;
  Archive := GLastBackupDir;
  Detail := '';
  if not FilesOk then Detail := 'файлы не восстановлены';
  if not DbOk then
  begin
    if Detail <> '' then Detail := Detail + ', ';
    Detail := Detail + 'БД не восстановлена';
  end;
  if FilesOk and DbOk then
  begin
    LogLine('INFO', 'Откат выполнен: файлы возвращены из ' + GLastRollbackDir +
      IfStr(Archive = '', '; архив БД не создавался — база оставлена как есть',
        '; БД восстановлена из ' + Archive));
    GFailureReason := GFailureReason + '. Откат выполнен: файлы возвращены из ' +
      GLastRollbackDir +
      IfStr(Archive = '', ', архив БД не создавался — база оставлена как есть',
        ', база восстановлена из ' + Archive) + '.';
    { Окно потерь (сценарий ed2e42df): архив создаётся после остановки службы
      и до замены файлов, поэтому записи неудачного запуска не сохраняются. }
    if Archive = '' then
      GFailureReason := GFailureReason +
        ' Изменения, сделанные в базу после остановки службы, восстановить невозможно.'
    else
      GFailureReason := GFailureReason +
        ' Данные, записанные после создания архива (неудачный запуск), ' +
        'потеряны.';
    Result := True;
  end
  else
  begin
    LogLine('ERROR', 'Откат не выполнен: ' + Detail + '; архив: ' +
      IfStr(Archive = '', 'не создавался', Archive) + '; снимок: ' +
      GLastRollbackDir + '; журнал: ' + GLogPath);
    GFailureReason := GFailureReason + '. Откат не выполнен (' + Detail +
      '). Архив: ' + IfStr(Archive = '', 'не создавался', Archive) +
      '. Снимок: ' + GLastRollbackDir + '. Журнал: ' + GLogPath +
      '. Данные, записанные после остановки службы, могут быть потеряны: ' +
      'восстановите базу из архива вручную (инструкция в журнале).';
  end;
  if not StartServiceIfNeeded then
    LogLine('WARN', 'Откат: служба не запустилась');
  if not HealthCheckApplicable then
    LogLine('INFO', 'Откат: режим app — health-check не выполняется ' +
      '(сервер запускается пользователем)')
  else if ProbeHealth(False) then
    LogLine('INFO', 'Откат: прежняя версия отвечает на health-check')
  else
    LogLine('WARN', 'Откат: прежняя версия не отвечает (' + GHealthReason + ')');
end;

{ Вызывается ли бэкап: только при смене версии (карточка bb063ac3). Ремонт
  той же версии — без архива; установка поверх существующих данных без записи
  установки (adopt, первая установка) — тоже без архива: прежней версии нет,
  менять нечего, данные установщик не трогает. }
function BackupNeeded: Boolean;
var
  Old: String;
begin
  Result := False;
  if GSkipCopy then Exit;
  Old := GInstalledVersion;
  if Old = '' then Old := GFilesVersion;
  if Old = '' then
  begin
    LogLine('INFO', 'Бэкап БД: прежняя версия неизвестна (первая установка) — ' +
      'архив не требуется');
    Exit;
  end;
  if SemverCompare(Old, GProductVersion) = 0 then
  begin
    LogLine('INFO', 'Бэкап БД: смена версии не требуется — архив не создаётся');
    Exit;
  end;
  Result := True;
end;

{ ---------------------------------------------------------------------------
  Фазы обновления до копирования файлов — задача bb063ac3.
  Порядок обязателен: остановка службы → бэкап БД → снимок отката. Копирование
  файлов выполняет Inno уже после возврата из этого вызова (ssInstall).
  Возвращает код контракта: 0 — можно копировать, 20 — предусловие,
  10 — сбой выполнения (файлы не тронуты).
  --------------------------------------------------------------------------- }
function PrepareServerUpdate(var Reason: String): Integer;
begin
  Result := EXIT_OK;
  Reason := '';
  if not GDoPrivilegedWork then Exit;
  if GSkipCopy then
  begin
    LogLine('INFO', 'Обновление: та же версия, файлы не заменяются — ' +
      'служба не останавливается, бэкап не создаётся');
    Exit;
  end;
  SetInstallStage('Остановка службы ETN…');
  if not StopServiceForUpdate(Reason) then
  begin
    Result := EXIT_PRECONDITION;
    Exit;
  end;
  if BackupNeeded then
  begin
    { Подпись этапа «Резервная копия баз данных…» ставит CreateDatabaseBackup. }
    if not CreateDatabaseBackup(True) then
    begin
      { Сценарий bc7cc846: причина, требуемый объём и путь к журналу. }
      Reason := 'резервная копия баз данных не создана: ' +
        IfStr(GBackupReason = '', 'причина в журнале', GBackupReason) +
        '; требуется свободного места: ' + FormatSizeBytes(DatabaseBackupSizeBytes) +
        ' (' + GDataDir + '\backups); журнал: ' + GLogPath +
        ' — обновление отменено, файлы не заменялись';
      { Служба уже остановлена — возвращаем её: сервер обязан работать на
        прежней версии (сценарий bc7cc846). }
      if not StartServiceIfNeeded then
        LogLine('WARN', 'Не удалось вернуть службу после неудачного бэкапа');
      Result := EXIT_FAILED;
      Exit;
    end;
  end;
  if not CreateRollbackSnapshot then
  begin
    Reason := 'снимок отката не создан: ' + RollbackRoot +
      ' — обновление отменено, файлы не заменялись (причина в журнале)';
    if not StartServiceIfNeeded then
      LogLine('WARN', 'Не удалось вернуть службу после неудачного снимка');
    Result := EXIT_FAILED;
    Exit;
  end;
end;

{ Успешное обновление: копия отката больше не нужна — удаляется вместе со
  всеми прежними снимками (хранится только копия последнего запуска).
  Ошибка удаления установку не отменяет — снимок остаётся точкой ручного
  восстановления. }
procedure CleanupRollbackSnapshot;
var
  Keep: String;
begin
  Keep := '';
  if GLastRollbackDir <> '' then
  begin
    if DelTree(GLastRollbackDir, True, True, True) then
    begin
      LogLine('INFO', 'Снимок отката удалён после успешного обновления: ' +
        GLastRollbackDir);
      GLastRollbackDir := '';
    end
    else
    begin
      Keep := GLastRollbackDir;
      LogLine('WARN', 'Снимок отката не удалось удалить: ' + GLastRollbackDir +
        ' — оставлен до следующего успешного обновления');
    end;
  end;
  CleanupRollbackSnapshotsExcept(Keep);
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
  WriteReasonFile(Reason);
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

{ Проверка занятости порта перечисляет ВСЕХ слушателей на порту
  (Get-NetTCPConnection по всем адресам): пробный bind только на 0.0.0.0
  не видит чужой процесс, слушающий 127.0.0.1 или конкретный адрес локальной
  сети, — дефект B1 приёмки 9b310991 (установщик считал порт свободным,
  health-check попадал в чужой процесс). Слушатели собственной службы ETN
  занятостью не считаются: службу останавливает привилегированная фаза
  (bb063ac3). WinSW 2.x запускает сервер дочерним процессом, поэтому
  владелец сокета сравнивается не только с ProcessId службы, но и с её
  потомками до 4 уровней (иначе при обновлении поверх работающей установки
  порт ошибочно считался бы занятым чужим).
  Скрипт передаётся в powershell.exe как -Command "<скрипт>"; вложенные
  ДВОЙНЫЕ кавычки разбор командной строки срезает — фильтр CIM становится
  невалидным, служба не находится (дефект B3 той же приёмки). Поэтому внутри
  скрипта только одинарные кавычки, а имя службы подставляется переменной.
  IPv6: ETN_HOST в 0.15.1 — только IPv4, поэтому IPv6-слушатели в перебор не
  входят (IPv6-only слушатель серверу не мешает); dual-stack `::` показывается
  в Get-NetTCPConnection и ловится перебором адресов. Если сервер начнёт
  слушать IPv6, перечисление надо расширить.
  Если командлет недоступен или IPv4-слушателей нет, порт проверяется без
  пробного bind на все интерфейсы: зарезервированные диапазоны (Hyper-V/WinNAT,
  TIME_WAIT после перезапуска) читаются из netsh, затем пробный bind на
  127.0.0.1 (loopback). Пробный bind 0.0.0.0 вызывал диалог Windows Security
  «Allow для Windows PowerShell» прямо во время установки (ошибка 860def0d,
  п.4).
  Возвращает 0 — свободен (или держит служба ETN), 1 — занят, 2 — проверить
  не удалось. Тестовые хуки (только TestMode): TESTSERVICENAME подменяет имя
  службы, и скрипт возвращает 0/2 по факту её нахождения (поведенческая проба
  CIM-запроса); TESTOWNSERVICEPID задаёт PID «своей» службы вместо CIM-запроса
  (поведенческая проба сравнения владельцев и цепочки потомков). }
function ServerPortStatus(const Port: String): Integer;
var
  Script, Args, SvcName, SvcNameLiteral, SvcProbe, OwnSeed: String;
  Code: Integer;
begin
  Result := 2;
  SvcName := SERVICE_NAME;
  SvcProbe := '0';
  OwnSeed := '0';
#ifdef TestMode
  if GTestServiceName <> '' then
  begin
    SvcName := GTestServiceName;
    SvcProbe := '1';
  end;
  { Валидация PID: строка из параметра идёт в скрипт только если это число. }
  if StrToIntDef(GTestOwnServicePid, 0) > 0 then
    OwnSeed := IntToStr(StrToIntDef(GTestOwnServicePid, 0));
#endif
  { Имя службы — в одинарные кавычки PowerShell; кавычки внутри имени
    удваиваются (правило PS-литерала). Двойных кавычек в скрипте нет. }
  SvcNameLiteral := SvcName;
  StringChangeEx(SvcNameLiteral, '''', '''''', True);
  Script :=
    '$ErrorActionPreference=''SilentlyContinue'';$port=' + Port + ';' +
    '$svcName=''' + SvcNameLiteral + ''';' +
    '$svcProbe=' + SvcProbe + ';$ownSeed=' + OwnSeed + ';' +
    '$svcFound=0;$own=@();' +
    'if($ownSeed -gt 0){$own+=$ownSeed}' +
    'else{try{$svc=Get-CimInstance Win32_Service|' +
    'Where-Object{$_.Name -eq $svcName}|Select-Object -First 1;' +
    'if($svc -and ([int]$svc.ProcessId -gt 0)){$svcFound=1;' +
    '$own+=[int]$svc.ProcessId}}catch{}};' +
    'if($svcProbe -eq 1){if($svcFound -eq 1){exit 0};exit 2};' +
    'if($own.Count -gt 0){$procs=@(Get-CimInstance Win32_Process);' +
    '$front=@($own);' +
    'for($d=0;$d -lt 4 -and $front.Count -gt 0;$d++){' +
    '$next=@();foreach($p in $procs){' +
    'if($front -contains [int]$p.ParentProcessId){' +
    '$own+=[int]$p.ProcessId;$next+=[int]$p.ProcessId}};' +
    '$front=$next}};' +
    '$v4=$null;' +
    'try{$v4=@(Get-NetTCPConnection -LocalPort $port -State Listen ' +
    '-ErrorAction Stop|Where-Object{$_.LocalAddress -notmatch '':''})}catch{};' +
    'if($null -ne $v4 -and $v4.Count -gt 0){' +
    '$foreign=@($v4|Where-Object{$own -notcontains [int]$_.OwningProcess});' +
    'if($foreign.Count -eq 0){exit 0};exit 1};' +
    { Порт в зарезервированном диапазоне (Hyper-V/WinNAT, TIME_WAIT после
      перезапуска) слушателя не имеет, но bind на 0.0.0.0 для него закрыт.
      Раньше это ловилось пробным bind на все интерфейсы — он и вызывал диалог
      Windows Security «Allow для Windows PowerShell» во время установки.
      Диапазоны читаем через netsh, пробный bind остаётся только на loopback
      (loopback диалога не вызывает). Ошибка 860def0d, п.4. }
    'try{$ex=@(netsh int ipv4 show excludedportrange protocol=tcp)}catch{$ex=@()};' +
    'foreach($ln in $ex){$t=@(($ln.Trim()) -split ''\s+'');' +
    'if($t.Count -ge 2){$a=0;$b=0;' +
    'if([int]::TryParse($t[0],[ref]$a)){if([int]::TryParse($t[1],[ref]$b)){' +
    'if(($port -ge $a) -and ($port -le $b)){exit 1}}}}}' +
    'try{$l=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$port);' +
    '$l.Start();$l.Stop()}catch{exit 1};' +
    'exit 0';
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
  Path := ServiceDir + '\service\etn-service.xml';
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
  if LowerCase(GTestFirewall) = 'fail' then
  begin
    LogLine('INFO', 'FIREWALL (тестовый режим, имитация сбоя netsh): ' + Args);
    Exit;
  end;
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
  netsh установку не отменяет: сервер слушает 0.0.0.0 (ETN_HOST при включённом
  чекбоксе), но подключения из локальной сети могут блокироваться брандмауэром
  Windows. Предупреждение пишется в журнал и (в GUI) на финальный экран. }
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
  begin
    GFirewallWarning := True;
    LogLine('WARN', 'Брандмауэр: правило «' + FIREWALL_RULE_NAME + '» не создано ' +
      '(TCP ' + GServerPort + '). Установка продолжается: сервер слушает ' +
      GServerHost + ', но подключения с других компьютеров могут блокироваться ' +
      'брандмауэром Windows. Причина — в журнале установки.');
  end;
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
#ifdef TestMode
  { /TESTUSERINSTALL=1 — установка клиента «только для меня» без окон.
    Silent-контракт ставит только сервер (клиент запрещён), поэтому ветки
    Files и Icons для клиента иначе не проверяются. Тест ставит только клиента:
    серверные предусловия (install.json, служба, порт) не применяются,
    GServerSelected снимается — серверные файлы не копируются. GSilent
    остаётся True: мастер не создаётся, установка идёт как silent. }
  if GTestUserInstall = '1' then
  begin
    GServerSelected := False;
    GClientSelected := True;
    GClientScopeUser := True;
    LogLine('INFO', 'TESTUSERINSTALL=1: silent-предусловия пропущены — ставится только клиент «для меня»');
    Exit;
  end;
#endif
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
  Экран ошибки и итоговая сводка (112642a4)
  --------------------------------------------------------------------------- }
function FailureReasonText: String;
begin
  if GFailureReason <> '' then
    Result := GFailureReason
  else
    Result := 'причина не записана — смотрите журнал установки';
end;

{ Возврат на экран компонентов: отказ UAC и ошибка удаления старого клиента
  не должны выбрасывать пользователя из мастера — выбор компонентов
  сохраняется. Перейти на страницу напрямую Inno не даёт, поэтому «Назад»
  нажимается программно. }
procedure ReturnToComponentsPage;
var
  Guard: Integer;
begin
  if (WizardForm = nil) or (GComponentsPage = nil) then Exit;
  Guard := 0;
  while (WizardForm.CurPageID <> GComponentsPage.ID) and (Guard < 20) do
  begin
    WizardForm.BackButton.OnClick(WizardForm.BackButton);
    Guard := Guard + 1;
  end;
end;

{ Свободный порт рядом с занятым: подсказка на экране параметров. Поле не
  меняется — решение за пользователем. Пустая строка — свободного рядом нет. }
function SuggestFreePort(const BasePort: String): String;
var
  Base, I, Candidate: Integer;
begin
  Result := '';
  Base := StrToIntDef(Trim(BasePort), 0);
  if Base <= 0 then Exit;
  for I := 1 to 20 do
  begin
    Candidate := Base + I;
    if Candidate > MAX_PORT then Break;
    if ServerPortStatus(IntToStr(Candidate)) = 0 then
    begin
      Result := IntToStr(Candidate);
      Exit;
    end;
  end;
end;

procedure OpenLogClick(Sender: TObject);
begin
  OpenPath(GLogPath);
end;

procedure OpenDataDirClick(Sender: TObject);
begin
  OpenPath(GDataDir);
end;

procedure RunClientClick(Sender: TObject);
var
  Exe: String;
  Code: Integer;
begin
  Exe := ClientExePath;
  if Exe = '' then Exit;
  { Клиент — обычное приложение пользователя, а не служба: запускаем от
    исходного пользователя, даже если установщик повышал права. Иначе клиент
    открылся бы в профиле другого администратора (режим app). }
  if ShellExecAsOriginalUser('open', Exe, '', ExtractFileDir(Exe),
    SW_SHOWNORMAL, ewNoWait, Code) then
    LogLine('INFO', 'Клиент запущен от исходного пользователя: ' + Exe)
  else
  begin
    LogLine('WARN', 'ShellExecAsOriginalUser не сработал, запуск через оболочку: ' + Exe);
    OpenPath(Exe);
  end;
end;

{ «Повторить установку» на экране ошибки: запускает установщик заново и
  закрывает текущий. Состояние машины уже записано (файлы, install.json),
  поэтому повторный запуск увидит repair/update и продолжит с того же места. }
procedure RetryInstallClick(Sender: TObject);
var
  Code: Integer;
begin
  if not ShellExec('open', ExpandConstant('{srcexe}'), '', '',
    SW_SHOWNORMAL, ewNoWait, Code) then
  begin
    SuppressibleMsgBox('Не удалось запустить установщик заново: ' +
      ExpandConstant('{srcexe}') + #13#10 + 'Запустите его вручную.',
      mbError, MB_OK, IDOK);
    Exit;
  end;
  LogLine('INFO', 'Экран ошибки: установщик запущен заново');
  if WizardForm <> nil then WizardForm.Close;
end;

{ Архив для экрана ошибки/сводки. Показывается только архив этого запуска;
  архив прошлых обновлений помечается явно: он не отражает состояние базы и
  для автоматического отката не используется (замечание приёмки bb063ac3). }
function BackupPathForMessage(const Prefix, Suffix: String): String;
var
  Backup: String;
begin
  if GLastBackupDir <> '' then
    Result := Prefix + GLastBackupDir + Suffix
  else
  begin
    Backup := LatestBackupDir;
    if Backup <> '' then
      Result := Prefix + Backup +
        ' (архив прошлого обновления — для автоматического отката не используется)' +
        Suffix
    else
      Result := Prefix + 'не создавалась' + Suffix;
  end;
end;

function ErrorMemoText: String;
var
  S: String;
begin
  S := 'Установка ETN ' + GProductVersion + ' не завершена.' + #13#10#13#10 +
    'Причина: ' + FailureReasonText + '.' + #13#10#13#10 +
    'Журнал установки: ' + IfStr(GLogPath = '', '(журнал не создан)', GLogPath) + #13#10;
  S := S + BackupPathForMessage('Резервная копия баз данных: ', #13#10);
  S := S + #13#10 +
    'Следующий шаг: устраните причину и запустите установщик снова — ' +
    'параметры и данные сохранятся. Если установка не запускается, приложите ' +
    'журнал установки к обращению в поддержку.';
  Result := S;
end;

function SummaryText: String;
var
  S, Exe, Ipv4: String;
begin
  S := 'Установка ETN ' + GProductVersion + ' завершена.' + #13#10#13#10;
  if GServerSelected then
  begin
    S := S + 'Сервер ETN установлен.' + #13#10;
    S := S + 'Адрес на этом компьютере: http://127.0.0.1:' + GServerPort + #13#10;
    if GServerFirewall then
    begin
      Ipv4 := DetectLanIp;
      if Ipv4 <> '' then
        S := S + 'Адрес в локальной сети: http://' + Ipv4 + ':' + GServerPort +
          ' (если на компьютере есть VPN или несколько сетей, адрес может ' +
          'отличаться — проверьте его в «Параметрах сети»)' + #13#10
      else
        S := S + 'Адрес в локальной сети: определить не удалось (порт ' +
          GServerPort + ' открыт брандмауэром)' + #13#10;
      if GFirewallWarning then
        S := S + 'Внимание: правило брандмауэра Windows не создано — подключения ' +
          'с других компьютеров могут блокироваться. Причина указана в журнале.' + #13#10;
    end
    else
      S := S + 'Подключения с других компьютеров отключены (только этот компьютер).' + #13#10;
    S := S + 'Каталог данных: ' + GDataDir + #13#10;
  end;
  { Клиент упоминается в сводке только когда он выбран: иначе найденный в
    каталоге программы файл мог бы оказаться старым NSIS-клиентом, который
    установщик не заменял (замечание приёмки 112642a4). }
  if GClientSelected then
  begin
    Exe := ClientExePath;
    if Exe <> '' then
      S := S + 'Клиент ETN: ' + Exe + #13#10;
  end;
  { Архив этого запуска; если его нет, а в backups что-то есть — архив
    прошлого обновления с явной пометкой (не для отката). }
  if (GLastBackupDir <> '') or (LatestBackupDir <> '') then
    S := S + BackupPathForMessage('Резервная копия баз данных: ', #13#10);
  S := S + 'Журнал установки: ' + IfStr(GLogPath = '', '(не создан)', GLogPath) + #13#10;
  if GKeyWasShown then
    S := S + #13#10 + 'Ключ администратора показывался на предыдущем экране: ' +
      'сохраните его в надёжном месте — восстановить ключ нельзя, только ' +
      'выпустить новый.';
  Result := S;
end;

{ Экран ошибки — после экрана ключа: ключ показывается всегда, даже если
  установка сорвалась после init (восстановить его нельзя). }
procedure CreateErrorPage;
begin
  GErrorPage := CreateCustomPage(GKeyPage.ID, 'Установка не завершена',
    'Установка ETN прервана. Ниже — причина, журнал, резервная копия и ' +
    'следующий шаг.');

  GErrorMemo := TNewMemo.Create(GErrorPage);
  GErrorMemo.Parent := GErrorPage.Surface;
  GErrorMemo.Left := 0;
  GErrorMemo.Top := 0;
  GErrorMemo.Width := GErrorPage.SurfaceWidth;
  GErrorMemo.Height := GErrorPage.SurfaceHeight - ScaleY(44);
  GErrorMemo.ReadOnly := True;
  GErrorMemo.WordWrap := True;
  GErrorMemo.ScrollBars := ssVertical;
  GErrorMemo.Font.Name := 'Segoe UI';
  GErrorMemo.Font.Size := 9;

  GErrorOpenLogButton := TNewButton.Create(GErrorPage);
  GErrorOpenLogButton.Parent := GErrorPage.Surface;
  GErrorOpenLogButton.Left := 0;
  GErrorOpenLogButton.Top := GErrorMemo.Top + GErrorMemo.Height + ScaleY(8);
  GErrorOpenLogButton.Width := ScaleX(130);
  GErrorOpenLogButton.Caption := 'Открыть журнал';
  GErrorOpenLogButton.OnClick := @OpenLogClick;

  GErrorOpenDataButton := TNewButton.Create(GErrorPage);
  GErrorOpenDataButton.Parent := GErrorPage.Surface;
  GErrorOpenDataButton.Left := GErrorOpenLogButton.Width + ScaleX(8);
  GErrorOpenDataButton.Top := GErrorOpenLogButton.Top;
  GErrorOpenDataButton.Width := ScaleX(150);
  GErrorOpenDataButton.Caption := 'Открыть папку данных';
  GErrorOpenDataButton.OnClick := @OpenDataDirClick;

  GErrorRetryButton := TNewButton.Create(GErrorPage);
  GErrorRetryButton.Parent := GErrorPage.Surface;
  GErrorRetryButton.Left := GErrorOpenDataButton.Left + GErrorOpenDataButton.Width +
    ScaleX(8);
  GErrorRetryButton.Top := GErrorOpenLogButton.Top;
  GErrorRetryButton.Width := ScaleX(170);
  GErrorRetryButton.Caption := 'Повторить установку';
  GErrorRetryButton.OnClick := @RetryInstallClick;
end;

{ Сводка на стандартной странице завершения: свой memo вместо FinishedLabel
  (у него одна строка без переносов) и кнопки действий. Геометрия берётся у
  FinishedLabel: страница завершения — на всю ширину окна и слева у неё
  декоративная полоса; memo от Left=0 перекрывал её (ошибка 860def0d, п.10).
  Кнопки — в две строки: три кнопки в ряд шире области контента (362 px). }
procedure CreateFinishedControls;
var
  BtnTop: Integer;
begin
  if (WizardForm = nil) or (GSummaryMemo <> nil) then Exit;

  GSummaryRunButton := TNewButton.Create(WizardForm);
  GSummaryRunButton.Parent := WizardForm.FinishedPage;
  GSummaryRunButton.Left := WizardForm.FinishedLabel.Left;
  GSummaryRunButton.Width := ScaleX(130);
  GSummaryRunButton.Caption := 'Запустить клиент';
  GSummaryRunButton.OnClick := @RunClientClick;

  GSummaryDataButton := TNewButton.Create(WizardForm);
  GSummaryDataButton.Parent := WizardForm.FinishedPage;
  GSummaryDataButton.Left := GSummaryRunButton.Left + GSummaryRunButton.Width +
    ScaleX(8);
  GSummaryDataButton.Top := 0;
  GSummaryDataButton.Width := ScaleX(150);
  GSummaryDataButton.Caption := 'Открыть папку данных';
  GSummaryDataButton.OnClick := @OpenDataDirClick;

  GSummaryLogButton := TNewButton.Create(WizardForm);
  GSummaryLogButton.Parent := WizardForm.FinishedPage;
  GSummaryLogButton.Left := WizardForm.FinishedLabel.Left;
  GSummaryLogButton.Width := ScaleX(130);
  GSummaryLogButton.Caption := 'Открыть журнал';
  GSummaryLogButton.OnClick := @OpenLogClick;

  { Нижняя строка кнопок — у нижнего края страницы, верхняя — над ней. }
  BtnTop := WizardForm.FinishedPage.ClientHeight - ScaleY(26);
  GSummaryLogButton.Top := BtnTop;
  GSummaryRunButton.Top := BtnTop - GSummaryLogButton.Height - ScaleY(6);
  GSummaryDataButton.Top := GSummaryRunButton.Top;

  GSummaryMemo := TNewMemo.Create(WizardForm);
  GSummaryMemo.Parent := WizardForm.FinishedPage;
  GSummaryMemo.Left := WizardForm.FinishedLabel.Left;
  GSummaryMemo.Top := WizardForm.FinishedLabel.Top;
  GSummaryMemo.Width := WizardForm.FinishedLabel.Width;
  GSummaryMemo.Height := GSummaryRunButton.Top - GSummaryMemo.Top - ScaleY(8);
  GSummaryMemo.ReadOnly := True;
  GSummaryMemo.WordWrap := True;
  GSummaryMemo.ScrollBars := ssVertical;
  GSummaryMemo.Font.Name := 'Segoe UI';
  GSummaryMemo.Font.Size := 9;
  { Стандартная подпись завершения остаётся под memo: её текст — не сводка и
    просвечивал бы сквозь/из-под memo. Геометрия снята с неё до скрытия. }
  WizardForm.FinishedLabel.Visible := False;
end;

{ ---------------------------------------------------------------------------
  Экран компонентов — первый экран и приветствие (112642a4)
  --------------------------------------------------------------------------- }
{ Подписи компонентов зависят от состояния машины (спека, экран 1). }
function ServerCheckCaption: String;
begin
  if GServerState = 'not-installed' then
    Result := 'Установить сервер ETN'
  else if GServerState = 'update-available' then
    Result := 'Обновить сервер ETN: ' + GInstalledVersion + ' → ' + GProductVersion
  else if GServerState = 'installed' then
    Result := 'Переустановить сервер ETN ' + GProductVersion
  else if GServerState = 'repair' then
    Result := 'Восстановить сервер ETN'
  else if GServerState = 'adopt' then
    Result := 'Установить сервер ETN и подключить существующие данные'
  else
    Result := 'Сервер ETN (установлена более новая версия)';
end;

function ClientCheckCaption: String;
begin
  if GClientState = 'installed' then
    Result := 'Переустановить клиент ETN'
  else
    Result := 'Установить клиент ETN';
end;

{ Единая точка чтения выбора: вызывается обработчиками OnClick всех контролов
  (чекбоксы компонентов, радиокнопки области клиента, чекбокс лицензии) и
  тестовым хуком /TESTSELECT. Область клиента читается с радиокнопок — без
  обработчика на них выбор «для всех» не влиял бы на элевацию (NeedElevation). }
procedure ApplySelection(const ServerChecked, ClientChecked,
  MachineScopeChecked: Boolean);
begin
  GServerSelected := ServerChecked;
  GClientSelected := ClientChecked;
  GClientScopeUser := not MachineScopeChecked;
end;

{ Разложить контролы экрана компонентов сверху вниз по ФАКТИЧЕСКИМ высотам.
  Вызывается после каждой смены подписей (UpdateComponentsState): высота
  зависит от переноса текста, а раскладка, посчитанная один раз при создании,
  при росте подписей давала наложение и «мелькающие остатки» (ошибка
  860def0d, п.1). Скрытые контролы места не занимают; позиция им всё равно
  назначается — при показе они встанут на своё место. }
procedure LayoutComponentsPage;
var
  Y: Integer;
begin
  if (GComponentsPage = nil) or (GServerCheck = nil) then Exit;
  Y := 0;
  GServerCheck.Top := Y;
  Y := Y + GServerCheck.Height + ScaleY(2);

  if GServerStateLabel <> nil then
  begin
    GServerStateLabel.Top := Y;
    Y := Y + GServerStateLabel.Height + ScaleY(4);
  end;
  if GServerHintLabel <> nil then
  begin
    GServerHintLabel.Top := Y;
    Y := Y + GServerHintLabel.Height + ScaleY(4);
  end;
  if GServerAltLink <> nil then
  begin
    GServerAltLink.Top := Y;
    Y := Y + GServerAltLink.Height + ScaleY(6);
  end;

  if GClientCheck <> nil then
  begin
    GClientCheck.Top := Y;
    Y := Y + GClientCheck.Height + ScaleY(2);
  end;
  if GClientStateLabel <> nil then
  begin
    GClientStateLabel.Top := Y;
    Y := Y + GClientStateLabel.Height + ScaleY(2);
  end;
  if GClientHintLabel <> nil then
  begin
    GClientHintLabel.Top := Y;
    Y := Y + GClientHintLabel.Height + ScaleY(4);
  end;

  { Область клиента — одна строка: радиокнопки стоят рядом (см.
    CreateComponentsPage), при обновлении на их месте поясняющий текст
    (ea8e223a). }
  if GScopeFixedLabel <> nil then
  begin
    GScopeFixedLabel.Top := Y;
    if GScopeFixedLabel.Visible then
      Y := Y + GScopeFixedLabel.Height + ScaleY(4);
  end;
  if GScopeUserRadio <> nil then GScopeUserRadio.Top := Y;
  if GScopeMachineRadio <> nil then GScopeMachineRadio.Top := Y;
  if (GScopeUserRadio <> nil) and GScopeUserRadio.Visible then
    Y := Y + GScopeUserRadio.Height + ScaleY(4);
  if GScopeHintLabel <> nil then
  begin
    GScopeHintLabel.Top := Y;
    if GScopeHintLabel.Visible then
      Y := Y + GScopeHintLabel.Height + ScaleY(4);
  end;

  if GDataNoteLabel <> nil then
  begin
    GDataNoteLabel.Top := Y;
    Y := Y + GDataNoteLabel.Height + ScaleY(4);
  end;
  if (GLicenseCheck <> nil) and GLicenseCheck.Visible then
  begin
    GLicenseCheck.Top := Y;
    if GLicenseLink <> nil then
      GLicenseLink.Top := Y + ScaleY(2);
    Y := Y + GLicenseCheck.Height + ScaleY(6);
  end;
  if GReasonLabel <> nil then
  begin
    GReasonLabel.Top := Y;
    Y := Y + GReasonLabel.Height;
  end;
end;

procedure UpdateComponentsState(Sender: TObject);
begin
  if GSilent or (not GComponentsReady) then Exit;
  if (GServerCheck <> nil) and (GClientCheck <> nil) and (GScopeMachineRadio <> nil) then
    ApplySelection(GServerCheck.Checked, GClientCheck.Checked, GScopeMachineRadio.Checked);
  if GLicenseCheck <> nil then
    GLicenseAccepted := GLicenseCheck.Checked;
  { Область клиента: на обновлении она фиксирована — радиокнопки не просто
    неактивны, а не показываются; выбранная область выводится текстом
    (ea8e223a, 4a66b7a5; замечание приёмки 98ad5eec). На первой установке
    радиокнопки видны и доступны только при выбранном клиенте. }
  if GScopeUserRadio <> nil then
  begin
    GScopeUserRadio.Visible := ClientScopeRadiosVisible;
    GScopeUserRadio.Enabled := GClientSelected;
  end;
  if GScopeMachineRadio <> nil then
  begin
    GScopeMachineRadio.Visible := ClientScopeRadiosVisible;
    GScopeMachineRadio.Enabled := GClientSelected;
  end;
  if GScopeFixedLabel <> nil then
  begin
    GScopeFixedLabel.Visible := ClientScopeFixed;
    if ClientScopeFixed then
    begin
      GScopeFixedLabel.Caption := ClientScopeText;
      FitLabel(GScopeFixedLabel);
    end;
  end;
  if GServerHintLabel <> nil then
  begin
    GServerHintLabel.Caption :=
      'Сервер хранит графовые базы знаний на этом компьютере и отдаёт к ним ' +
      'доступ по сети. Node.js входит в установку.';
    FitLabel(GServerHintLabel);
  end;
  if GServerCheck <> nil then GServerCheck.Caption := ServerCheckCaption;
  if GClientCheck <> nil then GClientCheck.Caption := ClientCheckCaption;
  { Текст состояния клиента зависит от выбора: обещание удалить старый
    NSIS-клиент — только когда клиент действительно выбран (замечание приёмки
    112642a4). }
  if GClientStateLabel <> nil then
  begin
    GClientStateLabel.Caption := ClientStateText;
    FitLabel(GClientStateLabel);
  end;
  if GClientHintLabel <> nil then
  begin
    if GClientSelected and (not GServerSelected) then
      GClientHintLabel.Caption :=
        'Сервер не выбран: при первом запуске понадобится адрес существующего ' +
        'сервера и ключ. Профили, серверы и ключи у каждого пользователя свои.'
    else
      GClientHintLabel.Caption :=
        'Клиент — окно для работы с базами; нужны адрес сервера и ключ.';
    { Каталог установки виден до начала установки: область клиента меняет и
      его, а отдельного экрана каталога нет (ADR 144bcdb0). }
    if GClientSelected then
      GClientHintLabel.Caption := GClientHintLabel.Caption + ' Каталог установки: ' +
        ClientInstallPath + '.';
    FitLabel(GClientHintLabel);
  end;
  { Чем «только для меня» отличается от «для всех пользователей» (п.2
    ошибки 860def0d): подсказка показывается, пока выбор области доступен. }
  if GScopeHintLabel <> nil then
  begin
    GScopeHintLabel.Caption :=
      '«Только для меня» — клиент в вашем профиле, права администратора не ' +
      'нужны. «Для всех пользователей» — в Program Files, нужны права ' +
      'администратора.';
    FitLabel(GScopeHintLabel);
    GScopeHintLabel.Visible := ClientScopeRadiosVisible and GClientSelected;
  end;
  if GReasonLabel <> nil then
  begin
    if GBlockedDowngrade then
      GReasonLabel.Caption := 'Установлена более новая версия ' + ServerVersionText +
        ' — понижение версии не поддерживается. Доступна только отмена.'
    else if GComponentsNotice <> '' then
      GReasonLabel.Caption := GComponentsNotice
    else if (not GServerSelected) and (not GClientSelected) then
      GReasonLabel.Caption := 'Выберите хотя бы один компонент.'
    else if LicensePromptNeeded and (not GLicenseAccepted) then
      GReasonLabel.Caption := 'Примите условия лицензии MIT, чтобы продолжить.'
    else
      GReasonLabel.Caption := '';
    FitLabel(GReasonLabel);
  end;
  { Раскладка — после подписей и высот: иначе выросшая подпись наезжает на
    следующие контролы (ошибка 860def0d, п.1). }
  LayoutComponentsPage;
  if WizardForm <> nil then
    WizardForm.NextButton.Enabled :=
      (not GBlockedDowngrade) and (GServerSelected or GClientSelected) and
      ((not LicensePromptNeeded) or GLicenseAccepted);
end;

{ Изменение выбора пользователем: уведомление после отказа UAC или ошибки
  удаления старого клиента больше не актуально. }
procedure ComponentsChanged(Sender: TObject);
begin
  GComponentsNotice := '';
  UpdateComponentsState(Sender);
end;

procedure CreateComponentsPage;
begin
  { До переноса начального выбора экран не готов: программная установка Checked
    вызывает OnClick, и ранний обработчик снял бы выбор клиента. }
  GComponentsReady := False;
  { Первый экран — приветствие и выбор компонентов (стандартные страницы
    welcome/license отключены в [Setup]). Позиции контролов назначает
    LayoutComponentsPage по фактическим высотам подписей (ошибка 860def0d,
    п.1): текст зависит от состояния машины и выбора, поэтому статическая
    раскладка при создании не годится. }
  GComponentsPage := CreateCustomPage(wpWelcome, 'ETN — установка',
    'Добро пожаловать в ETN: сервер хранит графовые базы знаний на этом ' +
    'компьютере, клиент — окно для работы с ними.');

  GServerCheck := TNewCheckBox.Create(GComponentsPage);
  GServerCheck.Parent := GComponentsPage.Surface;
  GServerCheck.Left := 0;
  GServerCheck.Width := GComponentsPage.SurfaceWidth;
  GServerCheck.Caption := ServerCheckCaption;
  GServerCheck.OnClick := @ComponentsChanged;

  GServerStateLabel := TNewStaticText.Create(GComponentsPage);
  GServerStateLabel.Parent := GComponentsPage.Surface;
  GServerStateLabel.Left := 20;
  GServerStateLabel.AutoSize := False;
  GServerStateLabel.WordWrap := True;
  GServerStateLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GServerStateLabel.Font.Color := clGray;
  GServerStateLabel.Caption := ServerStateText +
    IfStr(InitStateText = '', '', ' ' + InitStateText);
  FitLabel(GServerStateLabel);

  { Что такое сервер (договорённость ТП; ошибка 860def0d, п.2). }
  GServerHintLabel := TNewStaticText.Create(GComponentsPage);
  GServerHintLabel.Parent := GComponentsPage.Surface;
  GServerHintLabel.Left := 20;
  GServerHintLabel.AutoSize := False;
  GServerHintLabel.WordWrap := True;
  GServerHintLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GServerHintLabel.Font.Color := clGray;
  GServerHintLabel.Caption := '';
  FitLabel(GServerHintLabel);

  { Node.js входит в поставку; другие варианты — для опытных (спека, экран 1).
    Подпись ссылки — в одну строку: у TNewLinkLabel нет переноса, и длинный
    текст уходил за правый край страницы (ошибка 860def0d, п.1). }
  GServerAltLink := TNewLinkLabel.Create(GComponentsPage);
  GServerAltLink.Parent := GComponentsPage.Surface;
  GServerAltLink.Left := 20;
  GServerAltLink.Width := GComponentsPage.SurfaceWidth - 20;
  GServerAltLink.Caption := '<a href="server-options">Другие варианты установки ' +
    'сервера (удалённый сервер, Docker)</a>';
  GServerAltLink.OnLinkClick := @OpenServerOptions;

  GClientCheck := TNewCheckBox.Create(GComponentsPage);
  GClientCheck.Parent := GComponentsPage.Surface;
  GClientCheck.Left := 0;
  GClientCheck.Width := GComponentsPage.SurfaceWidth;
  GClientCheck.Caption := ClientCheckCaption;
  GClientCheck.OnClick := @ComponentsChanged;

  GClientStateLabel := TNewStaticText.Create(GComponentsPage);
  GClientStateLabel.Parent := GComponentsPage.Surface;
  GClientStateLabel.Left := 20;
  GClientStateLabel.AutoSize := False;
  GClientStateLabel.WordWrap := True;
  GClientStateLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GClientStateLabel.Font.Color := clGray;
  GClientStateLabel.Caption := ClientStateText;
  FitLabel(GClientStateLabel);

  { Что такое клиент (договорённость ТП; ошибка 860def0d, п.2). }
  GClientHintLabel := TNewStaticText.Create(GComponentsPage);
  GClientHintLabel.Parent := GComponentsPage.Surface;
  GClientHintLabel.Left := 20;
  GClientHintLabel.AutoSize := False;
  GClientHintLabel.WordWrap := True;
  GClientHintLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GClientHintLabel.Font.Color := clGray;
  GClientHintLabel.Caption := '';
  FitLabel(GClientHintLabel);

  { Область клиента: на первой установке — радиокнопки, при обновлении — текст
    в той же области (радиокнопки скрыты: выбор уже сделан, ea8e223a).
    Радиокнопки стоят рядом — подсказка о разнице областей занимает отдельную
    строку и при вертикальном расположении содержимое не помещалось на экран
    (ошибка 860def0d, п.1–2). }
  GScopeFixedLabel := TNewStaticText.Create(GComponentsPage);
  GScopeFixedLabel.Parent := GComponentsPage.Surface;
  GScopeFixedLabel.Left := 20;
  GScopeFixedLabel.AutoSize := False;
  GScopeFixedLabel.WordWrap := True;
  GScopeFixedLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GScopeFixedLabel.Caption := '';
  GScopeFixedLabel.Visible := False;
  FitLabel(GScopeFixedLabel);

  GScopeUserRadio := TNewRadioButton.Create(GComponentsPage);
  GScopeUserRadio.Parent := GComponentsPage.Surface;
  GScopeUserRadio.Left := 20;
  GScopeUserRadio.Width := ScaleX(220);
  GScopeUserRadio.Caption := 'Клиент: только для меня';
  GScopeUserRadio.Checked := True;
  GScopeUserRadio.OnClick := @ComponentsChanged;

  GScopeMachineRadio := TNewRadioButton.Create(GComponentsPage);
  GScopeMachineRadio.Parent := GComponentsPage.Surface;
  GScopeMachineRadio.Left := 20 + ScaleX(230);
  GScopeMachineRadio.Width := GComponentsPage.SurfaceWidth - 20 - ScaleX(230);
  GScopeMachineRadio.Caption := 'Клиент: для всех пользователей';
  GScopeMachineRadio.OnClick := @ComponentsChanged;

  GScopeHintLabel := TNewStaticText.Create(GComponentsPage);
  GScopeHintLabel.Parent := GComponentsPage.Surface;
  GScopeHintLabel.Left := 20;
  GScopeHintLabel.AutoSize := False;
  GScopeHintLabel.WordWrap := True;
  GScopeHintLabel.Width := GComponentsPage.SurfaceWidth - 20;
  GScopeHintLabel.Font.Color := clGray;
  GScopeHintLabel.Caption := '';
  FitLabel(GScopeHintLabel);

  GDataNoteLabel := TNewStaticText.Create(GComponentsPage);
  GDataNoteLabel.Parent := GComponentsPage.Surface;
  GDataNoteLabel.Left := 0;
  GDataNoteLabel.AutoSize := False;
  GDataNoteLabel.WordWrap := True;
  GDataNoteLabel.Width := GComponentsPage.SurfaceWidth;
  GDataNoteLabel.Font.Color := clGray;
  GDataNoteLabel.Caption := 'Каталог данных: ' + GDataDir + ' (фиксирован)';
  FitLabel(GDataNoteLabel);

  { Лицензия MIT — только первая установка (нет ни сервера, ни клиента). }
  GLicenseCheck := TNewCheckBox.Create(GComponentsPage);
  GLicenseCheck.Parent := GComponentsPage.Surface;
  GLicenseCheck.Left := 0;
  GLicenseCheck.Width := GComponentsPage.SurfaceWidth - ScaleX(120);
  GLicenseCheck.Caption := 'Я принимаю условия лицензии MIT';
  GLicenseCheck.Checked := False;
  GLicenseCheck.OnClick := @ComponentsChanged;
  GLicenseCheck.Visible := LicensePromptNeeded;

  GLicenseLink := TNewLinkLabel.Create(GComponentsPage);
  GLicenseLink.Parent := GComponentsPage.Surface;
  GLicenseLink.Left := GComponentsPage.SurfaceWidth - ScaleX(110);
  GLicenseLink.Width := ScaleX(110);
  GLicenseLink.Caption := '<a href="license">Текст лицензии</a>';
  GLicenseLink.OnLinkClick := @OpenLocalLicense;
  GLicenseLink.Visible := LicensePromptNeeded;

  GReasonLabel := TNewStaticText.Create(GComponentsPage);
  GReasonLabel.Parent := GComponentsPage.Surface;
  GReasonLabel.Left := 0;
  GReasonLabel.AutoSize := False;
  GReasonLabel.WordWrap := True;
  GReasonLabel.Width := GComponentsPage.SurfaceWidth;
  GReasonLabel.Caption := '';
  GReasonLabel.Font.Color := clRed;
  FitLabel(GReasonLabel);

  { Начальный выбор вычислен в ApplyDefaultSelection (чистая машина — оба
    компонента, частичная — только установленные); здесь он лишь переносится
    в контролы. Присваивание Checked в Inno вызывает OnClick, поэтому до этого
    места экран считается неготовым: иначе первый же обработчик прочитал бы
    ещё не заполненные чекбоксы и снял выбор клиента (найдено при 860def0d). }
  GServerCheck.Checked := GServerSelected;
  GClientCheck.Checked := GClientSelected;
  GScopeUserRadio.Checked := GClientScopeUser;
  GScopeMachineRadio.Checked := not GClientScopeUser;
  GLicenseAccepted := False;
  GComponentsReady := True;
  UpdateComponentsState(nil);
end;

{ ---------------------------------------------------------------------------
  Экран администратора (686c5d76): логин первого администратора и его
  отображаемое имя (112642a4: поле имени — на этом экране, etn init уже
  принимает --display-name).
  --------------------------------------------------------------------------- }
procedure CreateAdminPage;
begin
  GAdminPage := CreateCustomPage(GComponentsPage.ID, 'Администратор сервера',
    { Формулировка пользователя (ошибка 860def0d, п.3). }
    'Первый пользователь станет администратором ETN. Задайте его логин и ' +
    'отображаемое имя, а после установки сервера получите ключ для входа.');

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

  GAdminDisplayLabel := TNewStaticText.Create(GAdminPage);
  GAdminDisplayLabel.Parent := GAdminPage.Surface;
  GAdminDisplayLabel.Left := 0;
  GAdminDisplayLabel.Top := GAdminLoginEdit.Top + GAdminLoginEdit.Height + 12;
  GAdminDisplayLabel.Width := GAdminPage.SurfaceWidth;
  GAdminDisplayLabel.Caption := 'Отображаемое имя (необязательно):';

  GAdminDisplayEdit := TNewEdit.Create(GAdminPage);
  GAdminDisplayEdit.Parent := GAdminPage.Surface;
  GAdminDisplayEdit.Left := 0;
  GAdminDisplayEdit.Top := GAdminDisplayLabel.Top + GAdminDisplayLabel.Height + 4;
  GAdminDisplayEdit.Width := GAdminPage.SurfaceWidth;
  GAdminDisplayEdit.Text := GAdminDisplayName;

  GAdminHintLabel := TNewStaticText.Create(GAdminPage);
  GAdminHintLabel.Parent := GAdminPage.Surface;
  GAdminHintLabel.Left := 0;
  GAdminHintLabel.Top := GAdminDisplayEdit.Top + GAdminDisplayEdit.Height + 8;
  GAdminHintLabel.AutoSize := False;
  GAdminHintLabel.WordWrap := True;
  GAdminHintLabel.Width := GAdminPage.SurfaceWidth;
  GAdminHintLabel.Caption := 'Логин используется один раз — при первичной инициализации ' +
    'сервера. Если сервер уже инициализирован, логин не меняется.';
  { Перенос обязателен: без него длинная подпись уходила за правый край и
    обрезалась (ошибка 860def0d, п.1). }
  FitLabel(GAdminHintLabel);

  GAdminErrorLabel := TNewStaticText.Create(GAdminPage);
  GAdminErrorLabel.Parent := GAdminPage.Surface;
  GAdminErrorLabel.Left := 0;
  GAdminErrorLabel.Top := GAdminHintLabel.Top + GAdminHintLabel.Height + 8;
  GAdminErrorLabel.AutoSize := False;
  GAdminErrorLabel.WordWrap := True;
  GAdminErrorLabel.Width := GAdminPage.SurfaceWidth;
  GAdminErrorLabel.Caption := '';
  GAdminErrorLabel.Font.Color := clRed;
end;

{ ---------------------------------------------------------------------------
  Экран «Параметры сервера» (9b310991): порт, чекбокс подключений с других
  компьютеров и фиксированный каталог данных. Тексты и оформление полного
  экрана — зона 112642a4; здесь функциональный минимум.
  --------------------------------------------------------------------------- }
{ Пересчитать позиции контролов экрана «Параметры сервера». Пояснение к
  брандмауэру меняет высоту при переключении чекбокса, а пояснение обновления
  появляется при заблокированных параметрах; без пересчёта следующие подписи
  оставались на старых местах и наезжали друг на друга (ошибка 860def0d, п.1). }
procedure LayoutServerParamsPage;
var
  Y: Integer;
begin
  if (GServerParamsPage = nil) or (GPortEdit = nil) then Exit;
  if GPortHintLabel <> nil then
    GPortHintLabel.Top := GPortEdit.Top + ScaleY(4);
  Y := GFirewallCheck.Top + GFirewallCheck.Height + ScaleY(2);
  if GFirewallNoteLabel <> nil then
  begin
    GFirewallNoteLabel.Top := Y;
    if GFirewallNoteLabel.Visible then
      Y := Y + GFirewallNoteLabel.Height + ScaleY(8);
  end;
  if GDataDirInfoLabel <> nil then
  begin
    GDataDirInfoLabel.Top := Y;
    Y := Y + GDataDirInfoLabel.Height + ScaleY(8);
  end;
  if GServerParamsNoteLabel <> nil then
  begin
    { Пустая подпись не занимает места: иначе её прямоугольник совпадает с
      подписью ошибки порта — тест раскладки видит «наложение» там, где текста
      нет. Высоту вернёт FitLabel, когда текст появится. }
    if GServerParamsNoteLabel.Caption = '' then
      GServerParamsNoteLabel.Height := 0;
    GServerParamsNoteLabel.Top := Y;
    if (GServerParamsNoteLabel.Visible) and (GServerParamsNoteLabel.Caption <> '') then
      Y := Y + GServerParamsNoteLabel.Height + ScaleY(8);
  end;
  if GPortErrorLabel <> nil then
  begin
    if GPortErrorLabel.Caption = '' then
      GPortErrorLabel.Height := 0;
    GPortErrorLabel.Top := Y;
    if (GPortErrorLabel.Visible) and (GPortErrorLabel.Caption <> '') then
      Y := Y + GPortErrorLabel.Height;
  end;
end;

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
    FitLabel(GFirewallNoteLabel);
  end;
  LayoutServerParamsPage;
end;

procedure UpdateServerParamsState;
var
  S: String;
begin
  if GParamsLocked then
  begin
    { Обновление/ремонт: параметры берутся из install.json, поля только
      показывают значения; здесь — что именно произойдёт. Режим запуска
      называется по-человечески, а не «service»/«app» (ошибка 860def0d, n6). }
    S := 'Сервер уже установлен: ' + IfStr(GInstalledVersion = '',
      ServerVersionText, GInstalledVersion) + ' → ' + GProductVersion +
      ', режим: ' + ServerModeText(IfStr(GInstalledMode = '',
        GServerMode, GInstalledMode)) + '.' +
      ' При обновлении порт, доступ по локальной сети и каталог данных не меняются.';
    if GInstalledVersion <> GProductVersion then
      S := S + ' Служба ETN останавливается на время замены файлов, базы данных ' +
        'копируются в ' + GDataDir + '\backups, затем служба запускается снова.';
    if GServerParamsNoteLabel <> nil then
    begin
      GServerParamsNoteLabel.Caption := S;
      FitLabel(GServerParamsNoteLabel);
    end;
  end
  else if GServerParamsNoteLabel <> nil then
  begin
    GServerParamsNoteLabel.Caption := '';
    FitLabel(GServerParamsNoteLabel);
  end;
  FirewallCheckClick(nil);
  LayoutServerParamsPage;
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
  GPortHintLabel.AutoSize := False;
  GPortHintLabel.WordWrap := True;
  GPortHintLabel.Width := GServerParamsPage.SurfaceWidth - GPortEdit.Width - 12;
  GPortHintLabel.Caption := 'Порт должен быть свободен: занятость проверяется до установки.';
  FitLabel(GPortHintLabel);

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
  { Перенос и пересчёт высоты: без них подпись уходила за правый край, а при
    смене текста наезжала на нижние контролы (ошибка 860def0d, п.1). }
  GFirewallNoteLabel.AutoSize := False;
  GFirewallNoteLabel.WordWrap := True;
  GFirewallNoteLabel.Width := GServerParamsPage.SurfaceWidth - 20;
  GFirewallNoteLabel.Caption := '';
  FitLabel(GFirewallNoteLabel);

  GDataDirInfoLabel := TNewStaticText.Create(GServerParamsPage);
  GDataDirInfoLabel.Parent := GServerParamsPage.Surface;
  GDataDirInfoLabel.Left := 0;
  GDataDirInfoLabel.Top := GFirewallNoteLabel.Top + GFirewallNoteLabel.Height + ScaleY(16);
  GDataDirInfoLabel.AutoSize := False;
  GDataDirInfoLabel.WordWrap := True;
  GDataDirInfoLabel.Width := GServerParamsPage.SurfaceWidth;
  GDataDirInfoLabel.Caption := 'Каталог данных: ' + GDataDir +
    ' (в 0.15.1 фиксирован, не меняется при обновлении и удалении программы)';
  FitLabel(GDataDirInfoLabel);

  GServerParamsNoteLabel := TNewStaticText.Create(GServerParamsPage);
  GServerParamsNoteLabel.Parent := GServerParamsPage.Surface;
  GServerParamsNoteLabel.Left := 0;
  GServerParamsNoteLabel.Top := GDataDirInfoLabel.Top + GDataDirInfoLabel.Height + ScaleY(8);
  GServerParamsNoteLabel.Width := GServerParamsPage.SurfaceWidth;
  GServerParamsNoteLabel.AutoSize := False;
  GServerParamsNoteLabel.WordWrap := True;
  GServerParamsNoteLabel.Caption := '';
  FitLabel(GServerParamsNoteLabel);

  GPortErrorLabel := TNewStaticText.Create(GServerParamsPage);
  GPortErrorLabel.Parent := GServerParamsPage.Surface;
  GPortErrorLabel.Left := 0;
  GPortErrorLabel.Top := GServerParamsNoteLabel.Top + GServerParamsNoteLabel.Height + ScaleY(8);
  GPortErrorLabel.Width := GServerParamsPage.SurfaceWidth;
  GPortErrorLabel.AutoSize := False;
  GPortErrorLabel.WordWrap := True;
  GPortErrorLabel.Caption := '';
  GPortErrorLabel.Font.Color := clRed;
  FitLabel(GPortErrorLabel);

  LayoutServerParamsPage;
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

{ Пересчитать позиции экрана ключа: подсказка о предыдущем запуске показывается
  не всегда, а её высота зависит от переноса текста; без пересчёта чекбокс
  «Я сохранил ключ» оказывался поверх текста (ошибка 860def0d, п.1). }
procedure LayoutKeyPage;
var
  Y: Integer;
begin
  if (GKeyPage = nil) or (GKeyCopyButton = nil) then Exit;
  Y := GKeyCopyButton.Top + GKeyCopyButton.Height + ScaleY(14);
  if GKeyWarningLabel <> nil then
  begin
    GKeyWarningLabel.Top := Y;
    Y := Y + GKeyWarningLabel.Height + ScaleY(6);
  end;
  if GKeyPreviousLabel <> nil then
  begin
    GKeyPreviousLabel.Top := Y;
    if GKeyPreviousLabel.Visible then
      Y := Y + GKeyPreviousLabel.Height + ScaleY(14)
    else
      Y := Y + ScaleY(14);
  end;
  if GKeyConfirmCheck <> nil then GKeyConfirmCheck.Top := Y;
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
  GKeyWarningLabel.AutoSize := False;
  GKeyWarningLabel.WordWrap := True;
  GKeyWarningLabel.Width := GKeyPage.SurfaceWidth;
  GKeyWarningLabel.Caption := 'Ключ показывается один раз. Восстановить нельзя — только ' +
    'выпустить новый. Сохраните его в надёжном месте.';
  FitLabel(GKeyWarningLabel);

  GKeyPreviousLabel := TNewStaticText.Create(GKeyPage);
  GKeyPreviousLabel.Parent := GKeyPage.Surface;
  GKeyPreviousLabel.Left := 0;
  GKeyPreviousLabel.Top := GKeyWarningLabel.Top + GKeyWarningLabel.Height + 6;
  GKeyPreviousLabel.AutoSize := False;
  GKeyPreviousLabel.WordWrap := True;
  GKeyPreviousLabel.Width := GKeyPage.SurfaceWidth;
  GKeyPreviousLabel.Caption := 'Ключ получен при предыдущем запуске установщика ' +
    '(после сбоя) и сохранён в защищённом файле.';
  GKeyPreviousLabel.Visible := False;
  FitLabel(GKeyPreviousLabel);

  GKeyConfirmCheck := TNewCheckBox.Create(GKeyPage);
  GKeyConfirmCheck.Parent := GKeyPage.Surface;
  GKeyConfirmCheck.Left := 0;
  GKeyConfirmCheck.Top := GKeyPreviousLabel.Top + GKeyPreviousLabel.Height + 14;
  GKeyConfirmCheck.Width := GKeyPage.SurfaceWidth;
  GKeyConfirmCheck.Caption := 'Я сохранил ключ';
  GKeyConfirmCheck.Checked := False;
  GKeyConfirmCheck.OnClick := @UpdateKeyPageState;
  LayoutKeyPage;
end;

{ ---------------------------------------------------------------------------
  События установщика
  --------------------------------------------------------------------------- }
#ifdef TestMode
{ /TESTBACKUP=1|skip — прямой прогон CreateDatabaseBackup без фаз установки:
  1 — смена версии (архив создаётся), skip — ремонт (архива нет). Решение
  передаётся так же, как его передаст bb063ac3; служба и файлы не участвуют. }
function RunBackupProbe: Boolean;
var
  Needed, Ok: Boolean;
begin
  Needed := LowerCase(GTestBackup) <> 'skip';
  Ok := CreateDatabaseBackup(Needed);
  LogLine('INFO', 'TESTBACKUP result=' + Pick(Ok, 'ok', 'fail') +
    ' needed=' + Pick(Needed, '1', '0') +
    ' archive=' + IfStr(GLastBackupDir = '', '-', GLastBackupDir));
  Result := Ok;
end;

{ /TESTUNINSTALLSERVICE=1 — прямой прогон снятия службы при удалении
  (8b1f5980): та же RemoveServiceOnUninstall, что вызывает uninstaller, без
  настоящего удаления программы. 0 — служба снята (или её не было), 10 — отказ
  с причиной в журнале и reason-файле. Порядок команд (stop → uninstall) виден
  по строкам журнала; установщик при этом ничего не удаляет. }
function RunUninstallServiceProbe: Boolean;
var
  Reason: String;
begin
  Result := RemoveServiceOnUninstall(Reason);
  LogLine('INFO', 'TESTUNINSTALLSERVICE result=' + Pick(Result, 'ok', 'fail') +
    IfStr(Reason = '', '', ' reason=' + Reason));
  if not Result then WriteReasonFile(Reason);
end;
#endif

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
  GClientCloseRefused := False;
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
  GTestLayout := '';
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
  GTestServiceName := '';
  GTestOwnServicePid := '';
  GTestServiceCmd := '';
  GTestServiceState := '';
  GTestServiceStop := '';
  GTestServiceStart := '';
  GTestServiceWait := '';
  GTestServiceInstall := '';
  GTestServiceUninstall := '';
  GTestUninstallService := '';
  GTestServiceRegistered := False;
  GTestServiceRunning := False;
  GTestServiceRealFile := '';
  GTestServicePendingPolls := 0;
  GTestHealthUrl := '';
  GTestHealthWait := '';
  GTestHealthStep := '';
  GTestRollback := '';
  GTestBackup := '';
  GTestLegacy := '';
  GLastBackupDir := '';
  GLastRollbackDir := '';
  GHealthReason := '';
  GAdminLogin := '';
  GAdminDisplayName := '';
  GFirstUserChecked := False;
  GFirstUserPresent := False;
  GInitAttempted := False;
  GPendingKey := '';
  GPendingKeyPrevious := False;
  GKeyBeforeInstall := '';
  GComponentsNotice := '';
  GDowngradeWarned := False;
  GLicenseAccepted := False;
  GInstallStage := '';
  GFailureReason := '';
  GKeyWasShown := False;
  GLanIp := '';
  GLanIpChecked := False;
  GLegacyClientFound := False;
  GLegacyClientVersion := '';
  GLegacyClientMachine := False;
  GTestLegacyCmd := '';
  GTestLegacyStuck := '';
  GTestLegacyWait := '';
  GTestLegacyArgs := '';
  { Хуки 98ad5eec: модель запущенного клиента и установка клиента «для меня». }
  GTestClientPids := '';
  GTestClientGone := '';
  GTestClientSoft := '';
  GTestClientForce := '';
  GTestClientWait := '';
  GTestClientReal := '';
  GTestClientPath := '';
  GTestClientRunning := False;
  GTestClientSoftIssued := False;
  GTestClientGoneAt := 0;
  GTestUserInstall := '';
  GChildRanThisPass := False;
  GParamsPath := '';
  GReasonFile := '';
  GChildReason := '';
  GDeferredLog := '';
  GParamsLocked := False;
  GUninstallFirewallRule := False;
  GFirewallWarning := False;
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
  GTestLayout := ParamValue('TESTLAYOUT');
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
  GTestServiceName := ParamValue('TESTSERVICENAME');
  GTestOwnServicePid := ParamValue('TESTOWNSERVICEPID');
  GTestServiceCmd := ParamValue('TESTSERVICECMD');
  GTestServiceState := LowerCase(ParamValue('TESTSERVICESTATE'));
  GTestServiceStop := LowerCase(ParamValue('TESTSERVICESTOP'));
  GTestServiceStart := LowerCase(ParamValue('TESTSERVICESTART'));
  GTestServiceWait := ParamValue('TESTSERVICEWAIT');
  GTestServiceInstall := LowerCase(ParamValue('TESTSERVICEINSTALL'));
  GTestServiceUninstall := LowerCase(ParamValue('TESTSERVICEUNINSTALL'));
  GTestServiceRealFile := ParamValue('TESTSERVICEREALFILE');
  GTestServicePendingPolls := 0;
  GTestUninstallService := ParamValue('TESTUNINSTALLSERVICE');
  { Исходное состояние модели службы: present — зарегистрирована и работает
    (обычное состояние машины; обновление сначала её остановит), absent — не
    зарегистрирована; команды install/uninstall меняют регистрацию, start/stop —
    состояние. /TESTSERVICESTATE задаёт статическое состояние, которое команды
    не меняют (проверка «служба не остановилась»). }
  GTestServiceRegistered := LowerCase(GTestService) = 'present';
  GTestServiceRunning := GTestServiceRegistered;
  if GTestService <> '' then
    LogOrDefer('WARN', 'TESTSERVICE=' + GTestService + ': служба смоделирована — ' +
      'настоящая служба машины не трогается (тестовый режим)');
  GTestHealthUrl := ParamValue('TESTHEALTHURL');
  GTestHealthWait := ParamValue('TESTHEALTHWAIT');
  GTestHealthStep := ParamValue('TESTHEALTHSTEP');
  GTestRollback := LowerCase(ParamValue('TESTROLLBACK'));
  GTestBackup := ParamValue('TESTBACKUP');
  GTestLegacy := ParamValue('TESTLEGACY');
  GTestLegacyCmd := ParamValue('TESTLEGACYCMD');
  GTestLegacyStuck := ParamValue('TESTLEGACYSTUCK');
  GTestLegacyWait := ParamValue('TESTLEGACYWAIT');
  GTestLegacyArgs := ParamValue('TESTLEGACYARGS');
  GTestClientPids := ParamValue('TESTCLIENTPIDS');
  GTestClientGone := ParamValue('TESTCLIENTGONE');
  GTestClientSoft := LowerCase(ParamValue('TESTCLIENTSOFT'));
  GTestClientForce := LowerCase(ParamValue('TESTCLIENTFORCE'));
  GTestClientWait := ParamValue('TESTCLIENTWAIT');
  GTestClientReal := ParamValue('TESTCLIENTREAL');
  GTestClientPath := ParamValue('TESTCLIENTPATH');
  GTestUserInstall := ParamValue('TESTUSERINSTALL');
  GTestClientRunning := GTestClientPids <> '';
  GTestClientSoftIssued := False;
  if GTestClientGone <> '' then
    GTestClientGoneAt := StrToIntDef(GTestClientGone, 0)
  else
    GTestClientGoneAt := 0;
  if GTestClientForce = '' then
    GTestClientForce := 'ok';
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
  { Старый NSIS-клиент (0.14.x) ищется до показа экрана компонентов: подпись
    клиента и предупреждение о его удалении видны на первом экране. }
  DetectLegacyClient;

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

  { /TESTUSERINSTALL=1 — прогон установки клиента «только для меня» без окон:
    проверка выполняется в ValidateSilentPreconditions (silent-контракт клиент
    не ставит, но ветку [Files]/[Icons] нужно проверить). Здесь только след в
    журнале — GSilent не меняется, мастер не создаётся. }
  if GTestUserInstall = '1' then
    LogLine('INFO', 'TESTUSERINSTALL=1: установка только клиента «для меня» (тестовый режим)');

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
      ' scope_fixed=' + Pick(ClientScopeFixed, '1', '0') +
      ' scope_radios=' + Pick(ClientScopeRadiosVisible, 'visible', 'hidden') +
      ' need_elevation=' + Pick(NeedElevation, '1', '0') +
      ' in_privileged_context=' + Pick(InPrivilegedContext, '1', '0') +
      ' legacy=' + IfStr(GLegacyClientVersion = '', '-', GLegacyClientVersion) +
      ' legacy_machine=' + Pick(GLegacyClientMachine, '1', '0') +
      ' license_prompt=' + Pick(LicensePromptNeeded, '1', '0'));
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

  { /TESTLEGACYARGS=1 — вычисленные аргументы деинсталлятора старого клиента:
    проверяется _?=<каталог> на пути с пробелами без запуска деинсталлятора. }
  if GTestLegacyArgs = '1' then
  begin
    LogLine('INFO', 'TESTLEGACYARGS args=' +
      UninstallerArgs('"C:\Program Files\ETN\Uninstall ETN.exe" /currentuser'));
    ExitProcess(EXIT_OK);
  end;

  { /TESTBACKUP=1|skip — прямой прогон функции бэкапа (ce3ab836): код 0 —
    архив создан и проверен (или ремонт без архива), 10 — бэкап неудачен. }
  if GTestBackup <> '' then
  begin
    if RunBackupProbe then
      ExitProcess(EXIT_OK)
    else
      ExitProcess(EXIT_FAILED);
  end;

  { /TESTUNINSTALLSERVICE=1 — прямой прогон снятия службы при удалении
    (8b1f5980): 0 — служба снята (или её не было), 10 — отказ с причиной. }
  if GTestUninstallService = '1' then
  begin
    if RunUninstallServiceProbe then
      ExitProcess(EXIT_OK)
    else
      ExitProcess(EXIT_FAILED);
  end;
#endif

#ifdef TestMode
  { /TESTLAYOUT=1: только снять раскладку экранов и выйти (ошибка 860def0d).
    Silent-предусловия не выполняются: установка не начинается. }
  if GTestLayout = '1' then
  begin
    LogLine('INFO', 'TESTLAYOUT=1: снимок раскладки экранов без установки (тестовый режим)');
    Result := True;
    Exit;
  end;
#endif

  if GPrivilegedPhase then
  begin
    ValidatePrivilegedPhasePreconditions;
    { Старый NSIS-клиент удаляется до копирования файлов: привилегированная
      фаза — единственный процесс, который может снять машинную запись.
      Отказ деинсталлятора останавливает установку кодом 20 с причиной для
      родителя. }
    Reason := '';
    if GClientSelected and (not RemoveLegacyBeforeInstall(True, Reason)) then
      FailPrecondition(Reason);
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

#ifdef TestMode
{ /TESTLAYOUT=1 (ошибка 860def0d): раскладка экранов без окон. Тест читает
  строки TESTLAYOUT из журнала и проверяет, что подписи не обрезаны (Height не
  «дельта» AdjustHeight), не налезают друг на друга и помещаются на поверхность
  страницы. Значения реальные — их посчитал Inno при создании контролов в
  текущем состоянии машины. }
procedure DumpControl(const PageName, Name: String; C: TControl);
begin
  if C = nil then
  begin
    LogLine('INFO', 'TESTLAYOUT ' + PageName + ' ' + Name + ' missing');
    Exit;
  end;
  LogLine('INFO', 'TESTLAYOUT ' + PageName + ' ' + Name +
    ' left=' + IntToStr(C.Left) + ' top=' + IntToStr(C.Top) +
    ' width=' + IntToStr(C.Width) + ' height=' + IntToStr(C.Height) +
    ' visible=' + Pick(C.Visible, '1', '0'));
end;

{ Подпись: в снимок идёт и длина текста. Тест отличает пустую подпись (высота 0
  допустима) от сжатой «дельтой» AdjustHeight — у неё высота 0 при непустом
  тексте и текст обрезан (ошибка 860def0d, п.1). }
procedure DumpText(const PageName, Name: String; L: TNewStaticText);
begin
  if L = nil then
  begin
    LogLine('INFO', 'TESTLAYOUT ' + PageName + ' ' + Name + ' missing');
    Exit;
  end;
  LogLine('INFO', 'TESTLAYOUT ' + PageName + ' ' + Name +
    ' left=' + IntToStr(L.Left) + ' top=' + IntToStr(L.Top) +
    ' width=' + IntToStr(L.Width) + ' height=' + IntToStr(L.Height) +
    ' visible=' + Pick(L.Visible, '1', '0') +
    ' chars=' + IntToStr(Length(L.Caption)));
end;

procedure DumpPageSurface(const PageName: String; P: TWizardPage);
begin
  if P = nil then
  begin
    LogLine('INFO', 'TESTLAYOUT ' + PageName + ' surface missing');
    Exit;
  end;
  LogLine('INFO', 'TESTLAYOUT ' + PageName + ' surface width=' + IntToStr(P.SurfaceWidth) +
    ' height=' + IntToStr(P.SurfaceHeight));
end;

procedure DumpLayout;
begin
  LogLine('INFO', 'TESTLAYOUT state server_selected=' + Pick(GServerSelected, '1', '0') +
    ' client_selected=' + Pick(GClientSelected, '1', '0') +
    ' scope_user=' + Pick(GClientScopeUser, '1', '0') +
    ' radios=' + Pick(ClientScopeRadiosVisible, '1', '0') +
    ' license_prompt=' + Pick(LicensePromptNeeded, '1', '0'));
  DumpPageSurface('components', GComponentsPage);
  DumpControl('components', 'serverCheck', GServerCheck);
  DumpText('components', 'serverState', GServerStateLabel);
  DumpText('components', 'serverHint', GServerHintLabel);
  DumpControl('components', 'serverAltLink', GServerAltLink);
  DumpControl('components', 'clientCheck', GClientCheck);
  DumpText('components', 'clientState', GClientStateLabel);
  DumpText('components', 'clientHint', GClientHintLabel);
  DumpText('components', 'scopeFixed', GScopeFixedLabel);
  DumpControl('components', 'scopeUser', GScopeUserRadio);
  DumpControl('components', 'scopeMachine', GScopeMachineRadio);
  DumpText('components', 'scopeHint', GScopeHintLabel);
  DumpText('components', 'dataNote', GDataNoteLabel);
  DumpControl('components', 'license', GLicenseCheck);
  DumpText('components', 'reason', GReasonLabel);
  DumpPageSurface('admin', GAdminPage);
  DumpText('admin', 'loginLabel', GAdminLoginLabel);
  DumpControl('admin', 'loginEdit', GAdminLoginEdit);
  DumpText('admin', 'displayLabel', GAdminDisplayLabel);
  DumpControl('admin', 'displayEdit', GAdminDisplayEdit);
  DumpText('admin', 'hint', GAdminHintLabel);
  DumpText('admin', 'error', GAdminErrorLabel);
  UpdateServerParamsState;
  DumpPageSurface('params', GServerParamsPage);
  DumpText('params', 'portLabel', GPortLabel);
  DumpControl('params', 'portEdit', GPortEdit);
  DumpText('params', 'portHint', GPortHintLabel);
  DumpControl('params', 'firewallCheck', GFirewallCheck);
  DumpText('params', 'firewallNote', GFirewallNoteLabel);
  DumpText('params', 'dataDirInfo', GDataDirInfoLabel);
  DumpText('params', 'paramsNote', GServerParamsNoteLabel);
  DumpText('params', 'portError', GPortErrorLabel);
  DumpPageSurface('credentials', GKeyPage);
  DumpControl('credentials', 'valueEdit', GKeyValueEdit);
  DumpControl('credentials', 'copyButton', GKeyCopyButton);
  DumpText('credentials', 'copiedLabel', GKeyCopiedLabel);
  DumpText('credentials', 'warning', GKeyWarningLabel);
  DumpText('credentials', 'previous', GKeyPreviousLabel);
  DumpControl('credentials', 'confirm', GKeyConfirmCheck);
  { Итоговый экран (п.10): сводка и кнопки не должны налезать на левую полосу
    оформления и друг на друга. Геометрия берётся у FinishedLabel. }
  CreateFinishedControls;
  LogLine('INFO', 'TESTLAYOUT finished surface width=' +
    IntToStr(WizardForm.FinishedPage.ClientWidth) + ' height=' +
    IntToStr(WizardForm.FinishedPage.ClientHeight));
  DumpText('finished', 'label', WizardForm.FinishedLabel);
  DumpControl('finished', 'memo', GSummaryMemo);
  DumpControl('finished', 'run', GSummaryRunButton);
  DumpControl('finished', 'data', GSummaryDataButton);
  DumpControl('finished', 'log', GSummaryLogButton);
end;
#endif

procedure InitializeWizard;
begin
#ifdef TestMode
  { Раскладка без окон (ошибка 860def0d): строится тем же кодом, что и в GUI.
    GSilent снимается до создания страниц — иначе UpdateComponentsState не
    заполняет подписи и не раскладывает контролы. }
  if GTestLayout = '1' then
  begin
    GSilent := False;
    CreateComponentsPage;
    CreateAdminPage;
    CreateServerParamsPage;
    CreateKeyPage;
    DumpLayout;
    ExitProcess(EXIT_OK);
  end;
#endif
  if GSilent then Exit;
  CreateComponentsPage;
  CreateAdminPage;
  CreateServerParamsPage;
  CreateKeyPage;
  { Экран ошибки — после экрана ключа: при сбое после init ключ показывается
    всегда (восстановить его нельзя). }
  CreateErrorPage;
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
  { Стандартные страницы приветствия и лицензии не используются: первый экран —
    собственный экран компонентов с приветствием, лицензия MIT — чекбокс на
    нём (d75b7988). При обновлении лицензия не запрашивается вовсе. }
  if PageID = wpWelcome then
    Result := True;
  if PageID = wpLicense then
    Result := True;
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
  { Экран ошибки — только при сбое. }
  if (GErrorPage <> nil) and (PageID = GErrorPage.ID) then
    Result := GExitCode = EXIT_OK;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if GSilent then Exit;
  if (GComponentsPage <> nil) and (CurPageID = GComponentsPage.ID) then
  begin
    if GServerStateLabel <> nil then
    begin
      GServerStateLabel.Caption := ServerStateText +
        IfStr(InitStateText = '', '', ' ' + InitStateText);
      FitLabel(GServerStateLabel);
    end;
    if GClientStateLabel <> nil then
    begin
      GClientStateLabel.Caption := ClientStateText;
      FitLabel(GClientStateLabel);
    end;
    UpdateComponentsState(nil);
    { Понижение версии: один раз на запуск — объяснить и оставить «Отмена». }
    if GBlockedDowngrade and (not GDowngradeWarned) then
    begin
      GDowngradeWarned := True;
      LogLine('WARN', 'Понижение версии запрещено: установлена ' +
        ServerVersionText + ', установщик ' + GProductVersion);
      SuppressibleMsgBox('На этом компьютере установлена более новая версия ETN ' +
        ServerVersionText + '.' + #13#10 + 'Установщик ' + GProductVersion +
        ' не может её понизить: установка невозможна, доступна только отмена.',
        mbError, MB_OK, IDOK);
    end;
  end;
  if (GAdminPage <> nil) and (CurPageID = GAdminPage.ID) then
  begin
    if (GAdminLoginEdit <> nil) and (GAdminLoginEdit.Text = '') then
      GAdminLoginEdit.Text := GAdminLogin;
    if (GAdminDisplayEdit <> nil) and (GAdminDisplayEdit.Text = '') then
      GAdminDisplayEdit.Text := GAdminDisplayName;
    if GAdminErrorLabel <> nil then GAdminErrorLabel.Caption := '';
    if (WizardForm <> nil) and (GAdminLoginEdit <> nil) then
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
    LayoutKeyPage;
    if GKeyConfirmCheck <> nil then GKeyConfirmCheck.Checked := False;
    GKeyWasShown := True;
    { «Назад» на экране ключа недоступен: ключ уже создан, вернуться к выбору
      компонентов нельзя. «Далее» разблокирует только «Я сохранил ключ». }
    if WizardForm <> nil then
    begin
      WizardForm.BackButton.Visible := False;
      WizardForm.NextButton.Enabled := False;
    end;
  end;
  if (GErrorPage <> nil) and (CurPageID = GErrorPage.ID) then
  begin
    if GErrorMemo <> nil then
      GErrorMemo.Lines.Text := ErrorMemoText;
    if GErrorOpenLogButton <> nil then
      GErrorOpenLogButton.Visible := FileExists(GLogPath);
    if GErrorOpenDataButton <> nil then
      GErrorOpenDataButton.Visible := DirExists(GDataDir);
    if WizardForm <> nil then
      WizardForm.NextButton.Enabled := True;
  end;
  if CurPageID = wpFinished then
  begin
    if WizardForm <> nil then
    begin
      WizardForm.NextButton.Enabled := True;
      { Итоговая сводка: свой memo вместо однострочного FinishedLabel; при
        сбое — причина, журнал, бэкап и следующий шаг. Ошибка netsh установку
        не отменяет, но предупреждение о брандмауэре входит в сводку. }
      CreateFinishedControls;
      WizardForm.FinishedLabel.Visible := False;
      if GExitCode = EXIT_OK then
      begin
        WizardForm.FinishedHeadingLabel.Caption := 'Установка ETN завершена';
        if GSummaryMemo <> nil then
          GSummaryMemo.Lines.Text := SummaryText;
      end
      else
      begin
        WizardForm.FinishedHeadingLabel.Caption := 'Установка ETN не завершена';
        if GSummaryMemo <> nil then
          GSummaryMemo.Lines.Text := ErrorMemoText;
      end;
      { Кнопка «Запустить клиент» — только когда клиент выбран в этом запуске:
        иначе она могла бы открыть старый NSIS-клиент, оставшийся в каталоге
        программы (замечание приёмки 112642a4). }
      if GSummaryRunButton <> nil then
        GSummaryRunButton.Visible := (GExitCode = EXIT_OK) and GClientSelected and
          (ClientExePath <> '');
      if GSummaryDataButton <> nil then
        GSummaryDataButton.Visible := DirExists(GDataDir);
      if GSummaryLogButton <> nil then
        GSummaryLogButton.Visible := FileExists(GLogPath);
    end;
  end;
end;

{ Экран готовности: предупредить о запросе UAC ДО клика «Установить»
  (ошибка 860def0d, пп.4–5): следующий шаг — окно UAC, и пользователь должен
  знать, что в нём нажать «Да», иначе установка не начнётся. }
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo,
  MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  S: String;
begin
  S := '';
  if NeedElevation and (not (GIsElevated and IsAdminInstallMode)) then
    S := 'Windows запросит права администратора — в окне UAC нажмите «Да», ' +
      'иначе установка не начнётся.' + NewLine + NewLine;
  Result := S + MemoDirInfo + MemoComponentsInfo + MemoGroupInfo + MemoTasksInfo;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Reason, PortText, FreePort: String;
begin
  Result := True;
  if (GComponentsPage <> nil) and (CurPageID = GComponentsPage.ID) then
  begin
    UpdateComponentsState(nil);
    if GBlockedDowngrade then
    begin
      Result := False;
      Exit;
    end;
    if (not GServerSelected) and (not GClientSelected) then
    begin
      if GReasonLabel <> nil then
        GReasonLabel.Caption := 'Выберите хотя бы один компонент.';
      Result := False;
      Exit;
    end;
    if LicensePromptNeeded and (not GLicenseAccepted) then
    begin
      if GReasonLabel <> nil then
        GReasonLabel.Caption := 'Примите условия лицензии MIT, чтобы продолжить.';
      if (WizardForm <> nil) and (GLicenseCheck <> nil) then
        WizardForm.ActiveControl := GLicenseCheck;
      LogLine('WARN', 'Экран компонентов: не принята лицензия MIT');
      Result := False;
      Exit;
    end;
    LogLine('INFO', 'Экран компонентов: сервер=' +
      Pick(GServerSelected, 'да', 'нет') + ', клиент=' +
      Pick(GClientSelected, 'да', 'нет') + ', область клиента=' +
      Pick(GClientScopeUser, 'user', 'machine') + ', лицензия=' +
      IfStr(LicensePromptNeeded, Pick(GLicenseAccepted, 'принята', 'не принята'),
        'не требуется'));
  end;
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
        фокус на поле порта. Для занятого порта — подсказка свободного
        значения (поле не меняется без решения пользователя). }
      FreePort := '';
      if Pos('занят', Reason) > 0 then
        FreePort := SuggestFreePort(GServerPort);
      if FreePort <> '' then
        Reason := Reason + '. Рядом свободен порт ' + FreePort +
          ' — укажите его и нажмите «Далее»';
      if GPortErrorLabel <> nil then
      begin
        GPortErrorLabel.Caption := Reason;
        FitLabel(GPortErrorLabel);
        LayoutServerParamsPage;
      end;
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
    if GAdminDisplayEdit <> nil then
      GAdminDisplayName := Trim(GAdminDisplayEdit.Text);
    if not ValidAdminLogin(GAdminLogin) then
    begin
      if GAdminErrorLabel <> nil then
        GAdminErrorLabel.Caption := 'Логин обязателен и не должен содержать кавычек и переводов строк.';
      Result := False;
      Exit;
    end;
    if (GAdminDisplayName <> '') and (not ValidDisplayName(GAdminDisplayName)) then
    begin
      if GAdminErrorLabel <> nil then
        GAdminErrorLabel.Caption := 'Отображаемое имя не должно содержать кавычек и переводов строк.';
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
  { Готовность: до копирования файлов удаляется старый NSIS-клиент и
    выполняется повышение прав. Отказ UAC возвращает на экран компонентов
    с сохранённым выбором (PrepareToInstall дочерний процесс уже не запускает).
    В silent и привилегированной фазе мастера нет: повышение прав там
    выполняет InitializeSetup (silent-предусловие «уже элевирован»), поэтому
    этот обработчик для них ничего не делает. }
  if CurPageID = wpReady then
  begin
    LogLine('INFO', 'Экран готовности: проверка перед установкой (silent=' +
      Pick(GSilent, 'да', 'нет') + ', privileged_phase=' +
      Pick(GPrivilegedPhase, 'да', 'нет') + ', need_elevation=' +
      Pick(NeedElevation, 'да', 'нет') + ')');
    if GSilent or GPrivilegedPhase then Exit;
    if GChildRanThisPass then Exit;
    { Запущенный клиент закрывается до повышения прав и копирования: замена
      ETN.exe невозможна, пока процесс работает. Отказ пользователя или
      неудача закрытия — установка не начинается (код 20), выбор сохраняется.
      Исключение: машинный клиент другого пользователя родительский процесс
      закрыть не может (нет прав) — попытку повторит привилегированная фаза,
      которая и вернёт код 20 с причиной, если клиент не закроется. }
    Reason := '';
    if GClientSelected and (not CloseRunningClient(True, Reason)) then
    begin
      if (not GClientCloseRefused) and NeedElevation and
         (not (GIsElevated and IsAdminInstallMode)) then
      begin
        LogLine('WARN', 'Клиент ETN: родительский процесс не закрыл клиент (' +
          Reason + ') — повтор в привилегированной фазе');
        GComponentsNotice := '';
      end
      else
      begin
        GComponentsNotice := 'Установка не начата: ' + Reason;
        SuppressibleMsgBox('Установка не начата.' + #13#10#13#10 + Reason,
          mbError, MB_OK, IDOK);
        ReturnToComponentsPage;
        Result := False;
        Exit;
      end;
    end;
    Reason := '';
    if not RemoveLegacyBeforeInstall(GIsElevated, Reason) then
    begin
      GComponentsNotice := 'Установка не начата: ' + Reason;
      SuppressibleMsgBox('Установка не начата.' + #13#10#13#10 + Reason,
        mbError, MB_OK, IDOK);
      ReturnToComponentsPage;
      Result := False;
      Exit;
    end;
    if NeedElevation and (not (GIsElevated and IsAdminInstallMode)) then
    begin
      GChildRanThisPass := True;
      GChildResult := RunElevatedChild;
      if GChildResult < 0 then
      begin
        GChildRanThisPass := False;
        GChildResult := 0;
        { Отказ UAC ведёт к следующему шагу (ошибка 860def0d, п.5): раньше
          текст «можно изменить выбор или закрыть установщик» не подсказывал
          повторить и подтвердить запрос. }
        GComponentsNotice := 'Повышение прав отменено: изменения не выполнялись, ' +
          'выбор сохранён. Чтобы установить выбранные компоненты, нажмите ' +
          '«Далее» и подтвердите запрос UAC кнопкой «Да».';
        SuppressibleMsgBox(GComponentsNotice, mbError, MB_OK, IDOK);
        ReturnToComponentsPage;
        Result := False;
        Exit;
      end;
      if GChildResult = EXIT_PRECONDITION then
      begin
        GChildRanThisPass := False;
        GChildResult := 0;
        GComponentsNotice := 'Установка не начата: ' +
          IfStr(GChildReason = '', 'не выполнено предусловие (код 20)',
            GChildReason);
        SuppressibleMsgBox(GComponentsNotice + #13#10#13#10 +
          'Изменения не выполнялись. Порт и доступ по локальной сети можно ' +
          'изменить в «Параметры сервера».', mbError, MB_OK, IDOK);
        ReturnToComponentsPage;
        Result := False;
        Exit;
      end;
      if GChildResult <> EXIT_OK then
      begin
        { Сбой мог произойти после замены файлов: экран ошибки и итоговая
          сводка покажут причину, журнал и бэкап. GChildReason прочитан из
          reason-файла дочернего процесса и после отката содержит и его итог
          (блокер приёмки bb063ac3: раньше терялся). }
        FailInstall('привилегированная фаза завершилась с кодом ' +
          IntToStr(GChildResult) +
          IfStr(GChildReason = '', '', ': ' + GChildReason));
      end;
    end;
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

{ Подтверждение перед установкой. Повышение прав выполняется на экране
  готовности (NextButtonClick(wpReady)): при отказе UAC мастер возвращается на
  экран компонентов, а не показывает сообщение поверх экрана готовности.
  До копирования файлов на диск не пишется ничего, кроме временного файла
  параметров; при отказе UAC частичных файлов не остаётся. Здесь — только
  страховка на случай, если дочерний процесс ещё не запускался (например,
  экран готовности пропущен). }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Reason: String;
begin
  Result := '';
  NeedsRestart := False;
  if GSilent or GPrivilegedPhase then Exit;
  { Повышение прав уже выполнено на экране готовности — второй дочерний
    процесс не запускается. }
  if GChildRanThisPass then Exit;
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
    Result := 'Повышение прав отменено: изменения не выполнялись, выбор сохранён. ' +
      'Чтобы установить выбранные компоненты, нажмите «Установить» и подтвердите ' +
      'запрос UAC кнопкой «Да». Журнал: ' + GLogPath
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
    Result := 'Установка завершилась сбоем (код ' + IntToStr(GChildResult) +
      IfStr(GChildReason = '', '', ': ' + GChildReason) + '. Журнал: ' + GLogPath;
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
  Reason, FailText: String;
  Code: Integer;
begin
  if CurStep = ssInstall then
  begin
    { ssInstall вызывается ДО копирования файлов: здесь и только здесь можно
      остановить службу, сделать бэкап и снимок отката. При копировании файлов
      Inno показывает их имена в FilenameLabel — подпись этапа видна в момент
      перехода и снова появляется на этапах после копирования. }
    if GWorkAllowed and (GExitCode = EXIT_OK) then
    begin
      { Двухфазный UAC: серверные файлы, службу и init выполнил дочерний
        silent-процесс, а этот экземпляр копирует только клиент «для меня» —
        называть конкретный этап здесь нельзя (замечание приёмки 112642a4).
        Подробные этапы дочернего процесса — в журнале. }
      if GChildRanThisPass then
        SetInstallStage('Установка выполняется…');
      { Запущенный клиент закрывается до первого изменённого файла: мягко,
        с ожиданием, принудительно только после таймаута. Неудача — код 20,
        файлы не заменяются (в silent-прогоне без предупреждения). }
      if GClientSelected then
      begin
        Reason := '';
        if not CloseRunningClient(False, Reason) then
        begin
          FailText := 'Установка не начата: ' + Reason;
          LogLine('ERROR', FailText + ' (код ' + IntToStr(EXIT_PRECONDITION) + ')');
          if GFailureReason = '' then GFailureReason := Reason;
          WriteReasonFile(Reason);
          GExitCode := EXIT_PRECONDITION;
          if not GSilent then
            SuppressibleMsgBox(FailText + '.' + #13#10#13#10 +
              'Изменения не выполнялись. Журнал: ' + GLogPath, mbError, MB_OK, IDOK);
          ExitProcess(EXIT_PRECONDITION);
        end;
      end;
      { Фазы обновления (bb063ac3): остановка службы, бэкап БД, снимок
        отката — строго до первого изменённого файла. Неудача предусловия
        (служба не остановилась) — код 20, сбой (бэкап/снимок) — код 10.
        Процесс завершается здесь же: Inno не должен дойти до копирования. }
      Code := PrepareServerUpdate(Reason);
      if Code <> EXIT_OK then
      begin
        FailText := 'Установка не начата: ' + Reason;
        LogLine('ERROR', FailText + ' (код ' + IntToStr(Code) + ')');
        if GFailureReason = '' then GFailureReason := Reason;
        WriteReasonFile(Reason);
        GExitCode := Code;
        if not GSilent then
          SuppressibleMsgBox(FailText + '.' + #13#10#13#10 + 'Изменения не выполнялись. ' +
            'Журнал: ' + GLogPath, mbError, MB_OK, IDOK);
        ExitProcess(Code);
      end;
      if GServerSelected then
        SetInstallStage('Замена файлов сервера ETN…')
      else if GClientSelected then
        SetInstallStage('Замена файлов клиента ETN…');
    end;
    Exit;
  end;
  if CurStep = ssPostInstall then
  begin
    if GSilent then
      LogLine('INFO', 'Silent server-only: установка файлов завершена');
    if GDoPrivilegedWork then
    begin
      { Служба уже остановлена в ssInstall; здесь — каталоги данных, шаблон
        службы, инициализация (только первая установка), запуск и расширенный
        health-check. install.json пишется только после успешной проверки —
        иначе после отката файл врал бы о новой версии. }
      { Каталог данных и подкаталоги, которые обязаны существовать до старта
        службы (WinSW каталог журнала не создаёт) — 9b310991. }
      if GServerSelected then
      begin
        SetInstallStage('Подготовка каталогов данных…');
        if not EnsureServerDirs then
          FailInstall('каталог данных не подготовлен: ' + GDataDir);
        { Подстановка шаблона службы до регистрации/запуска: пока в
          etn-service.xml плейсхолдеры, службу запускать нельзя (ADR db60302a). }
        if GExitCode = EXIT_OK then
        begin
          SetInstallStage('Настройка службы…');
          if not InstallServiceConfig then
            FailInstall('конфигурация службы не подготовлена: ' + ServiceDir +
              '\service\etn-service.xml');
        end;
        { Регистрация службы — после записи etn-service.xml (WinSW читает
          конфигурацию из файла рядом с exe) и до запуска. Режим app службу
          не регистрирует. Сбой регистрации — код 20 с причиной: без службы
          сервер не поднимется, а install.json о новой версии врал бы. }
        if GExitCode = EXIT_OK then
        begin
          SetInstallStage('Регистрация службы ETN…');
          if not RegisterServiceIfNeeded(Reason) then
            FailInstallWithCode(EXIT_PRECONDITION, Reason);
        end;
        { Правило брандмауэра — по чекбоксу; ошибка netsh не отменяет
          установку (сервер слушает 0.0.0.0, предупреждение в журнал и в
          итоговую сводку), причина в журнале. }
        if GExitCode = EXIT_OK then
        begin
          SetInstallStage('Правило брандмауэра…');
          ApplyFirewallRule;
        end;
      end;
      { Инициализация — до запуска службы: сервер без администратора не
        стартует. Вызывается один раз: критерий hasFirstUser (686c5d76). }
      if (GServerSelected) and (GExitCode = EXIT_OK) then
      begin
        SetInstallStage('Инициализация сервера…');
        EnsureFirstUser;
        if GExitCode <> EXIT_OK then
          FailInstall('инициализация сервера не выполнена (etn init) — ' +
            'подробности в журнале');
      end;
#ifdef TestMode
      if (GTestFailAfterInit = '1') and GInitAttempted and (GPendingKey <> '') then
      begin
        LogLine('ERROR', 'TESTFAILAFTERINIT: имитация сбоя после etn init до показа ключа');
        ExitProcess(EXIT_FAILED);
      end;
#endif
      if GExitCode = EXIT_OK then
      begin
        SetInstallStage('Запуск службы ETN…');
        { Служба не перешла в RUNNING — предусловие: сервер не работает, и
          объявлять установку успешной нельзя (код 20 с причиной, как у сбоя
          регистрации). После отката прежняя версия поднимается. }
        if not StartServiceIfNeeded then
          FailInstallWithCode(EXIT_PRECONDITION, 'служба ' + SERVICE_NAME +
            ' не перешла в RUNNING после замены файлов ' +
            '(etn-service.exe start вернул ошибку или истёк бюджет ожидания)')
        else if not HealthCheckApplicable then
          { Режим app: сервер не служба, его запускает пользователь. Опрос
            health гарантированно истёк бы и увёл обновление в откат. }
          LogLine('INFO', 'Режим app: health-check не выполняется — сервер ' +
            'запускается пользователем')
        else
        begin
          SetInstallStage('Проверка работоспособности…');
          { Расширенный health-check (0a79d9de): 200, status=ok, db=ok,
            версия = целевая; затем GET /api/v1/version. }
          if not ProbeHealth(True) then
            FailInstall('health-check не пройден: ' + GHealthReason);
        end;
      end;
      { Silent: init не вызывался; без администратора сервер не работает —
        код 10, нужен ручной режим. }
      if (GExitCode = EXIT_OK) and IsSilentServerOnly then
      begin
        if not SilentAdminPresent then
          FailInstall('сервер не инициализирован: нет первого администратора ' +
            '(нужен ручной режим etn init --username)');
      end;
      { Сбой после замены файлов — возвращаем прежнюю версию: файлы из снимка,
        БД из архива, запуск и повторная проверка. Код уже 10, install.json
        не пишется. }
      if GExitCode <> EXIT_OK then
      begin
        RollbackAfterFailure;
        { Родитель (двухфазный UAC) читает reason-файл: FailInstall записал
          только исходную причину, до отката. Перезаписываем полным текстом —
          с итогом отката (блокер приёмки bb063ac3). }
        WriteReasonFile(GFailureReason);
      end;
    end;
    if (GExitCode = EXIT_OK) and NeedInstallRecord then
    begin
      SetInstallStage('Запись параметров установки…');
      if not WriteInstallJson then
      begin
        FailInstall('install.json не записан: ' + GInstallJsonPath);
        { Запись о новой версии не легла на диск — возвращаем прежнюю версию:
          иначе файлы новые, а install.json говорит о прежней. }
        if GDoPrivilegedWork then
        begin
          RollbackAfterFailure;
          WriteReasonFile(GFailureReason);
        end;
      end;
    end;
    { Снимок отката удаляется последним — только после того, как install.json
      зафиксировал новую версию (замечание приёмки: сбой записи при уже
      удалённом снимке оставлял установку без пути отката). }
    if (GExitCode = EXIT_OK) and GDoPrivilegedWork then
      CleanupRollbackSnapshot;
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

(* Деинсталлятор Inno НЕ вызывает InitializeSetup (проверено на Inno 6.7.3):
  все глобалы установщика в нём пусты. Снятие службы берёт путь из {app} по
  месту (ServiceDir), а каталог данных и режим для журнала удаления задаются
  здесь — из install.json, иначе из {commonappdata}\ETN. Журнал удаления
  (uninstall-*.log) нужен потому, что LogLine без GLogPath молчит: причина
  отказа снятия службы иначе осталась бы только в журнале Inno, который ведётся
  лишь при /LOG. *)
function InitializeUninstall: Boolean;
var
  JsonPath, Text, Dir, Candidate: String;
  JsonPresent: Boolean;
begin
  Result := True;
  GDataDir := ExpandConstant('{#DataDir}');
  JsonPath := GDataDir + '\install.json';
  JsonPresent := FileExists(JsonPath);
  if JsonPresent then
  begin
    Text := ReadTextFile(JsonPath);
    if JsonGetRaw(Text, 'data_dir') <> '' then
      GDataDir := JsonGetRaw(Text, 'data_dir');
    if JsonGetRaw(Text, 'mode') <> '' then
      GServerMode := JsonGetRaw(Text, 'mode');
  end;
  { Журнал — в каталоге данных только у серверной установки (install.json);
    удаление клиента без сервера не должно создавать %ProgramData%\ETN. }
  Dir := GDataDir + '\logs';
  Candidate := Dir + '\uninstall-' +
    GetDateTimeString('yyyymmdd-hhnnss', '-', '-') + '.log';
  if JsonPresent and ForceDirectories(Dir) then
    AppendUtf8Line(Candidate, 'ETN uninstall log');
  if not FileExists(Candidate) then
  begin
    Dir := ExpandConstant('{tmp}');
    Candidate := Dir + '\etn-uninstall-' +
      GetDateTimeString('yyyymmdd-hhnnss', '-', '-') + '.log';
    AppendUtf8Line(Candidate, 'ETN uninstall log');
  end;
  if FileExists(Candidate) then GLogPath := Candidate;
  LogLine('INFO', 'Удаление ETN: каталог данных ' + GDataDir + ', режим ' +
    IfStr(GServerMode = '', '—', GServerMode));
#ifdef TestMode
  { Проба настоящего деинсталлятора (silent-codes.ps1): InitializeSetup не
    вызывался, поэтому хуки модели службы разбираются здесь. }
  GTestMode := True;
  GTestService := ParamValue('TESTSERVICE');
  GTestServiceCmd := ParamValue('TESTSERVICECMD');
  GTestServiceState := LowerCase(ParamValue('TESTSERVICESTATE'));
  GTestServiceStop := LowerCase(ParamValue('TESTSERVICESTOP'));
  GTestServiceStart := LowerCase(ParamValue('TESTSERVICESTART'));
  GTestServiceWait := ParamValue('TESTSERVICEWAIT');
  GTestServiceInstall := LowerCase(ParamValue('TESTSERVICEINSTALL'));
  GTestServiceUninstall := LowerCase(ParamValue('TESTSERVICEUNINSTALL'));
  GTestServiceRealFile := ParamValue('TESTSERVICEREALFILE');
  GTestFirewall := ParamValue('TESTFIREWALL');
  GTestServiceRegistered := LowerCase(GTestService) = 'present';
  GTestServiceRunning := GTestServiceRegistered;
  GTestServicePendingPolls := 0;
  LogLine('INFO', 'Деинсталлятор (тестовый режим): TESTSERVICE=' +
    IfStr(GTestService = '', '—', GTestService) + ', TESTSERVICEREALFILE=' +
    IfStr(GTestServiceRealFile = '', '—', GTestServiceRealFile));
#endif
end;

{ Удаление программы: служба ETN снимается, правило брандмауэра удаляется
  вместе с ней (требования 15a1d3e4 и 8b1f5980). Снятие службы — в usUninstall,
  строго до того, как Inno удалит файлы: WinSW лежит в каталоге службы и после
  удаления файлов снять службу будет нечем. Отказ (служба не остановилась или
  uninstall вернул ошибку) отменяет удаление — Abort и причина в журнале
  удаления; uninstaller при этом завершается с ненулевым кодом (точный код Inno
  не гарантирует: «любой ненулевой — удаление не завершено»). Решение о правиле
  брандмауэра принимается тоже до удаления файлов (install.json ещё на месте),
  само удаление правила — в usPostUninstall. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Reason: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    if not RemoveServiceOnUninstall(Reason) then
    begin
      Log('ОШИБКА: удаление отменено — ' + Reason);
      SuppressibleMsgBox('Удаление программы отменено: ' + Reason +
        '. Остановите и удалите службу ' + SERVICE_NAME +
        ' вручную (sc stop ' + SERVICE_NAME + ', sc delete ' + SERVICE_NAME +
        ') и повторите удаление. Файлы не удалены.', mbError, MB_OK, IDOK);
      Abort;
    end
    else
      Log('Служба ' + SERVICE_NAME + ': снятие при удалении — ' +
        Pick(ServiceRegistered, 'осталась', 'снята'));
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
