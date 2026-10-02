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
  tocLines,
} from '../src/renderer/screens/publications/model.js';
import { reconcileKeyed } from '../src/renderer/lib/ui/keyed-list.js';
import { ShimElement } from './dom-shim.js';

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

describe('модель рабочей области публикации: повторное вхождение раздела', () => {
  /** Дерево из пробы сервера: A→D и B→D, D показан дважды (repeat_of). */
  const repeatTree = (): PublicationAssemblySection[] => [
    section('A', [section('D')]),
    section('B', [{ ...section('D'), flags: { repeat_of: 'pub-D', cycle_cut: false } }]),
  ];

  it('блоки документа несут уникальные ключи и DOM-id при повторе', () => {
    const blocks = documentBlocks(makeAssembly(repeatTree()), null);
    const keys = blocks.map((block) => block.key);
    assert.equal(new Set(keys).size, keys.length, 'ключи блоков уникальны');

    const sections = blocks.filter(
      (block): block is Extract<typeof block, { kind: 'section' }> => block.kind === 'section',
    );
    const domIds = sections.map((block) => block.domId);
    assert.equal(new Set(domIds).size, domIds.length, 'DOM-id уникальны');
    // Первое вхождение — чистый якорь (цель repeat_of), повтор — с суффиксом.
    assert.deepEqual(domIds, ['pub-A', 'pub-D', 'pub-B', 'pub-D-r1']);
    assert.equal(sections[3]!.repeat, true);
  });

  it('строки оглавления не дублируют ключи и reconcileKeyed не бросает', () => {
    const lines = tocLines(makeAssembly(repeatTree()), new Set(), (i) => `Текст ${i}`);
    const keys = lines.map((line) => line.key);
    assert.equal(new Set(keys).size, keys.length, 'ключи строк уникальны');

    const dRows = lines.filter(
      (line): line is Extract<typeof line, { kind: 'section' }> =>
        line.kind === 'section' && line.thoughtId === 'D',
    );
    assert.equal(dRows.length, 2, 'повтор даёт вторую строку');
    assert.equal(dRows[0]!.anchor, 'pub-D');
    assert.equal(dRows[0]!.repeat, false);
    assert.equal(dRows[1]!.anchor, 'pub-D-r1');
    assert.equal(dRows[1]!.repeat, true);
    // Переход по пометке повтора ведёт к первому вхождению (repeat_of).
    assert.equal(dRows[1]!.repeatOf, 'pub-D');

    // Прямая проверка: сверка списка с такими ключами не бросает duplicate key.
    const host = new ShimElement('div') as unknown as HTMLElement;
    reconcileKeyed(host, lines, {
      key: (line) => line.key,
      build: () => new ShimElement('div') as unknown as HTMLElement,
      update: () => undefined,
    });
    assert.equal(host.children.length, lines.length);
  });

  it('счётчик вхождений считается по всем ветвям — нумерация совпадает с документом (ошибка 59a17805)', () => {
    // Ветвь A свёрнута: первое вхождение D скрыто, видимым остаётся повтор под B.
    const asm = makeAssembly(repeatTree());
    const lines = tocLines(asm, new Set(['A']), (i) => `Текст ${i}`);

    const dRows = lines.filter(
      (line): line is Extract<typeof line, { kind: 'section' }> =>
        line.kind === 'section' && line.thoughtId === 'D',
    );
    assert.equal(dRows.length, 1, 'D под свёрнутой A скрыт, виден только повтор');

    // `documentBlocks` нумерует по всем вхождениям (свёрнутость на него не влияет):
    // D под A — чистый `pub-D`, повтор под B — `pub-D-r1`.
    const docD = documentBlocks(asm, null)
      .filter(
        (block): block is Extract<typeof block, { kind: 'section' }> =>
          block.kind === 'section' && block.thoughtId === 'D',
      )
      .map((block) => block.domId);
    assert.deepEqual(docD, ['pub-D', 'pub-D-r1']);

    assert.equal(dRows[0]!.anchor, docD[1], 'anchor видимого повтора совпадает с документом');
    assert.equal(dRows[0]!.anchor, 'pub-D-r1');
    assert.equal(dRows[0]!.repeat, true);
    // Пометка повтора ведёт к первому вхождению, а не на саму себя.
    assert.equal(dRows[0]!.repeatOf, 'pub-D');
    assert.notEqual(dRows[0]!.anchor, dRows[0]!.repeatOf);
  });
});
