/**
 * Переход к свойству из «Связей дня» (0.16.1, задача 3054fe86): клик по подписи
 * свойства датового факта открывает мысль на вкладке «Свойства» и показывает
 * строку ЭТОГО свойства (прокрутка + выделение `prop-row-current`).
 *
 * Проверяется на РЕАЛЬНОМ `mountEditor`: вкладка активируется программно
 * (`setThoughtEditorTarget` с опцией), панель пересобирается и забирает запрос
 * строки (`pendingPropertyRevealFor` → `nav.setCurrent`). Повторный клик по
 * тому же свойству тоже обязан сработать — запрос не «съедается» первым
 * переходом без показа строки.
 *
 * Дом — DOM-шим `renderer-editor-entity-switch.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusResponse, Thought, ThoughtType } from '@etn/shared';
import { ShimElement } from './dom-shim.js';

function shimDom(): void {
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    bubbles: boolean;
    constructor(type: string, init?: { detail?: unknown; bubbles?: boolean }) {
      this.type = type;
      this.detail = init?.detail;
      // Шиму нужен флаг всплытия: на `bubbles` держится `etn:reveal-outside`.
      this.bubbles = init?.bubbles === true;
    }
  };
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void): number => {
    cb();
    return 0;
  };
  (globalThis as any).getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px' });
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: { style: { setProperty: () => undefined, removeProperty: () => undefined } },
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.dispatchEvent = () => undefined;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
}

/**
 * Тип мысли с двумя свойствами. `id` — id ПРИВЯЗКИ (`type_properties.id`), он
 * уникален в эффективном наборе и служит ключом сверки строк; `property_id` —
 * реестровый id, который несёт датовый факт. В реальных данных они РАЗНЫЕ —
 * фикстура с одинаковыми id маскировала дефект (вердикт 4294f1f3).
 */
const TEXT_PROPERTY = {
  id: 'binding-1',
  property_id: 'p1',
  owner_type: 'thought_type',
  owner_id: 'ta',
  key: 'Заметка',
  value_type: 'text',
  config: null,
  required: false,
  position: 0,
};

/** Свойство-связь: ключ строки = id привязки, запрос — реестровый `p2`. */
const LINK_PROPERTY = {
  id: 'binding-2',
  property_id: 'p2',
  owner_type: 'thought_type',
  owner_id: 'ta',
  key: 'Связь',
  value_type: 'link',
  config: {},
  required: false,
  position: 1,
};

function installEtn(): void {
  const win = (globalThis as any).window as Record<string, unknown>;
  win.etn = {
    ui: { getState: async () => 'main', setState: async () => undefined },
    comments: { list: async () => [], create: async () => undefined },
    attachments: { list: async () => [] },
    thoughts: { get: async () => ({}) },
    properties: {
      get: async () => [
        {
          property_id: 'p1',
          property_name: 'Заметка',
          value_type: 'text',
          value: 'значение',
          outside_type: false,
        },
      ],
    },
    types: { listTypeProperties: async () => [TEXT_PROPERTY, LINK_PROPERTY] },
  };
}

function makeThought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 't1',
    title: 'T1',
    type_id: 'ta',
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    active: true,
    is_protected: false,
    is_root: false,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    synonyms: [],
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeType(id: string, overrides: Partial<ThoughtType> = {}): ThoughtType {
  return {
    id,
    name: id,
    parent_id: null,
    is_root: false,
    comment_template_md: null,
    icon: null,
    icon_kind: 'emoji',
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    description: null,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

function makeFocus(focused: Thought): FocusResponse {
  return {
    focused,
    parents: [],
    siblings: [],
    children: [],
    edges: [],
    sorts: {
      parents: { sort: 'created', order: 'asc' },
      children: { sort: 'created', order: 'asc' },
      siblings: { sort: 'created', order: 'asc' },
    },
  };
}

/** Дождаться собственных асинхронных цепочек редактора (render, панели). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Смонтировать редактор на мысли t1 и вернуть хост. */
async function mountOpenEditor(): Promise<{ host: ShimElement; scrollBox: ShimElement }> {
  shimDom();
  installEtn();
  const { mountEditor } = await import('../src/renderer/editor/editor.js');
  const { store } = await import('../src/renderer/state.js');
  const thought = makeThought();
  store.update({
    networkId: 'n1',
    focus: makeFocus(thought),
    thoughtTypes: [makeType('root', { is_root: true }), makeType('ta')],
    editorTarget: null,
    selectedLinkId: null,
    collapsedGroups: {},
  } as any);
  const host = new ShimElement('div');
  mountEditor(host as any);
  await flush();
  return { host, scrollBox: host.children[1]! };
}

/** Активная вкладка редактора (её подпись). */
function activeTabTitle(scrollBox: ShimElement): string {
  const active = scrollBox
    .querySelectorAll('.editor-tab')
    .find((tab) => tab.classList.contains('active'));
  assert.notEqual(active, undefined, 'в редакторе есть активная вкладка');
  return String(active!.textContent ?? '');
}

/** Строка выделенного свойства (класс `prop-row-current`) или null. */
function currentPropertyRow(scrollBox: ShimElement): ShimElement | null {
  return scrollBox.querySelector('.prop-row-current');
}

describe('переход к свойству из «Связей дня» (3054fe86)', () => {
  it('открывает вкладку «Свойства» и выделяет строку запрошенного свойства', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { setThoughtEditorTarget, pendingPropertyRevealFor } =
      await import('../src/renderer/editor/editor.js');
    // Исходно редактор на «Комментарии» — переход обязан сменить вкладку.
    assert.ok(
      activeTabTitle(scrollBox).includes('Основное'),
      'до перехода активна вкладка «Основное»',
    );

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p1',
    });
    await flush();

    assert.ok(
      activeTabTitle(scrollBox).includes('Свойства'),
      'переход активирует вкладку «Свойства»',
    );
    const row = currentPropertyRow(scrollBox);
    assert.notEqual(row, null, 'строка свойства выделена');
    // Ключ строки — id ПРИВЯЗКИ, а не property_id: переход нашёл строку по
    // реестровому id из факта (вердикт 4294f1f3).
    assert.equal(
      row!.getAttribute('data-key'),
      'binding-1',
      'выделена строка ЗАПРОШЕННОГО свойства (ключ — id привязки)',
    );
    assert.equal(pendingPropertyRevealFor('thought', 't1'), null, 'запрос снят показом строки');
  });

  it('находит строку свойства-связи по реестровому property_id', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p2',
    });
    await flush();

    const row = currentPropertyRow(scrollBox);
    assert.notEqual(row, null, 'строка свойства-связи выделена');
    assert.equal(
      row!.getAttribute('data-key'),
      'binding-2',
      'свойство-связь найдено по property_id при другом id привязки',
    );
  });

  it('раскрывает свёрнутую группу «Свойства типа» ради строки перехода', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { store } = await import('../src/renderer/state.js');
    // Пользователь свернул группу «Свойства типа» — её тело не строится,
    // поэтому переход обязан раскрыть группу, иначе строку не найти.
    store.update({ collapsedGroups: { 'properties.type': true } } as any);
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p1',
    });
    await flush();

    assert.equal(
      currentPropertyRow(scrollBox)?.getAttribute('data-key'),
      'binding-1',
      'строка найдена в раскрытой на время перехода группе',
    );
    assert.equal(
      store.state.collapsedGroups['properties.type'],
      true,
      'сохранённое предпочтение пользователя не переписано',
    );
  });

  it('повторный переход по тому же свойству снова показывает строку', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p1',
    });
    await flush();
    assert.notEqual(currentPropertyRow(scrollBox), null, 'первый переход показал строку');

    // Пользователь ушёл на другую вкладку и вернулся к «Свойствам» — строка
    // больше не текущая; повторный клик по подписи обязан выделить её снова.
    const mainTab = scrollBox
      .querySelectorAll('.editor-tab')
      .find((tab) => String(tab.textContent ?? '').includes('Основное'));
    mainTab!.emit('click', {});
    await flush();
    assert.equal(currentPropertyRow(scrollBox), null, 'после ухода строки нет в выделении');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p1',
    });
    await flush();
    assert.ok(activeTabTitle(scrollBox).includes('Свойства'));
    assert.equal(
      currentPropertyRow(scrollBox)?.getAttribute('data-key'),
      'binding-1',
      'повторный клик снова выделяет ту же строку',
    );
  });

  it('ручной выбор другой строки переносит выделение (не залипает)', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p1',
    });
    await flush();
    assert.equal(
      currentPropertyRow(scrollBox)?.getAttribute('data-key'),
      'binding-1',
      'переход выделил первую строку',
    );

    // Пользователь кликнул по другой строке таблицы: выделение переезжает на
    // неё единственным классом (механика списка), а не остаётся на прежней.
    const box = scrollBox.querySelector('.properties-type-body')!;
    const other = scrollBox
      .querySelectorAll('tr')
      .find((row) => row.getAttribute('data-key') === 'binding-2');
    assert.notEqual(other, undefined, 'вторая строка таблицы есть');
    box.emit('click', { target: other });
    await flush();

    assert.equal(
      currentPropertyRow(scrollBox)?.getAttribute('data-key'),
      'binding-2',
      'выделение перешло на выбранную строку',
    );
    assert.equal(
      scrollBox.querySelectorAll('.prop-row-current').length,
      1,
      'выделена ровно одна строка',
    );
  });

  it('не раскрывает типовую группу при переходе к внетиповому свойству', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { store } = await import('../src/renderer/state.js');
    // Свойства `p-out` в типе нет — строка живёт в группе «Свойства вне типа».
    const etnApi = (globalThis as any).window.etn as Record<string, any>;
    etnApi.types = { listTypeProperties: async () => [TEXT_PROPERTY] };
    etnApi.properties = {
      get: async () => [
        {
          property_id: 'p-out',
          property_name: 'дата приобретения',
          value_type: 'date',
          value: '2026-11-02',
          outside_type: true,
        },
      ],
    };
    store.update({ collapsedGroups: { 'properties.type': true } } as any);
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p-out',
    });
    await flush();

    // Типовая группа осталась свёрнутой — её тело даже не построено, поэтому
    // внетиповая группа не сжата (замечание к fa415304).
    assert.equal(
      scrollBox.querySelector('.properties-type-body'),
      null,
      'типовая группа не раскрыта ради внетипового свойства',
    );
    assert.notEqual(
      scrollBox.querySelector('.properties-outside-body'),
      null,
      'тело группы «Свойства вне типа» построено и не сжато',
    );
    assert.equal(
      currentPropertyRow(scrollBox)?.getAttribute('data-key'),
      'p-out',
      'внетиповая строка выделена',
    );
    assert.equal(
      store.state.collapsedGroups['properties.type'],
      true,
      'сохранённое предпочтение пользователя не переписано',
    );
  });

  it('раскрывает внетиповую группу, когда свёрнуты обе группы', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { store } = await import('../src/renderer/state.js');
    // Свойства `p-out` в типе нет, а пользователь свернул ОБЕ группы — ни одно
    // тело не построено. Переход обязан раскрыть именно внетиповую группу:
    // иначе строку не показать (замечание проверки 8894a5f8 — без этого кейса
    // ветка раскрытия вне-типа оставалась без сторожа).
    const etnApi = (globalThis as any).window.etn as Record<string, any>;
    etnApi.types = { listTypeProperties: async () => [TEXT_PROPERTY] };
    etnApi.properties = {
      get: async () => [
        {
          property_id: 'p-out',
          property_name: 'дата приобретения',
          value_type: 'date',
          value: '2026-11-02',
          outside_type: true,
        },
      ],
    };
    store.update({
      collapsedGroups: { 'properties.type': true, 'properties.outside': true },
    } as any);
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');

    await setThoughtEditorTarget(makeThought(), {
      tab: 'properties',
      revealPropertyId: 'p-out',
    });
    await flush();

    assert.equal(
      scrollBox.querySelector('.properties-type-body'),
      null,
      'типовая группа осталась свёрнутой (тело не построено)',
    );
    assert.notEqual(
      scrollBox.querySelector('.properties-outside-body'),
      null,
      'внетиповая группа раскрыта — тело построено',
    );
    assert.equal(
      currentPropertyRow(scrollBox)?.getAttribute('data-key'),
      'p-out',
      'внетиповая строка выделена в раскрытой группе',
    );
    // Раскрытие ради перехода не переписывает предпочтения пользователя.
    assert.equal(
      store.state.collapsedGroups['properties.type'],
      true,
      'типовая: свёрнуто сохранено',
    );
    assert.equal(
      store.state.collapsedGroups['properties.outside'],
      true,
      'внетиповая: свёрнуто сохранено',
    );
  });

  it('обычное открытие мысли вкладку не переключает', async () => {
    const { scrollBox } = await mountOpenEditor();
    const { setThoughtEditorTarget } = await import('../src/renderer/editor/editor.js');
    // Активная вкладка — состояние модуля редактора (общее для монтирований):
    // сначала явно встаём на «Основное», как это делает пользователь.
    const mainTab = scrollBox
      .querySelectorAll('.editor-tab')
      .find((tab) => String(tab.textContent ?? '').includes('Основное'));
    assert.notEqual(mainTab, undefined, 'вкладка «Основное» есть в полосе');
    mainTab!.emit('click', {});
    await flush();
    await setThoughtEditorTarget(makeThought());
    await flush();
    assert.ok(
      activeTabTitle(scrollBox).includes('Основное'),
      'клик по облачку (без опций) оставляет вкладку прежней',
    );
  });
});
