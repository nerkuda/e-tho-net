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
