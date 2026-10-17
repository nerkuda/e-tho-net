/**
 * Значение-токен `$user` в поле «Автор записи» (задача 347b307e, арбитраж
 * 2026-10-14) — КЛИЕНТСКАЯ сторона.
 *
 * Предопределённый набор «Мои записи за неделю» несёт `record_author eq $user`.
 * Поле автора должно ПОКАЗАТЬ этот токен отдельным пунктом «текущий
 * пользователь ($user)» и НЕ заводить фантомного участника `$user` в кэше
 * пользователей (иначе токен всплыл бы фальшивым пользователем во всех полях
 * авторства). Значение из пикера по-прежнему скаляр-id.
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import type { FilterTreeLeaf, FilterTreeNode } from '../src/renderer/lib/filter-builder.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

installShim();
(globalThis as any).window.etn = {
  admin: { listUsers: async () => [] },
  propertyRegistry: { list: async () => [] },
};

const users = await import('../src/renderer/lib/users.js');
const mod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');

const DATA = { registry: new Map(), linkTypes: [] as any[], thoughtTypes: [] as any[] };

describe('значение-токен $user в поле автора записи (клиентская сторона)', () => {
  it('поле автора показывает пункт-токен и не заводит фантомного участника', async () => {
    users.__resetForTests();
    const tree: FilterTreeNode = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'leaf',
          entity: { kind: 'record_author' } as FilterTreeLeaf['entity'],
          operator: 'eq',
          value: { kind: 'token', token: '$user' },
        },
      ],
    };
    const state = builder.defaultFilterCriteriaState();
    state.tree = tree;
    const handle = mod.buildFilterEditor({
      profile: 'chronicle',
      networkId: 'net-1',
      data: DATA,
      getState: () => state,
      host: { apply: () => undefined, save: () => undefined, reset: () => undefined },
    });
    const root = handle.root as unknown as ShimElement;

    const select = root.findAll((n) => n.tagName.toUpperCase() === 'SELECT')[0]!;
    const values = select.children
      .filter((child) => child.tagName.toUpperCase() === 'OPTION')
      .map((option) => option.value);
    assert.ok(values.includes('$user'), 'пункт-токен $user присутствует');
    assert.equal(select.value, '$user', 'токен выбран в поле');

    // Кэш не отравлен: фантомного участника «$user» нет.
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      !users.listUsers().some((u) => u.id === '$user'),
      'фантомный участник $user в кэш не попал',
    );
  });
});
