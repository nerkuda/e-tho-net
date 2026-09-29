/**
 * `lib/ui` — фасады дизайн-системы клиента (компонент f3979068, ADR
 * «Основа lib/ui: готовые Web Components за фасадами», задача 95dd50b9).
 *
 * Единственная точка доступа экранов и модулей рендерера к готовым Web
 * Components. Голые `wa-*`-элементы вне фасадов запрещены — экраны обязаны
 * ходить через модули-фасады этого каталога.
 *
 * Сейчас это каркас: импорт модуля регистрирует вендорские компоненты и
 * подключает карту маппинга токенов ETN → `--wa-*` (`./register.ts`).
 * Фасады (кнопки, поля, переключатели, вкладки, тосты, тултипы, деревья,
 * свёртки, сплиттеры) добавляются задачами этапа 2 и реэкспортируются
 * отсюда.
 */

import './register.js';

// Словарь кнопок — единственный API кнопок клиента (задача 56f1dcb2).
export {
  BUTTON_CLASS,
  BUTTON_ACTIVE_CLASS,
  uiButton,
  iconButton,
  setButtonActive,
} from './button.js';
export type { ButtonRole, ButtonSize, ButtonOptions, IconButtonOptions } from './button.js';

// Вкладки — единый механизм вкладок диалогов и экранов (задача a57e7998).
export { uiTabs } from './tabs.js';
export type { TabSpec, TabsOptions, TabsHandle } from './tabs.js';

// Сворачиваемые группы — единый компонент секций (задача a57e7998).
export { collapsibleSection } from './collapsible.js';
export type {
  CollapsibleSpec,
  CollapsibleSection,
  CollapsibleClasses,
} from './collapsible.js';

// Сообщения и строки ошибок — единственный вид строк ошибок клиента
// (задача e20761c2, требование 397c5a56).
export {
  ERROR_LINE_CLASS,
  FIELD_ERROR_CLASS,
  FOOTER_ERROR_CLASS,
  ERROR_LINE_LINK_CLASS,
  errorLine,
  errorParagraph,
  fieldError,
  operationError,
  operationErrorText,
  setStatusText,
  footerErrorLine,
  isFooterErrorLine,
} from './messages.js';
export type { ErrorAddress, FooterErrorLine } from './messages.js';

// Поле ввода — единый фасад (задача f351b894, требование e64083b5).
export {
  FIELD_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_HINT_CLASS,
  FIELD_CONTROL_CLASS,
  FIELD_MULTILINE_CLASS,
  FIELD_DISABLED_CLASS,
  FIELD_CLEARABLE_CLASS,
  FIELD_CLEAR_BTN_CLASS,
  fieldInput,
  fieldTextarea,
  fieldRow,
  wrapClearable,
  setFieldDisabled,
} from './field.js';
export type {
  FieldInputType,
  FieldControlOptions,
  FieldInputOptions,
  FieldTextareaOptions,
  FieldRowOptions,
} from './field.js';

// Строка-переключатель (флажок / радиокнопка) — единый фасад.
export {
  CHOICE_ROW_CLASS,
  CHOICE_GROUP_CLASS,
  CHOICE_ROW_LABEL_CLASS,
  choiceRow,
  checkboxRow,
  radioRow,
  choiceControl,
  choiceGroup,
} from './choice-row.js';
export type {
  ChoiceKind,
  ChoiceRowOptions,
  ChoiceRowHandle,
  ChoiceControlOptions,
} from './choice-row.js';

// Сегментный переключатель — ряд взаимоисключающих кнопок.
export { SEGMENTED_CLASS, segmentedControl } from './segmented.js';
export type { SegmentSpec, SegmentedOptions, SegmentedHandle } from './segmented.js';

// Тумблер (кнопка с состоянием «нажато»).
export { TOGGLE_CLASS, TOGGLE_GROUP_CLASS, toggleButton } from './toggle.js';
export type { ToggleVariant, ToggleOptions, ToggleHandle } from './toggle.js';

// Бейдж — метка/счётчик.
export { BADGE_CLASS, badge, setBadgeText } from './badge.js';
export type { BadgeTone, BadgeKind, BadgeOptions } from './badge.js';

// Поле пути к файлу — «поле + Обзор…».
export { filePathField } from './file-path-field.js';
export type { FilePathFieldOptions, FilePathFieldHandle } from './file-path-field.js';

// Поле цвета — picker (+ hex).
export {
  COLOR_PICKER_CLASS,
  COLOR_HEX_CLASS,
  colorField,
} from './color-field.js';
export type { ColorFieldOptions, ColorFieldHandle } from './color-field.js';

// Всплывающая панель — общая механика поповеров (задача dd1f47d4,
// требование f74f1aae): единый вид, позиционирование у якоря/курсора,
// закрытие кликом вне / Escape / прокруткой / потерей фокуса. Движки
// (Ctrl+hover-предпросмотр, лупа изображений) — потребители компонента.
export {
  POPOVER_CLASS,
  POPOVER_HEAD_CLASS,
  POPOVER_BODY_CLASS,
  POPOVER_MARGIN,
  POPOVER_GAP,
  POPOVER_CURSOR_GAP,
  placeUnderAnchor,
  placeAtCursor,
  openPopover,
} from './popover.js';
export type {
  RectLike,
  SizeLike,
  PointLike,
  AnchorPlacement,
  PointPlacement,
  PopoverContent,
  PopoverAnchor,
  PopoverOptions,
  PopoverHandle,
} from './popover.js';

// Оболочка комментария — единый каркас просмотра/правки (задача 9cb87c42,
// требование 24ca6770): рамка, панель действий, тело-поле markdown, состояния
// загрузки/пустоты/ошибки и режим «просмотр / правка» в `data-mode`.
export {
  COMMENT_CLASS,
  COMMENT_HEAD_CLASS,
  COMMENT_TOOLS_CLASS,
  COMMENT_BODY_CLASS,
  COMMENT_FOOT_CLASS,
  COMMENT_STATE_CLASS,
  COMMENT_FILL_CLASS,
  COMMENT_SCROLL_CLASS,
  commentShell,
} from './comment.js';
export type {
  CommentMode,
  CommentVariant,
  CommentState,
  CommentShellOptions,
  CommentShell,
} from './comment.js';

// Сплиттер — единый разделитель/ресайзер (задача 50f57b82, инвентаризация
// 3fc7c54d — раздел «Splitter»): жизненный цикл pointer-drag и гриф живут
// здесь, ось/знак/min/max/персист задаёт владелец.
export {
  SPLITTER_CLASS,
  SPLITTER_GRIP_CLASS,
  GRIP_GLYPH,
  splitterElement,
  wireSplitter,
  uiSplitter,
} from './splitter.js';
export type {
  SplitterAxis,
  SplitterSign,
  SplitterLimit,
  SplitterPlan,
  SplitterDragOptions,
  SplitterOptions,
} from './splitter.js';

// Реактивная основа списков — селекторы поверх store (задача 60fcc702,
// требование 628d33ee, компонент ebe5e19f). Не вендорский фасад, а слой
// состояния для будущего табличного фасада; реэкспортируется здесь по
// barrel-дисциплине `lib/ui` (сторож guard-ui-facades).
export { select, selectMany, deepEqual } from './state.js';
export type { StateSelector, SelectOptions } from './state.js';

// Единая таблица списков — фасад над Vaadin Grid (задача dad2b029,
// требование 93115633, компонент 88111458). Единственный разрешённый способ
// сборки списков в рендерере (сторож guard-ui-tables).
export {
  TABLE_CLASS,
  TABLE_EMPTY_CLASS,
  TABLE_CELL_EMPTY_CLASS,
  TABLE_CELL_CLASS,
  TABLE_CELL_CURRENT_CLASS,
  TABLE_FOCUSABLE_CLASS,
  TABLE_FOCUSABLE_CURRENT_CLASS,
  TABLE_ROW_KEY_ATTR,
  TABLE_EMPTY_CELL,
  NO_SORT,
  cycleSort,
  sortRows,
  nextRowIndex,
  isNavKey,
  escapeTsvCell,
  cellText,
  rowsToTsv,
  createTable,
} from './table.js';
export type {
  SortDir,
  SortState,
  SortMode,
  NavMode,
  NavKey,
  CellCursor,
  CellContext,
  TableColumn,
  TableSpec,
  TableHandle,
} from './table.js';

// Адаптер таблицы к вендорскому Vaadin Grid (задача dad2b029): контракт
// `GridTableAdapter` (стаб в тестах) и реализация поверх `vaadin-grid`.
export { vaadinGridAdapter } from './table-grid.js';
export type { GridColumnSpec, GridTableAdapter, GridPoint } from './table-grid.js';

// Единое дерево списков — общий рендер строк над типом-деревом данных
// (задача d1c15a2d, требование 0086037c, компонент 24a05c95). Единственный
// разрешённый способ сборки деревьев типов в рендерере (сторож guard-ui-tree).
export {
  TREE_CLASS,
  TREE_ROW_CLASS,
  TREE_ROW_CURRENT_CLASS,
  TREE_CARET_CLASS,
  TREE_CHECK_CLASS,
  TREE_CONTENT_CLASS,
  TREE_CELL_CLASS,
  TREE_HEAD_CLASS,
  TREE_EMPTY_CLASS,
  TREE_COUNT_CLASS,
  TREE_CARET_OPEN,
  TREE_CARET_CLOSED,
  treeChildIds,
  treeChildCounts,
  treeDepthOf,
  treeFilterKeepIds,
  treeVisibleIds,
  createTree,
} from './tree.js';
export type {
  TreeItem,
  TreeRowContext,
  TreeColumn,
  TreeOptions,
  TreeHandle,
} from './tree.js';

// Generic-чип-лист — чипы выбранных значений с крестиком снятия и поле
// добавления (требование d1cd2095). Значения и подписи даёт владелец;
// чипы-облачка сущностей остаются у `lib/entity-picker.ts`.
export {
  CHIP_LIST_CLASS,
  CHIP_CLASS,
  CHIP_REMOVE_CLASS,
  CHIP_LIST_ADD_CLASS,
  CHIP_LIST_EMPTY_CLASS,
  chipList,
} from './chip-list.js';
export type { ChipListOption, ChipListOptions, ChipListHandle } from './chip-list.js';

// Состояния списков и панелей — пустое состояние с подсказкой и точкой входа
// к действию, загрузка и ошибка (задача d7b7c367, требование e514768f).
// Единственный разрешённый способ показать «пусто/грузлю/ошибка» в списках,
// таблицах и панелях (сторож guard-ui-empty-state).
export {
  EMPTY_STATE_CLASS,
  EMPTY_STATE_TITLE_CLASS,
  EMPTY_STATE_HINT_CLASS,
  EMPTY_STATE_ACTION_CLASS,
  LOADING_STATE_CLASS,
  ERROR_STATE_CLASS,
  emptyState,
  loadingState,
  errorState,
} from './empty-state.js';
export type { StateAction, EmptyStateOptions } from './empty-state.js';

// Якорь возврата клавиатурного фокуса — общий атрибут обоих фасадов списков
// (дерева и таблицы) для правила 10 требования 11ddd910 (ошибка 28d69bc6).
export { FOCUS_ANCHOR_ATTR, FOCUS_ANCHOR_SELECTOR } from './focus-anchor.js';

// Сохранение позиции прокрутки при пересборке списка — общий модуль дизайн-
// системы (задача 3bfef1f7, уровень 1 тех.проекта 1d48df6d): якорь по ключу
// строки вместо простого `scrollTop`. Остаётся для списков, пересборка которых
// легитимна; для keyed-списков прокрутку удерживает сама identity узлов.
export { preserveScroll } from './scroll-anchor.js';

// Keyed-обновление списков — примитив инкрементального рендера (задача
// 6952c619, уровень 2 тех.проекта 1d48df6d): сверка набора узлов с массивом
// по ключу без пересоздания неизменных элементов; статистика — вход для FLIP.
export { DEFAULT_KEY_ATTR, reconcileKeyed } from './keyed-list.js';
export type { KeyedRenderSpec, KeyedReconcileStats } from './keyed-list.js';



