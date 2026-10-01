/**
 * Клиентские тесты диалога отличий слоя (задача 52c776f1):
 *
 *   * состояние загрузки сразу после открытия (прелоадер), список — по
 *     готовности первой страницы;
 *   * постраничная подгрузка при прокрутке (`layers.diffPage` + `next_cursor`)
 *     без запроса полного отчёта и `diff/doc`;
 *   * инкрементальный рендер списка (keyed-сверка: дозагрузка не пересобирает
 *     уже отрисованные строки);
 *   * секции отличий с заголовками-счётчиками.
 *
 * Окружение — общий DOM-шим (`dom-shim.ts`), `window.etn` подменён моками
 * моста. Тест держит контракт «одна лёгкая выборка на страницу».
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LayerDiffPage } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

interface DiffPageCall {
  layerId: string;
  limit?: number;
  cursor?: string | null;
}

const diffPageCalls: DiffPageCall[] = [];

/** Один ответ страницы diff по фикстуре. */
function page(overrides: Partial<LayerDiffPage>): LayerDiffPage {
  return {
    layer: { id: 'l1', title: 'Правки' },
    target_layer: { id: 'base', title: 'Основа' },
    sections: [],
    counts: {
      'links.added': 0,
      'links.removed': 0,
      'links.type_changed': 0,
      'links.reorder_collapsed': 0,
      'links.reparented': 0,
      'overridden.thought_ids': 0,
      'overridden.link_ids': 0,
    },
    links: {},
    overridden: {},
    limit: 1,
    truncated: false,
    reason: null,
    next_cursor: null,
    ...overrides,
  };
}

function installShim(): void {
  diffPageCalls.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

installShim();

const first = page({
  counts: {
    'links.added': 2,
    'links.removed': 1,
    'links.type_changed': 0,
    'links.reorder_collapsed': 0,
    'links.reparented': 0,
    'overridden.thought_ids': 1,
    'overridden.link_ids': 0,
  },
  links: {
    added: [{ id: 'link-a', source_id: 't1', target_id: 't2', type_id: null, position: 0 }],
    removed: [],
    type_changed: [],
    reorder_collapsed: [],
    reparented: [],
  },
  overridden: { thought_ids: ['t3'], link_ids: [] },
  truncated: true,
  reason: 'has_more',
  next_cursor: 'cursor-1',
});

const second = page({
  counts: {
    'links.added': 2,
    'links.removed': 1,
    'links.type_changed': 0,
    'links.reorder_collapsed': 0,
    'links.reparented': 0,
    'overridden.thought_ids': 1,
    'overridden.link_ids': 0,
  },
  links: {
    added: [{ id: 'link-b', source_id: 't2', target_id: 't4', type_id: null, position: 0 }],
    removed: [{ id: 'link-c', source_id: 't1', target_id: 't5', type_id: null, position: 0 }],
    type_changed: [],
    reorder_collapsed: [],
    reparented: [],
  },
  overridden: { thought_ids: [], link_ids: [] },
  truncated: false,
  reason: null,
  next_cursor: null,
});

// Мост: только то, что диалог вправе звать. Ни `diff`, ни `diffDoc` тут нет —
// обращение к ним сломало бы тест (и это тот самый запрет из задачи).
const etnMock = {
  layers: {
    diffPage: async (networkId: string, layerId: string, options?: DiffPageCall) => {
      diffPageCalls.push({ layerId, ...(options ?? {}) });
      void networkId;
      return options?.cursor === 'cursor-1' ? second : first;
    },
    thoughtDiff: async (_networkId: string, _layerId: string, thoughtId: string) => ({
      layer: { id: 'l1', title: 'Правки' },
      target_layer: { id: 'base', title: 'Основа' },
      thought_id: thoughtId,
      title: 'Мысль t3',
      kind: 'changed' as const,
      fields: [
        { key: 'title' as const, target: 'Мысль t3', layer: 'Мысль t3', changed: false },
        { key: 'comment' as const, target: 'строка A\nстрока B', layer: 'строка A\nстрока C', changed: true },
      ],
    }),
  },
  thoughts: {
    resolve: async (_networkId: string, ids: string[]) =>
      ids.map((id) => ({ id, title: `Мысль ${id}` })),
  },
};

(globalThis as any).window.etn = etnMock;

const { store } = await import('../src/renderer/state.js');
const { closeDialog } = await import('../src/renderer/lib/dialog.js');
const { openDiffDialog } = await import('../src/renderer/screens/layers.js');

store.update({
  layers: [
    { id: 'base', title: 'Основа', parent_id: null, is_base: true, depth: 0 } as any,
    { id: 'l1', title: 'Правки', parent_id: 'base', is_base: false, depth: 1 } as any,
  ],
});

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Закрыть всю стопку диалогов, оставшуюся после теста. */
function closeAllDialogs(): void {
  while (body().querySelector('.dialog-backdrop') !== null) closeDialog();
}

describe('diff dialog: загрузка и подгрузка (52c776f1)', () => {
  it('сначала прелоадер, затем строки первой страницы; прокрутка догружает следующую', async () => {
    diffPageCalls.length = 0;
    await openDiffDialog('net', 'l1');
    try {
      const scrollBox = body().querySelector('.dialog-body');
      assert.ok(scrollBox !== null, 'тело диалога смонтировано');
      const stateHost = scrollBox!.querySelector('.diff-state')!;
      const listHost = scrollBox!.querySelector('.diff-list')!;

      // Пока страница в полёте — единый индикатор загрузки (требование 1).
      assert.ok(
        stateHost.querySelector('.ui-state-loading') !== null,
        'до ответа показан прелоадер',
      );

      await flush();
      await flush();

      // Первая страница запрошена как ЛЁГКАЯ (с limit), без полного отчёта.
      assert.equal(diffPageCalls.length, 1);
      assert.deepEqual(diffPageCalls[0], { layerId: 'l1', limit: 100, cursor: null });
      assert.equal(stateHost.children.length, 0, 'прелоадер снят после первой страницы');

      // Заголовки секций с общими счётчиками + строки.
      const headers = listHost.querySelectorAll('.diff-group-title').map((h) => h.textContent);
      assert.deepEqual(headers, ['Добавленные связи · 2', 'Изменённые мысли · 1']);
      const rows = listHost.querySelectorAll('.diff-row');
      assert.deepEqual(
        rows.map((r) => r.textContent),
        ['+ Мысль t1 → Мысль t2', 'Мысль t3'],
      );
      // Мысль кликабельна (открывает текстовый дифф), связь — нет.
      const thoughtRow = rows[1]!;
      assert.ok(thoughtRow.classList.contains('diff-row-thought'));
      assert.equal(rows[0]!.classList.contains('diff-row-thought'), false);

      const rowNode = rows[0]!;

      // Прокрутка до конца догружает вторую страницу по курсору.
      scrollBox!.scrollHeight = 1000;
      scrollBox!.clientHeight = 200;
      scrollBox!.scrollTop = 900;
      scrollBox!.emit('scroll');
      await flush();
      await flush();

      assert.equal(diffPageCalls.length, 2);
      assert.deepEqual(diffPageCalls[1], { layerId: 'l1', limit: 100, cursor: 'cursor-1' });

      const allRows = listHost.querySelectorAll('.diff-row');
      assert.deepEqual(
        allRows.map((r) => r.textContent),
        [
          '+ Мысль t1 → Мысль t2',
          '+ Мысль t2 → Мысль t4',
          '− Мысль t1 → Мысль t5',
          'Мысль t3',
        ],
      );
      assert.equal(allRows[0], rowNode, 'ранее отрисованная строка сохранила identity (keyed)');
      assert.deepEqual(
        listHost.querySelectorAll('.diff-group-title').map((h) => h.textContent),
        ['Добавленные связи · 2', 'Удалённые связи · 1', 'Изменённые мысли · 1'],
      );

      // Курсор исчерпан — дальнейшие прокрутки страниц не запрашивают.
      scrollBox!.emit('scroll');
      await flush();
      assert.equal(diffPageCalls.length, 2);
    } finally {
      closeAllDialogs();
    }
    assert.equal(body().querySelector('.dialog-backdrop'), null, 'диалог закрыт');
  });

  it('клик по изменённой мысли открывает отдельный диалог построчного диффа', async () => {
    diffPageCalls.length = 0;
    await openDiffDialog('net', 'l1');
    try {
      await flush();
      await flush();
      const listHost = body().querySelector('.diff-list')!;
      const thoughtRow = listHost
        .querySelectorAll('.diff-row')
        .find((r) => r.classList.contains('diff-row-thought'));
      assert.ok(thoughtRow, 'в списке есть кликабельная строка мысли');

      thoughtRow!.click();
      await flush();
      await flush();

      const backdrops = body().querySelectorAll('.dialog-backdrop');
      assert.equal(backdrops.length, 2, 'текстовый дифф — отдельный диалог поверх списка');
      const top = backdrops[1]!;
      assert.equal(top.querySelector('.dialog-title')!.textContent, 'Правки мысли «Мысль t3»');
      // Показан только изменившийся атрибут — постоянный комментарий, построчно.
      assert.deepEqual(
        top.querySelectorAll('.diff-group-title').map((h) => h.textContent),
        ['Постоянный комментарий'],
      );
      const lines = top.querySelectorAll('.diff-line');
      assert.deepEqual(
        lines.map((l) => `${l.className.includes('diff-del') ? '-' : l.className.includes('diff-add') ? '+' : ' '}${l.textContent}`),
        [' строка A', '-строка B', '+строка C'],
      );
    } finally {
      closeAllDialogs();
    }
    assert.equal(body().querySelector('.dialog-backdrop'), null);
  });

  it('пустой отчёт показывает пустое состояние, а не бесконечную загрузку', async () => {
    diffPageCalls.length = 0;
    const empty = page({ truncated: false, next_cursor: null });
    const original = (globalThis as any).window.etn.layers.diffPage;
    (globalThis as any).window.etn.layers.diffPage = async () => empty;
    try {
      await openDiffDialog('net', 'l1');
      await flush();
      await flush();
      const scrollBox = body().querySelector('.dialog-body')!;
      const stateHost = scrollBox.querySelector('.diff-state')!;
      assert.ok(stateHost.querySelector('.ui-empty') !== null, 'пустое состояние показано');
      assert.equal(scrollBox.querySelectorAll('.diff-row').length, 0);
    } finally {
      (globalThis as any).window.etn.layers.diffPage = original;
      closeAllDialogs();
    }
  });
});
