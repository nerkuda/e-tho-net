/**
 * Единое правило вида иконки `icon_kind='icon'` (ADR 2b655b29, требование
 * ead91183, задача 610a440e).
 *
 * Вид `icon` хранит в поле `icon` kebab-имя каталога Lucide из `@etn/shared`
 * (`ICON_LIBRARY_NAMES`). Правило применяется в двух формах:
 *
 *  - {@link libraryIconValid} — для zod-`.refine` контракта: проверяет ТЕЛО
 *    запроса (создание/правка, когда вид и значение идут вместе);
 *  - {@link assertLibraryIcon} — для ИТОГОВОГО состояния: частичная правка
 *    может нести только `icon` (вид сохранён) или только `icon_kind`
 *    (значение сохранено), поэтому роуты PATCH и домен `ontology.write`
 *    сливают изменения с сохранённой записью и проверяют эффективную пару.
 *
 * Оба используют одно сообщение и один каталог имён — расхождение исключено.
 */

import { EtnError, isIconLibraryName, type IconKind } from '@etn/shared';

/** Канонический текст ошибки вида `icon` (REST и MCP — один). */
export const LIBRARY_ICON_MESSAGE =
  'icon должен быть именем иконки из каталога Lucide (kebab-case).';

/**
 * Тело запроса: при `icon_kind='icon'` поле `icon` обязано быть именем
 * каталога Lucide. `undefined`/`null` допустимы (вид задан, значение ещё не
 * выбрано). Для `emoji`/`image` правило не срабатывает.
 */
export function libraryIconValid(value: { icon_kind?: unknown; icon?: unknown }): boolean {
  if (value.icon_kind !== 'icon') return true;
  if (value.icon === undefined || value.icon === null) return true;
  return typeof value.icon === 'string' && isIconLibraryName(value.icon);
}

/**
 * Итоговое состояние (частичная правка уже слита с сохранённой записью):
 * при эффективном `icon_kind='icon'` эффективный `icon` обязан быть именем
 * каталога; иначе `VALIDATION_ERROR`. `undefined`/`null` — значение не задано,
 * пропускаем.
 */
export function assertLibraryIcon(
  iconKind: IconKind | undefined,
  icon: string | null | undefined,
  requestId?: string,
): void {
  if (iconKind !== 'icon') return;
  if (icon === undefined || icon === null) return;
  if (!isIconLibraryName(icon)) {
    throw new EtnError('VALIDATION_ERROR', LIBRARY_ICON_MESSAGE, { field: 'icon' }, requestId);
  }
}
