/**
 * Открытие публикации на странице/якоре и порционный живой поиск публикаций
 * (0.11.1, задача 3275fd8d).
 *
 *  - `resolveOpenPage` — чистая модель выбора страницы рабочей области;
 *  - `loadPublicationOptions` — offset/limit уходят в `GET /publications`,
 *    ответ отображается в варианты пикера.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Publication } from '@etn/shared';

import { resolveOpenPage } from '../src/renderer/screens/publications/workspace.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function publication(id: string, title: string): Publication {
  return {
    id,
    title,
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

describe('resolveOpenPage — страница открытия рабочей области (2ebacd12)', () => {
  it('целевая страница > 1 побеждает (переход из «Упоминаний»)', () => {
    assert.equal(resolveOpenPage(5, true, { page: 3 }), 3);
    assert.equal(resolveOpenPage(1, false, { page: 2 }), 2);
  });

  it('та же публикация без цели сохраняет текущую страницу', () => {
    assert.equal(resolveOpenPage(4, true), 4);
    assert.equal(resolveOpenPage(4, true, { page: 1 }), 4);
  });

  it('другая публикация без цели открывается с первой', () => {
    assert.equal(resolveOpenPage(4, false), 1);
    assert.equal(resolveOpenPage(2, false, { page: 1 }), 1);
  });
});

describe('loadPublicationOptions — порционный источник пикера', () => {
  it('передаёт limit/offset/q и отображает items в варианты', async () => {
    const calls: Array<Record<string, unknown>> = [];
    (globalThis as any).window = {
      etn: {
        publications: {
          list: async (_n: string, query: Record<string, unknown>) => {
            calls.push(query);
            return { items: [publication('p1', 'Первая')], total: 51 };
          },
        },
      },
    };
    const { loadPublicationOptions, PUBLICATIONS_PAGE_SIZE } = await import(
      '../src/renderer/lib/entity-picker.js'
    );
    const page2 = await loadPublicationOptions('net', 'отч', PUBLICATIONS_PAGE_SIZE);
    assert.deepEqual(calls[0], {
      q: 'отч',
      limit: PUBLICATIONS_PAGE_SIZE,
      offset: PUBLICATIONS_PAGE_SIZE,
    });
    assert.equal(page2[0]?.id, 'p1');
    assert.equal(page2[0]?.title, 'Первая');

    await loadPublicationOptions('net', '   ');
    assert.deepEqual(calls[1], { limit: PUBLICATIONS_PAGE_SIZE, offset: 0 });
  });
});
