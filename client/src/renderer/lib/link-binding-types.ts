/**
 * Ограничение типов значения свойства-связи для строк, чьё определение
 * собрано по РЕЕСТРУ свойств, а не по эффективной привязке типа: внетиповая
 * строка редактора мысли и строка массового диалога (ошибка f8f8fa49).
 *
 * Единственный источник ограничения — привязки свойства к типам
 * (`type_properties.side`), а не legacy-ключи `config.allowed_*_type_ids`
 * (спека «properties — справочник свойств сети», модель 0.8.2). Сервер
 * отдаёт типы привязок каждой стороны производными полями реестра:
 * `binding_source_type_ids` / `binding_target_type_ids`. Типовые строки
 * берут то же значение из `EffectiveTypeProperty.allowed_opposite_type_ids`.
 *
 * Семантика противоположного конца:
 *  - сторона `source` (прямое имя, мысль — источник) → допустимые ЦЕЛИ =
 *    типы привязок стороны назначения (`binding_target_type_ids`);
 *  - сторона `target` (обратное имя, мысль — назначение) → допустимые
 *    ИСТОЧНИКИ = типы привязок стороны источника
 *    (`binding_source_type_ids`);
 *  - противоположная сторона пуста/неизвестна → ограничения нет.
 *
 * Возвращаются «сырые» id типов: поддеревья раскрывает редактор значения
 * (`expandTypeIdsToSubtree`, L21). Чистая — юнит-тесты без DOM.
 */

import type { LinkPropertySide } from '@etn/shared';

/** Производные реестра свойств: id типов привязок по сторонам. */
export interface RegistryLinkBindingTypeIds {
  binding_source_type_ids?: readonly string[];
  binding_target_type_ids?: readonly string[];
}

/**
 * Допустимые типы значения свойства-связи для реестровой строки и её стороны.
 * Пустой массив — ограничения нет (кандидаты любые). `side = null`
 * (скалярная строка или сторона не определена) — тоже без ограничения:
 * выбрать противоположную таблицу не из чего.
 */
export function registryAllowedOppositeTypeIds(
  row: RegistryLinkBindingTypeIds | null | undefined,
  side: LinkPropertySide | null | undefined,
): string[] {
  if (row === null || row === undefined) return [];
  const ids =
    side === 'source'
      ? row.binding_target_type_ids
      : side === 'target'
        ? row.binding_source_type_ids
        : undefined;
  return Array.isArray(ids) ? ids.filter((id) => id !== '') : [];
}
