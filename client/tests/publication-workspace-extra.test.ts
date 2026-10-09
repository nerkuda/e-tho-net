/**
 * Регресс к ошибке 2dd51051 (ветка releases/0.12.1): блок «Дополнительные
 * материалы» в режиме чтения публикации обязан выводить подпись-имя
 * свойства-источника для КАЖДОЙ группы, иначе ссылки разных свойств сливаются
 * в один неотличимый список.
 *
 * Проба — живая рабочая область в DOM-шиме (тот же приём, что в
 * `publication-workspace-reactive.test.ts`): сборка с одним разделом и ДВУМЯ
 * группами доп. материалов; проверяем, что в DOM ровно один общий заголовок
 * «Дополнительные материалы» и разные подписи свойств, а ссылки сгруппированы по
 * своим свойствам. Ошибка была в рендере клиента (сервер DTO группирует верно).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Publication, PublicationAssembly } from '@etn/shared';

import { ShimElement } from './dom-shim.js';
import { store } from '../src/renderer/state.js';

const NETWORK_ID = 'net-1';

function publication(): Publication {
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
  };
}

/** Сборка: один раздел с двумя группами доп. материалов (разные свойства). */
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
        anchor: 'pub-sec-1',
        level: 1,
        heading: 'Раздел',
        preamble_html: '<p>Начало</p>',
        texts: [],
        extra: [
          { property: 'Зависит от', targets: [{ id: 't-1', title: 'Цель 1' }] },
          { property: 'Применяется к', targets: [{ id: 't-2', title: 'Цель 2' }] },
        ],
        flags: { repeat_of: null, cycle_cut: false },
        children: [],
      },
    ],
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: 1, has_more: false },
  };
}

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body,
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    etn: {
      ui: { getState: async () => null, setState: async () => undefined },
      publications: {
        get: async () => publication(),
        assembly: async () => assembly(),
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
}

describe('2dd51051: доп. материалы группируются по свойствам-источникам', () => {
  let active: { destroy(): void } | null = null;
  afterEach(() => {
    active?.destroy();
    active = null;
  });

  it('у каждой группы своя подпись-свойство; общий заголовок один', async () => {
    installShim();
    store.update({ networkId: NETWORK_ID });
    const root = new ShimElement('div');
    const mod = await import('../src/renderer/screens/publications/workspace.js');
    const handle = mod.mountPublicationWorkspace(root as unknown as HTMLElement, {
      onClose: () => undefined,
      onOpenCard: () => undefined,
      onExport: () => undefined,
      getTextWidth: () => 100,
      onTextWidthInput: () => undefined,
      onTextWidthChange: () => undefined,
    });
    active = handle;
    await handle.open('pub-1');

    const titles = root.findAll((el) => el.classList.contains('pub-doc-extra-title'));
    assert.equal(titles.length, 1, 'общий заголовок «Дополнительные материалы» — один');
    assert.equal(titles[0]?.textContent, 'Дополнительные материалы');

    const props = root
      .findAll((el) => el.classList.contains('pub-doc-extra-prop'))
      .map((el) => el.textContent);
    assert.deepEqual(
      props,
      ['Зависит от', 'Применяется к'],
      'подписи-имена свойств идут по группам в порядке рецепта',
    );

    // Ссылки сгруппированы по своим свойствам: у каждой группы свой список.
    const lists = root.findAll((el) => el.classList.contains('pub-doc-extra-list'));
    assert.equal(lists.length, 2, 'на каждое свойство — свой список целей');
    const perGroup = lists.map((list) =>
      list.findAll((el) => el.classList.contains('pub-doc-extra-link')).map((el) => el.textContent),
    );
    assert.deepEqual(perGroup, [['Цель 1'], ['Цель 2']], 'цели не смешаны между свойствами');
  });
});
