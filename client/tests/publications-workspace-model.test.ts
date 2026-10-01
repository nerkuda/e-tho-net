/**
 * Юнит-тесты чистой модели рабочей области открытой публикации (0.11.1,
 * задача 4f03b9d5, элемент интерфейса 2ebacd12): разворот дерева разделов,
 * ключ локального порядка и перестановка узлов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  Publication,
  PublicationAssembly,
  PublicationAssemblySection,
} from '@etn/shared';

import {
  blockSignature,
  documentBlocks,
  flattenSections,
  positionsFor,
  reorderIds,
  sectionNodeKey,
  siblingNodeKeys,
} from '../src/renderer/screens/publications/model.js';

/** Минимальная карточка публикации для подписи титула. */
function makePublication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'pub1',
    title: 'Док',
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
    created_at: '2024-01-01T00:00:00Z',
    created_by: 'u',
    updated_at: '2024-01-01T00:00:00Z',
    updated_by: 'u',
    ...overrides,
  };
}

/** Минимальная сборка документа с заданными разделами. */
function makeAssembly(
  sections: PublicationAssemblySection[],
  summaryHtml = '',
): PublicationAssembly {
  return {
    publication: {
      title: 'Док',
      subtitle: null,
      authorship: null,
      assembly_date: null,
      summary_html: summaryHtml,
      cover: { kind: 'placeholder', ref: null },
      new_candidates: 0,
    },
    sections,
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: sections.length, has_more: false },
  };
}

/**
 * Раздел сборки: минимальный узел с детьми. `nodeKey` по умолчанию — id мысли
 * (корень), у вложенного — id ребра вхождения (`e:<id>`).
 */
function section(
  thoughtId: string,
  children: PublicationAssemblySection[] = [],
  nodeKey = `e:${thoughtId}`,
): PublicationAssemblySection {
  return {
    thought_id: thoughtId,
    node_key: nodeKey,
    anchor: `pub-${thoughtId}`,
    level: 1,
    heading: thoughtId,
    preamble_html: '',
    texts: [],
    extra: [],
    flags: { repeat_of: null, cycle_cut: false },
    children,
  };
}

describe('модель рабочей области публикации: дерево разделов', () => {
  it('разворачивает дерево в плоский список в порядке документа (DFS)', () => {
    const tree = [section('A', [section('B'), section('C', [section('D')])]), section('E')];
    const flat = flattenSections(tree);
    assert.deepEqual(
      flat.map((item) => [item.section.thought_id, item.depth, item.parentThoughtId]),
      [
        ['A', 0, null],
        ['B', 1, 'A'],
        ['C', 1, 'A'],
        ['D', 2, 'C'],
        ['E', 0, null],
      ],
    );
  });

  it('ключ порядка берётся из DTO для корня и для вложенного раздела', () => {
    const flat = flattenSections([section('A', [section('B')], 'A')]);
    const [root, child] = flat;
    assert.equal(sectionNodeKey(root!), 'A');
    assert.equal(sectionNodeKey(child!), 'e:B');
  });

  it('выделяет группу соседей одного родителя (корни — parentThoughtId null)', () => {
    const tree = [
      section('A', [section('B'), section('C')], 'A'),
      section('D', [], 'D'),
    ];
    const flat = flattenSections(tree);
    assert.deepEqual(siblingNodeKeys(flat, null), ['A', 'D']);
    assert.deepEqual(siblingNodeKeys(flat, 'A'), ['e:B', 'e:C']);
    assert.deepEqual(siblingNodeKeys(flat, 'B'), []);
  });
});

describe('модель рабочей области публикации: перестановка узлов', () => {
  it('переносит узел перед указанным соседом', () => {
    assert.deepEqual(reorderIds(['A', 'B', 'C'], 'C', 'A'), ['C', 'A', 'B']);
    assert.deepEqual(reorderIds(['A', 'B', 'C'], 'A', 'C'), ['B', 'A', 'C']);
  });

  it('null-сосед ставит узел в конец', () => {
    assert.deepEqual(reorderIds(['A', 'B', 'C'], 'A', null), ['B', 'C', 'A']);
  });

  it('неизвестный перемещаемый узел возвращает исходный список', () => {
    assert.deepEqual(reorderIds(['A', 'B'], 'X', 'A'), ['A', 'B']);
  });

  it('неизвестный сосед трактуется как «в конец»', () => {
    assert.deepEqual(reorderIds(['A', 'B'], 'A', 'Z'), ['B', 'A']);
  });

  it('назначает позиции 1..N по порядку списка', () => {
    assert.deepEqual(positionsFor(['A', 'B', 'C']), [
      { node_key: 'A', position: 1 },
      { node_key: 'B', position: 2 },
      { node_key: 'C', position: 3 },
    ]);
  });

  it('переставляет вложенные разделы по node_key, не трогая корни', () => {
    const tree = [section('A', [section('B'), section('C'), section('D')], 'A')];
    const flat = flattenSections(tree);
    const keys = siblingNodeKeys(flat, 'A');
    assert.deepEqual(keys, ['e:B', 'e:C', 'e:D']);
    const next = reorderIds(keys, 'e:D', 'e:B');
    assert.deepEqual(next, ['e:D', 'e:B', 'e:C']);
    assert.deepEqual(positionsFor(next), [
      { node_key: 'e:D', position: 1 },
      { node_key: 'e:B', position: 2 },
      { node_key: 'e:C', position: 3 },
    ]);
    // Корневая группа при перестановке вложенных не меняется.
    assert.deepEqual(siblingNodeKeys(flat, null), ['A']);
  });
});

describe('модель рабочей области публикации: блоки документа и их подписи', () => {
  it('титульный блок меняет подпись при правке настроек публикации и резюме', () => {
    const asm = makeAssembly([section('A', [], 'A')], '<p>резюме</p>');
    const base = documentBlocks(asm, makePublication())[0]!;
    const renamed = documentBlocks(asm, makePublication({ title: 'Другое' }))[0]!;
    const resummed = documentBlocks(makeAssembly([section('A', [], 'A')], '<p>иное</p>'), makePublication())[0]!;
    assert.equal(base.kind, 'title');
    assert.notEqual(blockSignature(base), blockSignature(renamed));
    assert.notEqual(blockSignature(base), blockSignature(resummed));
    // Идентичная карточка — подпись стабильна (лишних пересборок нет).
    assert.equal(
      blockSignature(base),
      blockSignature(documentBlocks(asm, makePublication())[0]!),
    );
  });

  it('раздел меняет подпись при появлении предисловия', () => {
    const empty = documentBlocks(makeAssembly([section('A', [], 'A')]), null)[1]!;
    const withPreamble = documentBlocks(
      makeAssembly([{ ...section('A', [], 'A'), preamble_html: '<p>текст</p>' }]),
      null,
    )[1]!;
    assert.equal(empty.kind, 'section');
    assert.notEqual(blockSignature(empty), blockSignature(withPreamble));
  });

  it('блок «доп. материалы» меняет подпись при переименовании цели', () => {
    const withExtra = (title: string) =>
      documentBlocks(
        makeAssembly([
          {
            ...section('A', [], 'A'),
            extra: [{ property: 'p1', targets: [{ id: 't1', title }] }],
          },
        ]),
        null,
      )[2]!;
    const a = withExtra('Старое');
    const b = withExtra('Новое');
    assert.equal(a.kind, 'extra');
    assert.notEqual(blockSignature(a), blockSignature(b));
  });
});
