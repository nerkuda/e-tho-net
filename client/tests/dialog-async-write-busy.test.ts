/**
 * busy на время асинхронной записи в диалогах (ошибка ef89c5c8 «У диалогов с
 * асинхронной записью нет busy — двойной клик дублирует запись»).
 *
 * Контракт (08-ui-spec.md, панель кнопок: на busy все кнопки disabled):
 *  - пока обработчик ждёт ответ сервера, кнопки футера отключены;
 *  - второй клик не запускает вторую операцию — ни в DOM (кнопка disabled), ни
 *    в обработчике (флаг), потому что программный `click()` по disabled-кнопке
 *    в тестовом DOM-шиме доходит до слушателя;
 *  - после ответа состояние восстанавливается: успех закрывает диалог, ошибка
 *    оставляет открытым с активными кнопками и текстом ошибки.
 *
 * Тест монтирует НАСТОЯЩИЕ диалоги под общим DOM-шимом (jsdom в проекте нет) и
 * кликает кнопки футера поддельным `window.etn`. Запись «сервера» управляется
 * гейтом: тест сам решает, когда ответить.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement as ShimEl } from './dom-shim.js';

// ---------------------------------------------------------------------------
// DOM-шим: хватает пути «диалог → showDialog → клик по футеру».
// ---------------------------------------------------------------------------

/** `<vaadin-grid>` шима: методы вендорского Grid, нужные фасаду таблицы. */
function gridElement(tag: string): ShimEl {
  const grid = new ShimEl(tag);
  const carrier = grid as any;
  carrier.clearCache = () => undefined;
  carrier.generateCellPartNames = () => undefined;
  carrier.scrollToIndex = () => undefined;
  carrier.getEventContext = () => null;
  return grid;
}

function shimDom(): void {
  const doc: any = {
    createElement: (tag: string) => (tag === 'vaadin-grid' ? gridElement(tag) : new ShimEl(tag)),
    createElementNS: (_ns: string, tag: string) => new ShimEl(tag),
    body: new ShimEl('body'),
    documentElement: new ShimEl('html'),
    head: new ShimEl('head'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
  };
  (globalThis as any).document = doc;
  const win: any = ((globalThis as any).window ??= {});
  win.document = doc;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.matchMedia = () => ({ matches: false, addEventListener: () => undefined });
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  win.requestAnimationFrame = (cb: any) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: any) => clearTimeout(id);
  win.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  if ((globalThis as any).navigator === undefined) {
    (globalThis as any).navigator = { userAgent: 'node', language: 'ru' };
  }
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

shimDom();

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Чистое окружение: новый DOM-шим и пустой стек диалогов. */
async function resetDialogs(): Promise<void> {
  shimDom();
  const { closeDialog } = await import('../src/renderer/lib/dialog.js');
  for (let i = 0; i < 20; i += 1) closeDialog();
}

function body(): ShimEl {
  return (globalThis as any).document.body as ShimEl;
}

/** Все подложки открытых диалогов (нижняя первая). */
function backdrops(): ShimEl[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

/** Верхний (текущий) диалог. */
function topDialog(): ShimEl {
  const dialogs = backdrops();
  assert.ok(dialogs.length > 0, 'диалог открыт');
  return dialogs[dialogs.length - 1]!;
}

/** Кнопка по подписи в диалоге. */
function button(root: ShimEl, label: string): ShimEl {
  const btn = root.findAll((n) => n.tagName === 'button' && n.textContent === label)[0];
  assert.ok(btn !== undefined, `кнопка «${label}» есть в диалоге`);
  return btn!;
}

/** Первое текстовое поле диалога. */
function firstInput(root: ShimEl): ShimEl {
  const input = root.findAll((n) => n.tagName === 'input')[0];
  assert.ok(input !== undefined, 'в диалоге есть поле ввода');
  return input!;
}

/** Промис, которым тест управляет ответом «сервера». */
function gate<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Словарь подписей кнопок — тест не держит литералы. */
async function labels(): Promise<{
  cancel: string;
  create: string;
  apply: string;
  deleteForever: string;
  execute: string;
}> {
  const { t } = await import('../src/renderer/lib/i18n.js');
  return {
    cancel: t('actions.cancel'),
    create: t('admin.label.create'),
    apply: t('actions.apply'),
    deleteForever: t('actions.deleteForever'),
    execute: t('layerMerge.label.vypolnit'),
  };
}

// ---------------------------------------------------------------------------
// Создание мыслесети (screens/networks.ts) — одноразовая операция.
// ---------------------------------------------------------------------------

describe('busy: создание мыслесети (ef89c5c8)', () => {
  it('двойной клик — один POST, кнопки гаснут, после ошибки оживают', async () => {
    await resetDialogs();
    const L = await labels();
    const server = gate<any>();
    let creates = 0;
    (globalThis as any).window.etn = {
      networks: {
        create: async () => {
          creates += 1;
          return server.promise;
        },
      },
    };

    const { showCreateNetworkDialog } = await import('../src/renderer/screens/networks.js');
    void showCreateNetworkDialog();
    await tick(60);

    const root = topDialog();
    firstInput(root).value = 'Сеть пробы';
    const createBtn = button(root, L.create);
    createBtn.fire('click', {});
    // Вторая половина двойного клика: запрос уже в полёте.
    createBtn.fire('click', {});
    await tick(30);

    assert.equal(creates, 1, 'второй клик не запустил второй POST /networks');
    assert.equal(createBtn.disabled, true, '«Создать» отключена на время запроса');
    assert.equal(button(root, L.cancel).disabled, true, '«Отмена» отключена на время запроса');
    assert.equal(backdrops().length, 1, 'диалог открыт: ответа ещё нет');

    server.reject(new Error('сервер отказал'));
    await tick(80);

    assert.equal(creates, 1, 'запись была одна');
    assert.equal(createBtn.disabled, false, 'после ошибки создание можно повторить');
    assert.equal(button(root, L.cancel).disabled, false, '«Отмена» снова активна');
    assert.ok(topDialog().flatText().includes('сервер отказал'), 'текст ошибки в футере');
  });
});

// ---------------------------------------------------------------------------
// Создание публикации (screens/publications/wizard.ts).
// ---------------------------------------------------------------------------

describe('busy: создание публикации (ef89c5c8)', () => {
  it('двойной клик — один POST, кнопки гаснут, успех закрывает диалог', async () => {
    await resetDialogs();
    const L = await labels();
    const server = gate<any>();
    let creates = 0;
    (globalThis as any).window.etn = {
      publications: {
        create: async () => {
          creates += 1;
          return server.promise;
        },
      },
    };
    const { store } = await import('../src/renderer/state.js');
    store.update({ networkId: 'n1', activeTabId: 'tab-1' });

    const { openPublicationWizard } =
      await import('../src/renderer/screens/publications/wizard.js');
    openPublicationWizard({ onCreated: () => undefined });
    await tick(40);

    const root = topDialog();
    firstInput(root).value = 'Публикация пробы';
    const createBtn = button(root, L.create);
    createBtn.fire('click', {});
    createBtn.fire('click', {});
    await tick(30);

    assert.equal(creates, 1, 'второй клик не запустил второй POST публикации');
    assert.equal(createBtn.disabled, true, '«Создать» отключена на время запроса');
    assert.equal(button(root, L.cancel).disabled, true, '«Отмена» отключена на время запроса');

    server.resolve({ id: 'pub-1', title: 'Публикация пробы' });
    await tick(80);

    assert.equal(backdrops().length, 0, 'успех закрывает мастер');
  });
});

// ---------------------------------------------------------------------------
// Удаление сущности (lib/delete-dialog.ts): второй запрос давал 404.
// ---------------------------------------------------------------------------

describe('busy: диалог удаления сущности (ef89c5c8)', () => {
  it('двойной клик по «Удалить совсем» — одно действие, кнопки гаснут и оживают после ошибки', async () => {
    await resetDialogs();
    const L = await labels();
    const server = gate<void>();
    let purges = 0;
    const { openEntityDeleteDialog } = await import('../src/renderer/lib/delete-dialog.js');
    openEntityDeleteDialog({
      title: 'Удалить мысль',
      blocked: false,
      alreadyMarked: false,
      onPurge: () => {
        purges += 1;
        return server.promise;
      },
      onTrash: () => undefined,
    });
    await tick(30);

    const root = topDialog();
    const purgeBtn = button(root, L.deleteForever);
    purgeBtn.fire('click', {});
    purgeBtn.fire('click', {});
    await tick(30);

    assert.equal(purges, 1, 'второй клик не запустил второе удаление');
    assert.equal(purgeBtn.disabled, true, '«Удалить совсем» отключена на время запроса');
    assert.equal(button(root, L.cancel).disabled, true, '«Отмена» отключена на время запроса');

    server.reject(new Error('404'));
    await tick(60);

    assert.equal(purges, 1, 'удаление было одно');
    assert.equal(backdrops().length, 1, 'ошибка не закрывает диалог');
    assert.equal(purgeBtn.disabled, false, 'после ошибки удаление можно повторить');
    assert.equal(button(root, L.cancel).disabled, false, '«Отмена» снова активна');
  });
});

// ---------------------------------------------------------------------------
// Пакетное удаление из корзины (trash.ts).
// ---------------------------------------------------------------------------

describe('busy: пакетное удаление/очистка корзины (ef89c5c8)', () => {
  it('двойной клик по «Применить» — один пакетный запрос, кнопки гаснут', async () => {
    await resetDialogs();
    const L = await labels();
    const server = gate<any>();
    let batches = 0;
    (globalThis as any).window.etn = {
      thoughts: {
        deletionCheck: async () => ({
          t1: { blocked: false, blocking: { properties: 0, layers: [] }, orphaned_children: 0 },
        }),
        resolve: async () => [{ id: 't1', title: 'Мысль 1' }],
        batch: async () => {
          batches += 1;
          return server.promise;
        },
      },
    };
    const { openThoughtGroupDeleteDialog } = await import('../src/renderer/trash.js');
    void openThoughtGroupDeleteDialog('n1', ['t1']);
    await tick(80);

    const root = topDialog();
    const applyBtn = button(root, L.apply);
    applyBtn.fire('click', {});
    applyBtn.fire('click', {});
    await tick(30);

    assert.equal(batches, 1, 'второй клик не запустил второй пакетный запрос');
    assert.equal(applyBtn.disabled, true, '«Применить» отключена на время запроса');
    assert.equal(button(root, L.cancel).disabled, true, '«Отмена» отключена на время запроса');

    server.reject(new Error('сервер отказал'));
    await tick(80);

    assert.equal(batches, 1, 'пакетный запрос был один');
    assert.equal(applyBtn.disabled, false, 'после ошибки операцию можно повторить');
    assert.equal(button(root, L.cancel).disabled, false, '«Отмена» снова активна');
  });
});

// ---------------------------------------------------------------------------
// Слияние слоёв (screens/layer-thought-merge.ts).
// ---------------------------------------------------------------------------

describe('busy: слияние изменений мысли (ef89c5c8)', () => {
  it('двойной клик по «Выполнить» — одно слияние, кнопки гаснут', async () => {
    await resetDialogs();
    const L = await labels();
    const server = gate<any>();
    let merges = 0;
    (globalThis as any).window.etn = {
      layers: {
        thoughtDiff: async (_n: string, _l: string, thoughtId: string) => ({
          layer: { id: 'l1', title: 'Правки' },
          target_layer: { id: 'base', title: 'Основа' },
          thought_id: thoughtId,
          title: 'Мысль',
          kind: 'changed',
          fields: [
            { key: 'title', target: 'Мысль', layer: 'Мысль', changed: false },
            { key: 'comment', target: 'A', layer: 'A', changed: false },
          ],
        }),
        mergeThought: async () => {
          merges += 1;
          return server.promise;
        },
        discardThought: async () => {
          merges += 1;
          return server.promise;
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
    const { store } = await import('../src/renderer/state.js');
    store.update({
      layers: [
        { id: 'base', title: 'Основа', parent_id: null, is_base: true, depth: 0 } as any,
        { id: 'l1', title: 'Правки', parent_id: 'base', is_base: false, depth: 1 } as any,
      ],
      currentLayer: { id: 'l1', title: 'Правки' },
      layerOverrides: { thought_ids: ['t1'], link_ids: [] },
    });

    const { openThoughtMergeDialog } =
      await import('../src/renderer/screens/layer-thought-merge.js');
    openThoughtMergeDialog('n1', 't1', 'Мысль');
    await tick(120);

    const root = topDialog();
    const applyBtn = button(root, L.execute);
    applyBtn.fire('click', {});
    applyBtn.fire('click', {});
    await tick(40);

    assert.equal(merges, 1, 'второй клик не запустил второе слияние');
    assert.equal(applyBtn.disabled, true, '«Выполнить» отключена на время запроса');
    assert.equal(button(root, L.cancel).disabled, true, '«Отмена» отключена на время запроса');

    server.resolve({
      applied: { thoughts: 1 },
      skipped: [],
      reorder_collapsed: [],
      reserve_layer_id: null,
      purged: 0,
      activity_rollup: { groups: 0, removed: 0 },
      thought_merge: {
        thought_id: 't1',
        mode: 'overwrite',
        comment_merged: false,
        comment_conflicts: 0,
      },
    });
    await tick(80);

    assert.equal(backdrops().length, 0, 'успех закрывает диалог слияния');
  });
});
