# AGENTS.md — инструкции для агентов проекта ETN

> **TL;DR.** Это **ETN** — self-hosted граф мыслей (аналог TheBrain). Спецификации
> в [`docs/`](docs/) — **источник истины** (авторитетнее кода). MVP (фазы A–K из
> [`docs/workplan.md`](docs/workplan.md)) собран; проект в режиме **тестовой
> эксплуатации и баг-фиксов**: пользователь сообщает об ошибках/замечаниях, агент
> воспроизводит, диагностирует, чинит и проверяет. Где что искать — см. §2 и §10.

## 0. Текущий режим работы

- **MVP сдан.** Все задачи `docs/workplan.md` (фазы A–K) — `done`. Workplan теперь
  историческая справка, а не очередь работ.
- **Входной поток задач — от пользователя-тестировщика** (сообщает дефекты).
  Новую функциональность «с нуля» не начинать без явной задачи с ID.
- **Node 22 LTS** (`.nvmrc`). Это осознанный выбор — не Node 20/24.
- Установка и запуск **не должны требовать Python** и вообще чего-либо, кроме
  Node 22 и `npm install` (см. §4 про `better-sqlite3`).

## 1. Главные правила

1. **Спецификации в `docs/` — источник истины.** При конфликте кода и спецификации
   остановись, не правь молча. Разберись: поведение расходится со спецификацией →
   баг кода; код следует спецификации, а пользователю удобнее иначе → запрос на
   изменение спецификации (`docs:`-коммит). Неоднозначно — подними вопрос.
2. **Не начинай новую функциональность «мимо плана».** Текущая работа — баг-фиксы
   из отчётов пользователя. Всё крупное получает новый ID в `workplan.md`.
3. **Не ломай `done`-области.** Читай связанную спецификацию перед правками.
4. **Не коммить runtime- и build-артефакты:** `*.db`, `*.db-wal`, `*.db-shm`,
   `etn_data/`, `data/`, `var/`, `.env`, `node_modules/`, `dist/`, `out/`, `build/`,
   `release/` (см. `.gitignore`).

## 2. Структура репозитория и карта для отладки

```
etn/
├── docs/        # спецификации (01..11) + README + workplan + руководства
├── server/      # @etn/server  — Fastify + better-sqlite3 + WebSocket + MCP
│   ├── src/     #   исходники
│   ├── migrations/{system,network}/  # идемпотентные SQL-миграции
│   └── dist/    #   сборка (tsc) — НЕ коммитить
├── client/      # @etn/client  — Electron + electron-vite (vanilla TS, без React)
│   ├── src/{main,preload,renderer}/
│   ├── scripts/rebuild-native.mjs  # пересборка better-sqlite3 под Electron (см. §4)
│   └── out/     #   сборка electron-vite — НЕ коммитить
├── shared/      # @etn/shared  — общие типы, DTO, константы, коды ошибок
├── markdown/    # @etn/markdown — ЕДИНЫЙ markdown→HTML рендерер (markdown-it):
│   │            #   wiki-ссылки, размеры картинок, подсветка; используют server (body_html)
│   │            #   и client (виджеты live preview). Менять рендеринг — только здесь.
├── .nvmrc       # Node 22 LTS
└── package.json # npm workspaces: shared, markdown, server, client
```

### Где что искать (типичные темы баг-фиксов)

| Тема | Файлы |
|------|-------|
| **Связи на холсте** (отрисовка, hover/click, слои) | `client/src/renderer/canvas/links.ts` (три SVG-слоя: `.links-overlay` визуал под облачками, `.links-overlay-hit` прозрачные wide-линии над ними ловят мышь, `.links-overlay-top` выделенная связь над всем) |
| **Drag-n-drop облачка** (move/link/reorder/copy) | `client/src/renderer/canvas/drag-cloud.ts`; `add-dialog.ts` (`wireZoneExternalDrops` + фильтр `CLOUD_DRAG_MIME`) |
| **Облачка/зоны/эллипсы/фокус-ряд** | `client/src/renderer/canvas/canvas.ts` (`buildCloud`, `renderFocusRow`, `findCloudAnywhere`) |
| **Ресайзер холст/редактор** | `client/src/renderer/screens/editor-resizer.ts` |
| **Меню «Вид» / показ-скрытие редактора** | `screens/workspace-menus.ts` (`wireViewMenu`, `toggleEditorVisibility`); `editor/editor.ts` |
| **Realtime: применение событий** | `client/src/main/realtime/applier.ts` (cache + `removeFromFocusHistoryEverywhere`); `client/src/renderer/realtime-ui.ts` (UI-эффекты) |
| **Фокус-response, рёбра окрестности, степени эллипсов** | `server/src/domain/thought-service.ts` (`focus`); `server/src/domain/link-service.ts` (`getEdgesAmong`, `getLinkDirections`) |
| **IPC контракт клиент↔main** | `client/src/main/ipc/contract.ts` (домены `etn.*`), `preload/index.ts` |
| **Хранилище и схема** | `server/migrations/{system,network}/*.sql`; `docs/02-data-model.md` |

## 3. Жизненный цикл работы

### 3.1. Баг-фикс из отчёта пользователя (основной режим)

1. **Воспроизведи** локально (`dev:server` + `dev:client`). Не воспроизводится —
   уточни шаги/окружение, не гадай.
2. **Диагностируй корень.** Прочитай связанную спецификацию и код (карта — §2).
3. **Определи тип:** баг кода → правь код; неточность спецификации → правь `docs/`
   отдельным коммитом; неоднозначно → подними вопрос.
4. **Чини**, не нарушая архитектурных ограничений (§7).
5. **Проверь:** `npm run typecheck` + затронутые тесты + ручная проверка пути.
6. **Коммить** `fix(<scope>): <summary>` (или `[<ID>] ...` если завёл задачу).

### 3.2. Задача из workplan (если работа возобновляется по плану)

Статусы: `todo` → `in_progress` → `done` (`blocked` с причиной). Коммит
`[<TASK_ID>] <type>(<scope>): <summary>`.

## 4. Соглашения по коду и сборка

- **TypeScript везде** (`strict`, `noUncheckedIndexedAccess`). ESM.
- **Node 22 LTS** (`.nvmrc`). На 24 нужен Python для `better-sqlite3`, на 20 нет
  гарантий prebuilt — поэтому именно 22.
- **`better-sqlite3` — две физические копии (Node + Electron), БЕЗ Python.** В
  `server/package.json` и `client/package.json` зафиксированы **несовместимые
  точные версии** (`11.1.2` и `11.10.0`), чтобы npm workspaces не хойстил в одну
  копию. Итог: `server/node_modules/better-sqlite3` (под Node, для сервера) +
  корневая `node_modules/better-sqlite3` (под Electron, для клиента). **Не
  «выравнивай» эти версии и не ставь `^`** — снова схойстится в одну и сервер с
  клиентом не смогут работать одновременно.
- **`npm -w @etn/client run rebuild:native`** (`client/scripts/rebuild-native.mjs`)
  пересобирает **только клиентскую (корневую)** копию под Electron: удаляет
  `build/` (маркер иначе заставляет `prebuild-install` пропускать скачивание) и
  качает Electron-prebuilt. **Python не нужен.** Запускать после каждого
  `npm install`. Серверную копию НЕ трогает — сервер работает под Node.
- **Клиентский preload — ESM**, поэтому `sandbox: false` (см. комментарий в
  `client/src/main/index.ts`). Не возвращай `true`, не переведя preload в CJS.
- **SQL — параметризованный.** Миграции — в `server/migrations/{system,network}/`,
  идемпотентные в контрольной точке.
- **Никаких `any` без обоснования.** Для внешних данных — `unknown` + валидация.
- Комментарии/имена — английские; UI-тексты и документация — русские.

## 5. Команды (обязательны перед коммитом)

```bash
nvm use 22                              # активировать Node 22 (nvm-windows)
npm install                             # после checkout / смены ветки
npm -w @etn/client run rebuild:native   # один раз после install (см. §4)

npm run dev:server                      # сервер (tsx watch; подхватывает корневой .env через --env-file-if-exists)
npm run dev:client                      # Electron-клиент (electron-vite)

npm run typecheck                       # типы всех workspace
npm -w @etn/server test                 # серверные тесты
npm -w @etn/client test                 # клиентские тесты
npm run build                           # сборка всех workspace
```

Если `typecheck` или затронутые тесты красные — чинить до коммита.

> Сервер и клиент можно запускать **одновременно** — это и есть смысл §4.
> Команды выше для Git Bash; в PowerShell работают те же `npm …`.

## 6. Коммиты и ветки

- **Баг-фикс:** `fix(<scope>): <summary>`.
- **Задача workplan:** `[<TASK_ID>] <type>(<scope>): <summary>`.
- **Правка спецификации:** отдельный `docs(<area>): ...`, не смешивать с кодом.
- Один коммит = одна осмысленная правка. Деструктивные операции (удаление,
  `git push --force`) — только после подтверждения пользователя.

## 7. Архитектурные ограничения (часто нарушаются)

- **Онлайн-only клиент.** Локальный SQLite клиента — только персональные
  настройки, UI-state, черновики, история фокуса, `client_id`, `last_seq`.
- **Хранение:** `_system.db` (общая) + `networks/<uuid>/data.db` на сеть.
- **Идемпотентность:** каждый изменяющий запрос принимает `Client-Request-Id`;
  сервер кеширует ответ 10 мин.
- **Real-time:** `audience: "network"` (по умолчанию) или `"user"`.
- **Граф может содержать циклы** — любой обход с visited-set/path-CTE и лимитами.
- **Защищённые сущности:** HOME (`is_protected=1, is_root=1`) неудаляема; первый
  пользователь (`is_first_user=1`) неудаляем и всегда админ.
- **API-key** — только SHA-256 хеш; полный ключ возвращается ровно один раз.
- **MCP-агент вызывает `find_duplicates` перед `create_thought`.**
- **`better-sqlite3` — две копии (Node/Electron), см. §4.** Не хойстить в одну.
- **Слои связей на холсте** (`links.ts`): и визуальные кривые, и прозрачные
  wide-полосы `.links-overlay-hit` (hover/click) — **под** облачками
  (интерактивна только видимая часть линии — облачко всегда получает свой
  клик, связь под ним не «поднимается»); выделенная связь (и её подпись) —
  в `.links-overlay-top` над всем. **На hover перерисовывай только top-слой
  (`drawActive`)** — полный `clearSvg` между `mousedown` и `mouseup` убивает
  `click` (уже наступавший баг).
- **focus-response несёт扩展ения:** `edges` (все active-связи среди видимых
  мыслей, не только к фокусу), `sorts` (per-zone сортировка), а каждый
  `FocusNeighbor` — `has_incoming`/`has_outgoing` (закраска эллипсов по наличию
  любых связей). Все три заполнются сервером в `focus()`.

## 8. Если обнаружил проблему

- **Противоречие в спецификациях** → не выбирай версию молча, опиши и спроси.
- **Спецификация устарела** → `docs:`-коммит отдельно от кода.
- **Фикс оказался больше** → заведи ID в `workplan.md`.
- **Баг в чужой `done`-области** → чини как обычный фикс (§3.1), прочитав спеку.

## 9. Чек-лист перед коммитом

- [ ] Код следует §4 (TS strict, без `any` без причины, TSDoc).
- [ ] `npm run typecheck` зелёный.
- [ ] Затронутые тесты зелёные.
- [ ] Спецификация соблюдена (или правка — отдельным коммитом).
- [ ] Для задачи workplan: DoD отмечены, статус `done`.
- [ ] Коммит с правильным префиксом (`fix(...)` / `[<ID>] ...` / `docs(...)`).
- [ ] Runtime/build-артефакты не закоммичены.

## 10. Подводные камни среды (читай перед отладкой)

- **Серверные БД-тесты локально SKIP.** `npm -w @etn/server test` под `node --test`
  не поднимает `better-sqlite3` (native binding unavailable в test-runner) → тесты
  `thought-service`/`traversal`/`focus`… пропускаются. Assertion'ы всё равно
  добавляй — они пройдут под реальной БД/в CI. Для клиентских тестов (`node --test
  --import tsx`) это неактуально, они зелёные.
- **Горячая перезагрузка клиента** (`dev:client`) подтягивает изменения TS/CSS.
  Сервер после правок `server/src` нужно перезапустить (`dev:server` на tsx-watch
  перезагрузится сам; `node dist` — перезапусти вручную, предварительно
  `npm -w @etn/server run build`).
- **Изменения `shared/`** требуют `npm -w @etn/shared run build` — client/server
  читают `shared/dist`, а не `src`.
- **Изменения `markdown/`** требуют `npm -w @etn/markdown run build` — server и
  client читают `markdown/dist`. Смена `MD_RENDER_VERSION` заставляет сервер при
  старте перерендерить кеш `body_html` всех комментариев (sweep).
- **Связи/облачка «не работают» после правок рендера** — проверь три слоя в
  `links.ts` и DOM-порядок (`initLinksOverlay`: визуал через `prepend`, hit/top
  через `append`), а не только `z-index`.
- **«Связь не открывается по клику»** — почти всегда признак того, что что-то
  делает полный redraw hit-слоя в момент клика (см. §7 про `drawActive`).
- **Drag-and-drop в клиент «не работает» (курсор — красный перечёркнутый
  кружок, зоны не подсвечиваются)** — Windows UIPI: окно Electron запущено с
  повышенными правами (консоль «от администратора»), а источник (проводник,
  браузер) — с обычными. Это блокировка ОС, не кода. Лечится запуском
  `dev:client` из обычной консоли. Внутренние причины (перекрытия,
  перехватчики drag) исключаются, если «запрещено» над всем окном, включая холст.
