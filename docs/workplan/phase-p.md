# Фаза P — Экспорт/импорт мыслей между мыслесетями

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.

> По запросу пользователя из мыслесети «Тест 1», задача «Экспорт-импорт мыслей
> между разными мыслесетями» (`ETN → План разработки`,
> `72c7e899-e6ed-4bcc-b8c6-5099d339685a`). Цель — переносить мысли между
> разными мыслесетями и между разными компьютерами через zip-архив формата
> `.etnx` (собственный JSON-манифест + файлы вложений). Дедупликация при
> импорте — по ID → названию → новая, политика объединения полей — по ТЗ.

## P1. Спецификация формата `.etnx` и константа `ETNX_VERSION`
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** спроектировать формат файла переноса мыслей и зафиксировать
  константу версии в shared. Формат — zip-архив с `manifest.json` (полный
  снимок графа: типы мыслей/связей, определения свойств, мысли, связи,
  комментарии, `comment_targets`, метаданные вложений) и опциональной папкой
  `attachments/` с бинарными файлами. Поле `version: "1.0"` в манифесте +
  константа `ETNX_VERSION = '1.0'` в `shared/src/constants.ts` — сейчас
  никаких проверок совместимости (v.1.0, миграций нет), но номер пишется и
  читается для будущих версий.
- **DoD:**
  - [x] Раздел «Экспорт/импорт: формат `.etnx`» в `docs/02-data-model.md`:
    структура zip, JSON-манифест, правила для ID/created_by/active/per-user,
    политика `version`.
  - [x] `ETNX_VERSION = '1.0'` в `shared/src/constants.ts` с комментарием
    о политике совместимости.
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P2. Серверный zip-экспорт `.etnx` через `archiver`
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P1
- **Описание:** расширить `export-service.ts` функцией `exportToEtnx(ndb,
  rootIds, options)`: обход подграфа (с учётом `subtree`/`depth`),
  сериализация в `manifest.json` через `archiver`, стрим zip-архива в
  `reply.raw`. Опции: `include_types`, `include_attachments`,
  `include_chronology`, `include_subtree`, `subtree_depth`. Для каждого
  файла вложения — `archive.append(createReadStream(file_path), { name:
  'attachments/<rel>' })`.
- **DoD:**
  - [ ] Формат `'etnx'` в `EXPORT_FORMATS` (`shared/src/enums.ts`).
  - [ ] `exportToEtnx` через `archiver`, стрим в `reply.raw`, корректный
    `Content-Disposition: attachment; filename="*.etnx"`.
  - [ ] Зависимость `archiver` в `server/package.json` (`npm install`,
    без хойстинга в Electron — см. AGENTS.md §4).
  - [ ] Маршрут `POST /networks/{nid}/export` принимает `format: 'etnx'` +
    опции; идемпотентность через `app.idempotency.preHandler`.
  - [ ] Серверные тесты: `tests/import-export-routes.test.ts` — zip собирается,
    manifest валиден, файлы вложений внутри, при `include_types=false` —
    types не попадают в manifest.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P3. Серверный импорт zip через `yauzl`
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P1
- **Описание:** новый `server/src/domain/import-service.ts`: `commitImport(ndb,
  buffer, options)` — стрим-чтение zip через `yauzl`, защита от zip-slip
  (`path.resolve` внутри `networks/<nid>/attachments/`), парсинг `manifest.json`
  с логированием `version` (без проверок совместимости, см. P1), извлечение
  файлов вложений под серверный путь. Восстановление графа идёт через
  `upsertThoughtBundle` (`on_duplicate: 'update'`) в порядке: типы → свойства
  → мысли (с переписыванием `created_by`/`updated_by` на текущего
  пользователя, сбросом `is_root`/`is_protected`) → связи → комментарии →
  вложения (с привязкой к новым id).
- **DoD:**
  - [ ] Политика конфликтов из ТЗ: ID → название (full match по `title_norm`)
    → новая мысль. На совпадении ID — `title` берётся из импорта; на
    совпадении названия (без ID) — `title` сохраняется, синонимы
    объединяются, permanent-комментарий и свойства перезаписываются.
  - [ ] Зависимость `yauzl` в `server/package.json`.
  - [ ] `server/src/domain/etnx-format.ts`: сериализация/десериализация
    manifest, валидация обязательных полей, безопасное извлечение файлов.
  - [ ] Серверные тесты: `tests/import-service.test.ts` — все ветки
    дедупликации, zip-slip защита, восстановление вложений, перенос
    `active`, переписывание `created_by`.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P4. REST-маршруты импорта (`/import/commit` + `/import/preview`)
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P3
- **Описание:** новый `server/src/routes/import.ts` (или дополнить
  `routes/search.ts`): `POST /api/v1/networks/{nid}/import/commit` —
  `data_base64` zip в JSON + опции, идемпотентность через
  `app.idempotency.preHandler`, ответ `{ created, updated, skipped, errors }`.
  `POST /api/v1/networks/{nid}/import/preview` (read-only) — отчёт «что
  будет создано / совпадёт по ID / совпадёт по названию» без побочных
  эффектов (через тот же парсер manifest, но без `upsertThoughtBundle`).
- **DoD:**
  - [ ] Типы `ImportRequest`, `ImportCommitResult`, `ImportDryRunResult` в
    `@etn/shared` (`shared/src/types/api.ts`).
  - [ ] Маршруты под `authPreHandler` + `requireNetworkMember()` +
    `app.idempotency.preHandler` (только для `commit`).
  - [ ] Серверные тесты: `tests/import-export-routes.test.ts` —
    `commit` создаёт/обновляет/пропускает по политике, `preview` ничего не
    меняет, повторный `commit` с тем же `Client-Request-Id` возвращает
    кеш.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P5. UI: диалог экспорта `.etnx`
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P2
- **Описание:** новый `client/src/renderer/import-export/export-dialog.ts` —
  модальный диалог по шаблону `pickLinkType` (`selection/dialogs.ts`):
  чекбоксы «экспортировать типы мыслей/связей», «экспортировать вложения»,
  «экспортировать хронику», «экспортировать подчинённые», поле глубины
  (1–5, видимо только при включённом «подчинённые»). По нажатию OK —
  `runExport('etnx', { ...опции })`.
- **DoD:**
  - [ ] Диалог с дефолтами (типы/хроника включены, вложения/подчинённые
    выключены, глубина 1).
  - [ ] Валидация: глубина только при включённом `include_subtree`.
  - [ ] Диалог использует `showDialog` из `lib/dialog.ts`.
  - [ ] `runExport` (`selection.ts:561-599`) расширен: `'etnx'` формат
    собирает zip, polling job, скачивание через `<a download>`.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P6. UI: диалог импорта `.etnx`
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P4
- **Описание:** новый `client/src/renderer/import-export/import-dialog.ts` —
  `etn.system.pickFile` с фильтром `.zip`, показ прогресса job через
  polling, итог «создано/обновлено/пропущено» в `customFooter`. Кнопка
  «Предпросмотр» (опц.) → `import/preview` перед `import/commit`.
- **DoD:**
  - [ ] Диалог: поле с выбранным путём, кнопка «Выбрать файл», прогресс
    placeholder, итог.
  - [ ] При ошибке парсинга zip / manifest — `errorDialog`, без побочных
    эффектов.
  - [ ] `etn.system.import(networkId, { data_base64, options })` в
    `client/src/main/ipc/contract.ts` + handlers.ts + preload + rest-client
    (по шаблону `etn.system.export`).
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P7. Контекстные меню мысли: «Экспорт» и «Импорт»
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P5, P6
- **Описание:** добавить в `buildThoughtMenuItems`
  (`client/src/renderer/canvas/context-menu.ts:219-363`) подменю «Экспорт»
  (`zip`/`markdown`/`html`) и пункт «Импорт» — для всех 5 call-sites
  (холст, закреплённые, структуры, панель выделения, фокус-облако).
  Импорт = открыть `import-dialog`, передав `target.id` как мысль для
  подчинения (импортированные мысли подвешиваются к ней). Экспорт =
  открыть `export-dialog` с предустановленным `thought_ids = [target.id]`.
- **DoD:**
  - [ ] Подменю «Экспорт» с тремя форматами (`zip` первым).
  - [ ] Пункт «Импорт» после подменю.
  - [ ] Разделители (`MENU_SEPARATOR`) не ломают порядок.
  - [ ] Тест в `client/tests/import-export.test.ts`: пункты появляются в
    `buildThoughtMenuItems` для всех вызовов.
  - [ ] `npm run typecheck` + клиентские тесты зелёные.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P8. Подменю «Действия → Экспорт» в панели выделенных
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P2
- **Описание:** расширить `buildActionsMenu`
  (`client/src/renderer/selection/selection.ts:226-271`): добавить формат
  `zip` в подменю «Экспорт» (Markdown/PDF/HTML остаются). Старый
  `runExport(format)` уже умеет `polling job` + `triggerDownload` —
  обобщить до `runExport(format, options)`.
- **DoD:**
  - [ ] Подменю «Экспорт» содержит 4 пункта: zip / Markdown / PDF / HTML.
  - [ ] `runExport` принимает второй аргумент `options` (для `etnx` —
    параметры экспорта), для остальных форматов игнорируется.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P9. Спецификации и ручная проверка
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** P1..P8
- **Описание:** обновить спецификации и завершить ручную проверку всей
  фичи. Итоговая проверка пользователем: экспорт → удаление части мыслей
  в другой сети → импорт → проверка полноты графа, типов, вложений,
  хроники; проверка дедупликации при повторном импорте.
- **DoD:**
  - [ ] `docs/03-server-api.md` §14а «Импорт»: `POST /import/commit`,
    `POST /import/preview`, формат тела, коды ошибок, лимиты.
  - [ ] `docs/08-ui-spec.md` §5.3 («Действия» → добавить формат `zip`),
    §2.6 (контекстное меню мысли — пункт «Импорт», подменю «Экспорт»).
  - [ ] `docs/09-scenarios.md` сценарий **E4 «Импорт выбранных мыслей»** —
    рядом с E3 «Экспорт выбранных».
  - [ ] `docs/10-glossary.md`: термин `.etnx`, ссылка на фазу P.
  - [ ] `npm run typecheck` зелёный, все затронутые тесты зелёные.
  - [ ] Ручная проверка пользователем (последним пунктом).
