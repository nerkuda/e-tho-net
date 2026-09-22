/**
 * Диалог снятия значения свойства-связи: «В корзину» / «Удалить совсем»
 * (задача 96d27fc0, 0.8.2).
 *
 * Проверяем модель выбора: чистый отбор id рёбер ({@link pickRemovedLinkIds}) и
 * исполнение выбора {@link removeLinkValueEdges} на фальшивом `window.etn` —
 * «В корзину» пишет значение без purge, «Удалить совсем» сначала берёт id
 * рёбер из свежих значений, пишет значение (сервер помечает), затем точечный
 * purge; отмена не пишет вовсе.
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

/** Fake `window.etn`: пишет вызовы, значения отдаёт из `linkValues`. */
function fakeEtn(opts: {
  purged?: number;
  linkValues?: unknown[];
  getThrows?: boolean;
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
      if (method === 'trash.purge') {
        return { purged: opts.purged ?? 0, skipped: 0 };
      }
      return {};
    };
  const api = {
    properties: { get: record('properties.get') },
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

const { pickRemovedLinkIds, removeLinkValueEdges } = await import(
  '../src/renderer/editor/link-value-removal.js'
);

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

function clickFooter(label: string): void {
  const backdrop = body().children.find((c) => c.classList.contains('dialog-backdrop'));
  assert.ok(backdrop !== undefined, 'диалог смонтирован');
  const btn = backdrop
    .querySelectorAll('button')
    .find((b) => b.textContent === label);
  assert.ok(btn !== undefined, `в футере есть кнопка «${label}»`);
  btn!.emit('click');
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

describe('removeLinkValueEdges (96d27fc0)', () => {
  it('«В корзину»: пишет значение, не зовёт properties.get и не purges', async () => {
    installShim();
    const { calls, api } = fakeEtn({});
    (globalThis as any).window.etn = api;
    let committed = 0;
    const p = removeLinkValueEdges({
      networkId: 'net1',
      ownerType: 'thought',
      ownerId: 'th1',
      propertyKey: 'Родители',
      propertyId: 'p1',
      removedTargetIds: ['t1'],
      commit: async () => {
        committed += 1;
        return true;
      },
    });
    clickFooter('В корзину');
    assert.equal(await p, true);
    assert.equal(committed, 1, 'значение записано');
    assert.deepEqual(calls, [], 'в корзину — без обращений к серверу');
  });

  it('«Удалить совсем»: id рёбер берутся до записи, затем точечный purge', async () => {
    installShim();
    const { calls, api } = fakeEtn({
      purged: 1,
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    (globalThis as any).window.etn = api;
    const p = removeLinkValueEdges({
      networkId: 'net1',
      ownerType: 'thought',
      ownerId: 'th1',
      propertyKey: 'Родители',
      propertyId: 'p1',
      removedTargetIds: ['t1'],
      commit: async () => true,
    });
    clickFooter('Удалить совсем');
    assert.equal(await p, true);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['properties.get', 'trash.purge'],
      'сначала свежие значения, потом purge',
    );
    assert.deepEqual(calls[1]!.args, ['net1', ['l1']], 'purge получает id ребра');
  });

  it('отмена («Отмена») не пишет значение', async () => {
    installShim();
    const { api } = fakeEtn({});
    (globalThis as any).window.etn = api;
    let committed = 0;
    const p = removeLinkValueEdges({
      networkId: 'net1',
      ownerType: 'thought',
      ownerId: 'th1',
      propertyKey: 'Родители',
      propertyId: 'p1',
      removedTargetIds: ['t1'],
      commit: async () => {
        committed += 1;
        return true;
      },
    });
    clickFooter('Отмена');
    assert.equal(await p, false, 'отмена — false');
    assert.equal(committed, 0, 'значение не тронуто');
  });

  it('«Удалить совсем» без найденных рёбер: значение помечено, purge не зовётся', async () => {
    installShim();
    const { calls, api } = fakeEtn({ linkValues: [] });
    (globalThis as any).window.etn = api;
    const p = removeLinkValueEdges({
      networkId: 'net1',
      ownerType: 'thought',
      ownerId: 'th1',
      propertyKey: 'Родители',
      propertyId: 'p1',
      removedTargetIds: ['t1'],
      commit: async () => true,
    });
    clickFooter('Удалить совсем');
    assert.equal(await p, true);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['properties.get'],
      'purge не зовётся, рёбра остались в корзине',
    );
  });

  it('неудачная запись возвращает false (purge не запускается)', async () => {
    installShim();
    const { calls, api } = fakeEtn({
      linkValues: [linkEntry('p1', 'Родители', [['t1', 'l1']])],
    });
    (globalThis as any).window.etn = api;
    const p = removeLinkValueEdges({
      networkId: 'net1',
      ownerType: 'thought',
      ownerId: 'th1',
      propertyKey: 'Родители',
      propertyId: 'p1',
      removedTargetIds: ['t1'],
      commit: async () => false,
    });
    clickFooter('Удалить совсем');
    assert.equal(await p, false);
    assert.deepEqual(calls.map((c) => c.method), ['properties.get'], 'commit упал — purge не зовётся');
  });
});
