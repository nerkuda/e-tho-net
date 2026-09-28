/**
 * Keyed-обновление списков — юнит-тесты примитива `lib/ui/keyed-list.ts`
 * (задача 6952c619, уровень 2 тех.проекта `1d48df6d`, ADR keyed-обновления).
 *
 * Модуль не знает про продукт и Web Components, поэтому проверяется на общем
 * DOM-шиме (`./dom-shim.js`) без jsdom: identity неизменённых узлов, вставка/
 * удаление в середину, перемещение, обновление через `update`, двухуровневый
 * случай «группы × строки», свой `keyAttr`, дубликат ключа.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { reconcileKeyed, type KeyedRenderSpec } from '../src/renderer/lib/ui/keyed-list.js';

interface Item {
  id: string;
  label: string;
}

/** Наблюдения вызовов `build`/`update` конкретного прогона. */
interface Trace {
  updated: Array<{ id: string; prev: Item }>;
}

/** Хост-элемент шима, приведённый к HTMLElement для примитива. */
function newHost(): HTMLElement {
  return new ShimElement('div') as unknown as HTMLElement;
}

/** Дети хоста как элементы шима (для проверок порядка/identity). */
function kids(host: HTMLElement): ShimElement[] {
  return host.children as unknown as ShimElement[];
}

/** Ключи детей по атрибуту (по умолчанию `data-key`). */
function keys(host: HTMLElement, attr = 'data-key'): string[] {
  return kids(host).map((child) => child.getAttribute(attr) ?? '');
}

/** Спецификация строки: текст = подпись, ключ = id. */
function rowSpec(trace: Trace): KeyedRenderSpec<Item> {
  return {
    key: (item) => item.id,
    build: (item) => {
      const node = new ShimElement('div', 'row');
      node.textContent = item.label;
      return node as unknown as HTMLElement;
    },
    update: (el, item, prev) => {
      trace.updated.push({ id: item.id, prev });
      (el as unknown as ShimElement).textContent = item.label;
    },
  };
}

const item = (id: string, label = id): Item => ({ id, label });

describe('reconcileKeyed: identity и статистика (6952c619)', () => {
  it('неизменные данные не трогают узлы и не дают изменений', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const spec = rowSpec(trace);

    const first = reconcileKeyed(host, [item('a'), item('b'), item('c')], spec);
    const nodes = [...kids(host)];
    assert.deepEqual(first.added, ['a', 'b', 'c']);
    assert.deepEqual(first.removed, []);
    assert.equal(first.moved, false);
    assert.deepEqual(first.updated, []);

    // Новый (структурно равный) массив: deepEqual → ни update, ни пересоздания.
    const second = reconcileKeyed(host, [item('a'), item('b'), item('c')], spec);
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.removed, []);
    assert.equal(second.moved, false);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(kids(host), nodes, 'DOM-identity неизменённых узлов сохранена');
    assert.deepEqual(trace.updated, []);
  });

  it('вставка в середину сохраняет соседние узлы и их порядок', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const spec = rowSpec(trace);
    reconcileKeyed(host, [item('a'), item('b')], spec);
    const [a, b] = kids(host);

    const stats = reconcileKeyed(host, [item('a'), item('x'), item('b')], spec);
    assert.deepEqual(stats.added, ['x']);
    assert.deepEqual(stats.removed, []);
    assert.deepEqual(keys(host), ['a', 'x', 'b']);
    assert.equal(kids(host)[0], a, 'узел «a» не пересоздан');
    assert.equal(kids(host)[2], b, 'узел «b» не пересоздан');
  });

  it('удаление из середины убирает только пропавший узел', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const spec = rowSpec(trace);
    reconcileKeyed(host, [item('a'), item('x'), item('b')], spec);
    const [a, , b] = kids(host);

    const stats = reconcileKeyed(host, [item('a'), item('b')], spec);
    assert.deepEqual(stats.removed, ['x']);
    assert.deepEqual(stats.added, []);
    assert.deepEqual(keys(host), ['a', 'b']);
    assert.equal(kids(host)[0], a);
    assert.equal(kids(host)[1], b);
  });

  it('перемещение выравнивает порядок существующими узлами (moved=true)', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const spec = rowSpec(trace);
    reconcileKeyed(host, [item('a'), item('b'), item('c')], spec);
    const [a, b, c] = kids(host);

    const stats = reconcileKeyed(host, [item('c'), item('a'), item('b')], spec);
    assert.equal(stats.moved, true);
    assert.deepEqual(stats.added, []);
    assert.deepEqual(stats.removed, []);
    assert.deepEqual(keys(host), ['c', 'a', 'b']);
    assert.deepEqual(kids(host), [c, a, b], 'перемещены те же узлы, не копии');
  });

  it('изменённый элемент обновляется через update с прежним значением', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const spec = rowSpec(trace);
    reconcileKeyed(host, [item('a', 'старое'), item('b')], spec);
    const a = kids(host)[0]!;

    const stats = reconcileKeyed(host, [item('a', 'новое'), item('b')], spec);
    assert.deepEqual(stats.updated, ['a']);
    assert.deepEqual(stats.added, []);
    assert.deepEqual(stats.removed, []);
    assert.equal(stats.moved, false);
    assert.equal(kids(host)[0], a, 'узел сохранён, обновлено только содержимое');
    assert.equal(a.textContent, 'новое');
    assert.deepEqual(trace.updated, [{ id: 'a', prev: item('a', 'старое') }]);
  });

  it('свой keyAttr (data-row-key) ищет и проставляет ключ по нему', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const spec: KeyedRenderSpec<Item> = { ...rowSpec(trace), keyAttr: 'data-row-key' };
    reconcileKeyed(host, [item('a'), item('b')], spec);
    assert.deepEqual(keys(host, 'data-row-key'), ['a', 'b']);

    const [a, b] = kids(host);
    const stats = reconcileKeyed(host, [item('b'), item('a')], spec);
    assert.equal(stats.moved, true);
    assert.deepEqual(kids(host), [b, a]);
  });

  it('дублирующийся ключ — ошибка вызывающего', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    assert.throws(
      () => reconcileKeyed(host, [item('a'), item('a')], rowSpec(trace)),
      /duplicate key/,
    );
  });
});

describe('reconcileKeyed: двухуровневый случай «группы × строки»', () => {
  interface Group {
    day: string;
    rows: Item[];
  }

  /** Секция группы: заголовок + внутренний список строк. */
  function section(day: string): ShimElement {
    const el = new ShimElement('section', 'group');
    el.setAttribute('data-day', day);
    el.append(new ShimElement('div', 'group-head'), new ShimElement('div', 'group-list'));
    return el;
  }

  function listOf(sectionEl: ShimElement): HTMLElement {
    return sectionEl.querySelector('.group-list') as unknown as HTMLElement;
  }

  it('правка строки одной группы не трогает узлы другой', () => {
    const host = newHost();
    const trace: Trace = { updated: [] };
    const row = rowSpec(trace);
    const groupSpec: KeyedRenderSpec<Group> = {
      keyAttr: 'data-day',
      key: (group) => group.day,
      build: (group) => section(group.day) as unknown as HTMLElement,
      update: () => undefined,
      equals: (a, b) => a.day === b.day,
    };

    const groups1: Group[] = [
      { day: '2026-01-01', rows: [item('r1'), item('r2')] },
      { day: '2026-01-02', rows: [item('r3')] },
    ];
    reconcileKeyed(host, groups1, groupSpec);
    for (const group of groups1) {
      const sectionEl = host.children[
        groups1.indexOf(group)
      ] as unknown as ShimElement;
      reconcileKeyed(listOf(sectionEl), group.rows, row);
    }
    const day2 = host.children[1] as unknown as ShimElement;
    const day2Row = listOf(day2).children[0] as unknown as ShimElement;

    const groups2: Group[] = [
      { day: '2026-01-01', rows: [item('r1', 'правленая'), item('r2')] },
      { day: '2026-01-02', rows: [item('r3')] },
    ];
    const groupStats = reconcileKeyed(host, groups2, groupSpec);
    assert.deepEqual(groupStats.updated, [], 'группы не менялись — update не зовётся');
    for (const group of groups2) {
      const sectionEl = host.children[groups2.indexOf(group)] as unknown as ShimElement;
      reconcileKeyed(listOf(sectionEl), group.rows, row);
    }

    assert.equal(
      (host.children[1] as unknown as ShimElement).querySelector('.group-list')?.children[0],
      day2Row,
      'строка второй группы сохранила identity',
    );
    assert.equal(day2Row.textContent, 'r3');
  });
});
