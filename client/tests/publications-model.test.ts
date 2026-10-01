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
  dedupePropertyOptions,
  defaultPublicationsViewState,
  groupByShelves,
  parsePublicationsViewState,
  serializePublicationsViewState,
  shelfSwapUpdates,
} from '../src/renderer/screens/publications/model.js';
import type { EntityOption } from '../src/renderer/lib/entity-picker.js';

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

// --- Перестановка внутри полки (вкладка «Полки и статус») -------------------

type ShelfItem = { shelf_id: string; publication_id: string; position: number };

function items(...pairs: Array<[string, number]>): ShelfItem[] {
  return pairs.map(([publication_id, position]) => ({
    shelf_id: 's1',
    publication_id,
    position,
  }));
}

/** Видимый порядок: сортировка по `position` (как сервер и список). */
function visibleOrder(list: readonly ShelfItem[]): string[] {
  return [...list]
    .sort((a, b) => a.position - b.position)
    .map((item) => item.publication_id);
}

/** Применить правки порядка к составу (как это сделает сервер по ключу). */
function applyUpdates(list: readonly ShelfItem[], updates: Array<{ publication_id: string; position: number }>): ShelfItem[] {
  return list.map((item) => {
    const found = updates.find((u) => u.publication_id === item.publication_id);
    return found === undefined ? item : { ...item, position: found.position };
  });
}

describe('публикации: перестановка внутри полки (model)', () => {
  it('«A вниз» обменивает позиции A и B — видимый порядок меняется', () => {
    const list = items(['A', 1], ['B', 2], ['C', 3]);
    const updates = shelfSwapUpdates(list, 'A', 1);
    assert.deepEqual(updates, [
      { publication_id: 'A', position: 2 },
      { publication_id: 'B', position: 1 },
    ]);
    assert.deepEqual(visibleOrder(applyUpdates(list, updates!)), ['B', 'A', 'C']);
  });

  it('«C вверх» обменивает позиции C и B', () => {
    const list = items(['A', 1], ['B', 2], ['C', 3]);
    const updates = shelfSwapUpdates(list, 'C', -1);
    assert.deepEqual(updates, [
      { publication_id: 'C', position: 2 },
      { publication_id: 'B', position: 3 },
    ]);
    assert.deepEqual(visibleOrder(applyUpdates(list, updates!)), ['A', 'C', 'B']);
  });

  it('повторные перемещения продолжают двигать публикацию', () => {
    let list = items(['A', 1], ['B', 2], ['C', 3]);
    for (let i = 0; i < 2; i += 1) {
      const updates = shelfSwapUpdates(list, 'A', 1);
      assert.notEqual(updates, null);
      list = applyUpdates(list, updates!);
    }
    assert.deepEqual(visibleOrder(list), ['B', 'C', 'A']);
  });

  it('границы и неизвестная публикация — переставлять нечего', () => {
    const list = items(['A', 1], ['B', 2]);
    assert.equal(shelfSwapUpdates(list, 'A', -1), null);
    assert.equal(shelfSwapUpdates(list, 'B', 1), null);
    assert.equal(shelfSwapUpdates(list, 'X', 1), null);
  });

  it('при исходно равных позициях обмен возвращает те же позиции (видимый порядок не меняется)', () => {
    const list = items(['A', 2], ['B', 2], ['C', 3]);
    const updates = shelfSwapUpdates(list, 'A', 1);
    assert.deepEqual(updates, [
      { publication_id: 'A', position: 2 },
      { publication_id: 'B', position: 2 },
    ]);
  });
});

// --- Варианты свойств-связей без дублей -------------------------------------

describe('публикации: варианты свойств без дублей (model)', () => {
  it('две стороны одной связи сводятся к одному id, предпочитается source', () => {
    const options: EntityOption[] = [
      { id: 'p1:target', title: 'Обратное имя', linkProperty: { propertyId: 'p1', side: 'target', key: 'x' } },
      { id: 'p1:source', title: 'Прямое имя', linkProperty: { propertyId: 'p1', side: 'source', key: 'x' } },
      { id: 'p2:source', title: 'Другая связь', linkProperty: { propertyId: 'p2', side: 'source', key: 'y' } },
    ];
    const deduped = dedupePropertyOptions(options);
    assert.deepEqual(deduped.map((o) => o.id), ['p1', 'p2']);
    assert.equal(deduped[0]?.title, 'Прямое имя');
  });

  it('одиночные свойства и структурные (без linkProperty) не дублируются', () => {
    const options: EntityOption[] = [
      { id: 'p1', title: 'Одна' },
      { id: 'p1', title: 'Одна повторно' },
      { id: 'p2', title: 'Две' },
    ];
    assert.deepEqual(dedupePropertyOptions(options).map((o) => o.id), ['p1', 'p2']);
  });
});
