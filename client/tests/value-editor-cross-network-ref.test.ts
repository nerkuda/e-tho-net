/**
 * Редактор значения `cross_network_ref`: кнопка «Выбрать…» и её диалог
 * (задача ea04a185, тех.проект 7eeb4d96).
 *
 * Проверяется сквозной GUI-сценарий на реальном коде: `buildValueEditor`
 * строит поле адреса, кнопка открывает общий диалог выбора мысли с
 * ПРИНУДИТЕЛЬНЫМ кросс-сетевым охватом (`pickThoughtsDialog { crossNetwork }`),
 * выбор чужой мысли кладёт в поле адрес `n:<network>#<thought>`, а мысли
 * текущей сети в выдаче отсутствуют (запрет своей сети, требование 884d14e1).
 *
 * Харнесс — DOM-shim, как в `add-dialog.test.ts` (общий `ShimElement`,
 * синхронный `setTimeout`, живой `window.etn`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CURRENT_NET = '11111111-1111-4111-8111-111111111111';
const FOREIGN_NET = '22222222-2222-4222-8222-222222222222';
const FOREIGN_THOUGHT = '33333333-3333-4333-8333-333333333333';
const OWN_THOUGHT = '66666666-6666-4666-8666-666666666666';
const FOREIGN_ADDRESS = `n:${FOREIGN_NET}#${FOREIGN_THOUGHT}`;

/** Кандидат дубля с визуальными полями (форма `DuplicateHit`). */
function hit(id: string, networkId: string, title: string): Record<string, unknown> {
  return {
    id,
    network_id: networkId,
    title,
    synonyms: [],
    matched_on: 'title',
    type_id: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    parent_title: null,
  };
}

/** Выдача кросс-сетевого поиска: чужая мысль + мысль текущей сети. */
const crossHits: Array<Record<string, unknown>> = [
  hit(FOREIGN_THOUGHT, FOREIGN_NET, 'Чужая мысль'),
  hit(OWN_THOUGHT, CURRENT_NET, 'Своя мысль'),
];

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
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
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: () => undefined,
    etn: {
      thoughts: {
        findDuplicates: async () => [],
        findDuplicatesAcrossNetworks: async () => ({
          hits: crossHits,
          networks: { networks: [] },
        }),
        resolve: async (_n: string, ids: string[]) =>
          ids.map((id) => ({ id, title: `Title of ${id}`, type_id: null, active: true })),
        get: async () => ({}),
      },
      networks: { list: async () => [{ id: CURRENT_NET }, { id: FOREIGN_NET }] },
      ui: { setState: async () => undefined },
      system: { openExternal: async () => '' },
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

/** Первый элемент с классом-маркером в поддереве. */
function findClass(root: ShimElement, cls: string): ShimElement | null {
  if (root.className.split(/\s+/).includes(cls)) return root;
  for (const child of root.children) {
    const hit2 = findClass(child, cls);
    if (hit2 !== null) return hit2;
  }
  return null;
}

/** Тело открытого диалога выбора мысли. */
function dialogBody(): ShimElement | null {
  const body = (globalThis as any).document.body as ShimElement;
  const backdrop = body.children.find((c) => c.className === 'dialog-backdrop');
  return backdrop?.querySelector('.form-stack') ?? null;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Строит редактор cross_network_ref и возвращает поле ввода и кнопку. */
async function buildEditor(value: unknown): Promise<{
  input: ShimElement;
  pickBtn: ShimElement;
  saved: unknown[];
}> {
  const { buildValueEditor } = await loadEditor();
  const saved: unknown[] = [];
  const root = buildValueEditor({
    networkId: CURRENT_NET,
    definition: {
      value_type: 'cross_network_ref',
      config: { multiple: Array.isArray(value) },
      required: false,
      default_value: null,
    },
    value,
    commitOn: 'change',
    save: (next: unknown) => {
      saved.push(next);
      return true;
    },
  }) as unknown as ShimElement;
  const input = findClass(root, 'cross-network-ref-input');
  const pickBtn = findClass(root, 'cross-network-ref-pick');
  assert.ok(input !== null, 'поле адреса есть');
  assert.ok(pickBtn !== null, 'кнопка «Выбрать…» есть');
  return { input: input!, pickBtn: pickBtn!, saved };
}

describe('редактор cross_network_ref: выбор чужой мысли из диалога (ea04a185)', () => {
  it('кнопка «Выбрать…» открывает диалог с принудительным кросс-сетевым охватом', async () => {
    const { pickBtn } = await buildEditor(null);
    pickBtn.click();
    const form = dialogBody();
    assert.ok(form !== null, 'диалог выбора мысли открыт');
    // Переключатель охвата в этом диалоге не показывается (охват принудительный,
    // глобальное состояние тогла не портится).
    assert.equal(form!.querySelector('.cross-network-toggle'), null, 'нет общего тогла');
    const note = form!.querySelectorAll('p').find((p) => p.textContent.includes('текущей сети'));
    assert.ok(note !== undefined, 'есть понятное сообщение о недоступности своей сети');
    // Отменяем диалог.
    const backdrop = ((globalThis as any).document.body as ShimElement).children[0];
    backdrop?.querySelectorAll('button').find((b) => b.textContent === 'Отмена')?.click();
    await settle();
  });

  it('single: выбор чужой мысли подставляет адрес n:<network>#<thought> и сохраняет его', async () => {
    const { input, pickBtn, saved } = await buildEditor(null);
    pickBtn.click();
    const form = dialogBody();
    assert.ok(form !== null, 'диалог открыт');
    const textarea = form!.querySelector('textarea');
    assert.ok(textarea !== null, 'поле поиска есть');
    textarea!.value = 'Чужая';
    textarea!.emit('input');
    await settle();

    const rows = form!.querySelectorAll('.dup-item');
    // Мысль текущей сети отфильтрована — остаётся только чужая.
    assert.equal(rows.length, 1, 'в выдаче только мысль другой сети');
    rows[0]!.emit('click', {
      target: rows[0],
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await settle();

    assert.equal(input.value, FOREIGN_ADDRESS, 'в поле — адрес чужой мысли');
    assert.equal(saved.at(-1), FOREIGN_ADDRESS, 'адрес сохранён');
  });

  it('multiple: выбор чужой мысли добавляется к набору адресов', async () => {
    const existing = `n:44444444-4444-4444-8444-444444444444#55555555-5555-4555-8555-555555555555`;
    const { input, pickBtn, saved } = await buildEditor([existing]);
    pickBtn.click();
    const form = dialogBody();
    assert.ok(form !== null, 'диалог открыт');
    // Переключаем на «несколько»: клик по кандидату копит список.
    const modeRow = form!.querySelector('.add-mode-row');
    const multiRadio = modeRow!.children[1]!.children[0]!;
    multiRadio.checked = true;
    multiRadio.emit('change');

    const textarea = form!.querySelector('textarea')!;
    textarea.value = 'Чужая';
    textarea.emit('input');
    await settle();
    const rows = form!.querySelectorAll('.dup-item');
    assert.equal(rows.length, 1, 'в выдаче только мысль другой сети');
    rows[0]!.emit('click', {
      target: rows[0],
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await settle();
    // Применяем список.
    const backdrop = ((globalThis as any).document.body as ShimElement).children[0]!;
    backdrop.querySelectorAll('button').find((b) => b.textContent === 'Добавить')?.click();
    await settle();

    assert.equal(input.value, `${existing}, ${FOREIGN_ADDRESS}`, 'адрес добавлен к набору');
    assert.deepEqual(saved.at(-1), [existing, FOREIGN_ADDRESS], 'набор сохранён');
  });

  it('запрет своей сети: мысль текущей сети не попадает в выдачу диалога', async () => {
    const { pickBtn } = await buildEditor(null);
    pickBtn.click();
    const form = dialogBody();
    const textarea = form!.querySelector('textarea')!;
    // Запрос, который нашёл бы и свою, и чужую мысль, — отбор должен отсечь свою.
    textarea.value = 'мысль';
    textarea.emit('input');
    await settle();
    const titles = form!.querySelectorAll('.dup-item').map((r) => r.flatText());
    assert.equal(titles.some((t) => t.includes('Своя мысль')), false, 'своя сеть отфильтрована');
    const backdrop = ((globalThis as any).document.body as ShimElement).children[0];
    backdrop?.querySelectorAll('button').find((b) => b.textContent === 'Отмена')?.click();
    await settle();
  });
});
