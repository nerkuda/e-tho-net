/**
 * Юнит-тесты чистой модели рабочей области открытой публикации (0.11.1,
 * задача 4f03b9d5, элемент интерфейса 2ebacd12): разворот дерева разделов,
 * ключ локального порядка и перестановка узлов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PublicationAssemblySection } from '@etn/shared';

import {
  flattenSections,
  positionsFor,
  reorderIds,
  sectionNodeKey,
  siblingNodeKeys,
} from '../src/renderer/screens/publications/model.js';

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
