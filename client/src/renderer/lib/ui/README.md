# `lib/ui` — дизайн-система клиента

Единая точка доступа экранов и модулей рендерера к дизайн-системе ETN.
Каталог — тонкие **фасады** над готовыми Web Components (Web Awesome Core,
Vaadin) плюс собственный CSS-словарь классов. Спецификацию дизайн-системы
задаёт версия 0.9.1 (мыслесеть ETN, слой `0.9.1 — Дизайн-система клиентского
интерфейса`); этот файл — карта каталога и правила пользования.

Компонент в базе знаний: `lib/ui` (`f3979068`). Ключевое решение:
ADR «Основа lib/ui: готовые Web Components за фасадами» (`03eb2c61`).

## Как пользоваться

1. **Только через barrel `lib/ui/index.ts`.** Экраны и модули рендерера
   импортируют фасады из `./lib/ui/index.js`, а не из файлов напрямую
   (сторож `guard-ui-facades.test.ts`, ADR `03eb2c61`).
2. **Голые вендорские элементы запрещены.** `wa-*`, `vaadin-*` и импорт
   `@awesome.me/webawesome` / `@vaadin/*` допускаются только внутри
   `lib/ui/**` (сторож `guard-ui-facades`).
3. **Один вид на все случаи.** Кнопки — словарь `BUTTON_CLASS`/`uiButton`,
   строки ошибок — `messages.ts`, поля — `field.ts`, списки — компонент
   `list.ts` (навигация) и `table.ts` (таблица), деревья — `tree.ts`,
   «пусто/грузлю/ошибка» — `empty-state.ts`. Своих дублирующих классов под
   эти роли не заводим.
4. **Прикладные правила — поверх словаря по специфичности.** При равной
   специфичности исход решает порядок в бандле, а он не контракт
   (грабли `36889dd6`): модификатор поверх словарного класса поднимай
   специфичностью (`button.entity-combo-pick`), а не порядком.
5. **Размеры/цвета — только токенами.** Числовых `px`/`em`/`rem` и hex-цветов
   в CSS `lib/ui` нет (кроме «волосяного» `1px`) — сторож `guard-ui-tokens`.
6. **Адаптивность — к контейнеру, не к окну.** `@container` вместо `@media`
   по ширине окна; жёсткая ширина без `max-width`/`clamp`/`min` запрещена
   (`guard-ui-container`, требование `a08c2c4a`).
7. **Тач-таргет ≥ `--hit-area` (24px)** у компактных контролов: визуальный
   глиф меньше, зону нажатия даёт псевдоэлемент (`guard-ui-hit-area`,
   требование `5677bc3d`).
8. **Строки UI — через i18n** (`guard-ui-i18n`), вендорские лицензии — только
   Core-пакеты (`guard-ui-licenses`).
9. **Диалоги — через `lib/dialog.ts`**, не через `lib/ui` (каркас, роли
   размера S/M/L/XL; сторож `guard-ui-dialog`, требование `13464c39`).
10. **Списки обновляются инкрементально.** Keyed-сверка `reconcileKeyed`
    (`keyed-list.ts`) вместо `replaceChildren`/`clear` всей коллекции: полная
    пересборка — только при однократном монтировании экрана и смене сущности
    (стандарт «Списки рендерятся инкрементально», сторож `guard-keyed-lists`).
    На keyed-сверке: «Дневник», «Структуры», таблица «Свойства» редактора и
    дерево `tree.ts`. Строки `table.ts` живут в вендорском Vaadin Grid
    (набор — через `items`, свой keyed-механизм); фасад лишь не пере-назначает
    набор при смене выделения (`syncSelection`).
11. **Навигация списков — только через общее ядро.** Правила клавиатурной
    навигации (клавиши, границы, Home/End, разворот/сворачивание группы,
    активация, сохранение выделения по ключу, отсечка полей ввода) живут в
    `nav-core.ts` и используются ОБОИМИ видами — таблицей `table.ts` и списком
    `list.ts`. Свой обработчик стрелок у списочного экрана запрещён (сторож
    `guard-list-nav`, ADR `fadf99e0`). Адаптеры ленты «Дневника»
    (`screens/chronicle/feed-nav.ts`) и библиотеки «Публикаций»
    (`screens/publications/library-nav.ts`) отдают ядру лишь разметку и реакции.

## Каталог компонентов

| Модуль | Экспорт (barrel) | Назначение | Ссылки |
| --- | --- | --- | --- |
| `button.ts` / `button.css` | `uiButton`, `iconButton`, `BUTTON_CLASS`, `BUTTON_ACTIVE_CLASS`, `setButtonActive` | Единственный API кнопок: роли (`primary`/`neutral`/`danger`/`ghost`), плотности, состояния | задача `56f1dcb2`, требование `edc5faea` |
| `icon.ts` | `svgIcon`, `renderIcon`, `renderIconNode`, `ICON_NAMES`, `isIconName`, `loadIconCatalog`, `searchIconCatalog`, `iconAliases`, `renderLibraryIcon`, `ICON_CLASS` | **Единственный доступ к иконочной библиотеке Lucide**: рендер значка обвязки с размером/цветом/толщиной, каталог имён библиотеки (лениво), поиск по нему (в том числе по псевдонимам Lucide — возвращает канонические имена, ошибка `08b90470`) и отложенная отрисовка значка каталога по имени (вид `icon_kind='icon'`). Прямой импорт `lucide` вне фасада запрещён; эмодзи/картинки контента — не сюда | задача `6d8db38b`, ADR `bd224643`, требование `e52d249e` |
| `tabs.ts` / `tabs.css` | `uiTabs` | Полоса вкладок диалогов и экранов (`.ui-tab*`) поверх `wa-tab-group` | задача `a57e7998`, требование `88a9225a` |
| `collapsible.ts` | `collapsibleSection` | Сворачиваемые секции (группы редактора, панели) | задача `a57e7998` |
| `messages.ts` / `messages.css` | `errorLine`, `fieldError`, `operationError`, `setStatusText`, `footerErrorLine`, классы `ERROR_LINE_CLASS`/`FIELD_ERROR_CLASS`/`FOOTER_ERROR_CLASS` | Единый вид сообщений и строк ошибок | задача `e20761c2`, требование `397c5a56` |
| `field.ts` / `field.css` | `fieldInput`, `fieldTextarea`, `fieldRow`, `wrapClearable`, `setFieldDisabled`, классы `FIELD_*` | Поля ввода: базовые классы, подпись/подсказка/ошибка, clearable | задача `f351b894`, требование `e64083b5` |
| `choice-row.ts` / `choice-row.css` | `choiceRow`, `checkboxRow`, `radioRow`, `choiceControl`, `choiceGroup` | Строка-переключатель (флажок/радио) | задача `f351b894`, требование `e64083b5` |
| `segmented.ts` / `segmented.css` | `segmentedControl` | Сегментный переключатель (взаимоисключающие кнопки) | задача `f351b894` |
| `toggle.ts` / `toggle.css` | `toggleButton` | Тумблер — кнопка с состоянием «нажато» | требование `e64083b5` |
| `badge.ts` / `badge.css` | `badge`, `setBadgeText` | Метка/счётчик (тоны, виды) | задача `f351b894` |
| `file-path-field.ts` | `filePathField` | «Поле + Обзор…» | задача `f351b894` |
| `color-field.ts` | `colorField` | Поле цвета: picker + hex | задача `f351b894` |
| `popover.ts` / `popover.css` | `openPopover`, `placeUnderAnchor`, `placeAtCursor`, классы `POPOVER_*` | Общая всплывающая панель: вид, позиционирование, закрытие (клик вне/Escape/скролл/фокус) | задача `dd1f47d4`, требование `f74f1aae` |
| `comment.ts` / `comment.css` | `commentShell`, классы `COMMENT_*` | Каркас просмотра/правки комментария: рамка, панель действий, состояния, режим `data-mode` | задача `9cb87c42`, требование `24ca6770` |
| `splitter.ts` / `splitter.css` | `uiSplitter`, `wireSplitter`, `splitterElement`, `SPLITTER_CLASS` | Разделитель/ресайзер: pointer-drag и гриф; ось/знак/min/max задаёт владелец | задача `50f57b82` |
| `state.ts` | `select`, `selectMany`, `deepEqual` | Реактивные селекторы поверх store (основа списков) | задача `60fcc702`, требование `628d33ee` |
| `nav-core.ts` | `NAV_KEY_ACTIONS`, `resolveNavAction`, `nextNavIndex`, `listTargetIndex`, `isEditingTarget` | **Общее ядро клавиатурной навигации** таблиц и списков: клавиши, границы, Home/End, PgUp/PgDn, отсутствие выделения, отсечка полей ввода | ADR `fadf99e0`, требование `93115633`, задача `7893e429` |
| `list.ts` | `createListNav` | **Общий компонент списка**: навигация списков (лента «Дневника», библиотека «Публикаций») через ядро; разметку caller рисует keyed-сверкой | ADR `fadf99e0`, требование `93115633`, задача `7893e429` |
| `drag-list.ts` / `drag-list.css` | `createDragList`, `dragHandle`, классы `DRAG_*` | **Общий drag-фасад ручного порядка**: сортируемый список поверх `createListNav` — pointer-драг с порогом, клон-призрак, линии вставки, авто-скролл и клавиатурный сдвиг `Alt+↑/↓` (действия ядра `moveUp`/`moveDown`). Группа — «соседи одного родителя»; drag-логика только здесь | задача `d13fd645`, ADR `fadf99e0` |
| `keyed-list.ts` | `reconcileKeyed`, `DEFAULT_KEY_ATTR` | Инкрементальная сверка списка по ключу (identity неизменных узлов) | задача `6952c619`, ADR keyed-обновления |
| `scroll-anchor.ts` | `preserveScroll` | Возврат позиции прокрутки при легитимной полной пересборке | задача `3bfef1f7` |
| `table.ts` / `table.css` | `createTable`, классы `TABLE_*`, `cycleSort`, `sortRows`, `cellText`, `rowsToTsv` | Единственный способ сборки списков (модель таблицы); строки — вендорский Grid, выделение синхронизируется точечно; навигация — из общего ядра `nav-core.ts` | задача `dad2b029`, требование `93115633`, задача `d59fdfb9`, задача `7893e429` |
| `table-grid.ts` | `vaadinGridAdapter` | Адаптер модели таблицы к Vaadin Grid | задача `dad2b029` |
| `tree.ts` / `tree.css` | `createTree`, классы `TREE_*`, `treeVisibleIds`, `treeFilterKeepIds` | Единое дерево списков (типы, категории); коллекция строк — на keyed-сверке | задача `d1c15a2d`, требование `0086037c`, задача `d59fdfb9` |
| `chip-list.ts` / `chip-list.css` | `chipList`, классы `CHIP_*` | Чипы выбранных значений с крестиком и полем добавления | требование `d1cd2095` |
| `publication-cloud.ts` / `publication-cloud.css` | `createPublicationCloud`, классы `PUBLICATION_CLOUD_*` | Облачко публикации: прямые углы, значок-книга, контекстное меню (Открыть/Читать/Найти на полке) и крестик снятия владельца; единственное место показа облачка публикации | замечание Б2 приёмки задачи `b02ef1cf` |
| `empty-state.ts` / `empty-state.css` | `emptyState`, `loadingState`, `errorState`, классы `EMPTY_STATE_*`/`LOADING_STATE_CLASS`/`ERROR_STATE_CLASS` | «Пусто/грузлю/ошибка» с подсказкой и точкой входа к действию | задача `d7b7c367`, требование `e514768f` |
| `register.ts` | (side-effect импорт) | Регистрация вендора и подключение CSS в правильном порядке | задача `95dd50b9` |

## Карта токенов

Токены объявлены в `client/src/renderer/styles/tokens.css` (блоки `:root`
и `[data-theme='dark']`); `styles.css` — манифест модулей, см. `styles/`.
Компоненты `lib/ui` ссылаются только на токены.

**Шкалы оформления** (требование `0dddd939`, сторож `guard-ui-tokens`):

- типографика: `--font-size-3xs`…`--font-size-2xl` (10→20px),
  `--font-weight-normal|medium|semibold|bold`;
- отступы: `--space-1`…`--space-8` (2→16px);
- радиусы: `--radius-s|m|l|xl|pill` (+ алиасы `--radius-sm`, `--radius`,
  `--radius-cloud`);
- состояния и геометрия: `--transition-hover`, `--state-disabled-opacity`,
  `--hit-area`, `--hit-area-min`, `--tree-indent`.

**Пользовательские токены** (`--user-*`, требование `e2895c24`, сторож
`guard-ui-user-tokens`) — аспекты, которые планируется отдать пользователю
в настройках оформления; переопределяются подстановкой на корне документа:

- шрифты: `--user-font-ui`, `--user-font-mono`, `--user-font-size`;
- холст: `--user-canvas-bg`, `--user-canvas-image`, `--user-canvas-dot`;
- комментарии: `--user-comment-font-size`, `--user-comment-line-height`,
  `--user-comment-bg`, `--user-comment-color`, `--user-comment-link`.

**Маппинг на вендора** (обе карты — unlayered, поэтому перекрывают слои
вендора; одна карта красит обе темы):

- `client/src/renderer/lib/ui/tokens.css` — ETN → `--wa-*` (Web Awesome);
- `client/src/renderer/lib/ui/vaadin-tokens.css` — ETN → `--vaadin-*`
  (Vaadin Grid, задача `cf4f8f70`).

Карта `tokens.css` держит группы поверхностей/текста/фокуса, `brand`,
`success`/`warning`/`danger`/`neutral` и типографику кода. Полноту связности
проверяет `lib-ui-tokens.test.ts` (нет висячих `var(--token)`).

## Порядок CSS

Каталог — источник CSS-словаря (`.ui-btn*`, `.ui-field*`, `.ui-table` и т. д.).
`lib/ui/register.ts` подключает: стили вендора → `tokens.css` → CSS фасадов.
Порядок внутри `register.ts` значим (см. грабли `36889dd6` и раздел «Как
пользоваться», п. 4). Правила вида лежат в `client/src/renderer/styles/**`
(модульный CSS, задача `de23c709`).

## Сторожа

Все запреты каталога проверяются обычным `npm -w @etn/client test`:
`guard-ui-facades` (barrel, вендор, диалоги), `guard-ui-buttons`,
`guard-ui-fields`, `guard-ui-comment`, `guard-ui-popover`, `guard-ui-tables`,
`guard-ui-tree`, `guard-ui-empty-state`, `guard-ui-states`,
`guard-ui-discoverability`, `guard-ui-hit-area`, `guard-ui-container`,
`guard-ui-tokens`, `guard-ui-user-tokens`, `guard-ui-i18n`,
`guard-ui-licenses`, `guard-ui-dialog`, `guard-ui-icons`, `guard-keyed-lists`,
`guard-list-nav`.
