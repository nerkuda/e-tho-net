/**
 * Поведение реактивности документа публикации (замечания 1/2/7 приёмки
 * b02ef1cf): подсветка «Пересобрать» зажигается от изменения мысли, ВХОДЯЩЕЙ в
 * текущую сборку, и не зажигается от посторонней; внешняя правка рецепта даёт
 * stale БЕЗ перечитывания состава; контентная правка обновляет шапку/титул без
 * чтения сборки.
 *
 * Живая рабочая область в DOM-шиме с подставным `window.etn` (считаем запросы
 * `publications.assembly`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Publication, PublicationAssembly } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { store } from '../src/renderer/state.js';

const NETWORK_ID = 'net-1';

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub-1',
    title: 'Документ',
    subtitle: null,
    summary_md: null,
    authorship: null,
    cover_attachment_id: null,
    cover_url: null,
    cover_kind: 'none',
    assembly_date: null,
    title_recipe: null,
    text_sources: [],
    extra_properties: [],
    numbering_from: null,
    numbering_to: null,
    active: true,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    version: 1,
    created_at: '2026-10-01T00:00:00.000Z',
    created_by: 'u',
    updated_at: '2026-10-01T00:00:00.000Z',
    updated_by: 'u',
    ...overrides,
  };
}

function assembly(): PublicationAssembly {
  return {
    publication: {
      title: 'Документ',
      subtitle: null,
      authorship: null,
      assembly_date: null,
      summary_html: '',
      cover: { kind: 'placeholder', ref: null },
      new_candidates: 0,
    },
    sections: [
      {
        thought_id: 'sec-1',
        node_key: 'sec-1',
        anchor: 'pub-sec1',
        level: 1,
        heading: 'Раздел',
        preamble_html: '<p>Начало</p>',
        texts: [],
        extra: [],
        flags: { repeat_of: null, cycle_cut: false },
        children: [],
      },
    ],
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: 1, has_more: false },
  };
}

let assemblyFetches = 0;

function installShim(): void {
  assemblyFetches = 0;
  const body = new ShimElement('body');
  const docListeners = new Map<string, Array<(event: any) => void>>();
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: (type: string, listener: (event: any) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push(listener);
      docListeners.set(type, list);
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  const win: Record<string, unknown> = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {
      ui: { getState: async () => null, setState: async () => undefined },
      publications: {
        get: async () => publication(),
        assembly: async () => {
          assemblyFetches += 1;
          return assembly();
        },
        rebuild: async () => publication(),
        candidates: async () => ({ items: [], total: 0, limit: 50, offset: 0, has_more: false }),
      },
      attachments: { get: async () => null },
      linkTypes: { list: async () => [] },
      admin: { listUsers: async () => [] },
    },
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: any) => globalThis.clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = win;
}

type WsModule = typeof import('../src/renderer/screens/publications/workspace.js');

async function mount(): Promise<{
  mod: WsModule;
  handle: ReturnType<WsModule['mountPublicationWorkspace']>;
  root: ShimElement;
}> {
  installShim();
  store.update({ networkId: NETWORK_ID });
  const host = new ShimElement('div');
  const mod = await import('../src/renderer/screens/publications/workspace.js');
  const handle = mod.mountPublicationWorkspace(host as unknown as HTMLElement, {
    onClose: () => undefined,
    onOpenCard: () => undefined,
    onExport: () => undefined,
  });
  await handle.open('pub-1');
  return { mod, handle, root: host };
}

const stale = (root: ShimElement): boolean =>
  root.findAll((el) => el.classList.contains('pub-ws-rebuild-stale')).length > 0;

const headerTitle = (root: ShimElement): string | null =>
  root.querySelector('.pub-ws-title')?.textContent ?? null;

describe('рабочая область публикации: реактивность состава и контента (b02ef1cf)', () => {
  let active: { destroy(): void } | null = null;
  afterEach(() => {
    active?.destroy();
    active = null;
  });

  it('stale от мысли В сборке, не от посторонней', async () => {
    const { handle, root } = await mount();
    active = handle;
    const fetchesAfterOpen = assemblyFetches;
    assert.equal(stale(root), false, 'свежее открытие без подсветки');

    // Посторонняя мысль — ничего.
    handle.applyThoughtRealtime('stranger');
    assert.equal(stale(root), false, 'посторонняя мысль не зажигает stale');
    assert.equal(assemblyFetches, fetchesAfterOpen, 'посторонняя мысль не перечитывает сборку');

    // Мысль раздела — stale и точечное перечитывание (дебаунс reload 200 мс).
    handle.applyThoughtRealtime('sec-1');
    assert.equal(stale(root), true, 'мысль в сборке зажигает stale');
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.ok(assemblyFetches > fetchesAfterOpen, 'мысль в сборке перечитывает документ');
  });

  it('внешняя правка рецепта → stale БЕЗ перечитывания состава', async () => {
    const { handle, root } = await mount();
    active = handle;
    const before = assemblyFetches;
    handle.applyPublicationPatch({ title_recipe: { parent_ids: ['x'], sort: 'updated', order: 'asc' } });
    assert.equal(stale(root), true, 'смена рецепта зажигает stale');
    assert.equal(assemblyFetches, before, 'состав НЕ перечитывается на лету');
  });

  it('контентная правка обновляет шапку без чтения сборки', async () => {
    const { handle, root } = await mount();
    active = handle;
    const before = assemblyFetches;
    handle.applyPublicationPatch({ title: 'Новое имя' });
    assert.equal(headerTitle(root), 'Новое имя', 'шапка обновлена точечно');
    assert.equal(stale(root), false, 'контентная правка не зажигает stale');
    assert.equal(assemblyFetches, before, 'контентная правка не читает сборку');
  });
});
