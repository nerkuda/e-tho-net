/**
 * Сторож замечаний визуальной приёмки 0.11.1, волна 8 (задача 053dae09):
 *
 *  1) новый текст, добавленный командой «Добавить текст раздела…», оказывается
 *     ПОСЛЕДНЕЙ мыслью-текстом своего раздела (PUT order тем же механизмом, что
 *     DnD/Alt), а порядок существующих текстов/разделов не меняется;
 *  2) после создания мысль становится ТЕКУЩИМ блоком документа и открывается в
 *     редакторе: текст — вкладка «Комментарий» в режиме правки (курсор в начале),
 *     раздел — просто открыт; документ прокручивается к добавленному блоку.
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
  keysAppendedLast,
  positionsFor,
} from '../src/renderer/screens/publications/model.js';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const read = (...parts: string[]): string => fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');

const WS = read('screens', 'publications', 'workspace.ts');

function section(
  thoughtId: string,
  texts: PublicationAssemblySection['texts'] = [],
): PublicationAssemblySection {
  return {
    thought_id: thoughtId,
    node_key: `e:${thoughtId}`,
    anchor: `pub-${thoughtId}`,
    level: 1,
    heading: thoughtId,
    preamble_html: '',
    texts,
    extra: [],
    flags: { repeat_of: null, cycle_cut: false },
    children: [],
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

describe('волна 8, п.1: новый текст — последним в группе текстов раздела', () => {
  it('keysAppendedLast переносит добавленные ключи в конец, порядок прочих хранит', () => {
    assert.deepEqual(keysAppendedLast(['a', 'b', 'c'], ['a']), ['b', 'c', 'a']);
    assert.deepEqual(keysAppendedLast(['a', 'b', 'c'], ['a', 'c']), ['b', 'a', 'c']);
    // Уже последний — список не меняется (запрос порядка не нужен).
    assert.deepEqual(keysAppendedLast(['a', 'b'], ['b']), ['a', 'b']);
    // Пустой набор добавленных — исходный порядок без изменений.
    assert.deepEqual(keysAppendedLast(['a', 'b'], []), ['a', 'b']);
    // Незнакомый ключ не появляется в группе.
    assert.deepEqual(keysAppendedLast(['a', 'b'], ['x']), ['a', 'b']);
  });

  it('порядок, посчитанный keysAppendedLast+positionsFor, ставит новый текст последним (PUT order)', () => {
    const asm = assembly([
      section('A', [
        { thought_id: 'N', anchor: 'pub-N', edge_id: 'e:N', body_html: '' },
        { thought_id: 'T1', anchor: 'pub-T1', edge_id: 'e:T1', body_html: 'один' },
        { thought_id: 'T2', anchor: 'pub-T2', edge_id: 'e:T2', body_html: 'два' },
      ]),
    ]);
    const keys = ['e:N', 'e:T1', 'e:T2'];
    const reordered = keysAppendedLast(keys, ['e:N']);
    assert.deepEqual(reordered, ['e:T1', 'e:T2', 'e:N'], 'новый — в конец');
    assert.deepEqual(reordered.slice(0, 2), ['e:T1', 'e:T2'], 'существующие не перетасованы');
    const patched = applyPublicationOrder(asm, positionsFor(reordered));
    assert.deepEqual(
      patched!.sections[0]!.texts.map((text) => text.edge_id),
      ['e:T1', 'e:T2', 'e:N'],
      'модель документа показывает новый текст последним',
    );
  });

  it('тексты раздела — одна группа независимо от свойства-источника (паритет с сервером)', () => {
    // В DTO сборки тексты не несут свойства-источника: сервер после фикса волны 8
    // собирает их ЕДИНЫМ пулом раздела, поэтому порядок клиента — по всему
    // section.texts (edge_id), а не по отдельным свойствам. Кейс верификатора:
    // tFull (свойство 1) + tEmpty (свойство 2), затем новый текст добавлен в
    // свойство 1 (по сетевому месту он первый) — клиент переносит его в конец
    // ВСЕЙ группы, а не «за текстами первого свойства».
    const asm = assembly([
      section('A', [
        { thought_id: 'N', anchor: 'pub-N', edge_id: 'e:N', body_html: '' },
        { thought_id: 'TFull', anchor: 'pub-TFull', edge_id: 'e:TFull', body_html: 'полный' },
        { thought_id: 'TEmpty', anchor: 'pub-TEmpty', edge_id: 'e:TEmpty', body_html: '' },
      ]),
    ]);
    const keys = ['e:N', 'e:TFull', 'e:TEmpty'];
    const reordered = keysAppendedLast(keys, ['e:N']);
    assert.deepEqual(reordered, ['e:TFull', 'e:TEmpty', 'e:N'], 'новый — последний во всём пуле');
    const patched = applyPublicationOrder(asm, positionsFor(reordered))!;
    assert.deepEqual(
      patched.sections[0]!.texts.map((t) => t.edge_id),
      ['e:TFull', 'e:TEmpty', 'e:N'],
    );

    // Alt/DnD через границу свойства: позиции, назначенные наоборот, реально
    // меняют порядок пула (серверный локальный порядок перекрывает свойства).
    const swapped = applyPublicationOrder(patched, positionsFor(['e:TEmpty', 'e:N', 'e:TFull']))!;
    assert.deepEqual(
      swapped.sections[0]!.texts.map((t) => t.edge_id),
      ['e:TEmpty', 'e:N', 'e:TFull'],
    );
  });

  it('workspace применяет порядок общим commitOrder и не перечитывает сборку', () => {
    assert.match(
      WS,
      /import\s*\{[^}]*keysAppendedLast[^}]*\}\s*from\s*'\.\/model\.js'/s,
      'workspace импортирует чистый помощник порядка из модели',
    );
    assert.match(WS, /function finishAdditions\(/, 'завершение добавления вынесено в функцию');
    assert.match(WS, /keysAppendedLast\(keys,\s*addedKeys\)/, 'порядок группы считается помощником');
    assert.match(WS, /await commitOrder\(reordered\)/, 'порядок сохраняется тем же PUT order, что DnD/Alt');
    assert.match(
      WS,
      /const reordered = keysAppendedLast\(keys, addedKeys\);\s*if \(addedKeys\.length > 0 && reordered\.some/,
      'запрос порядка шлётся, только если порядок реально изменился',
    );
  });
});

describe('волна 8, п.2: автовыбор и автооткрытие добавленного', () => {
  it('добавленный блок становится текущим и открывается в редакторе', () => {
    assert.match(WS, /function finishAdditions\(/, 'единая точка завершения добавления');
    assert.match(WS, /scrollToAnchor\(block\.domId\)/, 'документ прокручивается к добавленному блоку');
    assert.match(
      WS,
      /if \(block\.kind === 'text'\) openTextCommentEditById\(block\.thoughtId\);\s*else openThought\(block\.thoughtId\)/,
      'текст открывается в правке комментария, раздел — просто открыт',
    );
    assert.match(
      WS,
      /function openTextCommentEditById\(thoughtId: string, findText\?: string\): void \{[\s\S]*?mod\.openThoughtCommentEditor\(thoughtId, findText\)/,
      'текст открывается на вкладке «Комментарий» в режиме правки',
    );
  });

  it('автовыбор идёт после проверки вхождения мысли в сборку', () => {
    assert.match(
      WS,
      /assemblyHasThought\(assembly, id\)/,
      'вхождение добавленной мысли определяется общей проверкой сборки',
    );
    assert.match(
      WS,
      /await finishAdditions\(\s*createdIds\.filter\(\(id\) => !missed\.includes\(id\)\),\s*kind,\s*anchorId,?\s*\)/s,
      'в finishAdditions уходят только вошедшие в сборку мысли',
    );
  });

  it('после PUT order документ обновляется патчем (lib/live), без onRealtimeEvent', () => {
    assert.doesNotMatch(WS, /onRealtimeEvent/, 'экран не подписывается на onRealtimeEvent');
    assert.match(WS, /runOptimistic</, 'порядок применяется оптимистичным патчем слоя lib/live');
  });
});
