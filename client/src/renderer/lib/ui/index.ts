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
