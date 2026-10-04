/**
 * Сторож замечаний визуальной приёмки 0.11.1, волна 9 (задача b5cfad70):
 *
 *  1) команды «Добавить раздел на этом уровне…» и «Добавить подчинённый
 *     раздел…» ставят добавленный раздел ПОСЛЕДНИМ в группе соседей своего
 *     уровня (PUT order тем же механизмом, что DnD/Alt: `commitOrder`), не
 *     трогая порядок существующих разделов; для вложенного раздела node_key —
 *     id ребра вхождения, для корня — id мысли;
 *  2) типографика документа публикации не переопределяет общий `.comment-view`
 *     (паритет с редактором) — инварианты CSS держит отдельный сторож
 *     `guard-publications-comment-typography.test.ts`, здесь — порядок.
 *
 * Поведенческие части (реальный клик и замер DOM) — на живом стенде; здесь
 * чистые инварианты модели и структурные проверки исходника. Входит в обычный
 * прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type {
  PublicationAssembly,
  PublicationAssemblySection,
} from '@etn/shared';

import {
  applyPublicationOrder,
  flattenSections,
  keysAppendedLast,
  positionsFor,
  sectionNodeKey,
  siblingNodeKeys,
} from '../src/renderer/screens/publications/model.js';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (...parts: string[]): string => fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');

const WS = read('screens', 'publications', 'workspace.ts');

function section(
  thoughtId: string,
  nodeKey: string,
  children: PublicationAssemblySection[] = [],
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

function assembly(sections: PublicationAssemblySection[]): PublicationAssembly {
  return {
    publication: {
      title: 'Док',
      subtitle: null,
      authorship: null,
      assembly_date: null,
      summary_html: '',
      cover: { kind: 'placeholder', ref: null },
      new_candidates: 0,
    },
    sections,
    excluded: [],
    warnings: [],
    meta: { page: 1, per_page: 20, total_roots: sections.length, has_more: false },
  };
}

describe('волна 9, п.1: новый раздел — последним в группе соседей своего уровня', () => {
  it('siblingNodeKeys отдаёт ключи одной группы в порядке документа', () => {
    const asm = assembly([
      section('A', 'a', [section('A1', 'e:A1'), section('A2', 'e:A2')]),
      section('B', 'b'),
      section('C', 'c'),
    ]);
    const flat = flattenSections(asm.sections);
    assert.deepEqual(siblingNodeKeys(flat, null), ['a', 'b', 'c'], 'корневая группа');
    assert.deepEqual(siblingNodeKeys(flat, 'A'), ['e:A1', 'e:A2'], 'дети A — node_key рёбер');
    assert.deepEqual(siblingNodeKeys(flat, 'B'), [], 'у листа детей нет');
  });

  it('sectionNodeKey возвращает node_key раздела (id мысли/ребра)', () => {
    const flat = flattenSections(assembly([section('A', 'a', [section('A1', 'e:A1')])]).sections);
    assert.equal(sectionNodeKey(flat[0]!), 'a');
    assert.equal(sectionNodeKey(flat[1]!), 'e:A1');
  });

  it('«на этом уровне»: новый корневой раздел — последним, существующий порядок цел', () => {
    const asm = assembly([section('A', 'a'), section('B', 'b'), section('C', 'c')]);
    // Сервер после создания вернул нового соседа ПЕРВЫМ (id нового раздела).
    const withNew = assembly([
      section('NEW', 'new'),
      section('A', 'a'),
      section('B', 'b'),
      section('C', 'c'),
    ]);
    const flat = flattenSections(withNew.sections);
    const keys = siblingNodeKeys(flat, null);
    assert.deepEqual(keys, ['new', 'a', 'b', 'c'], 'исходный (неверный) порядок сборки');
    const reordered = keysAppendedLast(keys, ['new']);
    assert.deepEqual(reordered, ['a', 'b', 'c', 'new'], 'добавленный — в конец группы');
    const patched = applyPublicationOrder(withNew, positionsFor(reordered))!;
    assert.deepEqual(
      patched.sections.map((s) => s.thought_id),
      ['A', 'B', 'C', 'NEW'],
      'модель документа показывает новый раздел последним',
    );
    // Существующие разделы сохранили взаимный порядок.
    assert.deepEqual(
      patched.sections.slice(0, 3).map((s) => s.thought_id),
      asm.sections.map((s) => s.thought_id),
      'порядок существующих не тронут',
    );
  });

  it('«подчинённый»: новый вложенный раздел — последним среди детей, node_key — ребро', () => {
    const withNew = assembly([
      section('A', 'a', [
        section('A1', 'e:A1'),
        section('A2', 'e:A2'),
        section('ANEW', 'e:ANEW'),
      ]),
      section('B', 'b'),
    ]);
    const flat = flattenSections(withNew.sections);
    const keys = siblingNodeKeys(flat, 'A');
    assert.deepEqual(keys, ['e:A1', 'e:A2', 'e:ANEW']);
    const addedKeys = flat
      .filter((item) => item.parentThoughtId === 'A' && item.section.thought_id === 'ANEW')
      .map(sectionNodeKey);
    assert.deepEqual(addedKeys, ['e:ANEW'], 'node_key вложенного раздела — id ребра');
    // Новый оказался первым в группе — переносим в конец.
    const wrong = ['e:ANEW', 'e:A1', 'e:A2'];
    const reordered = keysAppendedLast(wrong, addedKeys);
    assert.deepEqual(reordered, ['e:A1', 'e:A2', 'e:ANEW'], 'новый — последний среди детей');
    const patched = applyPublicationOrder(withNew, positionsFor(reordered))!;
    assert.deepEqual(
      patched.sections[0]!.children.map((s) => s.thought_id),
      ['A1', 'A2', 'ANEW'],
    );
  });

  it('уровень с одним разделом: новый всё равно уезжает в конец (и не раньше)', () => {
    // Группа из одного существующего раздела: сервер вернул нового ПЕРВЫМ.
    assert.deepEqual(keysAppendedLast(['new', 'a'], ['new']), ['a', 'new']);
    // Уже последний — запрос порядка не шлётся (порядок не меняется).
    assert.deepEqual(keysAppendedLast(['a', 'new'], ['new']), ['a', 'new']);
  });

  it('workspace завершает добавление РАЗДЕЛА группой соседей (обе команды)', () => {
    const finish = WS.slice(WS.indexOf('async function finishAdditions('));
    const body = finish.slice(0, finish.indexOf('async function createChild('));
    assert.match(body, /else if \(kind === 'section'\)/, 'ветка разделов в finishAdditions');
    assert.match(body, /siblingNodeKeys\(flat, anchorId\)/, 'группа соседей своего уровня');
    assert.match(body, /\.map\(sectionNodeKey\)/, 'node_key добавленного раздела из сборки');
    assert.match(body, /await commitOrder\(reordered\)/, 'порядок сохраняется общим PUT order');
    // Обе команды добавления раздела идут через finishAdditions с kind 'section'.
    assert.match(
      WS,
      /void createChild\(block\.parentThoughtId, 'section'\)/,
      '«на этом уровне» — родитель блока',
    );
    assert.match(
      WS,
      /void createChild\(block\.thoughtId, 'section'\)/,
      '«подчинённый» — сам блок',
    );
  });
});
