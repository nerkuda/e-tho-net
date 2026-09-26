/**
 * Листание списка «Структуры» keyset-курсором (требование 3f2fdc41,
 * ADR 5f6cb775, задача c2b39130).
 *
 * Проверяемый инвариант: первая страница читается с `offset: 0` без курсора,
 * каждая следующая — по `next_cursor` предыдущего ответа; `offset` не растёт
 * при листании; смена фильтра/сортировки (сброс) отбрасывает курсор.
 *
 * Поведение пейджера проверяется прогоном чистого модуля `pagination.ts`.
 * Проводка в `structures.ts`/`commands.ts` пинится по исходнику: оба модуля
 * импортируют DOM-слой экрана и в node:test не поднимаются (тот же приём, что
 * в `structures-hierarchy-link-filter.test.ts`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { StructuresPager } from '../src/renderer/screens/structures/pagination.js';

const SCREEN_DIR = path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'structures');
const STRUCTURES_TS = path.join(SCREEN_DIR, 'structures.ts');
const COMMANDS_TS = path.join(SCREEN_DIR, 'commands.ts');

/** Исходник без комментариев: домен листания упоминается и в JSDoc. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('StructuresPager: продолжение по курсору, offset не растёт', () => {
  it('первая страница — offset 0 без курсора', () => {
    const pager = new StructuresPager();
    assert.deepEqual(pager.address(true), { offset: 0 });
    assert.equal(pager.hasMore, false);
  });

  it('после accept следующая страница идёт по курсору, offset остаётся 0', () => {
    const pager = new StructuresPager();
    pager.accept('c1');
    assert.equal(pager.hasMore, true);
    assert.deepEqual(pager.address(false), { offset: 0, cursor: 'c1' });
  });

  it('offset не растёт на цепочке страниц — меняется только курсор', () => {
    const pager = new StructuresPager();
    pager.accept('c1');
    assert.equal(pager.address(false).offset, 0);
    pager.accept('c2');
    assert.deepEqual(pager.address(false), { offset: 0, cursor: 'c2' });
  });

  it('смена критериев отбора (reset) сбрасывает страницу без курсора', () => {
    const pager = new StructuresPager();
    pager.accept('c1');
    pager.reset();
    assert.equal(pager.hasMore, false);
    assert.deepEqual(pager.address(true), { offset: 0 });
    assert.deepEqual(pager.address(false), { offset: 0 });
  });

  it('null/undefined в accept означают последнюю страницу', () => {
    const pager = new StructuresPager();
    pager.accept('c1');
    pager.accept(null);
    assert.equal(pager.hasMore, false);
    pager.accept('c2');
    pager.accept(undefined);
    assert.equal(pager.hasMore, false);
  });
});

describe('структуры: проводка курсора в запросах выборки', () => {
  const structures = stripComments(fs.readFileSync(STRUCTURES_TS, 'utf8'));
  const commands = stripComments(fs.readFileSync(COMMANDS_TS, 'utf8'));

  it('страница списка берёт адрес у пейджера и передаёт cursor', () => {
    assert.ok(
      structures.includes('const page = resultPager.address(reset);'),
      'applyQuery обязан брать адрес страницы у пейджера',
    );
    assert.ok(
      structures.includes('offset: page.offset') &&
        structures.includes('...(page.cursor !== undefined ? { cursor: page.cursor } : {})'),
      'запрос выборки обязан передавать offset пейджера и условный cursor',
    );
    assert.ok(
      !/offset:\s*resultIds\.length/.test(structures),
      'offset не должен расти вместе с числом показанных строк',
    );
  });

  it('курсор берётся из ответа и сбрасывается на новом отборе', () => {
    assert.ok(
      structures.includes('resultPager.accept(result.next_cursor);'),
      'applyQuery обязан запоминать next_cursor ответа',
    );
    assert.ok(
      structures.includes('resultPager.reset();'),
      'смена фильтра/сортировки обязана сбрасывать пейджер',
    );
    assert.ok(
      structures.includes('if (resultPager.hasMore) {'),
      'кнопка «Показать ещё» обязана опираться на курсор, а не на total',
    );
  });

  it('сбор id для команд листает по курсору, offset 0', () => {
    assert.ok(
      commands.includes('...(cursor !== null ? { cursor } : {})') && commands.includes('offset: 0'),
      'collectAllIds обязан листать по курсору с нулевым offset',
    );
    assert.ok(
      !/offset:\s*ids\.length/.test(commands),
      'offset в collectAllIds не должен расти с числом собранных id',
    );
  });
});
