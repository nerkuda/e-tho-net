/**
 * Keyed-обновление списков — примитив инкрементального рендера дизайн-системы
 * (задача 6952c619, уровень 2 тех.проекта `1d48df6d`
 * «Инкрементальное обновление списков UI», ADR «Keyed-обновление списков:
 * собственный reconcile-примитив вместо morphdom/uhtml»).
 *
 * **Проблема.** Плоские списки рендерера пересобирались целиком
 * (`clear()`/`replaceChildren`), из-за чего сбрасывались прокрутка, hover,
 * фокус и открытые редакторы, а обработчики навешивались заново.
 *
 * **Решение.** {@link reconcileKeyed} синхронизирует набор DOM-узлов с
 * массивом элементов по СТАБИЛЬНОМУ КЛЮЧУ:
 *  • узел ищется по data-атрибуту ключа (`keyAttr`, по умолчанию `data-key`);
 *  • порядок выравнивается перемещением СУЩЕСТВУЮЩИХ узлов
 *    (`insertBefore`/`append`), а не их пересозданием;
 *  • пропавшие узлы удаляются;
 *  • изменившиеся (по `equals`, по умолчанию структурное `deepEqual`)
 *    обновляются через {@link KeyedRenderSpec.update};
 *  • неизменные узлы НЕ трогаются вовсе — identity узла сохраняется, поэтому
 *    живы прокрутка, фокус, hover и открытые редакторы.
 *
 * **Двухуровневый случай** («список групп × строки внутри») собирается двумя
 * ВЛОЖЕННЫМИ вызовами — группы по своему ключу во внешнем контейнере, строки по
 * своему во внутреннем. Произвольная вложенная иерархия намеренно не
 * поддерживается: для деревьев есть отдельный фасад (`./tree.ts`).
 *
 * **Возврат.** {@link KeyedReconcileStats} — вход для анимации перестроения
 * (FLIP): `added` → fade-in, `removed` → ghost-растворение, `moved` → смещение.
 * При пустых `added`/`removed` и `moved === false` анимировать нечего.
 *
 * Модуль не знает про Web Components и конкретные экраны: `build`/`update`
 * задаёт вызывающий. Импортирует только чистое сравнение `deepEqual` из
 * соседнего `./state.js` (модуль без DOM и побочных эффектов).
 */

import { deepEqual } from './state.js';

/** Атрибут ключа по умолчанию (совпадает с ключом строк дерева и таблиц). */
export const DEFAULT_KEY_ATTR = 'data-key';

/** Описание того, как рисовать и обновлять элементы списка. */
export interface KeyedRenderSpec<T> {
  /** Стабильный ключ элемента (переживает переупорядочивание и правки). */
  key(item: T): string;
  /** Новый узел для элемента. Примитив сам проставит атрибут ключа. */
  build(item: T): HTMLElement;
  /** Обновление существующего узла под новое значение (и прежнее — `prev`). */
  update(el: HTMLElement, item: T, prev: T): void;
  /**
   * Равенство элементов: `false` — зовётся `update`. По умолчанию — структурное
   * {@link deepEqual}. Передай свой компаратор, если знаешь более дешёвое
   * равенство по ключу/версии строки.
   */
  equals?(a: T, b: T): boolean;
  /** Атрибут ключа в DOM. По умолчанию {@link DEFAULT_KEY_ATTR} (`data-key`). */
  keyAttr?: string;
}

/** Что изменилось при сверке — вход для анимации перестроения (FLIP). */
export interface KeyedReconcileStats {
  /** Ключи появившихся элементов (в порядке следования). */
  added: string[];
  /** Ключи удалённых элементов. */
  removed: string[];
  /** Был ли перемещён хотя бы один существующий узел. */
  moved: boolean;
  /** Ключи обновлённых элементов (`update` был вызван). */
  updated: string[];
}

/**
 * Прежние элементы по ключу, привязанные к контейнеру: даёт {@link
 * KeyedRenderSpec.update} прежнее значение `prev` между вызовами. Хранится
 * слабо — контейнер удалён → запись уходит сама.
 */
const lastItems = new WeakMap<HTMLElement, Map<string, unknown>>();

/** Ключ узла из атрибута (`null`, если атрибут пуст/отсутствует). */
function readKey(node: Element, attr: string): string | null {
  const value = node.getAttribute(attr);
  return value === null || value === '' ? null : value;
}

/** Дети контейнера-элемента массивом (без текстовых узлов). */
function elementChildren(host: HTMLElement): HTMLElement[] {
  return Array.from(host.children) as HTMLElement[];
}

/**
 * Синхронизировать содержимое `host` с `items` по ключу. См. шапку модуля.
 *
 * Возвращает статистику изменений. Бросает исключение на дублирующемся ключе:
 * это ошибка вызывающего (ключ обязан быть стабильным и уникальным).
 */
export function reconcileKeyed<T>(
  host: HTMLElement,
  items: readonly T[],
  spec: KeyedRenderSpec<T>,
): KeyedReconcileStats {
  const attr = spec.keyAttr ?? DEFAULT_KEY_ATTR;
  const equals = spec.equals ?? (deepEqual as (a: T, b: T) => boolean);
  const prevItems = lastItems.get(host) as Map<string, T> | undefined;

  const current = new Map<string, T>();
  const desired: HTMLElement[] = [];
  const desiredSet = new Set<HTMLElement>();
  const existing = new Set<HTMLElement>();
  const added: string[] = [];
  const updated: string[] = [];

  // Существующие узлы по ключу (первый узел каждого ключа).
  const byKey = new Map<string, HTMLElement>();
  for (const child of elementChildren(host)) {
    const key = readKey(child, attr);
    if (key !== null && !byKey.has(key)) byKey.set(key, child);
  }

  for (const item of items) {
    const key = spec.key(item);
    if (current.has(key)) {
      throw new Error(`reconcileKeyed: duplicate key "${key}"`);
    }
    current.set(key, item);

    let node = byKey.get(key) ?? null;
    if (node === null) {
      node = spec.build(item);
      node.setAttribute(attr, key);
      added.push(key);
    } else {
      byKey.delete(key);
      existing.add(node);
      const prev = prevItems?.get(key);
      if (prev !== undefined && !equals(prev, item)) {
        spec.update(node, item, prev);
        updated.push(key);
      }
    }
    desired.push(node);
    desiredSet.add(node);
  }

  // Порядок существующих узлов ДО изменений — по нему видно реальное
  // перемещение (сдвиг от вставки/удаления таковым не считается).
  const existingOrder = elementChildren(host).filter((child) => existing.has(child));
  const desiredExisting = desired.filter((child) => existing.has(child));
  const moved =
    existingOrder.length !== desiredExisting.length ||
    existingOrder.some((child, i) => child !== desiredExisting[i]);

  // Удаление: ключевые узлы, для которых не нашлось элемента, и все безключевые.
  const removed: string[] = [];
  for (const child of elementChildren(host)) {
    if (desiredSet.has(child)) continue;
    const key = readKey(child, attr);
    if (key !== null) removed.push(key);
    host.removeChild(child);
  }

  // Выравнивание порядка перемещением существующих узлов.
  let refIndex = 0;
  for (const node of desired) {
    const at = (host.children[refIndex] as HTMLElement | undefined) ?? null;
    if (at !== node) host.insertBefore(node, at);
    refIndex += 1;
  }

  lastItems.set(host, current as Map<string, unknown>);
  return { added, removed, moved, updated };
}
