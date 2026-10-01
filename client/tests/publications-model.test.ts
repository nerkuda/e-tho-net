/**
 * Юнит-тесты чистой модели экрана «Публикации» (0.11.1, задача a3cfc018):
 * персональные настройки вида, заглушка обложки, разбиение по полкам.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Publication, Shelf } from '@etn/shared';

import {
  assemblyDateLabel,
  coverInitials,
  coverTone,
  COVER_TONES,
  defaultPublicationsViewState,
  groupByShelves,
  parsePublicationsViewState,
  serializePublicationsViewState,
} from '../src/renderer/screens/publications/model.js';

function publication(id: string, overrides: Partial<Publication> = {}): Publication {
  return {
    id,
    title: `Публикация ${id}`,
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
    created_by: 'user-1',
    updated_at: '2026-10-01T00:00:00.000Z',
    updated_by: 'user-1',
    ...overrides,
  };
}

function shelf(id: string, publicationIds: string[]): Shelf {
  return {
    id,
    title: `Полка ${id}`,
    position: 0,
    version: 1,
    marked_for_deletion: false,
    marked_for_deletion_at: null,
    marked_for_deletion_by: null,
    created_at: '',
    created_by: '',
    updated_at: '',
    updated_by: '',
    items: publicationIds.map((publicationId, index) => ({
      shelf_id: id,
      publication_id: publicationId,
      position: index + 1,
    })),
  };
}

describe('публикации: настройки вида (model)', () => {
  it('по умолчанию — вид «полки», ручная сортировка, только актуальные', () => {
    assert.deepEqual(defaultPublicationsViewState(), {
      viewMode: 'shelves',
      sort: 'manual',
      activeFilter: 'true',
      shelfFilter: null,
      query: '',
      filtersOpen: false,
    });
  });

  it('мусорный вход заменяется значениями по умолчанию, а не бросает', () => {
    assert.deepEqual(parsePublicationsViewState(null), defaultPublicationsViewState());
    assert.deepEqual(parsePublicationsViewState('не json'), defaultPublicationsViewState());
    assert.deepEqual(parsePublicationsViewState('42'), defaultPublicationsViewState());
  });

  it('валидные значения разбираются, неизвестные — отбрасываются', () => {
    const parsed = parsePublicationsViewState(
      JSON.stringify({
        viewMode: 'list',
        sort: 'title',
        activeFilter: 'any',
        shelfFilter: 'shelf-1',
        query: 'живые',
        filtersOpen: true,
        лишнее: 1,
      }),
    );
    assert.deepEqual(parsed, {
      viewMode: 'list',
      sort: 'title',
      activeFilter: 'any',
      shelfFilter: 'shelf-1',
      query: 'живые',
      filtersOpen: true,
    });
    const bad = parsePublicationsViewState(
      JSON.stringify({ viewMode: 'grid', sort: 'size', activeFilter: 'maybe', filtersOpen: 'yes' }),
    );
    assert.equal(bad.viewMode, 'shelves');
    assert.equal(bad.sort, 'manual');
    assert.equal(bad.activeFilter, 'true');
    assert.equal(bad.filtersOpen, false);
  });

  it('сериализация обратима', () => {
    const state = {
      viewMode: 'list' as const,
      sort: 'author' as const,
      activeFilter: 'false' as const,
      shelfFilter: null,
      query: '',
      filtersOpen: true,
    };
    assert.deepEqual(parsePublicationsViewState(serializePublicationsViewState(state)), state);
  });
});

describe('публикации: заглушка обложки (model)', () => {
  it('инициалы — до двух первых значимых слов', () => {
    assert.equal(coverInitials('Живые документы'), 'ЖД');
    assert.equal(coverInitials('Спецификация'), 'С');
    assert.equal(coverInitials('  ...  '), '?');
    assert.equal(coverInitials(''), '?');
  });

  it('тон детерминирован по id и лежит в палитре', () => {
    assert.deepEqual(coverTone('pub-1'), coverTone('pub-1'));
    assert.ok(COVER_TONES.includes(coverTone('pub-1')));
  });
});

describe('публикации: разбиение по полкам (model)', () => {
  it('раскладывает публикации по полкам, остаток — в «без полки»', () => {
    const pubs = [publication('p1'), publication('p2'), publication('p3')];
    const shelves = [shelf('s1', ['p2', 'p1']), shelf('s2', ['p3'])];
    const grouped = groupByShelves(pubs, shelves);
    assert.deepEqual(
      grouped.byShelf.map((g) => [g.shelf.id, g.items.map((p) => p.id)]),
      [
        ['s1', ['p2', 'p1']],
        ['s2', ['p3']],
      ],
    );
    assert.deepEqual(grouped.unshelved, []);
    assert.deepEqual(grouped.shelfIdsOf.get('p2'), ['s1']);
  });

  it('публикация вне полок попадает в остаток, порядок ответа сохраняется', () => {
    const pubs = [publication('p1'), publication('p2')];
    const grouped = groupByShelves(pubs, [shelf('s1', ['p2'])]);
    assert.deepEqual(grouped.unshelved.map((p) => p.id), ['p1']);
  });

  it('несуществующая на полке публикация пропускается', () => {
    const grouped = groupByShelves([publication('p1')], [shelf('s1', ['gone'])]);
    assert.deepEqual(grouped.byShelf[0]?.items, []);
  });
});

describe('публикации: дата сборки (model)', () => {
  it('пустое значение — пустая строка, ISO — локальная дата', () => {
    assert.equal(assemblyDateLabel(null), '');
    assert.equal(assemblyDateLabel(''), '');
    assert.equal(assemblyDateLabel('2026-10-01T12:00:00.000Z'), new Date('2026-10-01T12:00:00.000Z').toLocaleDateString('ru-RU'));
  });

  it('некорректная строка возвращается как есть', () => {
    assert.equal(assemblyDateLabel('не дата'), 'не дата');
  });
});
