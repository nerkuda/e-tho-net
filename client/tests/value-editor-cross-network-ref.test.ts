/**
 * Редактор значения `cross_network_ref` — поле-чип (ошибка 9be98ae1,
 * задача 7849008a, тех.проект 7eeb4d96).
 *
 * Проверяется сквозной GUI-сценарий на реальном коде:
 *  - живой веерный поиск по вводу в поле (чужие сети, кандидаты текущей
 *    отсекаются — запрет своей сети, требование 884d14e1);
 *  - выбор из живой выдачи и из диалога «Выбрать…» добавляет ОБЛАЧКО-чип с
 *    меткой «чужой сети» (а не строку адреса);
 *  - контекстное меню чипа — три команды («Открыть», «Обновить имя»,
 *    «Удалить из значения»);
 *  - чип помечен как Ctrl-hover триггер чужой мысли (заголовок с сетью
 *    проверяется в `cross-network-thought-preview.test.ts`);
 *  - «✕» удаляет цель из значения и сохраняет остаток.
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
const EXISTING_ADDRESS = `n:44444444-4444-4444-8444-444444444444#55555555-5555-4555-8555-555555555555`;

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
    addEventListener: () => undefined,
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
      networks: {
        list: async () => [
          { id: CURRENT_NET, display_name: 'Текущая сеть' },
          { id: FOREIGN_NET, display_name: 'Чужая сеть' },
        ],
      },
      properties: {
        crossResolve: async () => ({ values: [] }),
      },
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
    const found = findClass(child, cls);
    if (found !== null) return found;
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

/** Классы чипов значения. */
function chipEls(root: ShimElement): ShimElement[] {
  return root.querySelectorAll('.cross-network-ref-chip');
}

interface Built {
  root: ShimElement;
  input: ShimElement;
  pickBtn: ShimElement;
  saved: unknown[];
}

/** Строит редактор cross_network_ref и возвращает поле поиска и кнопку диалога. */
async function buildEditor(value: unknown): Promise<Built> {
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
  const input = findClass(root, 'cross-network-ref-add');
  const pickBtn = findClass(root, 'cross-network-ref-pick');
  assert.ok(input !== null, 'поле живого поиска есть');
  assert.ok(pickBtn !== null, 'кнопка «Выбрать…» есть');
  return { root, input: input!, pickBtn: pickBtn!, saved };
}

describe('редактор cross_network_ref: поле-чип (9be98ae1)', () => {
  it('живой поиск: ввод находит мысль другой сети и добавляет её облачком', async () => {
    const { root, input, saved } = await buildEditor(null);
    assert.equal(chipEls(root).length, 0, 'изначально чипов нет');

    input.focus();
    input.value = 'Чужая';
    input.emit('input');
    await settle();

    const body = (globalThis as any).document.body as ShimElement;
    const rows = body.querySelectorAll('.type-combo-item');
    assert.equal(rows.length, 1, 'в выдаче только мысль другой сети (своя отсечена)');
    assert.ok(rows[0]!.flatText().includes('Чужая мысль'), 'строка-облачко с именем цели');

    rows[0]!.click();
    await settle();

    const chips = chipEls(root);
    assert.equal(chips.length, 1, 'цель добавлена облачком-чипом');
    assert.equal(saved.at(-1), FOREIGN_ADDRESS, 'сохранён адрес цели');
    assert.ok(
      chips[0]!.flatText().includes('Чужая мысль'),
      'подпись чипа — имя мысли, а не сырой адрес',
    );
  });

  it('чип помечен меткой «чужой сети» и Ctrl-hover триггером чужой мысли', async () => {
    const { root, input } = await buildEditor(null);
    input.focus();
    input.value = 'Чужая';
    input.emit('input');
    await settle();
    ((globalThis as any).document.body as ShimElement)
      .querySelectorAll('.type-combo-item')[0]!
      .click();
    await settle();

    const chip = chipEls(root)[0]!;
    assert.ok(findClass(chip, 'list-network-mark') !== null, 'метка «сеть» у чипа');
    assert.equal(chip.dataset['hpKind'], 'thought-cross-network', 'Ctrl-hover — резолвер чужой мысли');
    assert.equal(chip.dataset['hpNetwork'], FOREIGN_NET, 'id сети-источника в триггере');
    assert.equal(chip.dataset['hpOwnerId'], FOREIGN_THOUGHT, 'id цели в триггере');
  });

  it('контекстное меню чипа — три команды значения', async () => {
    const { root } = await buildEditor(FOREIGN_ADDRESS);
    const chip = chipEls(root)[0]!;
    chip.dispatchContextMenu();
    await settle();

    const body = (globalThis as any).document.body as ShimElement;
    const menu = body.querySelector('.menu');
    assert.ok(menu !== null, 'меню открыто');
    const labels = menu!.querySelectorAll('.menu-item-label').map((r) => r.flatText());
    assert.deepEqual(labels, ['Открыть', 'Обновить имя', 'Удалить из значения']);
  });

  it('«Удалить из значения» в меню убирает адрес и сохраняет пусто', async () => {
    const { root, saved } = await buildEditor(FOREIGN_ADDRESS);
    const chip = chipEls(root)[0]!;
    chip.dispatchContextMenu();
    await settle();
    const body = (globalThis as any).document.body as ShimElement;
    const removeRow = body
      .querySelector('.menu')!
      .querySelectorAll('.menu-item')
      .find((r) => r.flatText().includes('Удалить из значения'));
    assert.ok(removeRow !== undefined, 'команда удаления есть');
    removeRow!.click();
    await settle();

    assert.equal(chipEls(root).length, 0, 'чип убран из значения');
    assert.equal(saved.at(-1), null, 'single: сохранено пустое значение');
  });

  it('«✕» чипа удаляет адрес из набора multiple и сохраняет остаток', async () => {
    const { root, saved } = await buildEditor([EXISTING_ADDRESS, FOREIGN_ADDRESS]);
    const chips = chipEls(root);
    assert.equal(chips.length, 2, 'два чипа набора');
    const foreignChip = chips.find((c) => c.dataset['id'] === FOREIGN_THOUGHT)!;
    const removeBtn = findClass(foreignChip, 'st-f-clear-inline');
    assert.ok(removeBtn !== null, 'кнопка «✕» у чипа есть');
    removeBtn!.click();
    await settle();

    assert.equal(chipEls(root).length, 1, 'остался один чип');
    assert.deepEqual(saved.at(-1), [EXISTING_ADDRESS], 'сохранён остаток набора');
  });
});

describe('редактор cross_network_ref: выбор из диалога (ea04a185)', () => {
  it('кнопка «Выбрать…» открывает диалог с принудительным кросс-сетевым охватом', async () => {
    const { pickBtn } = await buildEditor(null);
    pickBtn.click();
    const form = dialogBody();
    assert.ok(form !== null, 'диалог выбора мысли открыт');
    assert.equal(form!.querySelector('.cross-network-toggle'), null, 'нет общего тогла');
    const note = form!.querySelectorAll('p').find((p) => p.textContent.includes('текущей сети'));
    assert.ok(note !== undefined, 'есть сообщение о недоступности своей сети');
    const backdrop = ((globalThis as any).document.body as ShimElement).children[0];
    backdrop?.querySelectorAll('button').find((b) => b.textContent === 'Отмена')?.click();
    await settle();
  });

  it('single: выбор чужой мысли из диалога добавляет облачко и сохраняет адрес', async () => {
    const { root, pickBtn, saved } = await buildEditor(null);
    pickBtn.click();
    const form = dialogBody();
    assert.ok(form !== null, 'диалог открыт');
    const textarea = form!.querySelector('textarea');
    assert.ok(textarea !== null, 'поле поиска есть');
    textarea!.value = 'Чужая';
    textarea!.emit('input');
    await settle();

    const rows = form!.querySelectorAll('.type-combo-item');
    assert.equal(rows.length, 1, 'в выдаче только мысль другой сети');
    rows[0]!.emit('click', {
      target: rows[0],
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await settle();

    assert.equal(chipEls(root).length, 1, 'диалог даёт облачко, а не строку «Выбрано: …»');
    assert.equal(saved.at(-1), FOREIGN_ADDRESS, 'адрес сохранён');
  });

  it('multiple: выбор из диалога добавляется к набору адресов', async () => {
    const { root, pickBtn, saved } = await buildEditor([EXISTING_ADDRESS]);
    pickBtn.click();
    const form = dialogBody();
    assert.ok(form !== null, 'диалог открыт');
    const modeRow = form!.querySelector('.add-mode-row');
    const multiRadio = modeRow!.children[1]!.children[0]!;
    multiRadio.checked = true;
    multiRadio.emit('change');

    const textarea = form!.querySelector('textarea')!;
    textarea.value = 'Чужая';
    textarea.emit('input');
    await settle();
    const rows = form!.querySelectorAll('.type-combo-item');
    assert.equal(rows.length, 1, 'в выдаче только мысль другой сети');
    rows[0]!.emit('click', {
      target: rows[0],
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
    await settle();
    const backdrop = ((globalThis as any).document.body as ShimElement).children[0]!;
    backdrop.querySelectorAll('button').find((b) => b.textContent === 'Добавить')?.click();
    await settle();

    assert.equal(chipEls(root).length, 2, 'обе цели — облачками');
    assert.deepEqual(saved.at(-1), [EXISTING_ADDRESS, FOREIGN_ADDRESS], 'набор сохранён');
  });

  it('запрет своей сети: мысль текущей сети не попадает в выдачу диалога', async () => {
    const { pickBtn } = await buildEditor(null);
    pickBtn.click();
    const form = dialogBody();
    const textarea = form!.querySelector('textarea')!;
    textarea.value = 'мысль';
    textarea.emit('input');
    await settle();
    const titles = form!.querySelectorAll('.type-combo-item').map((r) => r.flatText());
    assert.equal(titles.some((t) => t.includes('Своя мысль')), false, 'своя сеть отфильтрована');
    const backdrop = ((globalThis as any).document.body as ShimElement).children[0];
    backdrop?.querySelectorAll('button').find((b) => b.textContent === 'Отмена')?.click();
    await settle();
  });
});
