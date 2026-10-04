/**
 * Вариант-публикация общего пикера сущностей (0.11.1, задача 3275fd8d,
 * элемент интерфейса 9626efb6): пятый источник `publications` — подпись
 * названием, живой поиск по подзаголовку/автору, мини-обложка в облачке
 * (вложение через `etnimg`, внешний URL — как есть, иначе глиф).
 *
 * Чистые помощники — без DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Publication } from '@etn/shared';

import {
  publicationCoverUrl,
  publicationEntityOption,
  publicationEntityOptions,
} from '../src/renderer/lib/entity-picker.js';

/** Минимальная публикация (поля, которые читает вариант). */
function pub(overrides: Partial<Publication> = {}): Publication {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Отчёт',
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

describe('публикация как вариант пикера (9626efb6)', () => {
  it('обложка-вложение отдаётся через протокол etnimg', () => {
    const p = pub({
      cover_kind: 'attachment',
      cover_attachment_id: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(
      publicationCoverUrl(p),
      'etnimg://attachment/22222222-2222-4222-8222-222222222222',
    );
  });

  it('внешняя обложка-URL отдаётся как есть; заглушка — null', () => {
    assert.equal(
      publicationCoverUrl(pub({ cover_kind: 'url', cover_url: 'https://x/y.png' })),
      'https://x/y.png',
    );
    assert.equal(publicationCoverUrl(pub({ cover_kind: 'none' })), null);
  });

  it('облачко варианта: название + картинка-обложка при наличии', () => {
    const opt = publicationEntityOption(
      pub({ title: 'Сборка', cover_kind: 'url', cover_url: 'https://x/y.png' }),
    );
    assert.equal(opt.id, '11111111-1111-4111-8111-111111111111');
    assert.equal(opt.title, 'Сборка');
    assert.equal(opt.selectable, true);
    assert.deepEqual(opt.cloud, {
      id: opt.id,
      title: 'Сборка',
      icon: 'https://x/y.png',
      icon_kind: 'image',
    });
  });

  it('без обложки — глиф-книга; подзаголовок и автор идут в поиск', () => {
    const opt = publicationEntityOption(
      pub({ subtitle: 'Подзаголовок', authorship: 'Автор' }),
    );
    assert.equal(opt.cloud?.icon_kind, 'emoji');
    assert.equal(opt.cloud?.icon, '📄');
    assert.equal(opt.searchText, 'Подзаголовок Автор');
  });

  it('публикации без подзаголовка/автора не несут лишнего searchText', () => {
    const opt = publicationEntityOption(pub());
    assert.equal(opt.searchText, undefined);
  });

  it('список публикаций — по варианту на каждую, порядок сохраняется', () => {
    const options = publicationEntityOptions([
      pub({ id: 'a' }),
      pub({ id: 'b', title: 'Вторая' }),
    ]);
    assert.deepEqual(
      options.map((o) => o.id),
      ['a', 'b'],
    );
    assert.equal(options[1]?.title, 'Вторая');
  });
});
