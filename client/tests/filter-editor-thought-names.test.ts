/**
 * Имена мыслей во фразе-превью редактора отбора (ошибка d17a8bfd, требование
 * 9d5e3c4e).
 *
 * Кэш имён мыслей (`lib/thought-names.ts`) наполняется батчем
 * `etn.thoughts.resolve` ВНЕ чистого композера, а фраза ПОДПИСАНА на его
 * наполнение: пока имя неизвестно — плейсхолдер без ID, как только батч
 * вернулся — имя, и фраза перерисовывается САМА (без действий пользователя).
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

/** Мысль, чьё имя вернёт `resolve`; остальные id останутся неизвестными. */
const KNOWN_ID = '56ce57bd-1111-4222-8333-444444444444';
const KNOWN_TITLE = 'Бюджет на квартал';
const UNKNOWN_ID = '11111111-2222-4333-8444-555555555555';

/** Запросы `thoughts.resolve` за время теста: `[networkId, ids]`. */
const resolveCalls: Array<{ networkId: string; ids: string[] }> = [];

function mockEtn(): void {
  (globalThis as any).window.etn = {
    thoughts: {
      resolve: async (networkId: string, ids: string[]) => {
        resolveCalls.push({ networkId, ids: [...ids] });
        return ids
          .filter((id) => id === KNOWN_ID)
          .map((id) => ({ id, title: KNOWN_TITLE, type_id: null, icon: null, icon_kind: 'emoji' }));
      },
    },
    propertyRegistry: { list: async () => [] },
    admin: { listUsers: async () => [] },
  };
}

mockEtn();

const thoughtNames = await import('../src/renderer/lib/thought-names.js');
// Кэш чист на старте файла; подписка фразы на наполнение оформляется при первой
// сборке редактора (одна на модуль) — сбрасывать кэш внутри тестов нельзя, иначе
// потеряется слушатель.
thoughtNames.__resetForTests();

const mod = await import('../src/renderer/lib/filter-editor.js');
const builder = await import('../src/renderer/lib/filter-builder.js');

const DATA = { registry: new Map(), linkTypes: [] as any[], thoughtTypes: [] as any[] };

function buildEditor(tree: FilterTreeNode): { root: ShimElement } {
  const state = builder.defaultFilterCriteriaState();
  state.tree = tree;
  const handle = mod.buildFilterEditor({
    profile: 'thoughts',
    networkId: 'net-1',
    data: DATA,
    getState: () => state,
    host: { apply: () => undefined, save: () => undefined, reset: () => undefined },
  });
  return { root: handle.root as unknown as ShimElement };
}

/** Дерево с одним условием «Мысль = <id>». */
function idTree(id: string): FilterTreeNode {
  return {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'leaf',
        entity: { kind: 'id' } as FilterTreeLeaf['entity'],
        operator: 'eq',
        value: { kind: 'scalar', value: id },
      },
    ],
  };
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

describe('фраза-превью и имена мыслей (ошибка d17a8bfd)', () => {
  it('холодный кэш → плейсхолдер без ID; после resolve фраза показывает имя сама', async () => {
    const { root } = buildEditor(idTree(KNOWN_ID));

    const cold = previewText(root);
    assert.ok(cold.length > 0, 'фраза построена');
    assert.match(cold, /без названия/, 'холодный кэш — нейтральный плейсхолдер');
    assert.ok(!cold.includes('56ce57bd'), 'во фразе нет фрагмента id мысли');

    await flush();
    assert.match(previewText(root), /Бюджет на квартал/, 'имя появилось без действий пользователя');
    assert.ok(!previewText(root).includes('без названия'), 'плейсхолдер заменён именем');

    // Догрузка шла батчем по id из определения отбора.
    assert.ok(
      resolveCalls.some((call) => call.networkId === 'net-1' && call.ids.includes(KNOWN_ID)),
      'resolve запросил имя мысли из определения',
    );
  });

  it('неизвестная мысль — плейсхолдер вместо UUID в любом состоянии', async () => {
    const { root } = buildEditor(idTree(UNKNOWN_ID));
    const cold = previewText(root);
    assert.match(cold, /без названия/);
    assert.ok(!cold.includes('11111111'), 'в фразе нет UUID неизвестной мысли');
    await flush();
    assert.match(previewText(root), /без названия/, 'имя не пришло — плейсхолдер остаётся');
    assert.ok(!previewText(root).includes('11111111'), 'UUID не просачивается и после resolve');
  });
});
