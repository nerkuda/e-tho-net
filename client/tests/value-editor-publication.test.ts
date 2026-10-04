/**
 * Редактор значения свойства вида `publication` (0.11.1, задача 3275fd8d,
 * элемент интерфейса 9626efb6).
 *
 * Проверяется на реальном коде под DOM-шимом (как
 * `value-editor-cross-network-ref.test.ts`):
 *  - уже выбранное значение рисуется облачком-чипом с названием публикации
 *    (id резолвится `publications.get`);
 *  - снятие чипа сохраняет `null`, выбор пикера — id (single) / массив (multiple);
 *  - у поля есть кнопка «…» — модальный пикер публикаций.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NET = '11111111-1111-4111-8111-111111111111';
const PUB_A = '22222222-2222-4222-8222-222222222222';
const PUB_B = '33333333-3333-4333-8333-333333333333';

function publication(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    subtitle: null,
    summary_md: null,
    authorship: null,
    cover_attachment_id: null,
    cover_url: null,
    cover_kind: 'none',
    assembly_date: null,
    title_recipe: null,
    text_sources: [],
    extra_properties: [],
    numbering_from: null,
    numbering_to: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
    updated_at: '2026-10-01T00:00:00.000Z',
    updated_by: 'u',
  };
}

const CATALOGUE: Record<string, Record<string, unknown>> = {
  [PUB_A]: publication(PUB_A, 'Публикация A'),
  [PUB_B]: publication(PUB_B, 'Публикация B'),
};

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    getElementById: () => null,
  };
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout: (fn: () => void) => {
      fn();
      return 1;
    },
    clearTimeout: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    etn: {
      publications: {
        list: async () => ({ items: Object.values(CATALOGUE), total: 2 }),
        get: async (_n: string, id: string) => {
          const hit = CATALOGUE[id];
          if (hit === undefined) throw new Error('not found');
          return hit;
        },
      },
      ui: { setState: async () => undefined },
    },
  };
}

let moduleCache: any = null;
async function loadEditor(): Promise<any> {
  if (moduleCache === null) {
    installShim();
    moduleCache = await import('../src/renderer/editor/value-editor.js');
  }
  return moduleCache;
}

function findClass(root: ShimElement, cls: string): ShimElement | null {
  if (root.className.split(/\s+/).includes(cls)) return root;
  for (const child of root.children) {
    const found = findClass(child, cls);
    if (found !== null) return found;
  }
  return null;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

interface Built {
  root: ShimElement;
  saved: unknown[];
}

async function buildEditor(value: unknown): Promise<Built> {
  const { buildValueEditor } = await loadEditor();
  const saved: unknown[] = [];
  const root = buildValueEditor({
    networkId: NET,
    definition: {
      value_type: 'publication',
      config: { multiple: Array.isArray(value) },
      required: false,
      default_value: null,
      key: 'pub-property',
    },
    value,
    commitOn: 'change',
    save: (next: unknown) => {
      saved.push(next);
      return true;
    },
  }) as unknown as ShimElement;
  await settle();
  return { root, saved };
}

describe('редактор значения «Публикация» (9626efb6)', () => {
  it('одиночное значение рисуется облачком с названием публикации', async () => {
    const { root } = await buildEditor(PUB_A);
    const chip = findClass(root, 'prop-ref-cloud');
    assert.ok(chip !== null, 'чип значения есть');
    assert.ok(chip!.flatText().includes('Публикация A'), 'подпись — название, не id');
  });

  it('поле несёт кнопку «…» (модальный пикер публикаций)', async () => {
    const { root } = await buildEditor(PUB_A);
    const corner = root.querySelectorAll('.link-value-corner-btn');
    assert.ok(corner.length >= 2, 'угловые кнопки «…» и «✕» есть');
  });

  it('снятие значения сохраняет null', async () => {
    const { root, saved } = await buildEditor(PUB_A);
    const chip = findClass(root, 'prop-ref-cloud');
    assert.ok(chip !== null, 'чип значения есть');
    const removeBtn = findClass(chip!, 'st-f-clear-inline');
    assert.ok(removeBtn !== null, 'кнопка снятия чипа есть');
    removeBtn!.click();
    await settle();
    assert.equal(saved.at(-1), null, 'пустое значение сохраняется как null');
  });

  it('множественное значение рисует два чипа и не пишет до правки', async () => {
    const { root, saved } = await buildEditor([PUB_A, PUB_B]);
    const chips = root.querySelectorAll('.prop-ref-cloud');
    assert.equal(chips.length, 2, 'два чипа значений');
    assert.ok(chips[0]!.flatText().includes('Публикация A'), 'первый — A');
    assert.ok(chips[1]!.flatText().includes('Публикация B'), 'второй — B');
    assert.deepEqual(saved, [], 'до правки ничего не сохраняется');
  });
});
