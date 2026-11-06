; ============================================================================
; installer/etn.iss — комбинированный установщик ETN для Windows
;
; Задача a1211915 (0.15.1): каркас установщика, определение состояния машины,
; параметры установки (install.json), штатная элевация Inno (UAC) и
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
;     (один GET /api/v1/health → 200, status=ok, db=ok, version = целевая из
;     тела ответа; бюджет 60 с фактического времени, повтор каждые 2 с;
;     задача a1ea1d40 — второй GET /api/v1/version установщик не вызывает);
;   * неудача health-check: остановка службы, возврат файлов из снимка,
;     восстановление БД из архива (с удалением WAL/SHM), запуск прежней
;     версии, повторная проверка, код 10; в журнале отдельно «Откат выполнен»
;     либо «Откат не выполнен, архив: <путь>»;
;   * install.json пишется только после успешного health-check — иначе после
;     отката файл врал бы о новой версии;
;   * коды: 20 — предусловие до замены файлов (занятый порт, режим app,
;     служба не остановилась, чужая/отключённая/помеченная на удаление
;     служба); 10 — сбой выполнения (бэкап, снимок, регистрация, запуск,
;     health, откат; файлы могли быть заменены).
;
; Задача ce3ab836 (0.15.1) — бэкап баз данных перед заменой файлов:
;   * CreateDatabaseBackup(Needed) — вызывающий (bb063ac3) передаёт решение:
;     при смене версии Needed = True, при ремонте той же версии False.
;
; Задача 3acd9c3c (0.15.3) — бэкап и восстановление БД вынесены в CLI сервера:
;   * SQLite/чекпойнт/копирования в Pascal больше нет: установщик извлекает
;     самодостаточный etn-db-tool.mjs (server/dist/db/db-backup.js) во
;     временный каталог ДО остановки службы и запускает его через
;     {app}\node.exe с рабочим каталогом {app}\server:
;       backup  --to <данные>\backups --report-out <tmp>\report.txt --data-dir <данные>
;       restore --from <архив этого запуска> --force --report-out ... --data-dir ...
;   * архив — ZIP по спецификации (сущность 2975c553):
;     etn-backup-<версия>-<YYYYMMDD-HHMMSS>.zip внутри _system.db и
;     networks\<uuid>\data.db; вложения не входят; ротация трёх архивов и
;     integrity_check — в CLI (server/src/db/db-backup.ts), покрыты TS-тестами;
;   * путь архива и причина отказа читаются из отчёта key=value (archive,
;     error, warnings) в GLastBackupDir/GBackupReason, попадают в журнал,
;     экран ошибки и сводку; любой ненулевой код инструмента — код 10;
;   * откат — только из архива ЭТОГО запуска (не LatestBackupDir);
;     восстановление staged, WAL/SHM удаляются с проверкой, занятая БД без
;     --force — отказ до перезаписи.
;
; Задача 686c5d76 (0.15.1) — первичная инициализация и экран ключа:
;   * «уже инициализирован» — критерий hasFirstUser(), а не наличие
;     _system.db (база от прерванной попытки доинициализируется);
;   * init вызывается в административном режиме (единый процесс установки):
;     node.exe server\dist\cli.js
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
;     запуск, health-check); установка идёт одним процессом, этапы видны и в
;     StatusLabel, и в журнале;
;   * экран ошибки — причина, путь к журналу, путь к резервной копии и
;     следующий шаг; кнопки «Открыть журнал» и «Повторить»;
;   * итоговая сводка — что установлено, адрес сервера (локальный и LAN при
;     открытом брандмауэре), каталог данных, журнал, бэкап, напоминание
;     сохранить ключ; кнопки «Запустить клиент», «Открыть папку данных»,
;     «Открыть журнал»;
;   * отказ UAC — установщик не запускается вовсе (права запрашиваются до
;     мастера); причина отказа остаётся только в журнале Inno ({log}) — нашего
;     install-лога в этот момент ещё нет (ограничение диагностики 2dd215f7);
;   * занятый порт — фокус на поле порта и подсказка свободного значения.
;
; Задача 9b310991 (0.15.1) — каталог данных, порт, брандмауэр и предпроверки:
;   * каталог данных фиксирован %ProgramData%\ETN (ADR 144bcdb0), поля выбора
;     в 0.15.1 нет; сервер получает его через ETN_DATA_DIR; каталог программы —
;     GetDefaultAppDir (Program Files при запуске от имени администратора,
;     профиль при обычном), служебные файлы службы — {app}\service (ADR db60302a);
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
;     перегистрируется (WinSW 2.12.0 вернул бы 1073), но её личность
;     проверяется (ImagePath, Start, DeleteFlag): чужая/отключённая/помеченная
;     на удаление — код 20 до копирования файлов; сбой регистрации после
;     копирования — код 10 с причиной; запуск не ждёт RUNNING — готовность
;     подтверждает health-check;
;   * при удалении программы служба останавливается и снимается
;     (etn-service.exe uninstall) до удаления файлов; отказ отменяет удаление
;     с причиной; деинсталлятор не вызывает InitializeSetup — путь к службе и
;     журнал удаления берутся из {app}/{commonappdata} и install.json;
;     режим app службу не регистрирует и удаление не трогает; чужую службу
;     (другой ImagePath) не снимаем — файлы программы удалить можно;
;   * при обновлении порт, хост, режим и каталог данных фиксированы — берутся
;     из install.json, поля на экране только показывают значения;
;   * установка только клиента серверных каталогов и правила не создаёт.
;
; Ошибка 5b9743da (0.15.2) — «Переустановить клиент ETN», «Далее»/«Отмена» не
; реагируют (мнимое зависание GUI):
;   * зависание по опубликованной сборке не воспроизвелось: и в ВМ, и на машине
;     пользователя процесс установщика жив, окно отвечает, «Далее» и «Отмена»
;     активны и принимают нажатия; в журнале нет ни одной строки обработчика —
;     значит, нажатие до установщика не дошло (окно было перекрыто другим);
;   * следствие в коде: нажатие неактивной «Далее» не оставляло в журнале ни
;     строки, а причина неактивности уезжала за нижний край поверхности
;     страницы (длинные подписи состояния клиента) — состояние «кнопка мертва,
;     объяснения нет» было неотличимо от зависания;
;   * раскладка экрана компонентов гарантирует, что содержимое умещается:
;     FitComponentsPage уступает (в порядке: пояснение режима, каталог данных,
;     описания компонентов, ссылка), но выбор, состояния и причина остаются;
;     пояснение режима не дублируется, когда показан текст фиксированной
;     области (он говорит то же самое);
;   * причина неактивности — одна функция ComponentsReasonText: она же пишется
;     в журнал при каждой смене экрана вместе с состоянием кнопки;
;   * вход в NextButtonClick и CancelButtonClick логируется: по журналу видно,
;     дошло ли нажатие до установщика;
;   * долгие операции (закрытие запущенного клиента, удаление старого NSIS-
;     клиента) убраны из NextButtonClick в PrepareToInstall: Inno показывает на
;     этом шаге страницу «Подготовка к установке», само копирование ещё не
;     начато, а долгое ожидание идёт там, где мастер это предусматривает;
;     ошибка возвращается строкой и печатается на той же странице, файлы не
;     заменяются. Бюджеты ожидания прежние, но короче: 45 с на клиента и 10 с
;     на исчезновение записи старого клиента (прежние 2 минуты неподвижного
;     цикла в NextButtonClick и выглядели зависанием);
;   * подпись состояния клиента в режиме «только для меня» поверх машинной
;     копии больше не предлагает «выберите клиент, чтобы заменить его».
;
; Ошибка aa5af30c (0.15.2) — мастер не принимает ввод мыши на машине
; пользователя:
;   * причина — respawn мастера после диалога режима Inno (PrivilegesRequired=
;     admin + PrivilegesRequiredOverridesAllowed=dialog): после перезапуска
;     окно на этой машине не принимало ни клики, ни программные сообщения;
;     без respawn мастер был живой;
;   * продуктовая сборка вернулась к PrivilegesRequired=lowest и
;     PrivilegesRequiredOverridesAllowed=commandline: мастер стартует и
;     работает в одном процессе, без диалога режима и без respawn;
;   * режим — по фактическим правам процесса: обычный запуск — только клиент
;     «только для меня»; запуск от имени администратора — сервер и клиент «для
;     всех» (GetDefaultAppDir → Program Files); попытка выбрать сервер в
;     обычном запуске объясняет, что установщик надо запустить от имени
;     администратора;
;   * /ALLUSERS сохранён для тихого автообновления службы: LocalSystem уже
;     элевирован, Inno включает административный режим без UAC и respawn.
;
; Задача c4b68d78 (0.15.3) — экран компонентов на TNewCheckListBox:
;   * ручная пиксельная раскладка (LayoutComponentsPage/FitComponentsPage с
;     циклом скрытия подсказок) удалена: два пункта списка — сервер и клиент
;     (checkbox, уровень 0), под каждым строки статуса и описания (group,
;     уровень 1); необязательная строка области клиента — тоже group;
;   * TNewCheckListBox переносит caption по словам, но ItemSubItem — одна
;     строка без переноса; поэтому статусы и описания — group-строки, subitem
;     всегда пуст;
;   * список получает остаток высоты и прокручивается сам; нижний блок
;     (ссылка на другие варианты установки, каталог данных, лицензия, причина
;     неактивности «Далее») закреплён от низа поверхности:
;     GComponentsList.Height := GServerAltLink.Top - ScaleY(8);
;   * серые статусы/подсказки — ItemEnabled := False (как прежний clGray):
;     средство доступности считает такую строку недоступной — принятый
;     компромисс, потому что TNewCheckListBox не умеет менять цвет строки;
;   * причина неактивности «Далее» — по-прежнему одна функция
;     ComponentsReasonText (экран и журнал), на экране — с префиксом
;     «Далее недоступна: »; FitLabel и пересчёт нижнего блока — после каждой
;     смены текста;
;   * Items.Add/AddSubItem/SubItems и запись ItemLevel/State запрещены: они
;     рассинхронизируют FStateList (сторож — installer/tests/silent-codes.ps1);
;     Items.Delete допустим только для последней строки области клиента.
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
;   /PRIVILEGEDPHASE — привилегированная работа без мастера: фаза пишет в
;   каталог программы и каталог данных; silent-предусловия самообновления к ней
;   НЕ применяются, проверяются только права, каталог программы, каталог данных
;   и порт. GUI-установка её больше не запускает (элевация штатная, 2dd215f7);
;   фаза остаётся для installer/tests/*.ps1.
;   /TESTSTATE, /TESTSELECT, /TESTRECORD, /TESTELEVATED, /TESTSERVICE,
;   /TESTHEALTH, /TESTPARAMS, /TESTDATADIR, /TESTPORT, /TESTMINFREE,
;   /TESTFIREWALL, /TESTPRECHECK, /TESTSERVICENAME, /TESTOWNSERVICEPID,
;   /TESTPORTBINDFAIL, /TESTLISTENERTABLEOFF, /TESTNOSERVICE,
;   /TESTSERVICECMD, /TESTSERVICESTATE, /TESTSERVICESTOP, /TESTSERVICESTART,
;   /TESTSERVICEWAIT, /TESTSERVICEINSTALL, /TESTSERVICEUNINSTALL,
;   /TESTSERVICEREALFILE, /TESTSERVICESTATUS, /TESTSERVICEIMAGE,
;   /TESTSERVICESTARTTYPE, /TESTSERVICEDELETEFLAG, /TESTUNINSTALLSERVICE,
;   /TESTHEALTHURL, /TESTHEALTHWAIT, /TESTHEALTHSTEP, /TESTROLLBACK,
;   /TESTADMINMODE, /TESTUSERONLYMODE, /TESTGUIMODE, /TESTNOTICE — только в
;   тестовой сборке (installer/tests/silent-codes.ps1, init-key.ps1,
;   staged-app.ps1).
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
  ; Каталог программы выбирается по ФАКТИЧЕСКИМ правам процесса (ошибка
  ; aa5af30c): запуск от имени администратора — %ProgramFiles%\ETN, обычный
  ; запуск — %LOCALAPPDATA%\Programs\ETN. При PrivilegesRequired=lowest Inno
  ; всегда работает в неадминистративном режиме, поэтому {autopf} указывает на
  ; профиль даже у элевированного процесса — вычислить каталог обязана
  ; GetDefaultAppDir. Жёсткий {commonpf} здесь недопустим: в user-режиме
  ; экземпляр не сможет создать каталог и записать деинсталлятор (Error 5).
  #define AppDir "{code:GetDefaultAppDir}"
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
;
; Пользовательская область (ошибка 0f8dd0f3, п.7 карточки 860def0d) задана
; ЯВНО, а не через {autodesktop}/{autoprograms}: машинная копия клиента ставится
; при элевированном запуске, когда Inno (PrivilegesRequired=lowest) остаётся в
; неадминистративном режиме и авто-константы указывают на профиль, а не на
; общие ярлыки. Машинные ярлыки заданы явно {commondesktop}/{commonprograms}
; (в административном режиме /ALLUSERS они совпадают с авто-константами), а
; пользовательские — {userdesktop}/{userprograms}. Явный каталог клиента в
; профиле совпадает с ClientInstallPath — область в install.json и реальное
; место файлов больше не расходятся.
#ifdef TestMode
  #define ShortcutDesktopDir ExtractFileDir(TestAppDir) + "\shortcuts\desktop"
  #define ShortcutMenuDir ExtractFileDir(TestAppDir) + "\shortcuts\menu"
  #define ShortcutUserDesktopDir ShortcutDesktopDir
  #define ShortcutUserMenuDir ShortcutMenuDir
  #define ClientUserDir TestAppDir
#else
  #define ShortcutDesktopDir "{commondesktop}"
  #define ShortcutMenuDir "{commonprograms}\ETN"
  #define ShortcutUserDesktopDir "{userdesktop}"
  #define ShortcutUserMenuDir "{userprograms}\ETN"
  #define ClientUserDir "{localappdata}\Programs\ETN"
#endif

; ============================================================================
; AppId — единственный источник идентификатора: из него Inno строит запись
; деинсталляции `{AppId}_is1`, по нему же ищется и чистится запись прежней
; области реестра (ошибка a7394117). Литералы в [Setup] и [Code] не дублируются.
#define ProductAppId "6D7E1C2A-4B9A-4E7C-9F3D-2A5B8C1E4F70"
#define TestUninstallAppId "B0C7D5E1-3A2F-4D6B-9E8C-1F0A2B3C4D5E"
#define ProductUninstallKey "{" + ProductAppId + "}_is1"
#define TestUninstallKey "{" + TestUninstallAppId + "}_is1"

[Setup]
; Идентификатор продукта: по нему Inno ведёт запись установки и обновление
; поверх прежней версии. Менять нельзя — иначе повторный запуск не увидит
; предыдущую установку. `{{` — литеральная скобка: AppId начинается с `{`.
#ifdef TestUninstallable
; Проба настоящего деинсталлятора (installer/tests/silent-codes.ps1, приёмка
; 8b1f5980): у тестовой установки отдельный AppId, чтобы запись установки и
; удаление не касались продуктовой установки на машине. Определяется только
; вместе с TestMode (см. Uninstallable ниже).
AppId={{{#TestUninstallAppId}}
#else
AppId={{{#ProductAppId}}
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
; фактическим правам процесса (ошибка aa5af30c): запуск от имени администратора
; — %ProgramFiles%\ETN, обычный запуск — %LOCALAPPDATA%\Programs\ETN, без прав.
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
; Restart Manager выключен: его диалог показывает служебный список процессов
; («4× ETN») и кнопку «Игнорировать», после которой копирование занятых файлов
; клиента гарантированно падает (ошибка 905dec4c). Клиент закрывает сам
; установщик — мягко, с таймаутом и принудительным завершением всех процессов
; до копирования (CloseRunningClient в [Code]).
CloseApplications=no
RestartApplications=no

; Элевация и режим — по фактическим правам процесса (ошибка aa5af30c).
; Продуктовая сборка работает с PrivilegesRequired=lowest: мастер стартует и
; работает в одном процессе и НЕ перезапускается после диалога режима —
; respawn оставлял на машине пользователя окно, не принимающее ввод.
;   * обычный запуск (процесс не элевирован) — только клиент «только для меня»
;     в профиль; сервер недоступен, причина и способ — на экране компонентов:
;     запустить установщик от имени администратора (правый клик → Запуск от
;     имени администратора);
;   * запуск от имени администратора — сервер и клиент «для всех» в Program
;     Files (IsAdmin); каталог программы вычисляет GetDefaultAppDir.
; /ALLUSERS разрешён (commandline) для тихого автообновления: служба LocalSystem
; запускает установщик уже элевированным — Inno включает административный режим
; без UAC и без respawn. /CURRENTUSER не нужен: обычный запуск и так lowest.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
; Один установщик за раз (наблюдение заказчика 2026-11-04): параллельный запуск
; второй версии во время первого оставлял залипший сеанс ввода. Inno создаёт
; мьютекс и второй экземпляр останавливает сообщением «установка уже
; запущена», ничего не меняя; в silent-режиме сообщение подавляется.
SetupMutex=ETNSetup
; Предупреждение Inno «per-user areas in admin mode» снято осознанно: пути
; {localappdata}/{userdesktop}/{userprograms} используются только установкой
; клиента «только для меня», а в элевированном (административном) запуске эта
; ветка отключена Check-условиями (GAdminMachineScope/InstallClientUser).
UsedUserAreasWarning=no
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
; Журнал Inno включён всегда (ошибка 2dd215f7): в нём лоадер печатает слой
; совместимости («Compatibility mode: …») и низкоуровневые причины отказа
; запуска/элевации, которых нет в нашем install-логе. Путь журнала пишется в
; наш лог строкой «Журнал Inno: …» (константа {log}).
SetupLogging=yes
UsePreviousAppDir=no
UsePreviousTasks=no

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
; Новые пользовательские строки задачи 3acd9c3c попадают сразу сюда.
; Массовый перенос старых литералов в [CustomMessages] — задача 4dc117f5.
BackupToolMissing=Инструмент резервного копирования баз данных не найден в поставке установщика.
BackupToolNotStarted=Инструмент резервного копирования баз данных не запустился — проверьте node.exe поставки и журнал установки.
; 34f8e315: служба возвращена после отмены обновления, но не отвечает.
ServiceStartManually=служба не запущена; запустите вручную (etn-service.exe start), журнал: %1
; 34f8e315: ручное снятие службы при отмене удаления — команды WinSW, без sc.
UninstallServiceManual=Остановите и удалите службу ETN вручную: etn-service.exe stop, дождитесь status=Stopped, затем etn-service.exe uninstall — и повторите удаление. Файлы не удалены.

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
; --- Инструмент бэкапа/восстановления БД (задача 3acd9c3c): dontcopy — только
; --- для ExtractTemporaryFile, в {app} отдельным файлом не копируется (код уже
; --- едет в dist\db); извлекается во {tmp} ПОД ИМЕНЕМ .mjs до остановки
; --- службы, чтобы обновить БД старой версии инструментом из payload.
; --- DestName обязателен: вне пакета @etn/server Node считал бы .js CommonJS.
; --- Без Check: извлечение не зависит от выбранных компонентов (бэкап бывает
; --- только при обновлении сервера, но файл нужен и тестовому прогону).
Source: "{#ServerPayload}\dist\db\db-backup.js"; DestName: "etn-db-tool.mjs"; Flags: dontcopy noencryption
#endif

#ifdef HaveNodePayload
Source: "{#NodePayload}\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallServerPayload
#endif

#ifdef HaveServicePayload
Source: "{#ServicePayload}\*"; DestDir: "{app}\service"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallServerPayload
#endif

; --- Клиент (поставка 98ad5eec). «Для всех» ставится в {app}\client
; --- административным режимом установки; «только для меня» — в каталог профиля
; --- пользователя ({#ClientUserDir} = %LOCALAPPDATA%\Programs\ETN), НЕ в {app}:
; --- в административном режиме (/ALLUSERS) {app} — Program Files, и файлы
; --- расходились с client_scope=user (ошибка 0f8dd0f3, п.7). Явный каталог
; --- совпадает с ClientInstallPath.
#ifdef HaveClientPayload
Source: "{#ClientPayload}\*"; DestDir: "{app}\client"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientMachine
Source: "{#ClientPayload}\*"; DestDir: "{#ClientUserDir}"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: InstallClientUser
#endif

[Icons]
; Ярлыки клиента (задача 98ad5eec): рабочий стол и меню «Пуск». Цель зависит
; от области установки — «для всех» ставится в {app}\client административным
; режимом установки, «только для меня» — в явный каталог профиля ({#ClientUserDir}).
; Каталоги ярлыков заданы через #define: в тестовой сборке они уведены в
; песочницу. Созданные ярлыки Inno удаляет деинсталлятором сам (записи [Icons]
; попадают в журнал удаления) — отдельного кода не нужно.
; Параметры подключения (ошибка 0f8dd0f3) лежат в самом ярлыке: запуск из меню
; «Пуск»/рабочего стола передаёт клиенту тот же prefill, что и кнопка
; «Запустить клиент». Это единственный путь для административного режима, где
; автозапуск клиента запрещён (профиль SMAA, 2dd215f7).
#ifdef HaveClientPayload
Name: "{#ShortcutMenuDir}\ETN"; Filename: "{app}\client\ETN.exe"; Parameters: "{code:ClientConnectParamsConst}"; WorkingDir: "{app}\client"; IconFilename: "{app}\client\ETN.exe"; Comment: "ETN — графовые базы знаний"; Check: InstallClientMachine
Name: "{#ShortcutUserMenuDir}\ETN"; Filename: "{#ClientUserDir}\ETN.exe"; Parameters: "{code:ClientConnectParamsConst}"; WorkingDir: "{#ClientUserDir}"; IconFilename: "{#ClientUserDir}\ETN.exe"; Comment: "ETN — графовые базы знаний"; Check: InstallClientUser
Name: "{#ShortcutDesktopDir}\ETN"; Filename: "{app}\client\ETN.exe"; Parameters: "{code:ClientConnectParamsConst}"; WorkingDir: "{app}\client"; IconFilename: "{app}\client\ETN.exe"; Check: InstallClientMachine
Name: "{#ShortcutUserDesktopDir}\ETN"; Filename: "{#ClientUserDir}\ETN.exe"; Parameters: "{code:ClientConnectParamsConst}"; WorkingDir: "{#ClientUserDir}"; IconFilename: "{#ClientUserDir}\ETN.exe"; Check: InstallClientUser
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
  { Снимок отката (bb063ac3): имя каталога — YYYYMMDD-HHmmss (15 символов).
    Ротация архивов БД (три последних) выполняется CLI сервера (3acd9c3c),
    в Pascal её больше нет. }
  BACKUP_DIR_NAME_LEN = 15;
  { Инструмент бэкапа/восстановления БД из payload: имя после
    ExtractTemporaryFile (DestName в [Files]) и имя файла отчёта key=value. }
  DB_TOOL_FILENAME = 'etn-db-tool.mjs';
  DB_TOOL_REPORT_NAME = 'etn-backup-report.txt';
  { Win32-коды отказа элевации (ошибка 2dd215f7): в журнал пишется код
    ShellExec, чтобы отличить отмену UAC от отказа окружения. }
  ERROR_ACCESS_DENIED = 5;
  ERROR_ELEVATION_REQUIRED = 740;
  ERROR_CANCELLED = 1223;
  { Остановка службы WinSW (34f8e315): после etn-service.exe stop состояние
    опрашивается через etn-service.exe status раз в 500 мс; бюджет — 60 с по
    системным часам (не суммой шагов: один вызов status — отдельный процесс
    ~350 мс, и суммирование растянуло бы бюджет в 2–3 раза). <stoptimeout>30sec
    в шаблоне службы — 30 с, остальное — запас на медленную остановку node.exe. }
  SERVICE_STOP_WAIT_MS = 60000;
  SERVICE_STOP_STEP_MS = 500;
  { stop на службе в переходном состоянии (StartPending/StopPending) WinSW
    2.12.0 возвращает 1061: StartPending может перейти в Running, поэтому stop
    повторяется с этим интервалом в пределах общего бюджета. }
  SERVICE_STOP_RETRY_MS = 1000;
  { Коды Win32, которые WinSW отдаёт кодом возврата. Разбор — в
    ServiceCommandResult: 1073/1056 — успех, 1060/1072 от stop — отказ. }
  ERROR_SERVICE_EXISTS = 1073;
  ERROR_SERVICE_ALREADY_RUNNING = 1056;
  ERROR_SERVICE_CANNOT_ACCEPT_CTRL = 1061;
  ERROR_SERVICE_NOT_ACTIVE = 1062;
  ERROR_SERVICE_DISABLED = 1058;
  ERROR_SERVICE_DOES_NOT_EXIST = 1060;
  ERROR_SERVICE_MARKED_FOR_DELETE = 1072;
  { Состояние службы по выводу etn-service.exe status (WinSW 2.12.0):
    Started — любое не-Stopped состояние (Running/StartPending/StopPending),
    Stopped — только полностью остановлена, NonExistent — службы нет. }
  SERVICE_STATE_STOPPED = 0;
  SERVICE_STATE_STARTED = 1;
  SERVICE_STATE_MISSING = 2;
  SERVICE_STATE_UNKNOWN = 3;
  { Health-check после запуска новой версии (требование 0a79d9de): бюджет
    60 с ФАКТИЧЕСКОГО времени, повтор каждые 2 с; прежние 60 с ожидания
    RUNNING не нужны — готовность подтверждает только health-check. Тело
    ответа разбирается, а не только код. 34f8e315 временно держал 120 с,
    чтобы сохранить прежний суммарный бюджет; a1ea1d40 вернул 60 с по
    требованию: health идёт после listen, миграция — только _system.db,
    markdown-переиндексация может быть дольше — отдельный риск. }
  HEALTH_WAIT_MS = 60000;
  HEALTH_STEP_MS = 2000;
  { Ветка реестра с записями «Программы и компоненты»: по ней ищется старый
    клиент electron-builder (NSIS) и запись установки Inno. }
  UNINSTALL_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall';
  { Та же ветка в 32-битном представлении профиля пользователя (WOW6432Node):
    запись прежней 32-битной установки могла остаться и там. }
  UNINSTALL_KEY_WOW = 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall';
  { Имя ключа записи деинсталляции Inno: AppId из [Setup] с суффиксом _is1
    (в реестре AppId записан с одной ведущей скобкой). У тестовой сборки с
    деинсталлятором свой AppId — продуктовую запись она не трогает.
    Ошибка a7394117: по этому ключу удаляется запись прежней области реестра. }
#ifdef TestUninstallable
  UNINSTALL_KEY_NAME = '{#TestUninstallKey}';
#else
  UNINSTALL_KEY_NAME = '{#ProductUninstallKey}';
#endif
  { Ожидание исчезновения записи Uninstall после удаления старого клиента:
    деинсталлятор NSIS с _?= завершается синхронно, но старая версия могла
    проигнорировать параметр и удалять в фоне — запись исчезает с задержкой.
    Опрос — раз в 500 мс, общий бюджет — 10 секунд (112642a4). Бюджет сокращён
    с 2 минут (ошибка 5b9743da): цикл не прокачивает сообщения, и долгое
    ожидание выглядело зависанием; в норме запись исчезает сразу. }
  LEGACY_GONE_WAIT_MS = 10000;
  LEGACY_GONE_STEP_MS = 500;
  { Закрытие запущенного клиента (задача 98ad5eec): сначала мягко (taskkill
    без /F — WM_CLOSE, Electron завершает процесс сам), ожидание выхода 30 с;
    только после таймаута — принудительно (/F /T) и ожидание ещё 15 с.
    Опрос — раз в 250 мс, как у службы и старого клиента. Если процесс не
    завершился и после /F — установка останавливается кодом 20 с причиной. }
  CLIENT_CLOSE_WAIT_MS = 30000;
  CLIENT_KILL_WAIT_MS = 15000;
  CLIENT_POLL_STEP_MS = 250;
  { Строки экрана компонентов (задача c4b68d78): два checkbox уровня 0 и
    group-строки уровня 1 под ними. Строка области клиента (6) —
    необязательная: удаляется и добавляется последней, индексы 0–5 стабильны. }
  COMP_ITEM_SERVER = 0;
  COMP_ITEM_SERVER_STATUS = 1;
  COMP_ITEM_SERVER_DESC = 2;
  COMP_ITEM_CLIENT = 3;
  COMP_ITEM_CLIENT_STATUS = 4;
  COMP_ITEM_CLIENT_DESC = 5;
  COMP_ITEM_CLIENT_SCOPE = 6;

var
  { Режим запуска }
  GSilent: Boolean;
  GServerOnly: Boolean;
  GPrivilegedPhase: Boolean;
  GIsElevated: Boolean;
  { Административный режим установки: установщик работает «для всех
    пользователей» (запуск от имени администратора или /ALLUSERS). Права даёт
    элевированный процесс; Inno не перезапускает мастер (ошибка aa5af30c).
    В TestMode моделируется /TESTADMINMODE=1. }
  GAdminInstallMode: Boolean;
  { Неадминистративный режим («только для меня»): сервер и клиент «для всех»
    недоступны, ставится только клиент в профиль пользователя (сценарий n2). }
  GUserOnlyMode: Boolean;
  { В административном режиме клиент ставится только «для всех»: под
    Administrator Protection элевированный процесс работает в отдельном
    профиле (SMAA), и «клиент для меня» попал бы в чужой профиль. }
  GAdminMachineScope: Boolean;
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
    налезают друг на друга. /TESTNOTICE=<текст> (c4b68d78) подставляет
    уведомление после возврата на экран компонентов для проверки его причины. }
  GTestLayout: String;
  GTestNotice: String;
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
    неудачи: техническую неудачу можно устранить и повторить установку,
    отказ — нет). }
  GClientCloseRefused: Boolean;
  { /TESTUSERINSTALL=1 — прогон установки клиента «только для меня» без окон:
    снимает silent-термин для проверки копирования неэлевированной фазой
    (silent-контракт клиент не ставит). }
  GTestUserInstall: String;
  { Хук ошибки 0f8dd0f3: /TESTCONNECTPARAMS=1 печатает в журнал параметры
    подключения, которые установщик передаст клиенту при «Запустить клиент»
    (проверка без живого клиента и без окон). }
  GTestConnectParams: String;
  { Хук 2dd215f7: /TESTADMINMODE=1 моделирует административный режим установки
    без настоящей элевации (проверка «клиент только для всех»); без него
    тестовая сборка работает как неадминистративный режим «только для меня». }
  GTestAdminMode: String;
  { Ошибка a7394117: /TESTINNOADMINMODE=1 моделирует административный режим
    самого Inno (/ALLUSERS): запись деинсталляции он пишет в HKLM; без хука
    тестовая сборка (PrivilegesRequired=lowest) пишет её в HKCU.
    /TESTUNINSTROOT=<подключ> уводит машинную область записи в песочницу HKCU:
    прав на настоящий HKLM в прогоне нет. Пользовательская область остаётся
    настоящим ключом Inno — так проверяется удаление оставшейся записи. }
  GTestInnoAdminMode: String;
  GTestUninstallRoot: String;
  { /TESTUSERONLYMODE=1 — явная проверка неадминистративного режима в тестовой
    сборке: сервер недоступен, ставится только клиент «для меня». }
  GTestUserOnlyMode: String;
  { B3: поведенческие пробы ветки «своя служба» — подмена имени службы для
    CIM-запроса и PID, который считается PID службы (проверка потомков). }
  GTestServiceName: String;
  GTestOwnServicePid: String;
  { 1dddac77: имитация неизвестного отказа пробного bind в запасной ветке —
    проверка перехода в статус 2 (fail-closed, код 20 с причиной). }
  GTestPortBindFail: String;
  { 1dddac77: имитация недоступной TCP-таблицы Windows (сборка без перечисления
    слушателей) и отсутствия службы ETN — проверка ветки «своя служба жива,
    таблица сломана» без реальной аномалии ОС. }
  GTestListenerTableOff: String;
  GTestNoService: String;
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
    4151edf6). /TESTSERVICESTATUS=fail|garbage|nonexistent — подмена вывода
    etn-service.exe status (ошибка, неизвестный вывод, NonExistent при живом
    ключе). /TESTSERVICEIMAGE, /TESTSERVICESTARTTYPE, /TESTSERVICEDELETEFLAG —
    подмена реестровой личности службы. /TESTSERVICESTOP=1061|1062 — код
    перехода/«уже остановлена»; 1061 повторяется, затем stop успешен.
    /TESTSERVICESTOP=fail-after-start — отказ останова после start (проверка
    отката при неудачной остановке). }
  GTestServiceRealFile: String;
  GTestServiceStatus: String;
  GTestServiceImage: String;
  GTestServiceStartType: String;
  GTestServiceDeleteFlag: String;
  { Состояние модели службы: команда start уже выполнялась (для
    TESTSERVICESTOP=fail-after-start) и служба снята из SCM (status после
    uninstall — NonExistent, ключ может остаться при 1072). }
  GTestServiceStartedFlag: Boolean;
  GTestServiceUninstalled: Boolean;
  { Сколько раз stop вернуть 1061 до успеха (TESTSERVICESTOP=1061). }
  GTestServiceStopRetries: Integer;
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
  { Файл параметров тестовой привилегированной фазы: пишется /TESTPARAMS и
    читается /PRIVILEGEDPHASE. GUI-установка его не использует — режим и выбор
    компонентов этот же процесс уже знает. }
  GParamsPath: String;

  { Выбор компонентов и параметры }
  GServerSelected: Boolean;
  { Пользователь (или тестовый хук) пытался выбрать сервер в обычном запуске:
    сервер не выбирается, на экране — причина ServerUnavailableReason. }
  GServerRequested: Boolean;
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
  { Найдена копия клиента «только для меня» (ClientUserCopyPresent). В
    административном режиме она не заменяется — рядом ставится машинная копия,
    и мастер обязан сказать об этом (2dd215f7, замечание верификатора п.1). }
  GUserClientCopyPresent: Boolean;
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
  { Архив БД (ZIP), созданный последним вызовом CreateDatabaseBackup ('' —
    архива нет). Вызывающему нужен путь для сообщения об отказе/откате. Откат
    БД восстанавливает только из него: LatestBackupDir — архив прошлых
    обновлений, для автоматического отката он не годится (bb063ac3). }
  GLastBackupDir: String;
  { Причина неудачного бэкапа — для сообщения (сценарий bc7cc846: причина,
    требуемый объём, путь к журналу). Текст причины берётся из отчёта
    инструмента (key=value, ключ error). }
  GBackupReason: String;
  { Путь к извлечённому во временный каталог etn-db-tool.mjs ('' — ещё не
    извлекался): один инструмент на backup и restore этого запуска. }
  GDatabaseToolPath: String;
  { Снимок отката текущего обновления (.install\rollback\<timestamp>) и
    последняя причина сбоя health-check для журнала и экрана ошибки. }
  GLastRollbackDir: String;
  GHealthReason: String;
  { Код возврата и текст последней команды службы: 1061/1062 (переход) нужны
    вызывающему для повтора stop, 1072 после uninstall — для подтверждения
    через status; текст причины — в сообщение и журнал (34f8e315). }
  GLastServiceCode: Integer;
  GLastServiceError: String;

  { Экран компонентов: список TNewCheckListBox (задача c4b68d78) и
    фиксированный нижний блок. Два checkbox уровня 0 (сервер и клиент), под
    каждым group-строки статуса и описания уровня 1 — TNewCheckListBox переносит
    caption по словам, а subitem остаётся одной строкой. }
  GComponentsPage: TWizardPage;
  GComponentsList: TNewCheckListBox;
  { Последняя строка списка (область клиента) сейчас существует: она
    удаляется/добавляется, индексы 0–5 при этом не сдвигаются. }
  GComponentsScopeRow: Boolean;
  { Ссылка на другие варианты установки сервера — в нижнем блоке, всегда
    видима (спека: «Другие варианты установки сервера (удалённый сервер,
    Docker)»). }
  GServerAltLink: TNewLinkLabel;
  { Каталог данных сервера — виден, когда сервер выбран или уже установлен. }
  GDataNoteLabel: TNewStaticText;
  { Причина неактивности «Далее» — внизу экрана, с префиксом «Далее
    недоступна: » (одна функция ComponentsReasonText — экран и журнал). }
  GReasonLabel: TNewStaticText;
  { Лицензия MIT (112642a4): чекбокс и ссылка на локальный текст; показываются
    только при первой установке (нет ни сервера, ни клиента). }
  GLicenseCheck: TNewCheckBox;
  GLicenseLink: TNewLinkLabel;
  GLicenseAccepted: Boolean;
  { Уведомление, оставленное после возврата на экран компонентов (ошибка
    закрытия клиента, ошибка удаления старого клиента): показывается вместо
    обычной причины и сбрасывается при изменении выбора. }
  GComponentsNotice: String;
  { Экран компонентов построен и начальный выбор перенесён в список. До этого
    обработчики не должны читать ещё не заполненный список. }
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
    тестовой привилегированной фазы идёт раньше: от него зависит выбор
    компонентов и место журнала). Выводятся сразу после InitLog. }
  GDeferredLog: String;
  { Файл причины отказа предусловия: привилегированная фаза (/PRIVILEGEDPHASE)
    пишет сюда причину, а вызывающий её процесс читает и показывает в
    сообщении об ошибке. }
  GReasonFile: String;
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

{ Каталог программы по фактическим правам процесса (ошибка aa5af30c).
  PrivilegesRequired=lowest всегда оставляет Inno в неадминистративном режиме,
  поэтому autopf у элевированного процесса указывал бы на профиль. Запуск от
  имени администратора — Program Files; обычный запуск — профиль пользователя
  (тот же каталог, что ClientUserDir). Функция вызывается и директивой
  DefaultDirName, и при вычислении GServerDir в InitializeSetup, — путь всегда
  один и тот же. }
function GetDefaultAppDir(Param: String): String;
begin
#ifdef TestMode
  { В тестовой сборке каталог изолирован и задан build.ps1; функция в этой
    ветке не участвует в выборе режима. }
  Result := ExpandConstant('{#AppDir}');
#else
  if IsAdmin then
    Result := ExpandConstant('{commonpf}\ETN')
  else
    Result := ExpandConstant('{localappdata}\Programs\ETN');
#endif
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

{ Каталог клиента «только для меня» — явная константа из #define: один и тот
  же путь в [Files], [Icons] и при определении «клиент установлен» (ошибка
  0f8dd0f3, п.7). }
function UserClientDir: String;
begin
  Result := ExpandConstant('{#ClientUserDir}');
end;

function ClientExeAt(const Dir: String): Boolean;
begin
  Result := (Dir <> '') and FileExists(Dir + '\ETN.exe');
end;

(* Копия клиента «только для меня»: строго корень профильного каталога —
  машинный клиент лежит в {app}\client и за пользовательскую копию не
  считается. Флаг нужен экрану компонентов: в административном режиме копия
  в профиле не заменяется, рядом появляется машинная (2dd215f7, замечание
  верификатора п.1). *)
function ClientUserCopyPresent: Boolean;
begin
  Result := ClientExeAt(UserClientDir);
end;

(* Машинная копия клиента: всегда во вложенном каталоге client ({app}\client
  либо {commonpf}\ETN\client, когда выбрана user-область). *)
function ClientMachineCopyPresent: Boolean;
begin
  Result := ClientExeAt(GServerDir + '\client') or
    ClientExeAt(MachineAppDir + '\client');
end;

(* Каталог установки клиента по области: «только для меня» — профиль
  пользователя (%LOCALAPPDATA%\Programs\ETN), «для всех» — Program Files.
  Показывается на экране компонентов; запущенный клиент ищется по обоим
  вариантам (ClientCloseRoots), потому что обновление может застать клиента
  прежней области. Каталог фиксирован ADR 144bcdb0, но область установки
  определяют фактические права процесса (ошибка aa5af30c).

  Ограничение Administrator Protection (2dd215f7): в элевированном процессе
  {localappdata} может указывать на профиль SMAA, а не на профиль запустившего
  пользователя. Поэтому путь «только для меня» задан явной константой
  {#ClientUserDir} (та же, что в [Files]/[Icons]), а не вычисляется из {autopf}
  выбранного режима: при обычном UAC она совпадает с профилем пользователя,
  под AP — нет, и копию пользователя установщик может не увидеть (ограничение
  диагностики, а не повод ставить вторую копию молча). *)
function ClientInstallPath: String;
begin
#ifdef TestMode
  Result := GServerDir;
#else
  if GClientScopeUser then
    Result := UserClientDir
  else
    Result := ExpandConstant('{commonpf}') + '\ETN';
#endif
end;

function ClientFilesPresent: Boolean;
begin
  (* Проверяются ОБЕ области (2dd215f7, замечание верификатора п.1): без
    явной проверки профиля административный режим (/ALLUSERS) не видел
    пользовательскую копию, считал клиент неустановленным и молча ставил
    вторую копию. GServerDir/MachineAppDir покрывают машинную копию
    ({app}\client) и запись без install.json. *)
  Result := ClientUserCopyPresent or ClientMachineCopyPresent or
    ClientExeAt(GServerDir) or ClientExeAt(MachineAppDir);
end;

{ Запись установки Inno: раздел машины (HKLM/HKLM64) пишет сам установщик
  в административном режиме; запись HKCU относится к клиенту «только для меня»
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
  Key := UNINSTALL_KEY + '\' + UNINSTALL_KEY_NAME;
  Result := RegKeyExists(HKLM, Key) or RegKeyExists(HKLM64, Key);
end;

{ Нормализация пути из значения реестра: снимаются кавычки и хвостовые
  обратные слэши. Inno пишет InstallLocation с AddBackslash, а UninstallString
  — в кавычках (см. Setup.Install.pas, RegisterUninstallInfo). }
function NormalizeRecordPath(const Value: String): String;
begin
  Result := Trim(Value);
  if (Length(Result) >= 2) and (Result[1] = '"') and
    (Result[Length(Result)] = '"') then
    Result := Trim(Copy(Result, 2, Length(Result) - 2));
  while (Length(Result) > 3) and (Result[Length(Result)] = '\') do
    Result := Copy(Result, 1, Length(Result) - 1);
end;

(* Каталог текущей машинной установки: {app} (обычно Program Files\ETN) либо
  MachineAppDir. Сравнение без учёта регистра — пути Windows. *)
function IsMachineInstallDir(const Dir: String): Boolean;
var
  Candidate, AppDir, MachineDir: String;
begin
  Result := False;
  Candidate := NormalizeRecordPath(Dir);
  if Candidate = '' then Exit;
  AppDir := NormalizeRecordPath(ExpandConstant('{app}'));
  MachineDir := NormalizeRecordPath(MachineAppDir);
  Result := (AppDir <> '') and (CompareText(Candidate, AppDir) = 0);
  if (not Result) and (MachineDir <> '') then
    Result := CompareText(Candidate, MachineDir) = 0;
end;

{ Путь к exe из UninstallString: Inno пишет его в кавычках, возможен хвост
  вида « /LOG». Без кавычек поддерживается путь до первого пробела. }
function UninstallExeFromString(const Value: String): String;
var
  S: String;
  P: Integer;
begin
  S := Trim(Value);
  Result := '';
  if S = '' then Exit;
  if S[1] = '"' then
  begin
    P := 2;
    while (P <= Length(S)) and (S[P] <> '"') do
      P := P + 1;
    if P <= Length(S) then
      Result := Copy(S, 2, P - 2)
    else
      Result := Copy(S, 2, Length(S) - 1);
  end
  else
  begin
    P := Pos(' /', S);
    if P > 0 then Result := Copy(S, 1, P - 1) else Result := S;
  end;
  Result := NormalizeRecordPath(Result);
end;

(* Ошибка 7dcbeb0c: под нашим AppId в реестре может лежать ЛЕГИТИМНАЯ
  per-user установка клиента «только для меня» (%LOCALAPPDATA%\Programs\ETN).
  Удаляем только запись машинной установки: InstallLocation или UninstallString
  указывают в каталог текущей машинной установки ({app}). Запись без этих
  значений или с чужим каталогом не трогаем: удалить чужое хуже, чем оставить
  дубль, о котором сообщит журнал. *)
function IsMachineUninstallRecord(const Root: Integer;
  const SubKey: String): Boolean;
var
  Location, Cmd, Exe: String;
begin
  Result := False;
  if RegQueryStringValue(Root, SubKey, 'InstallLocation', Location) and
    IsMachineInstallDir(Location) then
  begin
    Result := True;
    Exit;
  end;
  if RegQueryStringValue(Root, SubKey, 'UninstallString', Cmd) then
  begin
    Exe := UninstallExeFromString(Cmd);
    if (Exe <> '') and IsMachineInstallDir(ExtractFileDir(Exe)) then
      Result := True;
  end;
end;

{ Удаляет запись деинсталляции по одному корню реестра. Возвращает 1, если
  запись была и удалена. Удаляется только запись машинной установки (ошибка
  7dcbeb0c); чужая (per-user клиент) остаётся с записью в журнале. Ошибка
  удаления установку не отменяет: WARN в журнал (ошибка a7394117). }
function DeleteUninstallRecordAt(const Root: Integer; const RootName,
  SubKey: String): Integer;
begin
  Result := 0;
  if not RegKeyExists(Root, SubKey) then Exit;
  if not IsMachineUninstallRecord(Root, SubKey) then
  begin
    LogLine('INFO', 'Запись деинсталляции другой установки оставлена: ' +
      RootName + '\' + SubKey);
    Exit;
  end;
  if RegDeleteKeyIncludingSubkeys(Root, SubKey) then
  begin
    Result := 1;
    LogLine('INFO', 'Удалена запись деинсталляции прежней области: ' +
      RootName + '\' + SubKey);
  end
  else
    LogLine('WARN', 'Запись деинсталляции прежней области не удалена: ' +
      RootName + '\' + SubKey + ' (установка продолжается)');
end;

{ SID загруженного профиля пользователя. Служебные профили (LocalSystem,
  LocalService, NetworkService) и псевдонимы (`.DEFAULT`, `…_Classes`)
  пропускаются: записи установки в них не бывает, а трогать их незачем. }
function IsUserProfileSid(const Name: String): Boolean;
begin
  Result := (CompareText(Copy(Name, 1, 4), 'S-1-') = 0) and
    (Pos('_', Name) = 0) and
    (CompareText(Name, 'S-1-5-18') <> 0) and
    (CompareText(Name, 'S-1-5-19') <> 0) and
    (CompareText(Name, 'S-1-5-20') <> 0);
end;

{ Ошибка a7394117 (доработка по ревью верификатора): при тихом /ALLUSERS
  установщик запускает служба под LocalSystem, поэтому HKCU процесса — профиль
  системы, а запись GUI-админ-установки лежит в профиле пользователя.
  Перечисляем ЗАГРУЖЕННЫЕ профили (HKEY_USERS\<SID>) и удаляем в каждом запись
  нашего AppId — обычную и WOW6432Node. Удаляется только запись машинной
  установки (ошибка 7dcbeb0c): per-user клиент в профиле пользователя
  (%LOCALAPPDATA%\Programs\ETN) принадлежит другой установке и остаётся.
  Незагруженный профиль (пользователь вышел) сюда не виден: это ограничение
  отмечено в карточке компонента. Возвращает число удалённых ключей. }
function DeleteUninstallRecordInUserHives: Integer;
var
  Names: TArrayOfString;
  I: Integer;
  Base, Profile, SubKey, RootName: String;
begin
  Result := 0;
  Base := '';
  RootName := 'HKU';
#ifdef TestMode
  { Песочница теста: профили моделируются поддеревом HKCU\<root>\Profiles,
    реальные HKU в прогоне без прав администратора не читаются. }
  if GTestUninstallRoot <> '' then
  begin
    Base := GTestUninstallRoot + '\Profiles';
    RootName := 'HKCU\' + Base;
  end;
#endif
  if Base <> '' then
  begin
    if not RegGetSubkeyNames(HKCU, Base, Names) then Exit;
  end
  else if not RegGetSubkeyNames(HKU, '', Names) then
  begin
    LogLine('WARN', 'Не удалось перечислить профили пользователей (HKU): ' +
      'запись деинсталляции в них не проверена (установка продолжается)');
    Exit;
  end;
  for I := 0 to GetArrayLength(Names) - 1 do
  begin
    Profile := Names[I];
    if not IsUserProfileSid(Profile) then Continue;
    SubKey := Profile + '\' + UNINSTALL_KEY + '\' + UNINSTALL_KEY_NAME;
    if Base <> '' then
    begin
      SubKey := Base + '\' + SubKey;
      Result := Result + DeleteUninstallRecordAt(HKCU, RootName, SubKey);
    end
    else
      Result := Result + DeleteUninstallRecordAt(HKU, RootName, SubKey);
    SubKey := Profile + '\' + UNINSTALL_KEY_WOW + '\' + UNINSTALL_KEY_NAME;
    if Base <> '' then
    begin
      SubKey := Base + '\' + SubKey;
      Result := Result + DeleteUninstallRecordAt(HKCU, RootName, SubKey);
    end
    else
      Result := Result + DeleteUninstallRecordAt(HKU, RootName, SubKey);
  end;
end;

{ Удаляет запись деинсталляции в машинной (HKLM) или пользовательской (HKCU)
  области — в той, куда Inno её НЕ записал (ошибка a7394117). В тестовой
  сборке машинная область моделируется поддеревом HKCU: прав на HKLM в прогоне
  silent-codes.ps1 нет, а пользовательская область остаётся настоящим ключом
  Inno. Возвращает число удалённых ключей. }
function DeleteForeignUninstallRecord(const MachineScope: Boolean): Integer;
var
  SubKey: String;
begin
  Result := 0;
  SubKey := UNINSTALL_KEY + '\' + UNINSTALL_KEY_NAME;
  if MachineScope then
  begin
#ifdef TestMode
    if GTestUninstallRoot <> '' then
    begin
      Result := DeleteUninstallRecordAt(HKCU, 'HKCU',
        GTestUninstallRoot + '\Machine\' + UNINSTALL_KEY_NAME);
      Exit;
    end;
#endif
    { HKLM в 32- и 64-битном представлении — разные ветки реестра: прежняя
      установка могла записать запись в любую из них. }
    Result := DeleteUninstallRecordAt(HKLM64, 'HKLM64', SubKey);
    Result := Result + DeleteUninstallRecordAt(HKLM32, 'HKLM32', SubKey);
  end
  else
  begin
    { HKCU процесса — это профиль того, кто запустил установщик. При
      /ALLUSERS из службы LocalSystem это профиль системы, поэтому основную
      работу делает обход загруженных профилей пользователей. }
    Result := DeleteUninstallRecordAt(HKCU, 'HKCU', SubKey);
    Result := Result + DeleteUninstallRecordInUserHives;
  end;
end;

{ Ошибка a7394117: PrivilegesRequired=lowest пишет запись деинсталляции в
  HKCU при элевированном GUI-запуске (Inno остаётся в неадминистративном
  режиме) и в HKLM при тихом /ALLUSERS-обновлении. Прежнюю запись Inno не
  мигрирует — после обновления в «Программах и компонентах» две строки.
  После успешной установки удаляем запись в области, куда Inno её не записал.
  Удаляется только запись машинной установки — per-user клиент «только для
  меня» сохраняется (ошибка 7dcbeb0c). В режиме «только для меня» ничего не
  удаляем: запись одна, прав на HKLM нет. }
procedure RemoveDuplicateUninstallRecord;
var
  ForeignMachineScope: Boolean;
begin
#ifdef TestMode
  { Тестовая сборка без деинсталлятора (Uninstallable=no) запись не создаёт,
    а её AppId — продуктовый: удалять по нему запись на машине нельзя. }
  #ifndef TestUninstallable
  Exit;
  #endif
#endif
  if not GAdminInstallMode then Exit;
  { IsAdminInstallMode: Inno в административном режиме (/ALLUSERS) — запись
    HKLM, значит удаляем HKCU; иначе (элевированный GUI-запуск) — наоборот. }
  ForeignMachineScope := not IsAdminInstallMode;
#ifdef TestMode
  if GTestInnoAdminMode = '1' then ForeignMachineScope := False;
#endif
  DeleteForeignUninstallRecord(ForeignMachineScope);
end;

procedure DetectState;
begin
  GServerFilesPresent := ServerFilesPresent;
  GDataDirPresent := DataDirPresent;
  GClientFilesPresent := ClientFilesPresent;
  GUserClientCopyPresent := ClientUserCopyPresent;
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
    begin
      { Административный режим поверх установки «только для меня»: копия в
        профиле не заменяется, рядом появляется машинная (2dd215f7, замечание
        верификатора п.1) — обещать «замену» было бы неправдой. }
      if GAdminMachineScope and GUserClientCopyPresent and
         (not ClientMachineCopyPresent) then
        Result := 'клиент установлен в варианте «только для меня» — будет ' +
          'добавлена копия «для всех пользователей»'
      else
        Result := 'клиент уже установлен — при обновлении он будет заменён';
    end
    else
    begin
      { Режим «только для меня» поверх машинной копии (ошибка 5b9743da):
        «выберите клиент, чтобы заменить его» — неправда, выбор снят именно
        потому, что без прав администратора машинную копию не заменить.
        Подпись обязана совпадать с причиной неактивности «Далее», иначе экран
        противоречит сам себе. }
      if GUserOnlyMode and (GInstalledClientScope = 'machine') then
        Result := 'клиент установлен для всех пользователей — нужны права ' +
          'администратора'
      else
        Result := 'клиент уже установлен; выберите клиент, чтобы заменить его';
    end;
  end
  else if GLegacyClientFound and GClientSelected then
  begin
    { Компактно: длинный текст выталкивал нижние подписи за поверхность
      страницы (ошибка 860def0d, п.1). В режиме «только для меня» машинный
      старый клиент не удаляется — не обещаем этого (2dd215f7). }
    Result := 'найден клиент ETN ' + GLegacyClientVersion +
      ' от старого установщика (NSIS' +
      IfStr(GLegacyClientMachine, ', для всех пользователей', '') + ')';
    if GUserOnlyMode and GLegacyClientMachine then
      Result := Result + ' — для его удаления нужны права администратора; ' +
        'новый клиент поставится в ваш профиль'
    else
      Result := Result + ' — перед установкой он будет удалён';
  end
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
  области). В этом состоянии выводится текст области (ClientScopeText):
  выбора в мастере нет — его задают фактические права процесса. }
function ClientScopeFixed: Boolean;
begin
  Result := GClientState = 'installed';
end;

function ClientScopeText: String;
begin
  if GAdminMachineScope then
  begin
    Result := 'Установщик запущен от имени администратора: клиент ставится ' +
      'для всех пользователей. Подключение к локальному серверу уже ' +
      'предзаполнено в ярлыке клиента.';
    { Копия «только для меня» в профиле не заменяется (файлы user-области в
      admin-режиме не копируются): говорим прямо, иначе мастер обещает
      «замену», а на диске остаются две копии (2dd215f7, п.1). }
    if GUserClientCopyPresent then
    begin
      if ClientMachineCopyPresent then
        Result := Result + ' Найден клиент «только для меня»: он останется в ' +
          'профиле, обновляется копия «для всех пользователей».'
      else
        Result := Result + ' Найден клиент «только для меня»: он останется в ' +
          'профиле, а рядом будет установлена копия «для всех пользователей».';
    end;
    Exit;
  end;
  { Обычный запуск (ошибка aa5af30c): клиент «для всех» без прав администратора
    не заменить — говорим, что сделать, вместо невнятного «выберите хотя бы
    один компонент». Мастер не просит прав и не перезапускается: сервер и
    клиент «для всех» ставятся запуском установщика от имени администратора. }
  if GUserOnlyMode and (GInstalledClientScope = 'machine') then
  begin
    Result := 'Клиент установлен для всех пользователей: его обновление ' +
      'требует прав администратора. Закройте установщик и запустите его от ' +
      'имени администратора (правый клик → Запуск от имени администратора).';
    Exit;
  end;
  { Режим «только для меня»: клиент в профиле обновляется на месте; другой
    вариант — запуск установщика от имени администратора (см. выше). }
  if GUserOnlyMode then
  begin
    Result := 'Клиент установлен в варианте «только для меня» — обновление ' +
      'продолжится в ваш профиль. Чтобы поставить клиент «для всех ' +
      'пользователей», закройте установщик и запустите его от имени ' +
      'администратора (правый клик → Запуск от имени администратора).';
    Exit;
  end;
  { Остальные состояния (тестовый прогон без моделируемого режима): та же
    формулировка пользователя (860def0d, n5), что и в режиме «только для
    меня», — сменить вариант можно повторным запуском с нужными правами.
    «Удалите клиента и установите заново» больше не советуем. }
  if GClientScopeUser then
    Result := 'Клиент установлен в варианте «только для меня». Чтобы поставить ' +
      'клиент «для всех пользователей», закройте установщик и запустите его ' +
      'от имени администратора (правый клик → Запуск от имени администратора).'
  else
    Result := 'Клиент установлен в варианте «для всех пользователей». Чтобы ' +
      'поставить клиент «только для меня», запустите установщик обычным ' +
      'двойным кликом (без прав администратора).';
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
{ Текст отказа ShellExec по Win32-коду (2dd215f7): код 1223 — отказ UAC, 740 —
  нужны права администратора, 5 — доступ запрещён. Нужен и здесь, и на экране
  ошибки: без кода отказ оболочки невозможно разобрать по журналу. }
function ShellErrorText(const Code: Integer): String;
begin
  if Code = ERROR_CANCELLED then
    Result := 'код 1223: запрос UAC отклонён (ERROR_CANCELLED)'
  else if Code = ERROR_ELEVATION_REQUIRED then
    Result := 'код 740: требуются права администратора (ERROR_ELEVATION_REQUIRED)'
  else if Code = ERROR_ACCESS_DENIED then
    Result := 'код 5: отказано в доступе (ERROR_ACCESS_DENIED)'
  else if Code = 0 then
    Result := 'код не сообщён'
  else
    Result := 'Win32-код ' + IntToStr(Code);
end;

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
  begin
    { Win32-код отказа — в журнал: диагностика проблем оболочки (2dd215f7). }
    LogLine('ERROR', 'ShellExec(open, LICENSE) не удался: ' + ShellErrorText(Code));
    SuppressibleMsgBox('Не удалось открыть текст лицензии во временном каталоге: ' +
      ExpandConstant('{tmp}\LICENSE'), mbError, MB_OK, IDOK);
  end;
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
  машинную запись снимает административный режим установки — в GUI проверка
  идёт на экране готовности. Возвращает False только когда удаление обязательно
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
    { Машинный клиент старого установщика без прав не удалить: скриптовой
      элевации больше нет (2dd215f7), привилегированной фазы в GUI нет. В
      режиме «только для меня» это не ошибка — новый клиент ставится в профиль,
      старый остаётся; на экране компонентов обещания удаления нет. }
    LogLine('WARN', 'Старый клиент ETN ' + Version + ' установлен для всех ' +
      'пользователей: удаление требует прав администратора — запустите ' +
      'установщик от имени администратора (правый клик → Запуск от имени ' +
      'администратора)');
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

{ Каталоги, процессы которых заменяет этот экземпляр установщика: выбранная
  область установки и второй вариант ADR 144bcdb0. Закрываем только клиента из
  этих каталогов: Get-Process по имени ETN.exe без фильтра закрывал любые
  процессы ETN.exe на машине — при per-user установке это живой клиент другого
  пользователя: 30+15 с ожидания и код 20 (замечание приёмки 98ad5eec).

  Второй каталог нужен и в привилегированной фазе (905dec4c): каталог
  локальных приложений там — профиль того же пользователя (обычное
  подтверждение UAC), поэтому пользовательский клиент закрывается, а машинный
  клиент из Program Files закрывается всегда, даже если сейчас выбрана область
  «только для меня». Раньше при user-scope в привилегированной фазе фильтр был
  пуст и клиент не закрывался вовсе. }
function ClientCloseRoots: String;
var
  UserRoot, MachineRoot: String;
begin
#ifdef TestMode
  { Тестовая сборка реальные каталоги продукта не трогает: фильтр — каталог
    программы теста либо явный /TESTCLIENTPATH. }
  Result := ClientInstallPath;
#else
  UserRoot := ExpandConstant('{localappdata}') + '\Programs\ETN';
  MachineRoot := ExpandConstant('{commonpf}') + '\ETN';
  if GClientScopeUser then
    Result := UserRoot + #13#10 + MachineRoot
  else
    Result := MachineRoot + #13#10 + UserRoot;
#endif
end;

{ Условие PowerShell «путь процесса начинается с каталога». Завершающий '\'
  обязателен: иначе 'C:\Program Files\ETN' совпал бы с
  'C:\Program Files\ETN2\ETN.exe'. }
function ClientRootCondition(const Root: String): String;
var
  Dir: String;
begin
  Result := '';
  if Root = '' then Exit;
  Dir := Root;
  if Copy(Dir, Length(Dir), 1) <> '\' then
    Dir := Dir + '\';
  StringChangeEx(Dir, '''', '''''', True);
  Result := '$path.StartsWith(''' + Dir + ''',' +
    '[System.StringComparison]::OrdinalIgnoreCase)';
end;

{ Условие для всех каталогов клиента (ClientCloseRoots), объединённое через
  -or: процесс из любого варианта установки подлежит закрытию. }
function ClientPathCondition: String;
var
  Roots, Root, Cond: String;
  P: Integer;
begin
  Result := '';
  Cond := '';
  Roots := ClientCloseRoots;
  while Roots <> '' do
  begin
    P := Pos(#13#10, Roots);
    if P > 0 then
    begin
      Root := Copy(Roots, 1, P - 1);
      Roots := Copy(Roots, P + 2, Length(Roots) - P - 1);
    end
    else
    begin
      Root := Roots;
      Roots := '';
    end;
    if Root <> '' then
    begin
      if Cond <> '' then
        Cond := Cond + ' -or ';
      Cond := Cond + ClientRootCondition(Root);
    end;
  end;
  Result := Cond;
end;

{ Настоящий опрос: Get-Process по имени ETN.exe, но только процессы из
  каталогов клиента (Product: ClientPathCondition; TestMode: /TESTCLIENTPATH,
  по умолчанию каталог программы тестового прогона) — чужой клиент не
  трогается. PowerShell получает скрипт в двойных кавычках: внутри только
  одинарные (грабли B3 приёмки 9b310991). }
function RealClientPids: String;
var
  Script, Args, OutFile, OutFileLiteral, Condition: String;
  Code: Integer;
  Raw: AnsiString;
begin
  Result := '';
  OutFile := ExpandConstant('{tmp}') + '\etn-client-pids.txt';
  DeleteFile(OutFile);
  OutFileLiteral := OutFile;
  StringChangeEx(OutFileLiteral, '''', '''''', True);
  Condition := '';
#ifdef TestMode
  { Тестовая сборка может задать каталог явно (/TESTCLIENTPATH); иначе —
    общий продуктовый фильтр по каталогам клиента (в тестовой сборке это
    каталог программы теста). }
  if GTestClientPath <> '' then
    Condition := ClientRootCondition(GTestClientPath);
#endif
  if Condition = '' then
    Condition := ClientPathCondition;
  if Condition = '' then
  begin
    LogLine('INFO', 'Клиент ETN: каталоги установки не определены — закрывать нечего');
    Exit;
  end;
  Script :=
    '$ids=@(Get-Process -Name ''ETN''|ForEach-Object{$p=$_;$path='''';' +
    'try{$path=$p.Path}catch{};' +
    'if(' + Condition + '){$p.Id}});' +
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
  { Этап пишется в журнал всегда: журнал — след каждого этапа, а в GUI он
    ещё и подписывается в StatusLabel. Установка идёт одним процессом. }
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
  { Причина отказа — для экрана ошибки и для тестов: файл тот же, что у
    предусловий (GReasonFile), и читается по любому ненулевому коду установки.
    Перезаписывается после отката: должен быть виден не только причина, но и
    итог отката (bb063ac3). }
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
  { Причина сбоя — экрану ошибки и тестам: иначе будет виден только код.
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
var
  ScopeDir: String;
begin
  Result := '';
  (* Сначала — каталог ВЫБРАННОЙ области: при client_scope=user в
    административном режиме установки (/ALLUSERS) {app} — Program Files, а
    клиент лежит в профиле пользователя (ошибка 0f8dd0f3, п.7). *)
  ScopeDir := ClientInstallPath;
  if ScopeDir <> '' then
  begin
    if FileExists(ScopeDir + '\ETN.exe') then
    begin
      Result := ScopeDir + '\ETN.exe';
      Exit;
    end;
    if FileExists(ScopeDir + '\client\ETN.exe') then
    begin
      Result := ScopeDir + '\client\ETN.exe';
      Exit;
    end;
  end;
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

  { Режим «только для меня» (2dd215f7): прав администратора нет, поэтому
    сервер не ставится. Клиент ставится в профиль; если он уже установлен
    «для всех», обновить его без прав нельзя — выбор снят, объяснение выводит
    ClientScopeText. }
  if GUserOnlyMode then
  begin
    GServerSelected := False;
    GClientSelected := (GClientState <> 'installed') or
      (GInstalledClientScope <> 'machine');
    GClientScopeUser := True;
    Exit;
  end;

  { Область клиента: в административном режиме — «для всех»
    (GAdminMachineScope), иначе «только для меня»; если клиент уже стоит «для
    всех» (install.json, client_scope=machine) — сохраняем машинную область. }
  if GAdminMachineScope then
    GClientScopeUser := False
  else
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

{ Единственная точка вызова etn init. Работает под администратором (в GUI —
  административный режим установки; в тестах — /PRIVILEGEDPHASE): файлы
  сервера уже скопированы, права администратора есть. Повторно init
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
      LogLine('INFO', 'etn init не вызывается: первый администратор уже есть (проверка под администратором)');
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

{ Файл параметров тестовой привилегированной фазы: строки key=value, ASCII.
  Путь передаётся через /PARAMS (см. ParamsFilePath); файл кладётся в общий
  каталог. Кандидаты по порядку: %ProgramData%\ETN\.install (только для
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
  { Тестовый контракт: /PRIVILEGEDPHASE получает путь через /PARAMS, иначе —
    путь, сохранённый /TESTPARAMS в GParamsPath. }
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

{ Элевация (ошибка 2dd215f7): скриптовый self-exec установщика запрещён
  платформой — Inno не даёт Exec/ShellExec/FileCopy целиться в сам setup до
  старта установки (документация ISetup.chm, разделы Exec/ShellExec; пробы
  дают код 5). Права запрашивает сам Inno при старте: PrivilegesRequired=
  admin и PrivilegesRequiredOverridesAllowed=commandline dialog. Режим
  «только для меня» (/CURRENTUSER или выбор в диалоге) идёт без элевации.
  Скриптовых RunElevatedChild, /ELEVATEHELPER и RelaunchAdminInstallMode
  больше нет. }


{ ---------------------------------------------------------------------------
  Установка и параметры
  --------------------------------------------------------------------------- }
function InPrivilegedContext: Boolean;
begin
  { Привилегированная фаза — та, что пишет в каталог программы и каталог
    данных: silent (предусловие — уже элевирован), внутренняя фаза
    /PRIVILEGEDPHASE (тесты установщика; GUI её больше не запускает), либо
    элевированный процесс (запуск от имени администратора или /ALLUSERS);
    каталог программы при этом выбирает GetDefaultAppDir. Неэлевированный
    процесс пишет в профиль пользователя и привилегированной фазой не
    считается — иначе сервер попал бы и в Program Files, и в профиль.
    GAdminInstallMode, а не IsAdminInstallMode: в тестовой сборке режим
    моделируется хуком /TESTADMINMODE. }
  Result := GWorkAllowed and
    (GSilent or GPrivilegedPhase or (GIsElevated and GAdminInstallMode));
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
    профиль другого администратора. GAdminMachineScope закрывает ещё один
    случай — пользователь сам запустил установщик от имени администратора:
    под Administrator Protection это отдельный профиль SMAA, и «для меня»
    попало бы в него (замечание верификатора 2dd215f7, п.4). }
  Result := GClientSelected and GWorkAllowed and GClientScopeUser and
    (not GPrivilegedPhase) and (not GAdminMachineScope);
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
  Служба ETN (WinSW) — остановка и запуск, задачи bb063ac3 и 34f8e315.

  Служба останавливается до копирования файлов: иначе занятые node.exe,
  better-sqlite3 и файлы сервера не заменить. Состояние читается командой
  `etn-service.exe status` (WinSW 2.12.0: Started/Stopped/NonExistent, exit 0);
  после stop опрос повторяется, пока служба не окажется Stopped: WinSW вернул
  управление раньше фактической остановки дочернего node.exe. В тестовой
  сборке управление службой подменяется хуками — настоящая служба Windows не
  нужна.
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

{ Последняя непустая строка вывода команды: WinSW печатает одно слово
  (Started/Stopped/NonExistent), но CLR или логгер могут дописать строки.
  Сравнение — Trim/UpperCase по последней непустой. }
function LastNonEmptyLine(const Text: String): String;
var
  I, StartPos: Integer;
  Line: String;
begin
  Result := '';
  StartPos := 1;
  for I := 1 to Length(Text) do
    if Text[I] = #10 then
    begin
      Line := Trim(Copy(Text, StartPos, I - StartPos));
      if Line <> '' then Result := Line;
      StartPos := I + 1;
    end;
  Line := Trim(Copy(Text, StartPos, Length(Text) - StartPos + 1));
  if Line <> '' then Result := Line;
end;

{ Причина отказа status: конкретика (1072, 5, 1058, 1060) вместо «не удалось».
  Неизвестный код дополняется последней строкой вывода. }
function ServiceStatusFailureText(const Code: Integer; const Output: String): String;
var
  Line: String;
begin
  Line := LastNonEmptyLine(Output);
  if Code = ERROR_ACCESS_DENIED then
    Result := 'отказано в доступе (5)'
  else if Code = ERROR_SERVICE_DISABLED then
    Result := 'служба отключена (1058)'
  else if Code = ERROR_SERVICE_DOES_NOT_EXIST then
    Result := 'служба не найдена (1060)'
  else if (Code = ERROR_SERVICE_MARKED_FOR_DELETE) or (Pos('1072', Line) > 0) then
    Result := 'служба помечена на удаление (1072)'
  else
  begin
    Result := 'etn-service.exe status вернул код ' + IntToStr(Code);
    if Line <> '' then Result := Result + ': ' + Line;
  end;
end;

{ Состояние службы по выводу etn-service.exe status (WinSW 2.12.0):
  Started — любое не-Stopped состояние (Running/StartPending/StopPending),
  Stopped — служба полностью остановлена, NonExistent — службы нет.
  Detail — причина, если состояние определить не удалось (SERVICE_STATE_UNKNOWN).
  Ошибка или неизвестный вывод — быстрый отказ вызывающего: бюджет ожидания не
  тратится. В тестовом режиме вывод подменяется хуками; без /TESTSERVICE
  тестовая сборка службу не видит и состояние не запрашивает. }
function ServiceStatusOutput(var Detail: String): Integer;
var
  Args, OutFile, Line, Output: String;
  Code: Integer;
begin
  Detail := '';
#ifdef TestMode
  if GTestServiceStatus = 'fail' then
  begin
    Detail := 'etn-service.exe status не выполнен (тестовый режим)';
    Result := SERVICE_STATE_UNKNOWN;
    Exit;
  end;
  if GTestServiceStatus = 'garbage' then
  begin
    Detail := 'неизвестный вывод etn-service.exe status: TestMode';
    Result := SERVICE_STATE_UNKNOWN;
    Exit;
  end;
  if GTestServiceStatus = 'nonexistent' then
  begin
    Result := SERVICE_STATE_MISSING;
    Exit;
  end;
  if (GTestService <> '') and (GTestServiceRealFile = '1') and
     (not FileExists(ServiceExePath)) then
  begin
    Detail := 'нет ' + ServiceExePath + ' — состояние службы не определить';
    Result := SERVICE_STATE_UNKNOWN;
    Exit;
  end;
  if GTestServiceState = 'running' then
  begin
    Result := SERVICE_STATE_STARTED;
    Exit;
  end;
  if GTestServiceState = 'stopped' then
  begin
    Result := SERVICE_STATE_STOPPED;
    Exit;
  end;
  if GTestServiceUninstalled then
  begin
    Result := SERVICE_STATE_MISSING;
    Exit;
  end;
  if (GTestService <> '') and GTestServiceRunning then
    Result := SERVICE_STATE_STARTED
  else
    Result := SERVICE_STATE_STOPPED;
  Exit;
#endif
  if not FileExists(ServiceExePath) then
  begin
    Detail := 'нет ' + ServiceExePath + ' — состояние службы не определить';
    Result := SERVICE_STATE_UNKNOWN;
    Exit;
  end;
  OutFile := ExpandConstant('{tmp}') + '\etn-service-status.txt';
  DeleteFile(OutFile);
  { Кавычки вокруг exe обязательны: путь в Program Files содержит пробелы. }
  Args := '/c ""' + ServiceExePath + '" status > "' + OutFile + '" 2>&1"';
  if not Exec(ExpandConstant('{cmd}'), Args, ExtractFileDir(ServiceExePath), SW_HIDE,
    ewWaitUntilTerminated, Code) then
  begin
    Detail := 'не удалось запустить etn-service.exe status';
    Result := SERVICE_STATE_UNKNOWN;
    Exit;
  end;
  Output := '';
  if FileExists(OutFile) then Output := ReadTextFile(OutFile);
  if Code <> 0 then
  begin
    Detail := ServiceStatusFailureText(Code, Output);
    Result := SERVICE_STATE_UNKNOWN;
    Exit;
  end;
  Line := UpperCase(Trim(LastNonEmptyLine(Output)));
  if Line = 'STARTED' then
    Result := SERVICE_STATE_STARTED
  else if Line = 'STOPPED' then
    Result := SERVICE_STATE_STOPPED
  else if Line = 'NONEXISTENT' then
    Result := SERVICE_STATE_MISSING
  else
  begin
    if Line = '' then
      Detail := 'etn-service.exe status вернул пустой вывод'
    else
      Detail := 'неизвестный вывод etn-service.exe status: ' + Line;
    Result := SERVICE_STATE_UNKNOWN;
  end;
end;

function ServiceStopWaitMs: Integer;
begin
  Result := SERVICE_STOP_WAIT_MS;
#ifdef TestMode
  if GTestServiceWait <> '' then
    Result := StrToIntDef(GTestServiceWait, Result);
#endif
end;

{ Текущее время в секундах (сутки*86400 + часы*3600 + минуты*60 + секунды).
  GetTickCount в Pascal Script Inno 6 недоступен, поэтому бюджет ожидания
  считается по системным часам, а не суммой шагов опроса: один вызов status —
  отдельный процесс ~350 мс, и суммирование растянуло бы 60 с в разы.
  Точность — 1 с; для бюджета остановки этого достаточно. }
function ServiceNowSeconds: Int64;
var
  Stamp, DayStamp, TimeStamp: Int64;
begin
  { Разделители — #0 (по умолчанию), а не пустая строка: GetDateTimeString
    принимает Char и на пустой строке падает во время выполнения. }
  Stamp := StrToInt64Def(GetDateTimeString('yyyymmddhhnnss', #0, #0), 0);
  DayStamp := Stamp div 1000000;
  TimeStamp := Stamp mod 1000000;
  Result := DayStamp * 86400 + (TimeStamp div 10000) * 3600 +
    ((TimeStamp div 100) mod 100) * 60 + (TimeStamp mod 100);
end;

{ Ждём подтверждённой остановки — объявлена после RunServiceCommand: Pascal
  Script Inno требует, чтобы вызываемая функция была объявлена выше. }

{ Причина отказа команды службы с отдельным сообщением для каждого кода
  (1058/1060/1061/1072): администратору важно отличие «служба отключена» от
  «помечена на удаление» и «нет прав». }
function ServiceCodeText(const Verb: String; const Code: Integer): String;
begin
  if Code = 0 then
    Result := ''
  else if Code = ERROR_ACCESS_DENIED then
    Result := 'отказано в доступе (5) — нужны права администратора'
  else if Code = ERROR_SERVICE_DISABLED then
    Result := 'служба отключена (1058): включите её или удалите'
  else if Code = ERROR_SERVICE_DOES_NOT_EXIST then
    Result := 'служба не найдена (1060)'
  else if Code = ERROR_SERVICE_MARKED_FOR_DELETE then
    Result := 'служба помечена на удаление (1072)'
  else if Code = ERROR_SERVICE_CANNOT_ACCEPT_CTRL then
    Result := 'служба в переходном состоянии (1061)'
  else if Code = ERROR_SERVICE_NOT_ACTIVE then
    Result := 'служба уже остановлена (1062)'
  else if Code = ERROR_SERVICE_ALREADY_RUNNING then
    Result := 'служба уже запущена (1056)'
  else if Code = ERROR_SERVICE_EXISTS then
    Result := 'служба уже существует (1073)'
  else
    Result := 'код ' + IntToStr(Code);
  if (Result <> '') and (Pos('(', Result) = 0) then
    Result := 'команда ' + Verb + ' вернула ' + Result;
end;

{ Разбор кода возврата команды WinSW — общий для продуктовой ветки и модели
  службы (поведенческий тест 1073 обязан проверять тот же код, что выполняется
  на машине). WinSW 2.12.0: install существующей службы — 1073; start уже
  работающей — 1056; stop на остановленной/в переходе — 1062/1061; uninstall
  отсутствующей/помеченной — 1060/1072. 1060/1072 от stop — отказ: в обновлении
  служба не остановлена. GLastServiceCode запоминается для повтора stop (1061)
  и подтверждения uninstall (1072), GLastServiceError — для причины. }
function ServiceCommandResult(const Verb: String; const Code: Integer): Boolean;
begin
  Result := False;
  GLastServiceCode := Code;
  GLastServiceError := '';
  if Code = 0 then
  begin
    LogLine('INFO', 'Служба: команда ' + Verb + ' выполнена');
    Result := True;
    Exit;
  end;
  if (Verb = 'install') and (Code = ERROR_SERVICE_EXISTS) then
  begin
    LogLine('INFO', 'Служба: install — служба уже существует (код ' +
      IntToStr(Code) + '), регистрация не требуется');
    Result := True;
    Exit;
  end;
  if (Verb = 'start') and (Code = ERROR_SERVICE_ALREADY_RUNNING) then
  begin
    LogLine('INFO', 'Служба: start — служба уже запущена (код ' +
      IntToStr(Code) + ')');
    Result := True;
    Exit;
  end;
  if (Verb = 'stop') and
     ((Code = ERROR_SERVICE_NOT_ACTIVE) or (Code = ERROR_SERVICE_CANNOT_ACCEPT_CTRL)) then
  begin
    LogLine('INFO', 'Служба: stop — ' + ServiceCodeText(Verb, Code) +
      ', ждём подтверждённой остановки');
    Result := True;
    Exit;
  end;
  if (Verb = 'uninstall') and
     ((Code = ERROR_SERVICE_DOES_NOT_EXIST) or (Code = ERROR_SERVICE_MARKED_FOR_DELETE)) then
  begin
    LogLine('INFO', 'Служба: uninstall — ' + ServiceCodeText(Verb, Code) +
      ', подтверждаем удаление через status');
    Result := True;
    Exit;
  end;
  GLastServiceError := Verb + ': ' + ServiceCodeText(Verb, Code);
  LogLine('WARN', 'Служба: команда ' + Verb + ' вернула код ' +
    IntToStr(Code) + ': ' + ServiceCodeText(Verb, Code));
end;

{ Команда WinSW: install, uninstall, stop, start. Код возврата команды —
  успех/неудача (разбор — ServiceCommandResult).

  В тестовой сборке настоящая служба рабочей машины не трогается никогда.
  Хук /TESTSERVICE=present|absent включает модель: команды не выполняются, их
  результат и состояние службы ведут флаги GTestServiceRegistered/Running
  (install/uninstall меняют регистрацию, start/stop — состояние), а сбои
  задаются хуками /TESTSERVICEINSTALL=fail|exists,
  /TESTSERVICEUNINSTALL=fail|1072, /TESTSERVICESTOP=fail|fail-after-start|1061|1062,
  /TESTSERVICESTART=fail|1056|1061. Без /TESTSERVICE команда тоже не выполняется
  (изоляция тестов от машины), но состояние службы остаётся «не
  зарегистрирована». /TESTSERVICEREALFILE=1 добавляет проверку наличия
  etn-service.exe, как в продуктовой ветке: проба настоящего деинсталлятора
  (приёмка 4151edf6) должна падать, если путь к службе вычислен неверно. }
function RunServiceCommand(const Verb: String): Boolean;
var
  Code: Integer;
begin
  Result := False;
  GLastServiceCode := 0;
  GLastServiceError := '';
#ifdef TestMode
  if (GTestService <> '') and (GTestServiceRealFile = '1') and
     (not FileExists(ServiceExePath)) then
  begin
    GLastServiceError := 'нет ' + ServiceExePath;
    LogLine('ERROR', 'Служба: нет ' + ServiceExePath + ' — команда ' + Verb +
      ' не выполнена');
    Exit;
  end;
  if GTestService <> '' then
  begin
    if (Verb = 'stop') and (GTestServiceStop = 'fail') then
    begin
      GLastServiceError := 'stop не выполнен (хук)';
      LogLine('WARN', 'Служба (тестовый режим): stop не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'stop') and (GTestServiceStop = 'fail-after-start') and
       GTestServiceStartedFlag then
    begin
      GLastServiceError := 'stop не выполнен после start (хук)';
      LogLine('WARN', 'Служба (тестовый режим): stop после start не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'start') and (GTestServiceStart = 'fail') then
    begin
      GLastServiceError := 'start не выполнен (хук)';
      LogLine('WARN', 'Служба (тестовый режим): start не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'install') and (GTestServiceInstall = 'fail') then
    begin
      GLastServiceError := 'install не выполнен (хук)';
      LogLine('WARN', 'Служба (тестовый режим): install не выполнен (хук)');
      Exit;
    end;
    if (Verb = 'uninstall') and (GTestServiceUninstall = 'fail') then
    begin
      GLastServiceError := 'uninstall не выполнен (хук)';
      LogLine('WARN', 'Служба (тестовый режим): uninstall не выполнен (хук)');
      Exit;
    end;

    if (Verb = 'install') and (GTestServiceInstall = 'exists') then
    begin
      GTestServiceRegistered := True;
      Code := ERROR_SERVICE_EXISTS;
    end
    else if (Verb = 'install') then
    begin
      GTestServiceRegistered := True;
      GTestServiceUninstalled := False;
      Code := 0;
    end
    else if Verb = 'uninstall' then
    begin
      GTestServiceRunning := False;
      GTestServiceStartedFlag := False;
      GTestServiceUninstalled := True;
      if GTestServiceUninstall = '1072' then
      begin
        { 1072: SCM-запись снята, ключ реестра может остаться — ServiceRegistered
          остаётся True, status обязан вернуть NonExistent. }
        GTestServiceRegistered := True;
        Code := ERROR_SERVICE_MARKED_FOR_DELETE;
      end
      else
      begin
        GTestServiceRegistered := False;
        Code := 0;
      end;
    end
    else if Verb = 'start' then
    begin
      GTestServiceRunning := True;
      GTestServiceStartedFlag := True;
      GTestServiceUninstalled := False;
      if GTestServiceStart = '1056' then Code := ERROR_SERVICE_ALREADY_RUNNING
      else if GTestServiceStart = '1061' then Code := ERROR_SERVICE_CANNOT_ACCEPT_CTRL
      else Code := 0;
    end
    else if Verb = 'stop' then
    begin
      if (GTestServiceStop = '1061') and (GTestServiceStopRetries > 0) then
      begin
        { StartPending: первый stop возвращает 1061, служба ещё Started; повтор —
          успех (проверка повтора в WaitServiceStopped). }
        GTestServiceStopRetries := GTestServiceStopRetries - 1;
        Code := ERROR_SERVICE_CANNOT_ACCEPT_CTRL;
      end
      else if GTestServiceStop = '1062' then
      begin
        GTestServiceRunning := False;
        GTestServiceStartedFlag := False;
        Code := ERROR_SERVICE_NOT_ACTIVE;
      end
      else
      begin
        GTestServiceRunning := False;
        GTestServiceStartedFlag := False;
        Code := 0;
      end;
    end
    else
      Code := 0;

    Result := ServiceCommandResult(Verb, Code);
    if Result then
      LogLine('INFO', 'Служба (тестовый режим): команда ' + Verb +
        ' — успех (exe=' + ServiceExePath + ', config=' + ServiceDir +
        '\service\etn-service.xml, exists=' + Pick(FileExists(ServiceExePath), '1', '0') + ')');
    Exit;
  end;
  LogLine('WARN', 'Служба (тестовый режим, /TESTSERVICE не задан): команда ' +
    Verb + ' не выполняется — тестовая сборка не трогает службы машины');
  Result := True;
  Exit;
#endif
  if not FileExists(ServiceExePath) then
  begin
    GLastServiceError := 'нет ' + ServiceExePath;
    LogLine('ERROR', 'Служба: нет ' + ServiceExePath + ' — команда ' + Verb +
      ' не выполнена');
    Exit;
  end;
  LogLine('INFO', 'Служба: ' + ServiceExePath + ' ' + Verb +
    ' (конфигурация: ' + ServiceDir + '\service\etn-service.xml, exists=1)');
  if not Exec(ServiceExePath, Verb, ExtractFileDir(ServiceExePath), SW_HIDE,
    ewWaitUntilTerminated, Code) then
  begin
    GLastServiceError := 'не удалось запустить etn-service.exe';
    LogLine('WARN', 'Служба: не удалось запустить ' + ServiceExePath +
      ' ' + Verb);
    Exit;
  end;
  Result := ServiceCommandResult(Verb, Code);
end;

{ Ждём подтверждённой остановки: опрос status раз в SERVICE_STOP_STEP_MS,
  бюджет — по часам (не суммой шагов). Stop 1061 повторяется раз в
  SERVICE_STOP_RETRY_MS: StartPending мог перейти в Running. Бюджет
  ServiceStopWaitMs действует с момента начала остановки (StartAt). }
function WaitServiceStopped(StartAt: Int64; AllowMissing: Boolean;
  var Reason: String): Boolean;
var
  Status: Integer;
  Detail: String;
  NextStopAt: Int64;
  RetryStop: Boolean;
begin
  Result := False;
  Reason := '';
  RetryStop := GLastServiceCode = ERROR_SERVICE_CANNOT_ACCEPT_CTRL;
  NextStopAt := ServiceNowSeconds + 1;
  while (ServiceNowSeconds - StartAt) * 1000 < ServiceStopWaitMs do
  begin
    if RetryStop and (ServiceNowSeconds >= NextStopAt) then
    begin
      if not RunServiceCommand('stop') then
      begin
        Reason := 'не удалось остановить службу ' + SERVICE_NAME + ': ' +
          IfStr(GLastServiceError = '', 'причина в журнале', GLastServiceError);
        Exit;
      end;
      RetryStop := GLastServiceCode = ERROR_SERVICE_CANNOT_ACCEPT_CTRL;
      NextStopAt := ServiceNowSeconds + 1;
    end;
    Status := ServiceStatusOutput(Detail);
    if Status = SERVICE_STATE_STOPPED then
    begin
      Result := True;
      Exit;
    end;
    if Status = SERVICE_STATE_MISSING then
    begin
      if AllowMissing then
      begin
        Result := True;
        Exit;
      end;
      Reason := 'служба ' + SERVICE_NAME + ' зарегистрирована в реестре, но SCM ' +
        'её не видит (status=NonExistent) — несогласованное состояние';
      Exit;
    end;
    if Status = SERVICE_STATE_UNKNOWN then
    begin
      Reason := 'не удалось определить состояние службы ' + SERVICE_NAME + ': ' +
        IfStr(Detail = '', 'причина в журнале', Detail);
      Exit;
    end;
    Sleep(SERVICE_STOP_STEP_MS);
  end;
  Reason := 'служба ' + SERVICE_NAME + ' не остановилась за ' +
    IntToStr(ServiceStopWaitMs) + ' мс';
end;

{ ImagePath службы из реестра (в тестовом режиме — хук /TESTSERVICEIMAGE;
  без хука считается путём этой установки). Кавычки WinSW при install
  добавляет, если путь содержит пробелы, — сравнение без них и без регистра. }
function ServiceImagePath: String;
begin
  Result := '';
#ifdef TestMode
  if GTestService <> '' then
  begin
    if GTestServiceImage <> '' then
      Result := GTestServiceImage
    else
      Result := ServiceExePath;
    Exit;
  end;
#endif
  RegQueryStringValue(HKLM, 'SYSTEM\CurrentControlSet\Services\' + SERVICE_NAME,
    'ImagePath', Result);
end;

function NormalizeServicePath(const Path: String): String;
begin
  Result := Trim(Path);
  if (Length(Result) >= 2) and (Result[1] = '"') and
     (Result[Length(Result)] = '"') then
    Result := Copy(Result, 2, Length(Result) - 2);
  Result := LowerCase(Trim(Result));
end;

function ServiceImagePathMatches: Boolean;
begin
  Result := NormalizeServicePath(ServiceImagePath) =
    NormalizeServicePath(ServiceExePath);
end;

function ServiceStartDisabled: Boolean;
var
  Value: DWORD;
begin
#ifdef TestMode
  if GTestService <> '' then
  begin
    Result := GTestServiceStartType = '4';
    Exit;
  end;
#endif
  Result := RegQueryDWordValue(HKLM,
    'SYSTEM\CurrentControlSet\Services\' + SERVICE_NAME, 'Start', Value) and
    (Value = 4);
end;

function ServiceDeleteFlagSet: Boolean;
var
  Value: DWORD;
begin
#ifdef TestMode
  if GTestService <> '' then
  begin
    Result := GTestServiceDeleteFlag = '1';
    Exit;
  end;
#endif
  Result := RegQueryDWordValue(HKLM,
    'SYSTEM\CurrentControlSet\Services\' + SERVICE_NAME, 'DeleteFlag', Value) and
    (Value = 1);
end;

{ Личность службы до изменений (34f8e315): ключ HKLM есть — служба обязана
  быть нашей (ImagePath = <каталог программы>\service\etn-service.exe) и
  работоспособной. Чужая/устаревшая служба, Start=4 (disabled), DeleteFlag=1 и
  status NonExistent при живом ключе отсекаются ДО копирования файлов кодом 20:
  иначе install пропускается (1073), а start падает уже после замены файлов.
  Ошибка/неизвестный вывод status — тоже быстрый отказ с конкретной причиной. }
function CheckServiceIdentity(var Reason: String): Boolean;
var
  Detail: String;
  Status: Integer;
begin
  Result := True;
  Reason := '';
  if GServerMode = 'app' then Exit;
  if not ServiceRegistered then Exit;
  if not ServiceImagePathMatches then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' зарегистрирована с другим путём: ' +
      IfStr(ServiceImagePath = '', '<нет ImagePath>', ServiceImagePath) +
      ' (ожидается ' + ServiceExePath + ') — чужая или устаревшая служба; ' +
      'удалите её вручную и повторите установку';
    Result := False;
    Exit;
  end;
  if ServiceStartDisabled then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' отключена (Start=4): включите её ' +
      '(Start=2) или удалите и повторите установку';
    Result := False;
    Exit;
  end;
  if ServiceDeleteFlagSet then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' помечена на удаление (DeleteFlag=1): ' +
      'перезагрузите машину или удалите ключ службы и повторите установку';
    Result := False;
    Exit;
  end;
  Status := ServiceStatusOutput(Detail);
  if Status = SERVICE_STATE_MISSING then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' зарегистрирована в реестре, но SCM ' +
      'её не видит (status=NonExistent) — несогласованное состояние; ' +
      'перезагрузите машину или удалите ключ службы';
    Result := False;
    Exit;
  end;
  if Status = SERVICE_STATE_UNKNOWN then
  begin
    Reason := 'не удалось определить состояние службы ' + SERVICE_NAME + ': ' +
      IfStr(Detail = '', 'причина в журнале', Detail);
    Result := False;
  end;
end;

{ Остановка службы перед заменой файлов (AllowMissing=False) и при удалении
  программы (AllowMissing=True: status=NonExistent допустим). False — служба
  осталась работать (или состояние не подтвердилось): вызывающий отказывает
  кодом 20 до замены файлов. Причина возвращается для журнала и сообщения. }
function StopServiceForUpdate(var Reason: String; AllowMissing: Boolean): Boolean;
var
  Detail: String;
  Status: Integer;
  StartTick: Int64;
begin
  Result := True;
  Reason := '';
  if not ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' не зарегистрирована — ' +
      'останавливать нечего');
    Exit;
  end;
  Status := ServiceStatusOutput(Detail);
  if Status = SERVICE_STATE_STOPPED then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' уже остановлена (status=Stopped)');
    Exit;
  end;
  if Status = SERVICE_STATE_MISSING then
  begin
    if AllowMissing then
    begin
      LogLine('INFO', 'Служба ' + SERVICE_NAME + ' отсутствует в SCM ' +
        '(status=NonExistent) — останавливать нечего');
      Exit;
    end;
    Reason := 'служба ' + SERVICE_NAME + ' зарегистрирована в реестре, но SCM ' +
      'её не видит (status=NonExistent) — несогласованное состояние';
    Result := False;
    Exit;
  end;
  if Status = SERVICE_STATE_UNKNOWN then
  begin
    Reason := 'не удалось определить состояние службы ' + SERVICE_NAME + ': ' +
      IfStr(Detail = '', 'причина в журнале', Detail);
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Остановка службы ' + SERVICE_NAME + ' (status=Started)');
  StartTick := ServiceNowSeconds;
  if not RunServiceCommand('stop') then
  begin
    Reason := 'не удалось остановить службу ' + SERVICE_NAME + ': ' +
      IfStr(GLastServiceError = '', 'причина в журнале', GLastServiceError);
    Result := False;
    Exit;
  end;
  if not WaitServiceStopped(StartTick, AllowMissing, Reason) then
  begin
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ' остановлена');
end;

{ Подтверждение снятия после uninstall: exit 0 (в том числе 1072) не доказывает
  удаление — WinSW возвращает 0, а ключ службы может остаться. Опрашиваем
  status до NonExistent; Started/Stopped по истечении бюджета — удаление не
  завершено. }
function WaitServiceRemoved(StartTick: Int64; var Reason: String): Boolean;
var
  Detail: String;
  Status: Integer;
begin
  Result := False;
  Reason := '';
  while (ServiceNowSeconds - StartTick) * 1000 < ServiceStopWaitMs do
  begin
    Status := ServiceStatusOutput(Detail);
    if Status = SERVICE_STATE_MISSING then
    begin
      Result := True;
      Exit;
    end;
    if Status = SERVICE_STATE_UNKNOWN then
    begin
      Reason := 'не удалось подтвердить снятие службы ' + SERVICE_NAME + ': ' +
        IfStr(Detail = '', 'причина в журнале', Detail);
      Exit;
    end;
    Sleep(SERVICE_STOP_STEP_MS);
  end;
  if Status = SERVICE_STATE_STARTED then
    Reason := 'служба ' + SERVICE_NAME + ' всё ещё работает после uninstall'
  else
    Reason := 'служба ' + SERVICE_NAME + ' осталась в SCM после uninstall ' +
      '(status=' + Pick(Status = SERVICE_STATE_STOPPED, 'Stopped', 'не NonExistent') + ')';
end;

{ Запуск службы после замены файлов: start вызывается всегда для
  зарегистрированной службы (она остановлена перед копированием), ожидания
  RUNNING больше нет — готовность подтверждает health-check (34f8e315).
  start уже работающей службы WinSW завершает кодом 1056 — это успех. }
function StartServiceIfNeeded: Boolean;
begin
  Result := True;
  if not ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' не зарегистрирована — ' +
      'запускать нечего');
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ': команда start');
  if not RunServiceCommand('start') then
  begin
    LogLine('ERROR', 'Служба ' + SERVICE_NAME + ': команда start не выполнена: ' +
      IfStr(GLastServiceError = '', 'причина в журнале', GLastServiceError));
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ': команда start принята');
end;

{ Регистрация службы WinSW (8b1f5980): выполняется после подстановки
  etn-service.xml и до запуска. WinSW install читает etn-service.xml рядом с
  etn-service.exe — из него берутся точка запуска, стартовый режим, recovery и
  учётная запись. Режим app службу не регистрирует: сервер запускает
  пользователь.

  Повторная установка: уже зарегистрированную службу не перегистрируем — WinSW
  2.12.0 вернул бы ERROR_SERVICE_EXISTS (1073), а конфигурацию WinSW читает при
  каждом старте. Перед этим личность службы проверяется ещё раз: 1073 — успех
  только для СВОЕЙ службы, чужую не запускаем.

  False — служба не зарегистрирована. Регистрация идёт после копирования
  файлов, поэтому вызывающий отдаёт код 10 (сбой выполнения), а не 20
  (34f8e315). }
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
    if not CheckServiceIdentity(Reason) then
    begin
      LogLine('ERROR', 'Служба ' + SERVICE_NAME + ' уже зарегистрирована, но ' +
        'не может быть использована: ' + Reason);
      Result := False;
      Exit;
    end;
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' уже зарегистрирована — ' +
      'install не требуется');
    Exit;
  end;
  LogLine('INFO', 'Регистрация службы ' + SERVICE_NAME + ': ' + ServiceExePath +
    ' install (конфигурация: ' + Config + ')');
  if not RunServiceCommand('install') then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' не зарегистрирована: ' +
      'etn-service.exe install вернул ошибку: ' +
      IfStr(GLastServiceError = '', 'причина в журнале', GLastServiceError) +
      ' (конфигурация: ' + Config + ')';
    Result := False;
    Exit;
  end;
  { 1073 — служба появилась между проверкой реестра и install (гонка). Успех
    только для СВОЕЙ службы: чужую/устаревшую не запускаем (34f8e315). }
  if (GLastServiceCode = ERROR_SERVICE_EXISTS) and
     (not CheckServiceIdentity(Reason)) then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' уже зарегистрирована, но ' +
      'не может быть использована: ' + Reason;
    LogLine('ERROR', Reason);
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ' зарегистрирована (install)');
end;

{ Снятие службы при удалении программы (8b1f5980): stop + uninstall строго до
  удаления файлов (usUninstall). Служба, оставшаяся в SCM с путём в удалённый
  каталог, ломает повторную установку и висит в списке служб. False — служба
  осталась: удаление программы отменяется, причина возвращается вызывающему.

  Чужую/устаревшую службу (ImagePath не наш) не трогаем: предупреждение, файлы
  программы удалить можно. status=NonExistent допустим. После uninstall
  подтверждаем удаление через status (1072 возвращает 0, ключ может остаться);
  оставшийся ключ при status=NonExistent — SCM завершит удаление после
  перезагрузки. }
function RemoveServiceOnUninstall(var Reason: String): Boolean;
var
  StartTick: Int64;
begin
  Result := True;
  Reason := '';
  if not ServiceRegistered then
  begin
    LogLine('INFO', 'Служба ' + SERVICE_NAME + ' не зарегистрирована — ' +
      'снимать нечего');
    Exit;
  end;
  if not ServiceImagePathMatches then
  begin
    LogLine('WARN', 'Служба ' + SERVICE_NAME + ' зарегистрирована с другим путём: ' +
      IfStr(ServiceImagePath = '', '<нет ImagePath>', ServiceImagePath) +
      ' — чужая или устаревшая, не снимаю; файлы программы будут удалены');
    Exit;
  end;
  if not StopServiceForUpdate(Reason, True) then
  begin
    Reason := 'служба ' + SERVICE_NAME + ' не остановлена: ' + Reason;
    Result := False;
    Exit;
  end;
  StartTick := ServiceNowSeconds;
  if not RunServiceCommand('uninstall') then
  begin
    Reason := 'не удалось снять службу ' + SERVICE_NAME +
      ' (etn-service.exe uninstall вернул ошибку): ' +
      IfStr(GLastServiceError = '', 'причина в журнале', GLastServiceError);
    Result := False;
    Exit;
  end;
  if not WaitServiceRemoved(StartTick, Reason) then
  begin
    Reason := 'удаление службы ' + SERVICE_NAME + ' не завершено: ' + Reason;
    Result := False;
    Exit;
  end;
  LogLine('INFO', 'Служба ' + SERVICE_NAME + ' снята (uninstall)');
  if ServiceRegistered then
    LogLine('WARN', 'Ключ службы ' + SERVICE_NAME + ' ещё существует при ' +
      'status=NonExistent — SCM завершит удаление после перезагрузки; ' +
      'файлы программы удалять можно');
end;

{ ---------------------------------------------------------------------------
  Health-check (требование 0a79d9de): один GET /api/v1/health → 200, status=ok,
  db=ok, version = целевая из тела того же ответа. Тело разбирается, а не
  только HTTP-код; второй GET /api/v1/version установщик не вызывает —
  эндпоинт остаётся для клиентов и диагностики (задача a1ea1d40).
  Бюджет — 60 с фактического времени, повтор каждые 2 с; один запрос с
  --max-time 5 может перебрать бюджет до ~5 с — это допустимо.
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

{ Одна попытка расширенного health-check: единственный GET /api/v1/health,
  version берётся из того же тела. RequireTargetVersion=False нужен после
  отката: прежняя версия обязана отвечать, но её версия — не целевая. }
function CheckHealthOnce(const RequireTargetVersion: Boolean;
  var Detail: String): Boolean;
var
  Base, Body, Status, Db, Ver: String;
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
  Result := True;
end;

{ Health-check: fail-closed — успех объявляется только при подтверждённом
  запуске сервера целевой версии. Хук /TESTHEALTH=ok|fail подменяет весь
  опрос (тестовая сборка); /TESTHEALTHURL направляет запросы на подставной
  HTTP-сервер, чтобы разбор тела проверялся по-настоящему. }
function ProbeHealth(const RequireTargetVersion: Boolean): Boolean;
var
  StartAt, ElapsedMs, RemainingMs: Int64;
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
  { Бюджет — фактическое время по системным часам, а не сумма Sleep: один
    запрос с --max-time 5 может занять до 5 с, и сумма пауз исказила бы
    бюджет в разы. Перебор одного запроса до ~5 с допустим. }
  StartAt := ServiceNowSeconds;
  while True do
  begin
    if CheckHealthOnce(RequireTargetVersion, GHealthReason) then
    begin
      LogLine('INFO', 'Health-check ' + HealthBaseUrl + ': успех');
      Result := True;
      Exit;
    end;
    ElapsedMs := (ServiceNowSeconds - StartAt) * 1000;
    { Часы могли скорректироваться назад: отрицательный остаток не должен
      растягивать бюджет. }
    if ElapsedMs < 0 then ElapsedMs := 0;
    if ElapsedMs >= HealthWaitMs then Break;
    { Sleep не уходит за бюджет: остаток меньше шага — спим остаток. }
    RemainingMs := HealthWaitMs - ElapsedMs;
    if RemainingMs > HealthStepMs then RemainingMs := HealthStepMs;
    Sleep(RemainingMs);
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

{ Имя каталога снимка отката: YYYYMMDD-HHmmss; суффикс -N — если два снимка
  попали в одну секунду (быстрый повтор в тестах). Формат общий с прежними
  каталогами архивов; им пользуется очистка снимков отката. }
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

{ Метка времени из имени ZIP-архива
  etn-backup-<версия>-<YYYYMMDD-HHMMSS>[-N].zip ('' — имя не по шаблону).
  Сортировать по полному имени нельзя: версия стоит раньше метки, и архив
  новой версии оказался бы «старше» архива старой. }
function BackupZipStamp(const Name: String): String;
var
  I, L, TailLen: Integer;
  Tail: String;
begin
  Result := '';
  L := Length(Name);
  if (L < 20) or (CompareText(Copy(Name, L - 3, 4), '.zip') <> 0) then Exit;
  for I := 1 to L - 15 do
    if (Name[I] = '-') and IsAllDigits(Copy(Name, I + 1, 8)) and
       (Name[I + 9] = '-') and IsAllDigits(Copy(Name, I + 10, 6)) then
    begin
      Tail := Copy(Name, I + 16, L - (I + 15));
      TailLen := Length(Tail);
      if (CompareText(Tail, '.zip') = 0) or
         ((TailLen > 5) and (Tail[1] = '-') and
          (CompareText(Copy(Tail, TailLen - 3, 4), '.zip') = 0) and
          IsAllDigits(Copy(Tail, 2, TailLen - 5))) then
        Result := Copy(Name, I + 1, 15);
    end;
end;

{ Самый свежий архив по времени из имени: нужен итоговой сводке и экрану
  ошибки, чтобы показать реальный путь резервной копии (архив создаёт CLI
  сервера; каталог архивов — единственный источник пути). }
function LatestBackupDirName(const BackupsDir: String): String;
var
  FindRec: TFindRec;
  Stamp, Best: String;
begin
  Result := '';
  Best := '';
  if not FindFirst(BackupsDir + '\etn-backup-*.zip', FindRec) then Exit;
  try
    repeat
      if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then
      begin
        Stamp := BackupZipStamp(FindRec.Name);
        if (Stamp <> '') and ((Best = '') or (Stamp > Best)) then
        begin
          Best := Stamp;
          Result := FindRec.Name;
        end;
      end;
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

{ Новое имя архива и ротация трёх последних — в CLI сервера (3acd9c3c,
  server/src/db/db-backup.ts). В Pascal остаются только функции чтения
  каталога архивов для сообщений. }

{ SQLite-операции (чекпойнт WAL, integrity_check, копирование баз и ротация)
  вынесены в CLI сервера — задача 3acd9c3c. Pascal только запускает
  самодостаточный etn-db-tool.mjs через node.exe поставки и разбирает отчёт
  key=value; сюда SQL-логику не возвращать. }

{ Извлечь инструмент во временный каталог. Повторный вызов использует уже
  извлечённый файл; ошибка — False с причиной в Reason. }
function EnsureDatabaseTool(var Reason: String): Boolean;
begin
  Result := False;
  Reason := '';
  if GDatabaseToolPath <> '' then
  begin
    Result := True;
    Exit;
  end;
  try
    ExtractTemporaryFile(DB_TOOL_FILENAME);
  except
    Reason := CustomMessage('BackupToolMissing');
    LogLine('ERROR', 'Бэкап БД: не удалось извлечь ' + DB_TOOL_FILENAME +
      ' из установщика: ' + GetExceptionMessage);
    Exit;
  end;
  GDatabaseToolPath := ExpandConstant('{tmp}') + '\' + DB_TOOL_FILENAME;
  Result := FileExists(GDatabaseToolPath);
  if not Result then
    Reason := CustomMessage('BackupToolMissing');
end;

{ Значение из отчёта инструмента: строки key=value, разделитель — первый '='.
  Пустое значение и отсутствие ключа дают ''. }
function DatabaseReportValue(const ReportPath, Key: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Line, Prefix: String;
begin
  Result := '';
  if not LoadStringsFromFile(ReportPath, Lines) then Exit;
  Prefix := Key + '=';
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Lines[I];
    { UTF-8 BOM в первой строке — отчёт пишет Node; ключи английские. }
    if (I = 0) and (Length(Line) > 0) and (Line[1] = #$FEFF) then
      Delete(Line, 1, 1);
    if (Length(Line) >= Length(Prefix)) and
       (CompareText(Copy(Line, 1, Length(Prefix)), Prefix) = 0) then
    begin
      Result := Copy(Line, Length(Prefix) + 1, Length(Line) - Length(Prefix));
      Exit;
    end;
  end;
end;

{ Запустить инструмент и вернуть его код; False — процесс не стартовал.
  node.exe берётся из каталога программы (node\node.exe), рабочий каталог —
  server: оттуда резолвятся внешние библиотеки (archiver/yauzl) и
  package.json версии. }
function RunDatabaseTool(const Arguments, WorkingDir: String; var Code: Integer): Boolean;
var
  NodeExe: String;
begin
  Code := -1;
  if GDatabaseToolPath = '' then Exit;
  NodeExe := ServerNodeExe(GServerDir);
  if not FileExists(NodeExe) then
  begin
    LogLine('ERROR', 'Инструмент БД: нет node.exe поставки: ' + NodeExe);
    Exit;
  end;
  Result := Exec(NodeExe, '"' + GDatabaseToolPath + '" ' + Arguments, WorkingDir,
    SW_HIDE, ewWaitUntilTerminated, Code);
  if not Result then
    LogLine('ERROR', 'Инструмент БД: не удалось запустить ' + NodeExe);
end;

{ Отчёт инструмента: причины и предупреждения — в журнал, пути/причины — в
  GLastBackupDir/GBackupReason. Code — код возврата инструмента. }
procedure ApplyDatabaseToolReport(const ReportPath: String; const Code: Integer;
  const Operation: String);
var
  Reason, WarningsText, Archive: String;
begin
  Reason := DatabaseReportValue(ReportPath, 'error');
  WarningsText := DatabaseReportValue(ReportPath, 'warnings');
  Archive := DatabaseReportValue(ReportPath, 'archive');
  if WarningsText <> '' then
    LogLine('WARN', Operation + ': предупреждения: ' + WarningsText);
  if Code = 0 then
  begin
    if Archive <> '' then
      GLastBackupDir := Archive
    else
      GLastBackupDir := '';
    if Archive = '' then
      LogLine('WARN', Operation + ': архив не создан — баз данных нет');
  end
  else
  begin
    if Reason = '' then
      Reason := 'код ' + IntToStr(Code);
    GBackupReason := Reason;
    LogLine('ERROR', Operation + ': ' + Reason + ' (код ' + IntToStr(Code) + ')');
  end;
end;

{ Отчёт во временном каталоге Inno; старый файл удаляется, чтобы причина от
  прошлого шага не смешалась с текущей. }
function DatabaseReportPath: String;
begin
  Result := ExpandConstant('{tmp}') + '\' + DB_TOOL_REPORT_NAME;
  DeleteFile(Result);
end;

{ Есть ли что архивировать: _system.db или networks\<uuid>\data.db.
  Проверка до вызова инструмента: на первой установке и в тестовых прогонах
  без баз node.exe ещё не скопирован — CLI не должен запускаться зря. }
function HasDatabaseFiles: Boolean;
var
  NetworksDir: String;
  FindRec: TFindRec;
begin
  Result := False;
  if FileExists(GDataDir + '\_system.db') then
  begin
    Result := True;
    Exit;
  end;
  NetworksDir := GDataDir + '\networks';
  if not DirExists(NetworksDir) then Exit;
  if not FindFirst(NetworksDir + '\*', FindRec) then Exit;
  try
    repeat
      if IsRealSubdir(FindRec) and
         FileExists(NetworksDir + '\' + FindRec.Name + '\data.db') then
      begin
        Result := True;
        Exit;
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

{ Точка входа бэкапа. Needed — решение вызывающего (смена версии или ремонт).
  Возвращает True, когда архив создан и проверен либо бэкап не требуется. }
function CreateDatabaseBackup(const Needed: Boolean): Boolean;
var
  Reason, BackupsDir, ReportPath, Arguments: String;
  Code: Integer;
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
  if not HasDatabaseFiles then
  begin
    LogLine('WARN', 'Бэкап БД: в ' + GDataDir +
      ' нет баз данных — архив не создаётся, обновление продолжается');
    Result := True;
    Exit;
  end;
  SetInstallStage('Резервная копия баз данных…');
  if not EnsureDatabaseTool(Reason) then
  begin
    GBackupReason := Reason;
    Exit;
  end;
  BackupsDir := GDataDir + '\backups';
  if not ForceDirectories(BackupsDir) then
  begin
    GBackupReason := 'каталог архивов не создан: ' + BackupsDir +
      ' (нет прав или свободного места)';
    LogLine('ERROR', 'Бэкап БД: не удалось создать каталог архивов ' + BackupsDir +
      ' (нет прав или места) — обновление отменяется');
    Exit;
  end;
  ReportPath := DatabaseReportPath;
  { --to — родительский каталог: имя ZIP формирует инструмент (спека 2975c553). }
  Arguments := 'backup --to "' + BackupsDir + '" --report-out "' + ReportPath +
    '" --data-dir "' + GDataDir + '"';
  if not RunDatabaseTool(Arguments, GServerDir + '\server', Code) then
  begin
    GBackupReason := CustomMessage('BackupToolNotStarted');
    Exit;
  end;
  ApplyDatabaseToolReport(ReportPath, Code, 'Бэкап БД');
  if Code <> 0 then Exit;
  if GLastBackupDir = '' then
  begin
    LogLine('WARN', 'Бэкап БД: в ' + GDataDir +
      ' нет баз данных — архив не создаётся, обновление продолжается');
    Result := True;
    Exit;
  end;
  LogLine('INFO', 'Бэкап БД: архив создан: ' + GLastBackupDir +
    ' (баз: ' + DatabaseReportValue(ReportPath, 'databases') +
    ', байт: ' + DatabaseReportValue(ReportPath, 'bytes') + ')');
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

{ Восстановление БД из ZIP-архива ce3ab836 через etn-db-tool restore.
  Только из архива ЭТОГО запуска (GLastBackupDir). LatestBackupDir — самый
  свежий архив прошлых обновлений: он не отражает состояние базы на момент
  остановки службы, и подставлять его в автоматический откат нельзя (потеря
  данных, блокер приёмки bb063ac3). --force допустим: служба уже остановлена
  вызывающим (RollbackAfterFailure); инструмент всё равно проверяет ZIP и
  integrity_check каждой базы ДО перезаписи, а WAL/SHM удаляет с проверкой. }
function RestoreDatabaseFromArchive: Boolean;
var
  Archive, ReportPath, Arguments, ReasonText: String;
  Code: Integer;
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
  if not EnsureDatabaseTool(ReasonText) then
  begin
    LogLine('ERROR', 'Откат БД: ' + ReasonText);
    Exit;
  end;
  ReportPath := DatabaseReportPath;
  Arguments := 'restore --from "' + Archive + '" --force --report-out "' +
    ReportPath + '" --data-dir "' + GDataDir + '"';
  if not RunDatabaseTool(Arguments, GServerDir + '\server', Code) then Exit;
  ApplyDatabaseToolReport(ReportPath, Code, 'Откат БД');
  if Code <> 0 then Exit;
  LogLine('INFO', 'Откат БД: база восстановлена из ' + Archive +
    ' (баз: ' + DatabaseReportValue(ReportPath, 'databases') + ')');
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
    перед возвратом файлов её нужно остановить снова. Если остановить не
    удалось, откат файлов и restore --force по живой БД недопустимы: оставляем
    снимок и архив точкой ручного восстановления (34f8e315). }
  if not StopServiceForUpdate(Reason, False) then
  begin
    LogLine('ERROR', 'Откат не выполнен: служба ' + SERVICE_NAME +
      ' не остановилась — ' + Reason + '; файлы новой версии и БД не ' +
      'восстановлены; снимок: ' + GLastRollbackDir + '; архив: ' +
      IfStr(GLastBackupDir = '', 'не создавался', GLastBackupDir) +
      '; журнал: ' + GLogPath);
    GFailureReason := GFailureReason + '. Откат не выполнен: служба ' +
      SERVICE_NAME + ' не остановилась (' + Reason + '), файлы новой версии и ' +
      'БД не восстановлены; снимок: ' + GLastRollbackDir + '; архив: ' +
      IfStr(GLastBackupDir = '', 'не создавался', GLastBackupDir) +
      '; журнал: ' + GLogPath + '.';
    Result := False;
    Exit;
  end;
  FilesOk := RestoreInstallFiles;
  DbOk := RestoreDatabaseFromArchive;
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
  begin
    LogLine('WARN', 'Откат: прежняя версия не отвечает (' + GHealthReason + ')');
    { Причина отказа не должна маскировать неработающую прежнюю версию: файлы
      могли вернуться, но сервер не поднялся — администратор обязан увидеть
      это в причине, а не только WARN в журнале (a1ea1d40). }
    GFailureReason := GFailureReason + '. Прежняя версия не отвечает на ' +
      'health-check: ' + GHealthReason + '; ' + FmtMessage(
      CustomMessage('ServiceStartManually'), [GLogPath]);
  end;
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

{ После возврата службы на прежнюю версию (неудачный бэкап/снимок): start не
  ждёт готовности сервера, поэтому ограниченный health-check прежней версии —
  единственное доказательство, что сервер снова работает. False — служба не
  отвечает; вызывающий дописывает в причину подсказку о ручном запуске. }
function PreviousVersionResponsive: Boolean;
begin
  Result := True;
  if not HealthCheckApplicable then Exit;
  Result := ProbeHealth(False);
  if not Result then
    LogLine('WARN', 'Служба после отмены обновления не отвечает: ' + GHealthReason);
end;

{ ---------------------------------------------------------------------------
  Фазы обновления до копирования файлов — задача bb063ac3.
  Порядок обязателен: личность службы → остановка службы → бэкап БД → снимок
  отката. Копирование файлов выполняет Inno уже после возврата из этого вызова
  (ssInstall). Возвращает код контракта: 0 — можно копировать, 20 —
  предусловие, 10 — сбой выполнения (файлы не тронуты).
  --------------------------------------------------------------------------- }
function PrepareServerUpdate(var Reason: String): Integer;
var
  NeedBackup: Boolean;
  ToolReason: String;
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
  NeedBackup := BackupNeeded;
  { Личность службы до любых изменений (34f8e315): чужой ImagePath, Start=4,
    DeleteFlag=1 или status=NonExistent при живом ключе — код 20, иначе install
    пропускается (1073), а start падает уже после замены файлов. }
  if not CheckServiceIdentity(Reason) then
  begin
    LogLine('ERROR', 'Обновление отменено: ' + Reason);
    Result := EXIT_PRECONDITION;
    Exit;
  end;
  { Инструмент бэкапа распаковывается ДО остановки службы: если его нет в
    поставке, сервер продолжает работать, а обновление не начинается. }
  if NeedBackup and (not EnsureDatabaseTool(ToolReason)) then
  begin
    Reason := 'инструмент резервного копирования баз данных недоступен: ' +
      ToolReason + ' — обновление отменено, служба не останавливалась';
    LogLine('ERROR', Reason);
    Result := EXIT_FAILED;
    Exit;
  end;
  SetInstallStage('Остановка службы ETN…');
  if not StopServiceForUpdate(Reason, False) then
  begin
    Result := EXIT_PRECONDITION;
    Exit;
  end;
  if NeedBackup then
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
        прежней версии (сценарий bc7cc846). start не ждёт готовности, поэтому
        подтверждаем ответ прежней версии health-check-ом. }
      if not StartServiceIfNeeded then
        LogLine('WARN', 'Не удалось вернуть службу после неудачного бэкапа')
      else if not PreviousVersionResponsive then
        Reason := Reason + '; ' + FmtMessage(
          CustomMessage('ServiceStartManually'), [GLogPath]);
      Result := EXIT_FAILED;
      Exit;
    end;
  end;
  if not CreateRollbackSnapshot then
  begin
    Reason := 'снимок отката не создан: ' + RollbackRoot +
      ' — обновление отменено, файлы не заменялись (причина в журнале)';
    if not StartServiceIfNeeded then
      LogLine('WARN', 'Не удалось вернуть службу после неудачного снимка')
    else if not PreviousVersionResponsive then
      Reason := Reason + '; ' + FmtMessage(
        CustomMessage('ServiceStartManually'), [GLogPath]);
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
  { Причина отказа пишется в отдельный файл: экран ошибки показывает её в
    сообщении вместо «смотрите журнал», а тесты читают по ненулевому коду
    (9b310991). Кодировка UTF-8: причину читают и установщик, и тесты —
    кириллица не должна зависеть от системной кодовой страницы. }
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
  занятостью не считаются: службу останавливает административный режим
  установки (bb063ac3). WinSW 2.x запускает сервер дочерним процессом, поэтому
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
  Пустой или неуспешный ответ перечисления НЕ означает «порт свободен»:
  на Windows 11 build 28000 (KB5133111/KB5127653) TCP-таблица не показывает
  только что созданные слушатели — Get-NetTCPConnection падает с ObjectNotFound,
  netstat по порту пуст, а TcpClient.Connect успешен (ошибка 1dddac77). Поэтому
  запасная ветка работает fail-closed: зарезервированные диапазоны
  (Hyper-V/WinNAT) читаются из netsh, затем выполняется эксклюзивный bind на
  0.0.0.0 (SO_EXCLUSIVEADDRUSE) БЕЗ Listen. Раньше здесь был TcpListener на
  loopback: у него ExclusiveAddressUse=false, bind проходил при живом
  слушателе на 0.0.0.0/чужом конкретном адресе (SO_REUSEADDR), и порт
  считался свободным — fail-open. Эксклюзивный bind на 0.0.0.0 ловит все
  такие случаи и не срабатывает на свободном порту. Listen() не вызывается
  сознательно: он создаёт слушающий endpoint, и Windows Security показывает
  диалог «Allow для Windows PowerShell» прямо во время установки (ошибка
  860def0d, п.4); bind без Listen диалога не вызывает (проверено на build
  28000: положительный контроль с listen() даёт диалог, bind — нет).
  Ошибка bind AddressAlreadyInUse/AccessDenied — порт занят (1); любая другая
  ошибка (проверить не удалось) — статус 2.
  На сборках Windows с неработающей TCP-таблицей (build 28000,
  KB5133111/KB5127653) владельца слушателя не узнать: own-PID сопоставление
  невозможно, а эксклюзивный bind падает на порту живой своей службы — тогда
  установка и автообновление поверх работающей установки всегда получали бы
  20. Поэтому доступность таблицы проверяется пробой: временный TcpListener на
  loopback с портом 0 обязан появиться в Get-NetTCPConnection со своим PID
  (listen только на loopback диалога брандмауэра не даёт). Если таблица не
  работает, но служба ETN зарегистрирована и запущена (svcFound=1), порт
  считается своим (0): службу остановит ssInstall, а её работоспособность
  проверит health-check. Без запущенной службы — прежний fail-closed (netsh +
  эксклюзивный bind). Если таблица работает, логика не меняется: строки есть —
  foreign/own, строк нет — netsh + эксклюзивный bind.
  Возвращает 0 — свободен (или держит служба ETN), 1 — занят, 2 — проверить
  не удалось. Тестовые хуки (только TestMode): TESTSERVICENAME подменяет имя
  службы, и скрипт возвращает 0/2 по факту её нахождения (поведенческая проба
  CIM-запроса); TESTOWNSERVICEPID задаёт PID «своей» службы вместо CIM-запроса
  (поведенческая проба сравнения владельцев и цепочки потомков);
  TESTPORTBINDFAIL=1 имитирует неизвестный отказ пробного bind (статус 2);
  TESTLISTENERTABLEOFF=1 — недоступную TCP-таблицу, TESTNOSERVICE=1 —
  отсутствие службы (проверка новых веток без аномальной ОС). }
function ServerPortStatus(const Port: String): Integer;
var
  Script, Args, SvcName, SvcNameLiteral, SvcProbe, OwnSeed, BindFail,
  TableOff, NoSvc: String;
  Code: Integer;
begin
  Result := 2;
  SvcName := SERVICE_NAME;
  SvcProbe := '0';
  OwnSeed := '0';
  BindFail := '0';
  TableOff := '0';
  NoSvc := '0';
#ifdef TestMode
  if GTestServiceName <> '' then
  begin
    SvcName := GTestServiceName;
    SvcProbe := '1';
  end;
  { Валидация PID: строка из параметра идёт в скрипт только если это число. }
  if StrToIntDef(GTestOwnServicePid, 0) > 0 then
    OwnSeed := IntToStr(StrToIntDef(GTestOwnServicePid, 0));
  if GTestPortBindFail = '1' then
    BindFail := '1';
  if GTestListenerTableOff = '1' then
    TableOff := '1';
  if GTestNoService = '1' then
    NoSvc := '1';
#endif
  { Имя службы — в одинарные кавычки PowerShell; кавычки внутри имени
    удваиваются (правило PS-литерала). Двойных кавычек в скрипте нет. }
  SvcNameLiteral := SvcName;
  StringChangeEx(SvcNameLiteral, '''', '''''', True);
  Script :=
    '$ErrorActionPreference=''SilentlyContinue'';$port=' + Port + ';' +
    '$svcName=''' + SvcNameLiteral + ''';' +
    '$svcProbe=' + SvcProbe + ';$ownSeed=' + OwnSeed + ';$bindFail=' + BindFail +
    ';$tableOff=' + TableOff + ';$noSvc=' + NoSvc + ';' +
    '$svcFound=0;$own=@();' +
    'if($ownSeed -gt 0){$own+=$ownSeed;$svcFound=1}' +
    'elseif($noSvc -eq 0){try{$svc=Get-CimInstance Win32_Service|' +
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
    { Доступность TCP-таблицы: временный слушатель на loopback с портом 0
      обязан появиться в перечислении со своим PID. На аномальной сборке
      Windows (1dddac77) таблица его не показывает — тогда перечисление
      непригодно, и порт проверяется запасной веткой. Проба не даёт диалога
      брандмауэра: listen только на loopback. }
    '$tableOk=0;$v4=$null;' +
    'if($tableOff -eq 0){' +
    '$pl=$null;try{$pl=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);' +
    '$pl.Start();$pp=([Net.IPEndPoint]$pl.LocalEndpoint).Port;$tableOk=0;' +
    'for($i=0;$i -lt 10;$i++){' +
    '$c=@(Get-NetTCPConnection -LocalPort $pp -State Listen -ErrorAction Stop|' +
    'Where-Object{[int]$_.OwningProcess -eq $PID});' +
    'if($c.Count -gt 0){$tableOk=1;break};Start-Sleep -Milliseconds 100}}' +
    'catch{$tableOk=0}' +
    'finally{if($pl){$pl.Stop()}};' +
    'if($tableOk -eq 1){try{' +
    '$v4=@(Get-NetTCPConnection -LocalPort $port -State Listen ' +
    '-ErrorAction Stop|Where-Object{$_.LocalAddress -notmatch '':''})' +
    '}catch{$v4=$null}}};' +
    'if($null -ne $v4 -and $v4.Count -gt 0){' +
    '$foreign=@($v4|Where-Object{$own -notcontains [int]$_.OwningProcess});' +
    'if($foreign.Count -eq 0){exit 0};exit 1};' +
    { Таблица недоступна, но служба ETN зарегистрирована и запущена: порт
      считаем своим — службу остановит ssInstall, работоспособность проверит
      health-check. Иначе повторная установка/автообновление на аномальной ОС
      всегда падали бы с «порт занят» на собственной службе. }
    'if(($tableOk -eq 0) -and ($svcFound -eq 1)){exit 0};' +
    { Пустое перечисление — не признак свободного порта: на аномальной
      сборке Windows TCP-таблица не показывает новые слушатели (1dddac77).
      Порт в зарезервированном диапазоне (Hyper-V/WinNAT) слушателя не имеет,
      но bind/Listen для него закрыт; диапазоны читаем через netsh (bind без
      Listen исключения не проверяет). Ошибка 860def0d, п.4. }
    'try{$ex=@(netsh int ipv4 show excludedportrange protocol=tcp)}catch{$ex=@()};' +
    'foreach($ln in $ex){$t=@(($ln.Trim()) -split ''\s+'');' +
    'if($t.Count -ge 2){$a=0;$b=0;' +
    'if([int]::TryParse($t[0],[ref]$a)){if([int]::TryParse($t[1],[ref]$b)){' +
    'if(($port -ge $a) -and ($port -le $b)){exit 1}}}}}' +
    { Fail-closed проба: эксклюзивный bind на 0.0.0.0 без Listen. }
    'if($bindFail -eq 1){exit 2};' +
    '$sock=$null;' +
    'try{$sock=New-Object Net.Sockets.Socket([Net.Sockets.AddressFamily]::InterNetwork,' +
    '[Net.Sockets.SocketType]::Stream,[Net.Sockets.ProtocolType]::Tcp);' +
    '$sock.SetSocketOption([Net.Sockets.SocketOptionLevel]::Socket,' +
    '[Net.Sockets.SocketOptionName]::ExclusiveAddressUse,$true);' +
    '$ep=New-Object Net.IPEndPoint([Net.IPAddress]::Any,$port);' +
    '$sock.Bind($ep);$sock.Close();exit 0}' +
    'catch{' +
    'if($sock){$sock.Close()};' +
    '$se=$_.Exception;while($se.InnerException){$se=$se.InnerException};' +
    '$ec=-1;if($se -is [Net.Sockets.SocketException]){$ec=[int]$se.SocketErrorCode};' +
    { 10048 = AddressAlreadyInUse, 10013 = AccessDenied. }
    'if(($ec -eq 10048) -or ($ec -eq 10013)){exit 1};exit 2}';
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
  { Административный режим установки даёт элевированный процесс или /ALLUSERS:
    silent-прогон службы идёт с /ALLUSERS и уже элевирован, поэтому Inno не
    перезапускает мастер (ошибка aa5af30c). }
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
    административный режим установки (bb063ac3). }
  Reason := CheckServerEnvironment(False);
  if Reason <> '' then
    FailPrecondition(Reason);

  GSkipCopy := (SemverCompare(GInstalledVersion, GProductVersion) = 0);
  if GSkipCopy then
    LogLine('INFO', 'Установлена та же версия ' + GProductVersion + ': файлы не заменяются');
end;

{ ---------------------------------------------------------------------------
  Предусловия привилегированной фазы — внутреннего запуска с /PRIVILEGEDPHASE.
  GUI-установка её больше не запускает (элевация штатная, 2dd215f7); фазу
  используют тесты установщика (installer/tests/*.ps1), чтобы выполнить
  привилегированную работу без настоящей элевации.
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
  { Административный режим обеспечивает элевированный процесс (или /ALLUSERS);
    скриптового перезапуска нет (ошибка aa5af30c). }
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

{ Параметры подключения к локальному серверу для автозапуска клиента
  (ошибка 0f8dd0f3, п.6 860def0d). Передаются, только когда сервер установлен
  или ставится этим же запуском: без сервера клиенту некуда подключаться и
  предзаполнение было бы ложью. Адрес — loopback с портом установки, имя —
  то, что пользователь увидит в списке подключений; API-ключ вводит он сам. }
function ClientConnectParams: String;
begin
  if not (GServerSelected or (GServerState <> 'not-installed')) then
  begin
    Result := '';
    Exit;
  end;
  Result := '--connect-url="http://localhost:' + GServerPort + '"' +
    ' --connect-name="Локальный сервер"';
end;

(* Обёртка для скриптовой константы в [Icons]: такая константа обязана иметь
  параметр Param: String (справка Inno «Scripted Constants»). *)
function ClientConnectParamsConst(Param: String): String;
begin
  Result := ClientConnectParams;
end;

procedure RunClientClick(Sender: TObject);
var
  Exe, Params: String;
  Code: Integer;
begin
  { Из элевированного процесса клиент не запускаем: под Administrator
    Protection это отдельный профиль SMAA, и клиент открылся бы не у того
    пользователя. Кнопка в этом режиме скрыта, запуск — из ярлыка (в нём уже
    есть параметры подключения). }
  if GAdminMachineScope then
  begin
    LogLine('WARN', 'Запуск клиента из элевированного процесса отключён: ' +
      'профиль Administrator Protection отделён, запускайте клиент из ярлыка');
    Exit;
  end;
  Exe := ClientExePath;
  if Exe = '' then Exit;
  Params := ClientConnectParams;
  { Клиент — обычное приложение пользователя, а не служба: запускаем от
    исходного пользователя, даже если установщик повышал права. Иначе клиент
    открылся бы в профиле другого администратора (режим app). }
  if ShellExecAsOriginalUser('open', Exe, Params, ExtractFileDir(Exe),
    SW_SHOWNORMAL, ewNoWait, Code) then
    LogLine('INFO', 'Клиент запущен от исходного пользователя: ' + Exe +
      IfStr(Params = '', '', '; параметры подключения: ' + Params))
  else
  begin
    LogLine('WARN', 'ShellExecAsOriginalUser не сработал, запуск через оболочку: ' + Exe);
    { Оболочка параметры не передаст — клиент открылся бы пустым. Запасной
      вариант — ShellExec с теми же параметрами: лучше предзаполнение в чужом
      профиле, чем пустая форма у пользователя. }
    if (Params <> '') and
       ShellExec('open', Exe, Params, ExtractFileDir(Exe), SW_SHOWNORMAL,
         ewNoWait, Code) then
      LogLine('INFO', 'Клиент запущен с параметрами подключения (ShellExec): ' + Exe)
    else
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
    LogLine('ERROR', 'Повторный запуск установщика не удался: ' + ShellErrorText(Code));
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
    if GAdminMachineScope then
      S := S + 'Клиент установлен для всех пользователей. Запустите его из ' +
        'меню «Пуск» или с рабочего стола: подключение к локальному серверу ' +
        'уже предзаполнено в ярлыке.' + #13#10;
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

{ Единая точка чтения выбора: обработчики OnClick чекбоксов (компоненты,
  лицензия) и тестовый хук /TESTSELECT. Радиокнопок области в мастере нет:
  в продуктовой сборке область задают фактические права процесса
  (GAdminMachineScope / GUserOnlyMode), при обновлении — install.json. Третий
  аргумент — только для /TESTSELECT и сохранения текущей области. }
procedure ApplySelection(const ServerChecked, ClientChecked,
  MachineScopeChecked: Boolean);
begin
  { В режиме «только для меня» сервера нет: права на него не запрашивались
    (ошибка aa5af30c: нет элевации — нет сервера). Флаг остаётся ложным даже
    если чекбокс программно отмечен; попытка запоминается для причины на
    экране. }
  GServerRequested := ServerChecked;
  GServerSelected := ServerChecked and (not GUserOnlyMode);
  GClientSelected := ClientChecked;
  { В административном режиме область одна — «для всех» (GAdminMachineScope).
    В режиме «только для меня» — наоборот: только профиль пользователя. }
  if GUserOnlyMode then
    GClientScopeUser := True
  else
    GClientScopeUser := (not MachineScopeChecked) and (not GAdminMachineScope);
end;

{ Причина недоступности сервера в обычном (неэлевированном) запуске — одна
  строка для экрана компонентов и журнала (ошибка aa5af30c). Права из мастера
  не запрашиваются: чтобы получить сервер, пользователь закрывает установщик и
  запускает его от имени администратора — мастер при этом остаётся одним
  процессом, без respawn. }
function ServerUnavailableReason: String;
begin
  Result := 'Для установки сервера закройте установщик и запустите его от имени администратора (правый клик → Запуск от имени администратора).';
end;

{ Причина неактивности «Далее» — одна функция для экрана и журнала (ошибка
  5b9743da): по спеке (элемент интерфейса «Экран установщика — выбор
  компонентов и лицензия») кнопка неактивна без выбранного компонента или без
  принятой лицензии, и причина обязана быть на экране. Раньше причина жила
  только в обработчике экрана, уезжала за нижний край и в журнал не попадала —
  по журналу нельзя было понять, почему «Далее» не отвечает. }
function ComponentsReasonText: String;
begin
  if GBlockedDowngrade then
    Result := 'Установлена более новая версия ' + ServerVersionText +
      ' — понижение версии не поддерживается. Доступна только отмена.'
  else if GComponentsNotice <> '' then
    Result := GComponentsNotice
  else if GUserOnlyMode and GServerRequested and (not GServerSelected) then
    Result := ServerUnavailableReason
  else if (not GServerSelected) and (not GClientSelected) then
  begin
    if GUserOnlyMode and (GInstalledClientScope = 'machine') then
      Result := 'Клиент установлен для всех пользователей: нужны права ' +
        'администратора.'
    else
      Result := 'Выберите хотя бы один компонент.';
  end
  else if LicensePromptNeeded and (not GLicenseAccepted) then
    Result := 'Примите условия лицензии MIT, чтобы продолжить.'
  else
    Result := '';
end;

{ ---------------------------------------------------------------------------
  Экран компонентов: список TNewCheckListBox и фиксированный нижний блок
  (задача c4b68d78, 0.15.3)
  --------------------------------------------------------------------------- }

{ Статус сервера: состояние машины и признак инициализации. }
function ServerStatusRowText: String;
begin
  Result := ServerStateText + IfStr(InitStateText = '', '', ' ' + InitStateText);
end;

{ Описание сервера. В обычном (неэлевированном) запуске вместо описания —
  причина недоступности сервера (ошибка aa5af30c): пользователь должен видеть,
  что именно сделать, чтобы получить сервер. }
function ServerDescriptionRowText: String;
begin
  if GUserOnlyMode then
    Result := ServerUnavailableReason
  else
    Result := 'Сервер хранит графовые базы знаний на этом компьютере и отдаёт ' +
      'к ним доступ по сети. Node.js входит в установку.';
end;

{ Описание клиента: что это, что понадобится при первом запуске и каталог
  установки выбранной области (ADR 144bcdb0). Текст состояния клиента зависит
  от выбора: обещание удалить старый NSIS-клиент — только когда клиент выбран. }
function ClientDescriptionRowText: String;
begin
  if GClientSelected and (not GServerSelected) then
    Result := 'Сервер не выбран: при первом запуске понадобится адрес ' +
      'существующего сервера и ключ. Профили, серверы и ключи у каждого ' +
      'пользователя свои.'
  else
    Result := 'Клиент — окно для работы с базами; нужны адрес сервера и ключ.';
  if GClientSelected then
    Result := Result + ' Каталог установки: ' + ClientInstallPath + '.';
end;

{ Строка области клиента. Выбора в мастере нет: область задают фактические
  права процесса. При установленном клиенте — текст выбранной области
  (ClientScopeText, ea8e223a/4a66b7a5), в административном режиме — постоянное
  объяснение; в режиме «только для меня» — пояснение режима (п.2 ошибки
  860def0d). Радиокнопки недостижимы в продуктовой сборке и удалены. }
function ClientScopeRowText: String;
begin
  if ClientScopeFixed or GAdminMachineScope then
    Result := ClientScopeText
  else
    Result := 'Режим «только для меня»: клиент ставится в ваш профиль, права ' +
      'администратора не нужны. Чтобы установить сервер или клиент «для всех ' +
      'пользователей», закройте установщик и запустите его от имени ' +
      'администратора (правый клик → Запуск от имени администратора).';
end;

{ Нужна ли необязательная строка области клиента: текст области показывается
  при установленном клиенте и в административном режиме, пояснение режима —
  когда клиент выбран. }
function ClientScopeRowNeeded: Boolean;
begin
  Result := ClientScopeFixed or GAdminMachineScope or GClientSelected;
end;

{ Обновить строки списка на месте. TNewCheckListBox.SetCaption сохраняет
  Checked/ItemEnabled (внутри Items[Index] := ...), но сбрасывает ItemIndex и
  прокрутку — сохраняем и восстанавливаем их через LB_GETTOPINDEX ($018E) и
  LB_SETTOPINDEX ($0197). Список не пересоздаётся: спека требует, чтобы он
  сохранял прокрутку и выделение при смене выбора.

  Строки статусов и описаний — group уровня 1 и серые: ItemEnabled := False.
  Это единственный способ сделать их серыми в TNewCheckListBox; средство
  доступности считает такую строку недоступной — принятый компромисс.

  Items.Add/AddSubItem и запись ItemLevel/State запрещены: они рассинхронизируют
  FStateList (сторож в silent-codes.ps1). Items.Delete допустим только для
  последней строки области клиента — её состояние удаляется вместе с ней. }
procedure SyncComponentsList;
var
  SavedIndex, SavedTop: Integer;
begin
  if GComponentsList = nil then Exit;
  SavedIndex := GComponentsList.ItemIndex;
  SavedTop := SendMessage(GComponentsList.Handle, $018E, 0, 0);

  GComponentsList.ItemCaption[COMP_ITEM_SERVER] := ServerCheckCaption;
  GComponentsList.ItemCaption[COMP_ITEM_SERVER_STATUS] := ServerStatusRowText;
  GComponentsList.ItemCaption[COMP_ITEM_SERVER_DESC] := ServerDescriptionRowText;
  GComponentsList.ItemCaption[COMP_ITEM_CLIENT] := ClientCheckCaption;
  GComponentsList.ItemCaption[COMP_ITEM_CLIENT_STATUS] := ClientStateText;
  GComponentsList.ItemCaption[COMP_ITEM_CLIENT_DESC] := ClientDescriptionRowText;
  { В режиме «только для меня» сервер недоступен: строка выключена, причина —
    в описании сервера и в причине неактивности «Далее». }
  GComponentsList.ItemEnabled[COMP_ITEM_SERVER] := not GUserOnlyMode;

  if ClientScopeRowNeeded then
  begin
    if GComponentsScopeRow then
      GComponentsList.ItemCaption[COMP_ITEM_CLIENT_SCOPE] := ClientScopeRowText
    else
    begin
      GComponentsList.AddGroup(ClientScopeRowText, '', 1, nil);
      GComponentsScopeRow := True;
    end;
    GComponentsList.ItemEnabled[COMP_ITEM_CLIENT_SCOPE] := False;
  end
  else if GComponentsScopeRow then
  begin
    GComponentsList.Items.Delete(COMP_ITEM_CLIENT_SCOPE);
    GComponentsScopeRow := False;
  end;

  { ItemCaption/Delete/AddGroup сбрасывают выделение и прокрутку — возвращаем
    их; список при этом не пересоздаётся. }
  if GComponentsList.ItemIndex <> SavedIndex then
    GComponentsList.ItemIndex := SavedIndex;
  SendMessage(GComponentsList.Handle, $0197, SavedTop, 0);
  GComponentsList.Invalidate;
end;

{ Текст причины для экрана: с префиксом (спека, элемент интерфейса «Экран
  установщика — выбор компонентов и лицензия»). В журнал по-прежнему идёт
  ComponentsReasonText без префикса — по нему причина ищется в логе. }
function ComponentsReasonLabelText: String;
begin
  Result := ComponentsReasonText;
  if Result <> '' then
    Result := 'Далее недоступна: ' + Result;
end;

{ Нижний блок закреплён от низа поверхности страницы: причина — в самом низу,
  выше лицензия (когда нужна), выше каталог данных (когда показывается), выше
  ссылка на другие варианты установки. Все элементы блока видимы всегда
  (лицензия — по правилу LicensePromptNeeded): раньше нехватка места скрывала
  подсказки, и причина неактивности «Далее» уезжала за нижний край (ошибка
  5b9743da). Список получает остаток высоты и прокручивается сам — высоту
  строк он считает по переносу caption, ручная раскладка не нужна. }
procedure LayoutComponentsBottom;
var
  Y: Integer;
begin
  if (GComponentsPage = nil) or (GComponentsList = nil) then Exit;
  Y := GComponentsPage.SurfaceHeight;
  if GReasonLabel <> nil then
  begin
    GReasonLabel.Top := Y - GReasonLabel.Height;
    Y := GReasonLabel.Top - ScaleY(6);
  end;
  if (GLicenseCheck <> nil) and GLicenseCheck.Visible then
  begin
    GLicenseCheck.Top := Y - GLicenseCheck.Height;
    if GLicenseLink <> nil then
      GLicenseLink.Top := GLicenseCheck.Top + ScaleY(2);
    Y := GLicenseCheck.Top - ScaleY(4);
  end;
  if (GDataNoteLabel <> nil) and GDataNoteLabel.Visible then
  begin
    GDataNoteLabel.Top := Y - GDataNoteLabel.Height;
    Y := GDataNoteLabel.Top - ScaleY(4);
  end;
  if GServerAltLink <> nil then
  begin
    GServerAltLink.Top := Y - GServerAltLink.Height;
    Y := GServerAltLink.Top - ScaleY(8);
  end;
  GComponentsList.Top := 0;
  GComponentsList.Left := 0;
  GComponentsList.Width := GComponentsPage.SurfaceWidth;
  if Y < 0 then Y := 0;
  GComponentsList.Height := Y;
end;


procedure UpdateComponentsState(Sender: TObject);
begin
  if GSilent or (not GComponentsReady) then Exit;
  if GComponentsList <> nil then
    { Радиокнопок области нет: третий аргумент сохраняет текущую область
      (install.json при обновлении) и принудительно включает машинную только
      в административном режиме. }
    ApplySelection(GComponentsList.Checked[COMP_ITEM_SERVER],
      GComponentsList.Checked[COMP_ITEM_CLIENT],
      (not GClientScopeUser) or GAdminMachineScope);
  if GLicenseCheck <> nil then
    GLicenseAccepted := GLicenseCheck.Checked;
  { Ссылка на другие варианты установки видна всегда (спека). }
  if GServerAltLink <> nil then GServerAltLink.Visible := True;
  { Каталог данных нужен только тому, кто ставит сервер или уже его имеет:
    в режиме «только клиент» строки нет (спека, экран 1). }
  if GDataNoteLabel <> nil then
    GDataNoteLabel.Visible := GServerSelected or (GServerState <> 'not-installed');
  { Строки списка — после выбора: текст статуса и описания зависит от него. }
  SyncComponentsList;
  if GReasonLabel <> nil then
  begin
    GReasonLabel.Caption := ComponentsReasonLabelText;
    FitLabel(GReasonLabel);
  end;
  { Нижний блок — после подписей: высота причины зависит от переноса текста,
    список получает остаток высоты поверхности. }
  LayoutComponentsBottom;
  if WizardForm <> nil then
  begin
    WizardForm.NextButton.Enabled :=
      (not GBlockedDowngrade) and (GServerSelected or GClientSelected) and
      ((not LicensePromptNeeded) or GLicenseAccepted);
    { Состояние кнопки и причина — в журнал при каждой смене (ошибка 5b9743da):
      раньше нажатие неактивной «Далее» не оставляло в журнале ни строки, и
      причина зависания не восстанавливалась по логу. }
    LogLine('INFO', 'Экран компонентов: «Далее» ' +
      Pick(WizardForm.NextButton.Enabled, 'активна', 'неактивна') +
      IfStr(ComponentsReasonText = '', '', ' — причина: ' + ComponentsReasonText));
  end;
end;

{ Изменение выбора пользователем: уведомление об ошибке закрытия клиента или
  удаления старого клиента больше не актуально. }
procedure ComponentsChanged(Sender: TObject);
begin
  GComponentsNotice := '';
  UpdateComponentsState(Sender);
end;

procedure CreateComponentsPage;
begin
  { До заполнения списка экран не готов: обработчик OnClickCheck не должен
    читать ещё не созданные строки. }
  GComponentsReady := False;
  { Первый экран — приветствие и выбор компонентов (стандартные страницы
    welcome/license отключены в [Setup]). Раскладку задаёт LayoutComponentsBottom:
    список занимает остаток высоты и прокручивается сам, нижний блок закреплён
    от низа поверхности (задача c4b68d78). }
  GComponentsPage := CreateCustomPage(wpWelcome, 'ETN — установка',
    'Добро пожаловать в ETN: сервер хранит графовые базы знаний на этом ' +
    'компьютере, клиент — окно для работы с ними.');

  { Список компонентов: два checkbox уровня 0 и group-строки статуса/описания
    уровня 1. TNewCheckListBox переносит caption по словам, поэтому длинные
    статусы и описания видны целиком; subitem не используется — он остаётся
    одной строкой. Width задаётся ДО Add*: иначе Inno меряет строки по нулевой
    ширине (высота переноса получается неверной). }
  GComponentsList := TNewCheckListBox.Create(GComponentsPage);
  GComponentsList.Parent := GComponentsPage.Surface;
  GComponentsList.Left := 0;
  GComponentsList.Top := 0;
  GComponentsList.Width := GComponentsPage.SurfaceWidth;
  GComponentsList.BorderStyle := bsNone;
  GComponentsList.ShowLines := False;
  GComponentsList.MinItemHeight := ScaleY(22);
  GComponentsList.Offset := ScaleX(4);
  GComponentsList.OnClickCheck := @ComponentsChanged;
  { Начальный выбор вычислен в ApplyDefaultSelection (чистая машина — оба
    компонента, частичная — только установленные); он передаётся в AddCheckBox.
    Программная установка Checked событие OnClickCheck не поднимает, поэтому
    обработчик не снимает только что выставленный выбор. }
  GComponentsList.AddCheckBox(ServerCheckCaption, '', 0, GServerSelected,
    not GUserOnlyMode, False, False, nil);
  GComponentsList.AddGroup(ServerStatusRowText, '', 1, nil);
  GComponentsList.AddGroup(ServerDescriptionRowText, '', 1, nil);
  GComponentsList.AddCheckBox(ClientCheckCaption, '', 0, GClientSelected,
    True, False, False, nil);
  GComponentsList.AddGroup(ClientStateText, '', 1, nil);
  GComponentsList.AddGroup(ClientDescriptionRowText, '', 1, nil);
  { Необязательная последняя строка области клиента: добавляется и удаляется
    только она, индексы 0–5 не сдвигаются. }
  GComponentsScopeRow := ClientScopeRowNeeded;
  if GComponentsScopeRow then
    GComponentsList.AddGroup(ClientScopeRowText, '', 1, nil);
  { Статусы и описания — серые, как прежний clGray: ItemEnabled := False.
    Средство доступности считает такую строку недоступной — принятый
    компромисс, потому что TNewCheckListBox не умеет менять цвет строки. }
  GComponentsList.ItemEnabled[COMP_ITEM_SERVER_STATUS] := False;
  GComponentsList.ItemEnabled[COMP_ITEM_SERVER_DESC] := False;
  GComponentsList.ItemEnabled[COMP_ITEM_CLIENT_STATUS] := False;
  GComponentsList.ItemEnabled[COMP_ITEM_CLIENT_DESC] := False;
  if GComponentsScopeRow then
    GComponentsList.ItemEnabled[COMP_ITEM_CLIENT_SCOPE] := False;

  { Ссылка на другие варианты установки сервера — в нижнем блоке, всегда
    видима. Подпись в одну строку: у TNewLinkLabel нет переноса, длинный текст
    уходил бы за правый край (ошибка 860def0d, п.1). }
  GServerAltLink := TNewLinkLabel.Create(GComponentsPage);
  GServerAltLink.Parent := GComponentsPage.Surface;
  GServerAltLink.Left := 0;
  GServerAltLink.Width := GComponentsPage.SurfaceWidth;
  GServerAltLink.Caption := '<a href="server-options">Другие варианты установки ' +
    'сервера (удалённый сервер, Docker)</a>';
  GServerAltLink.OnLinkClick := @OpenServerOptions;

  { Каталог данных сервера — в нижнем блоке; видимость задаёт
    UpdateComponentsState (сервер выбран или уже установлен). }
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

  { Причина неактивности «Далее» — внизу экрана, всегда видима: раньше она
    уезжала за нижний край и «Далее» выглядела зависшей (ошибка 5b9743da). }
  GReasonLabel := TNewStaticText.Create(GComponentsPage);
  GReasonLabel.Parent := GComponentsPage.Surface;
  GReasonLabel.Left := 0;
  GReasonLabel.AutoSize := False;
  GReasonLabel.WordWrap := True;
  GReasonLabel.Width := GComponentsPage.SurfaceWidth;
  GReasonLabel.Caption := '';
  GReasonLabel.Font.Color := clRed;
  FitLabel(GReasonLabel);

  { Начальный выбор уже передан в AddCheckBox; здесь заполняются тексты строк
    и раскладывается нижний блок. }
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
  GWorkAllowed := True;
  GServerSelected := False;
  GServerRequested := False;
  GClientSelected := False;
  GClientScopeUser := True;
  GAdminMachineScope := False;
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
  GTestNotice := '';
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
  GTestPortBindFail := '';
  GTestListenerTableOff := '';
  GTestNoService := '';
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
  GTestServiceStatus := '';
  GTestServiceImage := '';
  GTestServiceStartType := '';
  GTestServiceDeleteFlag := '';
  GTestServiceStartedFlag := False;
  GTestServiceUninstalled := False;
  GTestServiceStopRetries := 0;
  GTestHealthUrl := '';
  GTestHealthWait := '';
  GTestHealthStep := '';
  GTestRollback := '';
  GTestBackup := '';
  GTestLegacy := '';
  GLastBackupDir := '';
  GDatabaseToolPath := '';
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
  GTestConnectParams := '';
  GTestAdminMode := '';
  GTestUserOnlyMode := '';
  GTestInnoAdminMode := '';
  GTestUninstallRoot := '';
  GParamsPath := '';
  GReasonFile := '';
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
  GTestNotice := ParamValue('TESTNOTICE');
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
  GTestPortBindFail := ParamValue('TESTPORTBINDFAIL');
  GTestListenerTableOff := ParamValue('TESTLISTENERTABLEOFF');
  GTestNoService := ParamValue('TESTNOSERVICE');
  GTestServiceCmd := ParamValue('TESTSERVICECMD');
  GTestServiceState := LowerCase(ParamValue('TESTSERVICESTATE'));
  GTestServiceStop := LowerCase(ParamValue('TESTSERVICESTOP'));
  GTestServiceStart := LowerCase(ParamValue('TESTSERVICESTART'));
  GTestServiceWait := ParamValue('TESTSERVICEWAIT');
  GTestServiceInstall := LowerCase(ParamValue('TESTSERVICEINSTALL'));
  GTestServiceUninstall := LowerCase(ParamValue('TESTSERVICEUNINSTALL'));
  GTestServiceRealFile := ParamValue('TESTSERVICEREALFILE');
  GTestServiceStatus := LowerCase(ParamValue('TESTSERVICESTATUS'));
  GTestServiceImage := ParamValue('TESTSERVICEIMAGE');
  GTestServiceStartType := ParamValue('TESTSERVICESTARTTYPE');
  GTestServiceDeleteFlag := ParamValue('TESTSERVICEDELETEFLAG');
  GTestServiceStartedFlag := False;
  GTestServiceUninstalled := False;
  { /TESTSERVICESTOP=1061 — первый stop возвращает 1061 (StartPending),
    повтор — успех: ровно один смоделированный переход. }
  if GTestServiceStop = '1061' then
    GTestServiceStopRetries := 1
  else
    GTestServiceStopRetries := 0;
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
  GTestConnectParams := ParamValue('TESTCONNECTPARAMS');
  GTestAdminMode := ParamValue('TESTADMINMODE');
  GTestUserOnlyMode := ParamValue('TESTUSERONLYMODE');
  GTestInnoAdminMode := ParamValue('TESTINNOADMINMODE');
  GTestUninstallRoot := ParamValue('TESTUNINSTROOT');
  { /TESTNOTICE=<текст>: уведомление после возврата на экран компонентов.
    Проверяет, что причина неактивности «Далее» показывает уведомление и
    помещается в нижний блок (задача c4b68d78). }
  if GTestNotice <> '' then
    GComponentsNotice := GTestNotice;
  { /TESTGUIMODE=1 имитирует GUI-запуск в silent-прогоне: silent-термин снимается
    ДО расчёта режима (GUserOnlyMode) и выбора компонентов — иначе контекст
    всегда привилегированный, а режим «только для меня» не смоделировать. }
  if GTestGui = '1' then
    GSilent := False;
  { /TESTUSERONLYMODE=1 моделирует выбор «только для меня»: в продуктовой
    сборке это неадминистративный GUI-режим (silent всегда административный),
    поэтому silent-термин снимается и здесь. }
  if GTestUserOnlyMode = '1' then
    GSilent := False;
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

  { Режим по фактическим правам процесса (ошибка aa5af30c): обычный запуск —
    клиент «только для меня», запуск от имени администратора — сервер и клиент
    «для всех». IsAdminInstallMode остаётся в формуле для /ALLUSERS: тихое
    автообновление службы включает административный режим Inno без respawn.
    В TestMode привилегий нет — режимы моделируются хуками /TESTADMINMODE и
    /TESTUSERONLYMODE, чтобы прогон не зависел от прав машины. }
#ifdef TestMode
  GAdminInstallMode := IsAdminInstallMode;
  if GTestAdminMode = '1' then
  begin
    GAdminInstallMode := True;
    LogOrDefer('WARN', 'TESTADMINMODE=1: административный режим смоделирован (тестовый режим)');
  end;
  if GTestUserOnlyMode = '1' then
  begin
    GAdminInstallMode := False;
    LogOrDefer('WARN', 'TESTUSERONLYMODE=1: режим «только для меня» смоделирован (тестовый режим)');
  end;
#else
  GAdminInstallMode := IsAdmin or IsAdminInstallMode;
#endif
  { Привилегированная фаза всегда административная: вызывающий запускает её с
    /ALLUSERS, и клиент «для меня» ставит не она. Silent-прогон с /ALLUSERS
    тоже административный; без /ALLUSERS он элевацию требует предусловием. }
  GAdminMachineScope := GAdminInstallMode and (not GPrivilegedPhase);
  GUserOnlyMode := (not GAdminInstallMode) and (not GPrivilegedPhase) and
    (not GSilent);

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
  { Ошибка 2dd215f7: слой совместимости оболочки (Windows 11 с Administrator
    Protection) наследуется дочерними процессами и ломает их runas. Пишем его
    всегда — по журналу видно, запущен ли установщик оболочкой. }
  LogLine('INFO', 'Слой совместимости: __COMPAT_LAYER=' +
    IfStr(GetEnv('__COMPAT_LAYER') = '', '(нет)', GetEnv('__COMPAT_LAYER')));
  LogLine('INFO', 'Журнал Inno: ' +
    IfStr(ExpandConstant('{log}') = '', '(выключен)', ExpandConstant('{log}')));
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
    { /TESTGUIMODE=1 уже снял silent-термин при разборе параметров — здесь
      только след в журнале. }
    if GTestGui = '1' then
      LogLine('INFO', 'TESTGUIMODE=1: silent-термин контекста отключён (тестовый режим)');
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
      ' user_copy=' + Pick(GUserClientCopyPresent, '1', '0') +
      ' machine_copy=' + Pick(ClientMachineCopyPresent, '1', '0') +
      ' need_elevation=' + Pick(NeedElevation, '1', '0') +
      ' in_privileged_context=' + Pick(InPrivilegedContext, '1', '0') +
      ' admin_mode=' + Pick(GAdminInstallMode, '1', '0') +
      ' server_enabled=' + Pick(not GUserOnlyMode, '1', '0') +
      ' legacy=' + IfStr(GLegacyClientVersion = '', '-', GLegacyClientVersion) +
      ' legacy_machine=' + Pick(GLegacyClientMachine, '1', '0') +
      ' license_prompt=' + Pick(LicensePromptNeeded, '1', '0'));
    LogLine('INFO', 'TESTSTATE_NOTICE server_notice=' +
      IfStr(GUserOnlyMode, ServerUnavailableReason, ''));
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

  { /TESTCONNECTPARAMS=1 — какие параметры получит клиент при «Запустить
    клиент» (ошибка 0f8dd0f3). Подмена порта уже применена, выбор компонентов и
    состояние машины — тоже; прогон завершается без изменений. }
  if GTestConnectParams = '1' then
  begin
    LogLine('INFO', 'TESTCONNECTPARAMS ' +
      IfStr(ClientConnectParams = '', '(none)', ClientConnectParams));
    ExitProcess(EXIT_OK);
  end;

  { /TESTELEVHELPER удалён вместе со скриптовой элевацией (2dd215f7):
    режим определяют фактические права процесса; мастер не перезапускается. }

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
      Удаляется после предусловий — привилегированная фаза (тесты) ещё
      передаёт путь через /PARAMS. }
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

{ Список компонентов (задача c4b68d78): прямоугольник, число строк и по
  строке на элемент. Высота строки — LB_GETITEMHEIGHT ($01A1): в Pascal Script
  нет ни ItemRect, ни ItemHeight, ни TopIndex, а SendMessage есть. chars —
  длина caption (перенос считается самим списком), sub_chars — длина subitem
  (обязана быть 0: статусы/описания — group-строки, а не subitem). }
procedure DumpList(const PageName: String; L: TNewCheckListBox);
var
  I, ItemH: Integer;
begin
  if L = nil then
  begin
    LogLine('INFO', 'TESTLAYOUT ' + PageName + ' list missing');
    Exit;
  end;
  LogLine('INFO', 'TESTLAYOUT ' + PageName + ' list left=' + IntToStr(L.Left) +
    ' top=' + IntToStr(L.Top) + ' width=' + IntToStr(L.Width) +
    ' height=' + IntToStr(L.Height));
  LogLine('INFO', 'TESTLAYOUT ' + PageName + ' items count=' +
    IntToStr(L.Items.Count));
  for I := 0 to L.Items.Count - 1 do
  begin
    ItemH := SendMessage(L.Handle, $01A1, I, 0);
    LogLine('INFO', 'TESTLAYOUT ' + PageName + ' item idx=' + IntToStr(I) +
      ' level=' + IntToStr(Ord(L.ItemLevel[I])) +
      ' checked=' + Pick(L.Checked[I], '1', '0') +
      ' enabled=' + Pick(L.ItemEnabled[I], '1', '0') +
      ' height=' + IntToStr(ItemH) +
      ' chars=' + IntToStr(Length(L.ItemCaption[I])) +
      ' sub_chars=' + IntToStr(Length(L.ItemSubItem[I])));
  end;
end;

procedure DumpLayout;
begin
  LogLine('INFO', 'TESTLAYOUT state server_selected=' + Pick(GServerSelected, '1', '0') +
    ' client_selected=' + Pick(GClientSelected, '1', '0') +
    ' scope_user=' + Pick(GClientScopeUser, '1', '0') +
    ' license_prompt=' + Pick(LicensePromptNeeded, '1', '0'));
  { Кнопка «Далее» и причина её неактивности (ошибка 5b9743da): прогон обязан
    проверить, что неактивная кнопка всегда объяснена, а причина видна. Текст
    причины — точный (T6), а не только длина: тест сверяет его с ожидаемым. }
  if WizardForm <> nil then
    LogLine('INFO', 'TESTLAYOUT next enabled=' +
      Pick(WizardForm.NextButton.Enabled, '1', '0') +
      ' reason_chars=' + IntToStr(Length(ComponentsReasonLabelText)) +
      ' reason=' + ComponentsReasonLabelText);
  DumpPageSurface('components', GComponentsPage);
  DumpList('components', GComponentsList);
  DumpControl('components', 'serverAltLink', GServerAltLink);
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
    { Статусы и описания в списке обновляет SyncComponentsList внутри
      UpdateComponentsState: при возврате на экран (например, после ошибки
      закрытия клиента) они не должны оставаться старыми. }
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
        программы (замечание приёмки 112642a4), и только в неэлевированном
        режиме: из административного процесса клиент открылся бы в профиле
        SMAA (2dd215f7), там его запускают ярлыком. }
      if GSummaryRunButton <> nil then
        GSummaryRunButton.Visible := (GExitCode = EXIT_OK) and GClientSelected and
          (ClientExePath <> '') and (not GAdminMachineScope);
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
  { Права не запрашиваются ни на одном экране мастера: их даёт запуск от имени
    администратора (или /ALLUSERS в silent). В обычном запуске прав нет вовсе —
    сказано на экране компонентов (ошибка aa5af30c). }
  S := '';
  if GUserOnlyMode then
    S := 'Режим «только для меня»: права администратора не требуются.' +
      NewLine + NewLine;
  Result := S + MemoDirInfo + MemoComponentsInfo + MemoGroupInfo + MemoTasksInfo;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Reason, PortText, FreePort: String;
begin
  Result := True;
  { Первая строка обработчика — в журнал (ошибка 5b9743da): по логу должно быть
    видно, дошло ли нажатие до установщика вообще. Неактивная кнопка сюда не
    попадает и следа не оставляет — именно это и выдавало себя за зависание. }
  LogLine('INFO', 'Кнопка «Далее»: страница ' + IntToStr(CurPageID));
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
      { Причина уже есть в ComponentsReasonText; уведомление сохраняет её на
        экране до смены выбора и не пишет подпись в обход нижнего блока. }
      if GUserOnlyMode and (GInstalledClientScope = 'machine') then
        GComponentsNotice := 'Клиент установлен для всех пользователей: ' +
          'обновление требует прав администратора — закройте установщик и ' +
          'запустите его от имени администратора (правый клик → Запуск от ' +
          'имени администратора).'
      else
        GComponentsNotice := 'Выберите хотя бы один компонент.';
      UpdateComponentsState(nil);
      Result := False;
      Exit;
    end;
    { Режим «только для меня» физически не может поставить сервер или клиент
      «для всех»: прав нет, а запрашивает их Inno только при старте (2dd215f7).
      Защита от программной установки флагов (например, из тестового хука). }
    if GUserOnlyMode and
       (GServerSelected or (GClientSelected and (not GClientScopeUser))) then
    begin
      GComponentsNotice := 'Для установки компонентов, требующих прав ' +
        'администратора, закройте установщик и запустите его от имени ' +
        'администратора (правый клик → Запуск от имени администратора).';
      UpdateComponentsState(nil);
      LogLine('WARN', 'Экран компонентов: в режиме «только для меня» выбраны ' +
        'компоненты, требующие прав администратора');
      Result := False;
      Exit;
    end;
    if LicensePromptNeeded and (not GLicenseAccepted) then
    begin
      { Причина лицензии уже в ComponentsReasonText; здесь только фокус на
        чекбоксе, чтобы клавиатура и мышь вели к нему. }
      UpdateComponentsState(nil);
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
  { Экран готовности файлы не копирует и долгих операций не выполняет (ошибка
    5b9743da): закрытие запущенного клиента и удаление старого NSIS-клиента
    перенесены в PrepareToInstall, где Inno сам показывает страницу «Подготовка
    к установке» (кнопки скрыты, «Отмена» отключена) — пауза выглядит как
    штатная подготовка, а не как окно с неотвечающими кнопками. Здесь остаётся
    только отметка в журнале, что нажатие дошло до обработчика. }
  if CurPageID = wpReady then
    LogLine('INFO', 'Экран готовности: нажата «Далее» (silent=' +
      Pick(GSilent, 'да', 'нет') + ', privileged_phase=' +
      Pick(GPrivilegedPhase, 'да', 'нет') + ', admin_mode=' +
      Pick(GAdminInstallMode, 'да', 'нет') + ')');
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  { Нажатие «Отмены» — в журнал (ошибка 5b9743da): отмена открывает штатный
    диалог подтверждения Inno, и по логу должно быть видно, что кнопка жива. }
  LogLine('INFO', 'Кнопка «Отмена»: страница ' + IntToStr(CurPageID));
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

{ Подготовка перед копированием файлов. Долгие операции (закрытие запущенного
  клиента, удаление старого NSIS-клиента) выполняются здесь, а не в
  NextButtonClick(wpReady) (ошибка 5b9743da): на время PrepareToInstall Inno
  сам показывает страницу «Подготовка к установке» с отключённой «Отменой»,
  поэтому ожидание завершения процессов больше не выглядит неподвижным окном с
  неотвечающими кнопками. Ошибка возвращается строкой: Inno печатает её на этой
  же странице, «Назад» и «Отмена» остаются доступны, файлы не заменяются.
  Права запрашивает Inno при старте (режим выбран диалогом до мастера), поэтому
  скриптовой элевации нет — self-exec установщика запрещён (2dd215f7); здесь
  только предпроверки окружения до замены файлов (9b310991). }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Reason: String;
begin
  Result := '';
  NeedsRestart := False;
  if GSilent or GPrivilegedPhase then Exit;
  LogLine('INFO', 'Подготовка к установке: предпроверки перед копированием файлов (server=' +
    Pick(GServerSelected, 'да', 'нет') + ', client=' +
    Pick(GClientSelected, 'да', 'нет') + ', admin_mode=' +
    Pick(GAdminInstallMode, 'да', 'нет') + ')');
  { Запущенный клиент закрывается до копирования: замена ETN.exe невозможна,
    пока процесс работает. Отказ пользователя или неудача закрытия —
    установка не начинается, выбор компонентов сохраняется. Машинный клиент
    другого пользователя без прав не закроется: в административном режиме
    установщик уже элевирован, поэтому попытка выполняется с его правами. }
  if GClientSelected then
  begin
    Reason := '';
    if not CloseRunningClient(True, Reason) then
    begin
      GComponentsNotice := 'Установка не начата: ' + Reason;
      LogLine('ERROR', GComponentsNotice);
      Result := GComponentsNotice + '. Изменения не выполнялись. Журнал: ' + GLogPath;
      Exit;
    end;
  end;
  { Старый NSIS-клиент удаляется до копирования файлов: его файлы и запись
    деинсталляции не должны пережить установку. }
  Reason := '';
  if not RemoveLegacyBeforeInstall(GIsElevated, Reason) then
  begin
    GComponentsNotice := 'Установка не начата: ' + Reason;
    LogLine('ERROR', GComponentsNotice);
    Result := GComponentsNotice + '. Изменения не выполнялись. Журнал: ' + GLogPath;
    Exit;
  end;
  if not NeedElevation then Exit;
  if not GServerSelected then Exit;
  { Административный режим: этот экземпляр сам выполняет привилегированную
    работу. В режиме «только для меня» сервер недоступен, поэтому выбранным
    компонентам права не нужны. }
  if not InPrivilegedContext then Exit;
  Reason := CheckServerEnvironment(False);
  if Reason <> '' then
  begin
    LogLine('ERROR', 'Установка не начата: ' + Reason);
    Result := 'Установка не начата: ' + Reason + '. Изменения не выполнялись. ' +
      'Журнал: ' + GLogPath;
  end;
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
          не регистрирует. Сбой регистрации — код 10: файлы уже заменены, это
          сбой выполнения, а не предусловие (34f8e315). }
        if GExitCode = EXIT_OK then
        begin
          SetInstallStage('Регистрация службы ETN…');
          if not RegisterServiceIfNeeded(Reason) then
            FailInstallWithCode(EXIT_FAILED, Reason);
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
        { start не ждёт RUNNING: готовность подтверждает health-check.
          Сбой команды start после замены файлов — код 10 (сбой выполнения).
          После отката прежняя версия поднимается. }
        if not StartServiceIfNeeded then
          FailInstallWithCode(EXIT_FAILED, 'служба ' + SERVICE_NAME +
            ' не запущена после замены файлов: ' +
            IfStr(GLastServiceError = '', 'причина в журнале', GLastServiceError))
        else if not HealthCheckApplicable then
          { Режим app: сервер не служба, его запускает пользователь. Опрос
            health гарантированно истёк бы и увёл обновление в откат. }
          LogLine('INFO', 'Режим app: health-check не выполняется — сервер ' +
            'запускается пользователем')
        else
        begin
          SetInstallStage('Проверка работоспособности…');
          { Расширенный health-check (0a79d9de, a1ea1d40): один GET
            /api/v1/health — 200, status=ok, db=ok, version = целевая из тела
            ответа; повтор до 60 с фактического времени. }
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
        { Экран ошибки и reason-файл для тестов читают итог отката: FailInstall
          записал только исходную причину, до отката. Перезаписываем полным
          текстом — с итогом отката (блокер приёмки bb063ac3). }
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
    { Ошибка a7394117: запись деинсталляции прежней области реестра удаляется
      только после успешной установки — при откате она остаётся точкой
      возврата. В машинном режиме Inno пишет запись только в одну область
      (HKCU или HKLM), вторую удаляем, чтобы в «Программах и компонентах» была
      одна строка. }
    if (GExitCode = EXIT_OK) and GAdminInstallMode then
      RemoveDuplicateUninstallRecord;
    { Снимок отката удаляется последним — только после того, как install.json
      зафиксировал новую версию (замечание приёмки: сбой записи при уже
      удалённом снимке оставлял установку без пути отката). }
    if (GExitCode = EXIT_OK) and GDoPrivilegedWork then
      CleanupRollbackSnapshot;
    { Ключ мог создать элевированный процесс (административный режим
      установки): читаем защищённый файл после установки, чтобы показать его
      на экране ключа. }
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
  { Установка выполняется в выбранном режиме одним экземпляром: дочернего
    привилегированного процесса больше нет (2dd215f7). }
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
  GTestServiceStatus := LowerCase(ParamValue('TESTSERVICESTATUS'));
  GTestServiceImage := ParamValue('TESTSERVICEIMAGE');
  GTestServiceStartType := ParamValue('TESTSERVICESTARTTYPE');
  GTestServiceDeleteFlag := ParamValue('TESTSERVICEDELETEFLAG');
  GTestServiceStartedFlag := False;
  GTestServiceUninstalled := False;
  if GTestServiceStop = '1061' then
    GTestServiceStopRetries := 1
  else
    GTestServiceStopRetries := 0;
  GTestFirewall := ParamValue('TESTFIREWALL');
  GTestServiceRegistered := LowerCase(GTestService) = 'present';
  GTestServiceRunning := GTestServiceRegistered;
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
      SuppressibleMsgBox('Удаление программы отменено: ' + Reason + '. ' +
        CustomMessage('UninstallServiceManual'), mbError, MB_OK, IDOK);
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
