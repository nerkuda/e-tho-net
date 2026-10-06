/**
 * Юнит-тесты чистой модели экрана «Публикации» (0.11.1, задача a3cfc018):
 * персональные настройки вида, заглушка обложки, разбиение по полкам.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Publication, Shelf } from '@etn/shared';

import {
  assemblyDateLabel,
  clampTextWidth,
  coverInitials,
  coverTone,
  COVER_TONES,
  defaultPublicationsViewState,
  groupByShelves,
  isShelfCollapsed,
  nextShelfTitle,
  parsePublicationsViewState,
  publicationMenuCommands,
  publicationsEmptyKind,
  serializePublicationsViewState,
  shelfMenuCommands,
  shelfSwapUpdates,
  sortPublications,
  TEXT_WIDTH_DEFAULT,
  TEXT_WIDTH_MAX,
  TEXT_WIDTH_MIN,
  visibleLibraryEntities,
  wizardShelfChoice,
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
      textWidth: 100,
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
      textWidth: 100,
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
      textWidth: 75,
    };
    assert.deepEqual(parsePublicationsViewState(serializePublicationsViewState(state)), state);
  });

  it('ширина текста клампится в границы и переживает сериализацию', () => {
    assert.equal(TEXT_WIDTH_MIN, 50);
    assert.equal(TEXT_WIDTH_MAX, 100);
    assert.equal(TEXT_WIDTH_DEFAULT, 100);
    assert.equal(clampTextWidth(undefined), TEXT_WIDTH_DEFAULT);
    assert.equal(clampTextWidth('70'), TEXT_WIDTH_DEFAULT, 'строка — мусор');
    assert.equal(clampTextWidth(10), TEXT_WIDTH_MIN);
    assert.equal(clampTextWidth(1000), TEXT_WIDTH_MAX);
    assert.equal(clampTextWidth(63.6), 64);
    const parsed = parsePublicationsViewState(JSON.stringify({ textWidth: 55 }));
    assert.equal(parsed.textWidth, 55);
    assert.equal(
      parsePublicationsViewState(JSON.stringify({ textWidth: 5 })).textWidth,
      TEXT_WIDTH_MIN,
      'ниже границы — минимум',
    );
    assert.equal(
      JSON.parse(serializePublicationsViewState({ ...defaultPublicationsViewState(), textWidth: 70 }))
        .textWidth,
      70,
    );
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

// --- Пустое состояние, сортировка, inline-имя (ошибка 28fbdb59, задача 00160da1) ---

describe('публикации: пустое состояние (model, 1eecd988 v3)', () => {
  it('есть публикации — глобального состояния нет', () => {
    assert.equal(publicationsEmptyKind(3, 0, false), 'none');
  });

  it('сеть без публикаций, но с живой полкой — полки остаются (глобального состояния нет)', () => {
    assert.equal(publicationsEmptyKind(0, 1, false), 'none');
  });

  it('нет ни публикаций, ни полок — пустая библиотека', () => {
    assert.equal(publicationsEmptyKind(0, 0, false), 'noData');
  });

  it('поиск/фильтр без результата — состояние запроса', () => {
    assert.equal(publicationsEmptyKind(0, 2, true), 'noResults');
  });
});

describe('публикации: сортировка внутри полок/групп (model, задача 00160da1)', () => {
  const pubs = [
    publication('p1', { title: 'Б', created_at: '2026-01-02T00:00:00.000Z', authorship: 'Я' }),
    publication('p2', { title: 'А', created_at: '2026-01-03T00:00:00.000Z', authorship: 'А' }),
    publication('p3', { title: 'В', created_at: '2026-01-01T00:00:00.000Z', authorship: 'Б' }),
  ];

  it('manual — исходный порядок; title/date/author — как сервер', () => {
    assert.deepEqual(sortPublications(pubs, 'manual').map((p) => p.id), ['p1', 'p2', 'p3']);
    assert.deepEqual(sortPublications(pubs, 'title').map((p) => p.id), ['p2', 'p1', 'p3']);
    assert.deepEqual(sortPublications(pubs, 'date').map((p) => p.id), ['p2', 'p1', 'p3']);
    assert.deepEqual(sortPublications(pubs, 'author').map((p) => p.id), ['p2', 'p3', 'p1']);
  });

  it('groupByShelves применяет сортировку внутри полок и остатка', () => {
    const publications = [publication('p1', { title: 'Б' }), publication('p2', { title: 'А' })];
    const grouped = groupByShelves(publications, [shelf('s1', ['p1', 'p2'])], 'title');
    assert.deepEqual(grouped.byShelf[0]?.items.map((p) => p.id), ['p2', 'p1']);
  });

  it('manual не меняет порядок состава полки (позиции)', () => {
    const publications = [publication('p1', { title: 'Б' }), publication('p2', { title: 'А' })];
    const grouped = groupByShelves(publications, [shelf('s1', ['p1', 'p2'])], 'manual');
    assert.deepEqual(grouped.byShelf[0]?.items.map((p) => p.id), ['p1', 'p2']);
  });
});

describe('публикации: inline-переименование полки (model, задача 00160da1)', () => {
  it('обрезка пробелов; пусто и без изменений — сохранять нечего', () => {
    assert.equal(nextShelfTitle('Полка', '  Новая  '), 'Новая');
    assert.equal(nextShelfTitle('Полка', '   '), null);
    assert.equal(nextShelfTitle('Полка', 'Полка'), null);
  });
});

// --- Единая навигация и общие меню (задача 55ee3c85) -------------------------

describe('публикации: единая навигация, свёрнутость и меню (задача 55ee3c85)', () => {
  it('видимая последовательность: полка, затем её публикации; свёрнутая — без публикаций', () => {
    const entities = visibleLibraryEntities([
      { shelfId: 's1', publicationIds: ['p1', 'p2'], collapsed: false },
      { shelfId: 's2', publicationIds: ['p3'], collapsed: true },
      { shelfId: 's3', publicationIds: [], collapsed: false },
    ]);
    assert.deepEqual(entities, [
      { kind: 'shelf', key: 's1' },
      { kind: 'publication', key: 'p1' },
      { kind: 'publication', key: 'p2' },
      { kind: 'shelf', key: 's2' },
      { kind: 'shelf', key: 's3' },
    ]);
  });

  it('свёрнутость полки решается набором; по умолчанию полка развёрнута', () => {
    assert.equal(isShelfCollapsed('s1', new Set()), false);
    assert.equal(isShelfCollapsed('s1', new Set(['s1'])), true);
  });

  it('состав меню публикации: открыть/удалить/читать/экспортировать (b51dbca4, 178f4921)', () => {
    assert.deepEqual(publicationMenuCommands(), [
      'open',
      'delete',
      'read',
      'exportMd',
      'exportHtml',
      'exportPdf',
    ]);
  });

  it('состав меню полки: «Добавить публикацию» и «Удалить»', () => {
    assert.deepEqual(shelfMenuCommands(), ['addPublication', 'delete']);
  });

  it('выбор полки в мастере: живая явная полка сохраняется, несуществующая — «без полки»', () => {
    const shelves = [{ id: 's1' }, { id: 's2' }];
    assert.equal(wizardShelfChoice(shelves, 's2'), 's2');
    assert.equal(wizardShelfChoice(shelves, null), null);
    assert.equal(wizardShelfChoice(shelves, 'gone'), null);
  });
});
