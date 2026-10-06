/**
 * Значки интерфейсной обвязки клиента — модуль обратной совместимости
 * (задача 6d8db38b, ADR bd224643).
 *
 * Набор значков переехал в фасад дизайн-системы `lib/ui/icon.ts` (библиотека
 * Lucide). Этот модуль ничего не объявляет сам: он лишь реэкспортирует
 * публичный API фасада, чтобы существующие потребители (`svgIcon`,
 * `IconName`) продолжали работать. Новые потребители импортируют значки
 * из `lib/ui` (barrel), а не отсюда.
 */

export { ICON_CLASS, ICON_NAMES, svgIcon, renderIcon, isIconName } from './ui/icon.js';
export type { IconName, IconOptions } from './ui/icon.js';
