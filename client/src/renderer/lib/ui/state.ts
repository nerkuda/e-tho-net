/**
 * Реактивная основа списков: селекторы поверх рендерерского store
 * (задача 60fcc702, требование 628d33ee, компонент ebe5e19f).
 *
 * Тонкий слой над {@link store} (`renderer/state.ts`): читает текущий снимок
 * состояния, перевычисляет срез на КАЖДОМ обновлении store и зовёт потребителя
 * только когда срез фактически изменился (структурное сравнение,
 * {@link deepEqual}). Realtime-канал (`realtime-ui.ts`, `applyRealtimeToUi`)
 * уже фан-аутит события через `store.update`, поэтому подписчик селектора
 * обновляется сам — ручные `invalidate`-хуки вызывающего не нужны
 * (требование 628d33ee).
 *
 * Модуль не знает про DOM и Web Components: это чистая функция над снимком
 * store, поэтому тестируется без jsdom. Фасад таблицы этапа 2 подписывается
 * на срез этим API и отписывается возвращённой функцией при удалении узла.
 *
 * Сравнение срезов — СТРУКТУРНОЕ (не по ссылке): store.update подменяет
 * отдельные поля снимка (`focus`, `linkTypes`, …) новыми объектами даже когда
 * содержимое прежнее (перезапрос ради свежести данных), а селектор обычно
 * возвращает заново собранный массив. Сравнение по ссылке будило бы список на
 * каждый посторонний апдейт; структурное сравнение зовёт fn только на реальном
 * изменении значения. Стоимость сравнения приемлема — срезы списков малы.
 * Потребитель, знающий более дешёвое равенство своего среза, передаёт
 * `options.equals`.
 *
 * API рассчитан на табличный фасад (задача Z3 этапа 2): таблица принимает
 * селектор среза строк, подписывается в конструкторе и отписывается при
 * удалении; realtime-события приходят в список сами.
 */

import { store, type AppState } from '../../state.js';

/** Селектор: чистая функция от снимка состояния к его срезу. */
export type StateSelector<T> = (state: AppState) => T;

/** Настройки подписки на селектор. */
export interface SelectOptions<T> {
  /**
   * Равенство срезов. По умолчанию — {@link deepEqual} (структурное).
   * Передай свой компаратор, если знаешь более дешёвое/точное равенство
   * (например, сравнение по стабильному ключу строки списка).
   */
  equals?: (a: T, b: T) => boolean;
  /**
   * Звать ли `fn` сразу при подписке текущим значением среза. По умолчанию
   * `true` — список, подписавшийся на селектор, обязан отрисовать текущее
   * состояние, не дожидаясь первого изменения. `false` — только на изменения.
   */
  immediate?: boolean;
}

/**
 * Структурное равенство значений: примитивы (через `Object.is`), массивы,
 * `Date`, `Set`, `Map` и plain-объекты. Нужно селекторам, потому что store
 * подменяет объекты/массивы снимка при каждом апдейте (см. шапку модуля).
 *
 * Циклы не поддерживаются намеренно: снимок состояния и срезы списков
 * ацикличны, а защита от циклов стоила бы дороже на каждом сравнении.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  if (a instanceof Set || b instanceof Set) {
    return a instanceof Set && b instanceof Set && setEqual(a, b);
  }

  if (a instanceof Map || b instanceof Map) {
    return a instanceof Map && b instanceof Map && mapEqual(a, b);
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setEqual(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;
  const bItems = [...b];
  outer: for (const aItem of a) {
    for (const bItem of bItems) {
      if (deepEqual(aItem, bItem)) continue outer;
    }
    return false;
  }
  return true;
}

function mapEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>): boolean {
  if (a.size !== b.size) return false;
  const bEntries = [...b.entries()];
  outer: for (const [aKey, aValue] of a) {
    for (const [bKey, bValue] of bEntries) {
      if (deepEqual(aKey, bKey) && deepEqual(aValue, bValue)) continue outer;
    }
    return false;
  }
  return true;
}

/**
 * Общая механика подписки: перевычисление среза и вызов пользователя только
 * на фактическом изменении. Возвращает функцию отписки.
 */
function subscribeSlice<T>(
  compute: () => T,
  fn: (value: T) => void,
  options: SelectOptions<T>,
): () => void {
  const equals = options.equals ?? (deepEqual as (a: T, b: T) => boolean);
  const immediate = options.immediate ?? true;
  let current: T | undefined;
  let hasCurrent = false;

  const evaluate = (): void => {
    const next = compute();
    if (!hasCurrent) {
      hasCurrent = true;
      current = next;
      if (immediate) fn(next);
      return;
    }
    if (equals(current as T, next)) return;
    current = next;
    fn(next);
  };

  evaluate();
  return store.subscribe(evaluate);
}

/**
 * Подписка на вычисляемый срез состояния. `fn` зовётся при каждом изменении
 * среза (сравнение — {@link deepEqual} либо `options.equals`), а также сразу
 * при подписке, если `options.immediate` не `false`.
 *
 * Возвращает функцию отписки; вызывающий обязан отписаться при удалении
 * своего узла (фасад таблицы — в своём teardown).
 */
export function select<T>(
  selector: StateSelector<T>,
  fn: (value: T) => void,
  options: SelectOptions<T> = {},
): () => void {
  return subscribeSlice(() => selector(store.state), fn, options);
}

/**
 * Подписка сразу на несколько срезов: `fn` зовётся с их значениями, когда
 * изменился АТОМАРНО весь набор (структурное сравнение массива значений).
 * Удобно спискам, чья отрисовка зависит от нескольких полей store.
 *
 * Тип селекторов выводится как кортеж, поэтому значения `fn` типизированы
 * позиционно:
 * `selectMany([s => s.pins, s => s.showTrash], (pins, showTrash) => …)`.
 */
export function selectMany<T extends readonly unknown[]>(
  selectors: { readonly [K in keyof T]: StateSelector<T[K]> },
  fn: (...values: NoInfer<T>) => void,
  options: SelectOptions<T> = {},
): () => void {
  const compute = (): T =>
    selectors.map((selector) => selector(store.state)) as unknown as T;
  return subscribeSlice(compute, (values) => fn(...values), options);
}
