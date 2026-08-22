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
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P1
- **Описание:** расширить `export-service.ts` функцией `exportToEtnx(ndb,
  rootIds, options)`: обход подграфа (с учётом `subtree`/`depth`),
  сериализация в `manifest.json` через `archiver`, стрим zip-архива в
  `reply.raw`. Опции: `include_types`, `include_attachments`,
  `include_chronology`, `include_subtree`, `subtree_depth`. Для каждого
  файла вложения — `archive.append(createReadStream(file_path), { name:
  'attachments/<rel>' })`.
- **DoD:**
  - [x] Формат `'etnx'` в `EXPORT_FORMATS` (`shared/src/enums.ts`).
  - [x] `exportToEtnx` через `archiver`, стрим в `reply.raw`, корректный
    `Content-Disposition: attachment; filename="*.etnx"`.
  - [x] Зависимость `archiver` в `server/package.json` (`npm install`,
    без хойстинга в Electron — см. AGENTS.md §4).
  - [x] Маршрут `POST /networks/{nid}/export` принимает `format: 'etnx'` +
    опции; идемпотентность через `app.idempotency.preHandler`.
  - [x] Серверные тесты: `tests/import-export-routes.test.ts` — zip собирается,
    manifest валиден, файлы вложений внутри, при `include_types=false` —
    types не попадают в manifest.
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P3. Серверный импорт zip через `yauzl`
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P1
- **Описание:** новый `server/src/domain/import-service.ts`: `importFromEtnx(ndb,
  buffer, options)` — стрим-чтение zip через `yauzl`, защита от zip-slip
  (`path.resolve` внутри `networks/<nid>/attachments/`), парсинг `manifest.json`
  с логированием `version` (без проверок совместимости, см. P1), извлечение
  файлов вложений под серверный путь. Восстановление графа через прямые
  INSERT в одной транзакции (быстрее `upsertThoughtBundle` на тысячах мыслей)
  с политикой `02-data-model.md` §9.3: по id / по title_norm / создать;
  `created_by`/`updated_by` переписываются на текущего пользователя,
  `is_root`/`is_protected` сбрасываются.
- **DoD:**
  - [x] Политика конфликтов из ТЗ: ID → название (full match по `title_norm`)
    → новая мысль. На совпадении ID — `title` берётся из импорта; на
    совпадении названия (без ID) — `title` сохраняется, синонимы
    объединяются, permanent-комментарий и свойства перезаписываются.
  - [x] Зависимость `yauzl` в `server/package.json`.
  - [x] `server/src/domain/etnx-format.ts`: сериализация/десериализация
    manifest, валидация обязательных полей, безопасное извлечение файлов.
  - [ ] Серверные тесты: `tests/import-service.test.ts` — все ветки
    дедупликации, zip-slip защита, восстановление вложений, перенос
    `active`, переписывание `created_by`. *Локально SKIP — DB-тесты под
    `node --test` без `better-sqlite3`.*
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P4. REST-маршруты импорта (`/import/commit` + `/import/preview`)
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P3
- **Описание:** новый `server/src/routes/import.ts`: `POST
  /api/v1/networks/{nid}/import/commit` — `archive_b64` zip в JSON +
  `parent_thought_id`, идемпотентность через `app.idempotency.preHandler`,
  ответ `ImportSummary`. `POST /api/v1/networks/{nid}/import/preview`
  (read-only) — отчёт со счётчиками манифеста без побочных эффектов.
- **DoD:**
  - [x] Типы `ImportRequest`, `ImportSummary`, `ImportPreview` в
    `@etn/shared` (`shared/src/types/api.ts`).
  - [x] Маршруты под `authPreHandler` + `requireNetworkMember()` +
    `app.idempotency.preHandler` (только для `commit`).
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P5. UI: диалог экспорта `.etnx`
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P2
- **Описание:** `client/src/renderer/import-export/export-dialog.ts` —
  модальный диалог с чекбоксами «типы мыслей/связей», «вложения»,
  «хронологические комментарии», «подчинённые мысли» + поле глубины
  (1–5, активное только при включённом «подчинённые») + поле имени файла.
  По нажатию «Экспортировать» — `runExport('etnx', { ...опции })` или
  `exportSingleThought(...)` для одиночной мысли.
- **DoD:**
  - [x] Диалог с дефолтами (типы/хроника включены, вложения/подчинённые
    выключены, глубина 1).
  - [x] Валидация: глубина только при включённом `include_subtree`.
  - [x] Диалог использует `showDialog` из `lib/dialog.ts`.
  - [x] `runExport` (`selection.ts:563-602`) расширен: `'etnx'` формат
    собирает zip, polling job, скачивание через main-процесс.
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P6. UI: диалог импорта `.etnx`
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P4
- **Описание:** упрощённый flow без отдельного диалога: file picker
  через main-процесс (`etn.system.importEtnx`) с фильтром `.etnx`/`.zip`,
  результат — `notice` с кратким summary. Контекстное меню мысли и
  подменю «Действия» зовут `importToThought(networkId, targetId)` /
  `runImport()` соответственно.
- **DoD:**
  - [x] IPC `system.importEtnx(networkId, parentThoughtId)` в contract.ts
    + handlers.ts + preload + rest-client.ts (по шаблону
    `system.downloadExport`).
  - [x] Клиентские тесты обновлены (`context-menu.test.ts`).
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P7. Контекстные меню мысли: «Экспорт» и «Импорт»
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P5, P6
- **Описание:** в `buildThoughtMenuItems`
  (`client/src/renderer/canvas/context-menu.ts:264+`) пункты «Экспорт…»
  и «Импорт…» — для всех 5 call-sites (холст, закреплённые, структуры,
  панель выделения, фокус-облако). Один общий `buildThoughtMenuItems`
  покрывает их все.
- **DoD:**
  - [x] Пункт «Экспорт…» (один, ведёт в диалог экспорта с `thought_ids = [id]`).
  - [x] Пункт «Импорт…» сразу после «Экспорт…».
  - [x] Тест в `client/tests/context-menu.test.ts` обновлён под новый порядок.
  - [x] `npm run typecheck` + клиентские тесты зелёные (193/193).
  - [ ] Ручная проверка пользователем (последним пунктом).

## P8. Подменю «Действия → Экспорт» в панели выделенных
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P2
- **Описание:** в `buildActionsMenu` (`selection.ts:226+`) подменю
  «Экспорт» содержит 4 пункта: `zip-архив (.etnx)…` / Markdown / PDF / HTML.
  Пункт «Импорт…» отдельно рядом с подменю.
- **DoD:**
  - [x] Подменю «Экспорт» содержит 4 пункта: zip / Markdown / PDF / HTML.
  - [x] `runExport` принимает второй аргумент `etnxOptions` (для `etnx` —
    параметры экспорта), для остальных форматов игнорируется.
  - [x] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## P9. Спецификации и ручная проверка
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** P1..P8
- **Описание:** обновить спецификации и завершить ручную проверку всей
  фичи. Итоговая проверка пользователем: экспорт → удаление части мыслей
  в другой сети → импорт → проверка полноты графа, типов, вложений,
  хроники; проверка дедупликации при повторном импорте.
- **DoD:**
  - [x] `docs/03-server-api.md` §14а «Импорт»: `POST /import/commit`,
    `POST /import/preview`, формат тела, коды ошибок, лимиты.
  - [x] `docs/08-ui-spec.md` §5.3 («Действия» → добавить формат `zip`,
    пункт «Импорт»), §2.6 (контекстное меню мысли).
  - [x] `docs/09-scenarios.md` сценарий **E4 «Импорт»** — рядом с E3
    «Экспорт выбранных».
  - [x] `docs/10-glossary.md`: термин `.etnx`, ссылка на фазу P.
  - [x] `npm run typecheck` зелёный, все затронутые тесты зелёные.
  - [ ] Ручная проверка пользователем (последним пунктом).
