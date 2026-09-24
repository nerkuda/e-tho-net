/**
 * Снятие значения свойства-связи без диалога (задача 0d4f793a, 0.8.3).
 *
 * Проверяем модель: чистый отбор id рёбер ({@link pickRemovedLinkIds}), режим по
 * модификатору клика ({@link removalModeForClick}) и исполнение
 * {@link removeLinkValueEdges} на фальшивом `window.etn` —
 * - `auto`: возможность удаления спрашивается у `links.deletionCheck`; свободные
 *   рёбра удаляются совсем (свежие значения → запись → purge); заблокированные,
 *   не найденные или непроверяемые — в корзину;
 * - `trash`: сразу корзина, без обращений к проверке и purge;
 * - модальный диалог не открывается ни в одном случае, итог — всплывашкой.
 *
 * Дом — минимальный шим (конвенция `dialog-wrappers-cancel.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShimElement } from './dom-shim.js';

interface Call {
  method: string;
  args: unknown[];
}

/** Fake `window.etn`: пишет вызовы, значения/проверку отдаёт из опций. */
function fakeEtn(opts: {
  purged?: number;
  linkValues?: unknown[];
  getThrows?: boolean;
  checkThrows?: boolean;
  blocked?: boolean;
}): { calls: Call[]; api: any } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]): unknown => {
      calls.push({ method, args });
      if (method === 'properties.get') {
        if (opts.getThrows === true) return Promise.reject(new Error('boom'));
        return opts.linkValues ?? [];
      }
      if (method === 'links.deletionCheck') {
        if (opts.checkThrows === true) return Promise.reject(new Error('boom'));
        const ids = args[1] as string[];
        const out: Record<string, unknown> = {};
        for (const id of ids) out[id] = { blocked: opts.blocked === true, blocking: { layers: [] } };
        return out;
      }
      if (method === 'trash.purge') {
        return { purged: opts.purged ?? 0, skipped: 0 };
      }
      return {};
    };
  const api = {
    properties: { get: record('properties.get') },
    links: { deletionCheck: record('links.deletionCheck') },
    trash: { purge: record('trash.purge') },
  };
  return { calls, api };
}

function installShim(): void {
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
    setTimeout: (fn: () => void) => {
      void fn;
      return 0;
    },
    clearTimeout: () => undefined,
  };
}

installShim();

const { pickRemovedLinkIds, removalModeForClick, removeLinkValueEdges } = await import(
  '../src/renderer/editor/link-value-removal.js'
);

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Тексты показанных всплывашек (все `.notice .notice-text`). */
function notices(): string[] {
  const out: string[] = [];
  for (const box of body().children) {
    if (!box.classList.contains('notice')) continue;
    for (const span of box.children) {
      if (span.classList.contains('notice-text')) out.push(span.textContent ?? '');
    }
  }
  return out;
}

/** `LinkPropertyValues`-образная запись с рёбрами `[targetId, linkId]`. */
function linkEntry(
  propertyId: string,
  propertyName: string,
  edges: Array<[string, string]>,
): unknown {
  return {
    property_id: propertyId,
    property_name: propertyName,
    count: edges.length,
    values: edges.map(([target_id, link_id]) => ({ target_id, link_id })),
  };
}

/** Опции снятия одного ребра; `commit` считает вызовы в `state`. */
function removal(
  api: any,
  mode: 'auto' | 'trash',
  state: { committed: number },
  commitOk = true,
): Parameters<typeof removeLinkValueEdges>[0] {
  (globalThis as any).window.etn = api;
  return {
    networkId: 'net1',
    ownerType: 'thought',
    ownerId: 'th1',
    propertyKey: 'Родители',
    propertyId: 'p1',
    removedTargetIds: ['t1'],
    mode,
    commit: async () => {
      state.committed += 1;
      return commitOk;
    },
  };
}

describe('pickRemovedLinkIds (96d27fc0)', () => {
  it('находит рёбра реестрового свойства по property_id', () => {
    const values = [
      { value_type: 'text', value: 'x' }, // скаляр — пропускается
      linkEntry('prop-1', 'Родители', [['t1', 'l1'], ['t2', 'l2']]),
      linkEntry('prop-2', 'Потомки', [['t3', 'l3']]),
    ];
    assert.deepEqual(
      pickRemovedLinkIds(values, { propertyKey: 'Родители', propertyId: 'prop-1' }, ['t2', 't3']),
      ['l2'],
    );
  });

  it('находит внетиповое ребро по property_name, когда id пуст', () => {
    const values = [linkEntry('', 'Цели', [['t1', 'l1']])];
    assert.deepEqual(
      pickRemovedLinkIds(values, { propertyKey: 'Цели', propertyId: '' }, ['t1']),
      ['l1'],
    );
  });

  it('схлопывает дубли и пропускает пустые link_id', () => {
    const values = [
      linkEntry('p', 'A', [['t1', 'l1'], ['t1', 'l1'], ['t2', '']]),
    ];
    assert.deepEqual(pickRemovedLinkIds(values, { propertyKey: 'A', propertyId: 'p' }, ['t1', 't2']), [
      'l1',
    ]);
  });

  it('не трогает цели, которых нет в списке снятия', () => {
    const values = [linkEntry('p', 'A', [['t1', 'l1'], ['t5', 'l5']])];
    assert.deepEqual(pickRemovedLinkIds(values, { propertyKey: 'A', propertyId: 'p' }, ['t1']), ['l1']);
  });
});

describe('removalModeForClick (0d4f793a)', () => {
  it('Shift — принудительная корзина, без Shift — авто-выбор', () => {
    assert.equal(removalModeForClick(true), 'trash');
    assert.equal(removalModeForClick(false), 'auto');
  });
});

describe('removeLinkValueEdges (0d4f793a)', () => {
  it('auto, ребро свободно: запись + purge, всплывашка «Связь удалена.», без диалога', async () => {
    installShim();
    const { calls, api } = fakeEtn({
      purged: 1,
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'auto', state));
    assert.equal(ok, true);
    assert.equal(state.committed, 1, 'значение записано');
    assert.deepEqual(
      calls.map((c) => c.method),
      ['properties.get', 'links.deletionCheck', 'trash.purge'],
      'свежие значения, проверка, затем purge',
    );
    assert.deepEqual(calls[2]!.args, ['net1', ['l1']], 'purge получает id ребра');
    assert.deepEqual(notices(), ['Связь удалена.']);
    assert.equal(
      body().querySelectorAll('.dialog-backdrop').length,
      0,
      'модального диалога нет',
    );
  });

  it('auto, ребро заблокировано: только запись (корзина), без purge', async () => {
    installShim();
    const { calls, api } = fakeEtn({
      blocked: true,
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'auto', state));
    assert.equal(ok, true);
    assert.equal(state.committed, 1);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['properties.get', 'links.deletionCheck'],
      'purge не зовётся',
    );
    assert.deepEqual(notices(), ['Связь помещена в корзину.']);
  });

  it('auto, id рёбер не нашлись: корзина, purge не зовётся', async () => {
    installShim();
    const { calls, api } = fakeEtn({ linkValues: [] });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'auto', state));
    assert.equal(ok, true);
    assert.deepEqual(calls.map((c) => c.method), ['properties.get']);
    assert.deepEqual(notices(), ['Связь помещена в корзину.']);
  });

  it('auto, проверка недоступна: безопасный выбор — корзина', async () => {
    installShim();
    const { calls, api } = fakeEtn({
      checkThrows: true,
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'auto', state));
    assert.equal(ok, true);
    assert.deepEqual(calls.map((c) => c.method), ['properties.get', 'links.deletionCheck']);
    assert.deepEqual(notices(), ['Связь помещена в корзину.']);
  });

  it('trash (Shift/меню): всегда корзина, без проверки и purge', async () => {
    installShim();
    const { calls, api } = fakeEtn({ purged: 1 });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'trash', state));
    assert.equal(ok, true);
    assert.equal(state.committed, 1);
    assert.deepEqual(calls, [], 'никаких обращений к серверу');
    assert.deepEqual(notices(), ['Связь помещена в корзину.']);
  });

  it('неудачная запись: false, purge не запускается и всплывашки нет', async () => {
    installShim();
    const { calls, api } = fakeEtn({
      purged: 1,
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'auto', state, false));
    assert.equal(ok, false);
    assert.deepEqual(calls.map((c) => c.method), ['properties.get', 'links.deletionCheck']);
    assert.deepEqual(notices(), []);
  });

  it('auto, purge не удалил ребро (гонка): сообщаем о блокировке, true', async () => {
    installShim();
    const { api } = fakeEtn({
      purged: 0,
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    const state = { committed: 0 };
    const ok = await removeLinkValueEdges(removal(api, 'auto', state));
    assert.equal(ok, true);
    assert.deepEqual(notices(), ['Часть связей заблокирована и осталась в корзине.']);
  });
});
