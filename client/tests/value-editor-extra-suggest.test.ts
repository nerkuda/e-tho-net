/**
 * Общий редактор значения: источник подсказок вызывающего (`extraSuggest`) и
 * общий чип-лист сущностей (`buildEntityChipField`).
 *
 * Задача 5e0bfc28 (веха «чистота» версии 0.8.2):
 *  - токены отбора (`$today+7d`, `$thought`) — источник вызывающего: у даты с
 *    токенами поле становится ТЕКСТОВЫМ (токен не влезает в `<input
 *    type="date">`), у text/url источник добавляется в общую выпадашку;
 *  - у number/bool источников нет — вид поля не меняется (токены не
 *    появляются там, где их быть не должно);
 *  - чип-лист сущностей рисует значения мини-облачками, токены сохраняет, а
 *    модальный пикер заменяет только нетокенную часть набора.
 *
 * Харнесс повторяет editor-link-value-chip.test.ts (DOM-shim, без dispatch
 * асинхронных цепочек живого поиска).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: {} },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
    body,
  };
  const win = ((globalThis as any).window ??= {});
  const etnApi = (win['etn'] ??= {}) as Record<string, unknown>;
  etnApi['thoughts'] = {
    findDuplicates: async () => [],
    resolve: async (_n: string, ids: string[]) =>
      ids.map((id) => ({ id, title: `Title of ${id}`, type_id: null, active: true, marked_for_deletion: false })),
  };
  (etnApi['system'] ??= {}) as Record<string, unknown>;
  (etnApi['system'] as Record<string, unknown>)['openExternal'] = async () => '';
  win['innerWidth'] = 1024;
  win['innerHeight'] = 768;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
}

/** Первый элемент с тегом `input`/`select` в поддереве. */
function findTag(root: ShimElement, tag: string): ShimElement | null {
  if (root.tagName === tag) return root;
  for (const child of root.children) {
    const hit = findTag(child, tag);
    if (hit !== null) return hit;
  }
  return null;
}

/** Все элементы с классом-маркером мини-облачка. */
function findAllClouds(root: ShimElement): ShimElement[] {
  const out: ShimElement[] = [];
  const walk = (node: ShimElement): void => {
    if (node.className.split(' ').includes('prop-ref-cloud')) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Источник-заглушка: запоминает тексты, что вернул бы. */
function tokenSource(text: string) {
  return {
    when: 'always' as const,
    load: () => [{ value: text, label: text }],
  };
}

describe('buildValueEditor — источник подсказок вызывающего (extraSuggest)', () => {
  it('дата с токенами — текстовое поле с подсказкой-заполнителем (токен в date не влезает)', async () => {
    installShim();
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: { value_type: 'date', config: null, required: false, default_value: null },
      value: '2024-01-01',
      commitOn: 'change',
      placeholder: 'YYYY-MM-DD или токен ($today+7d)…',
      extraSuggest: [tokenSource('$today+7d')],
      save: () => true,
    }) as unknown as ShimElement;

    const input = findTag(root, 'input');
    assert.ok(input !== null, 'поле ввода есть');
    assert.equal(input!.type, 'text', 'с токенами дата — текстовое поле');
    assert.equal(input!.placeholder, 'YYYY-MM-DD или токен ($today+7d)…');
    assert.equal(input!.value, '2024-01-01');
  });

  it('дата без токенов остаётся нативным полем даты', async () => {
    installShim();
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: { value_type: 'date', config: null, required: false, default_value: null },
      value: '2024-01-01',
      commitOn: 'change',
      save: () => true,
    }) as unknown as ShimElement;

    const input = findTag(root, 'input');
    assert.equal(input!.type, 'date');
  });

  it('bool с extraSuggest игнорирует источник: вид поля не меняется (токенов у bool нет)', async () => {
    installShim();
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: { value_type: 'bool', config: null, required: false, default_value: null },
      value: null,
      commitOn: 'change',
      boolTriState: true,
      extraSuggest: [tokenSource('$today')],
      save: () => true,
    }) as unknown as ShimElement;

    assert.equal(root.tagName, 'select', 'bool — селект, а не поле с токенами');
    assert.equal(root.children.length, 3, '«—» / да / нет');
  });

  it('числовое значение приходит в редактор числом (не строкой)', async () => {
    installShim();
    const { buildValueEditor } = await import('../src/renderer/editor/value-editor.js');
    const root = buildValueEditor({
      networkId: 'n1',
      definition: { value_type: 'number', config: null, required: false, default_value: null },
      value: 7,
      commitOn: 'change',
      save: () => true,
    }) as unknown as ShimElement;

    const input = findTag(root, 'input');
    assert.equal(input!.type, 'number');
    assert.equal(input!.value, '7');
  });
});

describe('buildEntityChipField — общий чип-лист сущностей', () => {
  it('значения — мини-облачка, токен сохраняется, «✕» убирает один', async () => {
    installShim();
    const { buildEntityChipField } = await import('../src/renderer/lib/entity-picker.js');
    let values = ['t-1', '$thought'];
    const field = buildEntityChipField({
      getValues: () => values,
      onChange: (next) => {
        values = next;
      },
      loadOptions: () => [],
      cloudOf: (v) => (v === 't-1' ? { id: v, title: 'Тип 1' } : null),
      placeholder: 'Тип…',
    }) as unknown as { root: ShimElement };
    // Перерисовка после внешнего резолва.
    (field as unknown as { refresh: () => void }).refresh();

    assert.equal(findAllClouds(field.root).length, 2, 'два чипа: сущность и токен');
    const firstRemove = findAllClouds(field.root)[0]!.children.find((c) =>
      c.className.split(' ').includes('st-f-clear-inline'),
    );
    assert.ok(firstRemove !== undefined, 'у чипа есть «✕»');
    firstRemove!.dispatch('click', { stopPropagation: () => undefined });
    assert.deepEqual(values, ['$thought'], 'убрали только сущность, токен остался');
  });

  it('модальный пикер заменяет нетокенную часть, токены сохраняются', async () => {
    installShim();
    const { buildEntityChipField } = await import('../src/renderer/lib/entity-picker.js');
    let values = ['t-1', '$thought'];
    const field = buildEntityChipField({
      getValues: () => values,
      onChange: (next) => {
        values = next;
      },
      loadOptions: () => [],
      picker: { label: 'список типов…', open: async () => ['t-2', 't-3'] },
    }) as unknown as { root: ShimElement };

    const pickBtn = field.root.children.find((c) => c.textContent === 'список типов…');
    assert.ok(pickBtn !== undefined, 'кнопка пикера есть');
    pickBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(values, ['$thought', 't-2', 't-3'], 'токен сохранён, набор заменён');
  });
});
