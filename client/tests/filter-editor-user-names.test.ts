/**
 * Имена пользователей в редакторе отбора (довесок 7 части 6, задача 347b307e).
 *
 * Холодный кэш имён: фраза-превью показывает имя пользователя по id, а кэш
 * участников наполняется best-effort. Пока кэш холодный — id; когда ростер
 * придёт, фраза ПЕРЕРИСОВЫВАЕТСЯ (подписка), а не «застывает» на id.
 *
 * Клиентская сторона значения-токена `$user` в «Авторе записи» — в
 * `filter-user-token.test.ts`.
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

/** Мок пользователей (ростер). */
const USER = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  username: 'bob',
  display_name: 'Борис',
  is_admin: false,
  is_first_user: false,
  disabled: false,
  created_at: '',
  updated_at: '',
};

function mockEtn(listUsers: () => Promise<unknown[]>): void {
  (globalThis as any).window.etn = {
    admin: { listUsers: async () => listUsers() },
    propertyRegistry: { list: async () => [] },
  };
}

mockEtn(async () => [USER]);

const users = await import('../src/renderer/lib/users.js');
const mod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');

const DATA = { registry: new Map(), linkTypes: [] as any[], thoughtTypes: [] as any[] };

function buildEditor(profile: 'thoughts' | 'chronicle', tree: FilterTreeNode): any {
  const state = builder.defaultFilterCriteriaState();
  state.tree = tree;
  return mod.buildFilterEditor({
    profile,
    networkId: 'net-1',
    data: DATA,
    getState: () => state,
    host: { apply: () => undefined, save: () => undefined, reset: () => undefined },
  });
}

/** Текст фразы-превью. */
function previewText(root: ShimElement): string {
  return root.findAll((n) => n.classList.contains('ff-preview__text'))[0]?.flatText() ?? '';
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('фраза-превью и имена пользователей (довесок 7)', () => {
  it('холодный кэш → плейсхолдер без ID; после наполнения ростера фраза показывает имя', async () => {
    users.__resetForTests();
    mockEtn(async () => [USER]);
    const tree: FilterTreeNode = {
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'leaf',
          entity: { kind: 'author' } as FilterTreeLeaf['entity'],
          operator: 'eq',
          value: { kind: 'scalar', value: USER.id },
        },
      ],
    };
    const handle = buildEditor('thoughts', tree);
    const root = handle.root as unknown as ShimElement;

    const cold = previewText(root);
    assert.ok(cold.length > 0, 'фраза построена');
    assert.ok(!cold.includes('Борис'), 'пока кэш холодный — имени нет');
    // ID в подписях недопустим (требование 9d5e3c4e): холодный кэш даёт
    // нейтральный плейсхолдер, а не обрезанный UUID участника.
    assert.ok(!cold.includes(USER.id.slice(0, 8)), 'во фразе нет фрагмента id участника');
    assert.match(cold, /без имени|неизвестный участник/, 'нейтральный плейсхолдер вместо id');

    await flush();
    assert.match(previewText(root), /Борис/, 'после наполнения кэша фраза показывает имя');
    assert.ok(!/без имени|неизвестный участник/.test(previewText(root)), 'плейсхолдер заменён именем');
  });
});
