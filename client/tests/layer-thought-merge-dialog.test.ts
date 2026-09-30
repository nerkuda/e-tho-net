/**
 * Клиентские тесты диалога разрешения изменений мысли слоя (задача f5c363a3):
 *
 *   * набор вариантов: мысль с изменившимся постоянным комментарием → три
 *     («Отказаться» / «Переписать» / «Объединить»), не-мысль (правки лишь в
 *     связях/свойствах/синонимах) → два;
 *   * выбранный вариант доводит операцию до конца через мост
 *     (`layers.mergeThought` / `layers.discardThought`);
 *   * «Отказаться от изменений» сначала требует подтверждения.
 *
 * Окружение — общий DOM-шим (`dom-shim.ts`), `window.etn` подменён моками.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

interface MergeCall {
  thoughtId: string;
  mode: string;
}
interface DiscardCall {
  thoughtId: string;
}

const mergeCalls: MergeCall[] = [];
const discardCalls: DiscardCall[] = [];

/** Комментарий-дифф: `changed` и наличие основы в комментарии решают 3-й вариант. */
let commentField = { key: 'comment' as const, target: 'строка A\nстрока B', layer: 'строка A\nстрока C', changed: true };

function installShim(): void {
  mergeCalls.length = 0;
  discardCalls.length = 0;
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // Таймеры каркаса/обновления перекрытий — no-op, тест синхронный.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
}

installShim();

const etnMock = {
  layers: {
    thoughtDiff: async (_networkId: string, _layerId: string, thoughtId: string) => ({
      layer: { id: 'l1', title: 'Правки' },
      target_layer: { id: 'base', title: 'Основа' },
      thought_id: thoughtId,
      title: 'Мысль',
      kind: 'changed' as const,
      fields: [
        { key: 'title' as const, target: 'Мысль', layer: 'Мысль', changed: false },
        commentField,
      ],
    }),
    mergeThought: async (_n: string, _l: string, thoughtId: string, mode: string) => {
      mergeCalls.push({ thoughtId, mode });
      return {
        applied: { thoughts: 1 },
        skipped: [],
        reorder_collapsed: [],
        reserve_layer_id: null,
        purged: 0,
        activity_rollup: { groups: 0, removed: 0 },
        thought_merge: { thought_id: thoughtId, mode, comment_merged: false, comment_conflicts: 0 },
      };
    },
    discardThought: async (_n: string, _l: string, thoughtId: string) => {
      discardCalls.push({ thoughtId });
      return {
        layer: { id: 'l1', title: 'Правки' },
        target_layer: { id: 'base', title: 'Основа' },
        thought_id: thoughtId,
        discarded: { comments: 1 },
        total: 1,
      };
    },
    diff: async () => ({
      layer: { id: 'l1', title: 'Правки' },
      target_layer: { id: 'base', title: 'Основа' },
      links: {
        added: [],
        removed: [],
        type_changed: [],
        reorder_collapsed: [],
        reparented: [],
      },
      overridden: { thought_ids: [], link_ids: [] },
    }),
  },
};

(globalThis as any).window.etn = etnMock;

const { store } = await import('../src/renderer/state.js');
const { closeDialog } = await import('../src/renderer/lib/dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');
const { availableMergeVariants, openThoughtMergeDialog, openMergeDialog } = await import(
  '../src/renderer/screens/layer-thought-merge.js'
);

store.update({
  layers: [
    { id: 'base', title: 'Основа', parent_id: null, is_base: true, depth: 0 } as any,
    { id: 'l1', title: 'Правки', parent_id: 'base', is_base: false, depth: 1 } as any,
  ],
  currentLayer: { id: 'l1', title: 'Правки' },
  layerOverrides: { thought_ids: ['t1', 't2'], link_ids: [] },
});

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function findAllByClass(root: ShimElement, cls: string): ShimElement[] {
  const out: ShimElement[] = [];
  if (root.classList.contains(cls)) out.push(root);
  for (const child of root.children) out.push(...findAllByClass(child, cls));
  return out;
}

function openBackdrop(): ShimElement {
  const backdrops = body().children.filter((c) => c.classList.contains('dialog-backdrop'));
  assert.ok(backdrops.length > 0, 'диалог смонтирован');
  return backdrops[backdrops.length - 1]!;
}

function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = findAllByClass(backdrop, 'ui-btn')
    .filter((b) => !b.classList.contains('ui-btn--icon'))
    .find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в футере есть кнопка «${label}»`);
  return btn!;
}

/** Радиокнопки вариантов в теле диалога. */
function variantInputs(backdrop: ShimElement): ShimElement[] {
  return findAllByClass(backdrop, 'ui-choice-row')
    .map((row) => row.querySelector('input'))
    .filter((input): input is ShimElement => input !== null);
}

function closeAllDialogs(): void {
  while (body().querySelector('.dialog-backdrop') !== null) closeDialog();
}

describe('диалог разрешения изменений мысли (f5c363a3)', () => {
  it('набор вариантов: мысль с комментарием → три, не-мысль → два', () => {
    assert.deepEqual(
      availableMergeVariants({ commentChanged: true, targetCommentPresent: true }),
      ['discard', 'overwrite', 'combine'],
    );
    assert.deepEqual(
      availableMergeVariants({ commentChanged: false, targetCommentPresent: true }),
      ['discard', 'overwrite'],
    );
    assert.deepEqual(
      availableMergeVariants({ commentChanged: true, targetCommentPresent: false }),
      ['discard', 'overwrite'],
    );
  });

  it('мысль с изменившимся комментарием: три радиокнопки, «Объединить» присутствует', async () => {
    commentField = {
      key: 'comment',
      target: 'строка A\nстрока B',
      layer: 'строка A\nстрока C',
      changed: true,
    };
    openThoughtMergeDialog('net', 't1', 'Мысль t1');
    await flush();
    await flush();
    try {
      const inputs = variantInputs(openBackdrop());
      assert.deepEqual(
        inputs.map((i) => i.value),
        ['discard', 'overwrite', 'combine'],
      );
    } finally {
      closeAllDialogs();
    }
  });

  it('не-мысль (комментарий не изменён): только «Отказаться» и «Переписать»', async () => {
    commentField = { key: 'comment', target: 'строка A', layer: 'строка A', changed: false };
    openThoughtMergeDialog('net', 't2', 'Мысль t2');
    await flush();
    await flush();
    try {
      const inputs = variantInputs(openBackdrop());
      assert.deepEqual(
        inputs.map((i) => i.value),
        ['discard', 'overwrite'],
      );
    } finally {
      closeAllDialogs();
    }
  });

  it('вариант «переписать» доводит операцию до моста', async () => {
    commentField = { key: 'comment', target: '', layer: 'x', changed: false };
    mergeCalls.length = 0;
    openThoughtMergeDialog('net', 't1', 'Мысль t1');
    await flush();
    await flush();
    const backdrop = openBackdrop();
    footerButton(backdrop, 'Выполнить').click();
    await flush();
    await flush();
    assert.deepEqual(mergeCalls, [{ thoughtId: 't1', mode: 'overwrite' }]);
    closeAllDialogs();
  });

  it('«Отказаться от изменений» требует подтверждения и зовёт discard', async () => {
    commentField = { key: 'comment', target: '', layer: 'x', changed: false };
    discardCalls.length = 0;
    mergeCalls.length = 0;
    openMergeDialog('net', [{ id: 't1', title: 'Мысль t1' }]);
    await flush();
    await flush();
    let backdrop = openBackdrop();
    const discardInput = variantInputs(backdrop).find((i) => i.value === 'discard')!;
    discardInput.checked = true;
    discardInput.emit('change', {});
    footerButton(backdrop, 'Выполнить').click();
    await flush();
    await flush();
    // Появился диалог подтверждения — подтверждаем.
    backdrop = openBackdrop();
    footerButton(backdrop, t('actions.confirm')).click();
    await flush();
    await flush();
    assert.deepEqual(discardCalls, [{ thoughtId: 't1' }]);
    assert.equal(mergeCalls.length, 0);
    closeAllDialogs();
  });
});

describe('точки входа «слить в основу» (f5c363a3)', () => {
  const target = { id: 't1', title: 'Мысль', dir: 'siblings' } as const;

  it('контекстное меню мысли: команда есть в слое, но не в основе и не без перекрытия', async () => {
    const { menuInternals } = await import('../src/renderer/canvas/context-menu.js');
    store.update({
      networkId: 'net',
      currentLayer: { id: 'l1', title: 'Правки' } as any,
      layerOverrides: { thought_ids: ['t1'], link_ids: [] },
    });
    let labels = menuInternals.buildThoughtMenuItems('net', target).map((i: any) => i.label);
    assert.ok(labels.includes('Слить мысль в основу…'), 'в слое команда есть');

    store.update({ layerOverrides: { thought_ids: [], link_ids: [] } });
    labels = menuInternals.buildThoughtMenuItems('net', target).map((i: any) => i.label);
    assert.ok(!labels.includes('Слить мысль в основу…'), 'без перекрытия команды нет');

    store.update({
      currentLayer: { id: BASE_LAYER_ID, title: 'Основа' } as any,
      layerOverrides: { thought_ids: ['t1'], link_ids: [] },
    });
    labels = menuInternals.buildThoughtMenuItems('net', target).map((i: any) => i.label);
    assert.ok(!labels.includes('Слить мысль в основу…'), 'в основе команды нет');
  });

  it('меню «Действия» панели выделения: пункт активен только при перекрытых выбранных', async () => {
    const { selectionMenuInternals } = await import('../src/renderer/selection/selection.js');
    store.update({
      currentLayer: { id: 'l1', title: 'Правки' } as any,
      layerOverrides: { thought_ids: ['t1'], link_ids: [] },
      selection: ['t1', 't2'],
    });
    let row = selectionMenuInternals
      .buildActionsMenu()
      .find((i: any) => i.label === 'Слить в основу…');
    assert.ok(row !== undefined, 'пункт есть в меню «Действия»');
    assert.notEqual(row!.disabled, true, 'активен при перекрытой выбранной мысли');

    store.update({ layerOverrides: { thought_ids: [], link_ids: [] } });
    row = selectionMenuInternals
      .buildActionsMenu()
      .find((i: any) => i.label === 'Слить в основу…');
    assert.equal(row!.disabled, true, 'неактивен без перекрытых выбранных');
  });
});
