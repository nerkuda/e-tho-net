/**
 * Регресс ошибки b610729c-2fdf-4f18-b526-7e7aeddb860f: условие по свойству с
 * оператором «в списке» (`in`/`not_in`) теряло все значения, кроме первого,
 * когда в конструкторе отбора выбирали ДВА и более значения.
 *
 * Корень — в конвертере состояния в wire: строка условия брала значения из
 * редактора значения, который для `text` отдаёт ХРАНИМУЮ форму свойства —
 * строку с разделителем `, ` (множественное text-свойство хранится
 * comma-joined, 02-data-model.md §3.4–3.5). Конструктор условий сворачивал
 * список `['Москва','Питер']` в одну строку `'Москва, Питер'` и слал её
 * серверу одним элементом массива — сервер сравнивал `value_text IN ('Москва,
 * Питер')` и не находил ни одного совпадения. Одно значение проходило (строка
 * без разделителя), поэтому дефект выглядел как «работает при 1, пусто при 2+».
 *
 * Тест гоняет РЕАЛЬНУЮ строку условия конструктора (`buildConditionsSection`
 * над минимальным DOM-шимом): добавляет два значения в «в списке» и проверяет,
 * что модель и wire несут ДВА дискретных значения, а не одну склеенную строку.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { NetworkProperty } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const OPTIONS = ['Москва', 'Питер', 'Тверь'];

/** Минимальный DOM/window-шим, которого требуют конструктор формы и редактор. */
function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      delete store[key];
    },
  };
}

/** Текстовое свойство со списком вариантов — «свойство-список» из карточки. */
const TEXT_OPTIONS_PROP = {
  id: 'p-city',
  network_id: 'n1',
  name: 'Город',
  value_type: 'text',
  config: { options: [...OPTIONS], multiple: true },
  description: null,
  created_at: '',
  updated_at: '',
} as unknown as NetworkProperty;

const registry = new Map<string, NetworkProperty>([[TEXT_OPTIONS_PROP.id, TEXT_OPTIONS_PROP]]);

/** Найти первый элемент по классу в поддереве шима. */
function findByClass(root: ShimElement, cls: string): ShimElement | null {
  if (root.classList.contains(cls)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, cls);
    if (hit !== null) return hit;
  }
  return null;
}

/** Дать осесть асинхронной цепочке коммита редактора. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Ввести значение в чип-поле и зафиксировать его (Enter). */
async function addChip(input: ShimElement, value: string): Promise<void> {
  input.value = value;
  input.emit('keydown', {
    key: 'Enter',
    defaultPrevented: false,
    preventDefault: () => undefined,
  });
  await flush();
}

describe('условие «в списке» несёт каждое выбранное значение (ошибка b610729c)', () => {
  before(() => {
    installShim();
  });

  it('два значения в «в списке» не склеиваются в одно (покрытие хранимой формы)', async () => {
    const { buildConditionsSection } = await import('../src/renderer/lib/filter-form.js');
    const { defaultFilterCriteriaState, buildConditionsWire } = await import(
      '../src/renderer/lib/filter-builder.js'
    );

    const state = defaultFilterCriteriaState();
    state.properties = [{ propertyId: TEXT_OPTIONS_PROP.id, op: 'in', values: [''] }];

    const section = buildConditionsSection(
      { networkId: 'n1', getState: () => state, registry, touch: () => undefined },
      { get: () => false, set: () => undefined },
    );

    const input = findByClass(section.body as unknown as ShimElement, 'value-chips-input');
    assert.ok(input !== null, 'строка условия строит чип-поле значений');
    await addChip(input!, 'Москва');
    await addChip(input!, 'Питер');

    assert.deepEqual(
      state.properties[0]!.values,
      ['Москва', 'Питер'],
      'модель условия хранит два дискретных значения, а не склеенную строку',
    );

    const wire = buildConditionsWire(state, registry);
    assert.deepEqual(
      wire[0]!.value,
      ['Москва', 'Питер'],
      'wire-условие «в списке» несёт массив из двух значений',
    );
  });
});
