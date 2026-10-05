/**
 * Чистая логика приёмников pointer-дропа мыслей (задача d144ef71). Вынесена из
 * `lib/thought-drop.ts` отдельно, чтобы юнит-тесты не тянули граф рантайма
 * (диалоги, entity-picker, app.js) — по конвенции репозитория `*-pure`.
 */

/** Что делает дроп в поле: добавить в приёмник и/или снять из источника. */
export interface FieldDropPlan {
  /** Приёмник принял мысль (её не было) — надо отрисовать/сохранить. */
  add: boolean;
  /** Мысль ушла из поля-источника (перенос без Shift между разными полями). */
  removeFromSource: boolean;
}

/**
 * Семантика дропа мысли в поле. Перенос — когда драг начат в ДРУГОМ поле,
 * Shift не зажат, поля разные и приёмник реально изменился; во всех остальных
 * случаях мысль в источнике не трогается (копирование, бросок в своё же поле,
 * повторный бросок в поле, где мысль уже есть).
 */
export function resolveFieldDrop(input: {
  accepted: boolean;
  originIsField: boolean;
  sameField: boolean;
  copy: boolean;
}): FieldDropPlan {
  return {
    add: input.accepted,
    removeFromSource:
      input.accepted && input.originIsField && !input.copy && !input.sameField,
  };
}

/**
 * Ищет приёмник по цепочке родителей от точки дропа. `get` отдаёт данные поля
 * для элемента (в рантайме — запись `WeakMap`); живой DOM даёт `parentElement`,
 * лёгкие тестовые элементы — `parent`.
 */
export function walkDropField<T>(
  el: object | null,
  get: (node: object) => T | undefined,
): { el: object; handlers: T } | null {
  let current: object | null = el;
  while (current !== null) {
    const handlers = get(current);
    if (handlers !== undefined) return { el: current, handlers };
    current =
      (current as { parentElement?: object | null }).parentElement ??
      (current as { parent?: object | null }).parent ??
      null;
  }
  return null;
}
