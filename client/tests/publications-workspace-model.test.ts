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
} from '../src/renderer/screens/publications/model.js';

/** Раздел сборки: минимальный узел с детьми. */
function section(
  thoughtId: string,
  children: PublicationAssemblySection[] = [],
): PublicationAssemblySection {
  return {
    thought_id: thoughtId,
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

  it('ключ порядка есть только у корневых разделов (вложенные DTO не адресует)', () => {
    const flat = flattenSections([section('A', [section('B')])]);
    const [root, child] = flat;
    assert.equal(sectionNodeKey(root!), 'A');
    assert.equal(sectionNodeKey(child!), null);
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
});
