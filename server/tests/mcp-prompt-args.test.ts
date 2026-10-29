/**
 * Юнит-тесты разборщиков аргументов MCP-промптов (ошибка b2223e98).
 *
 * Аргументы `prompts/get` по протоколу — строки, поэтому строковые формы
 * `seed_ids` (JSON-массив, разделители, смесь) и `radius` разбирает сам
 * промпт. Здесь проверяются все формы и края разбора без MCP-сессии;
 * достижимость промптов по проводу — `mcp-prompts.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import {
  MAX_PROMPT_SEED_IDS,
  PROMPT_RADIUS_DEFAULT,
  parseRadiusArg,
  parseSeedIds,
} from '../src/mcp/prompts.js';

/** Ожидание ошибки валидации аргумента (`-32602`) с фрагментами текста. */
function assertInvalid(run: () => unknown, ...patterns: RegExp[]): void {
  assert.throws(run, (err: unknown) => {
    const error = err as { code?: number; message?: string };
    assert.equal(error.code, ErrorCode.InvalidParams, `код ошибки: ${error.message}`);
    for (const pattern of patterns) assert.match(error.message ?? '', pattern);
    return true;
  });
}

describe('parseSeedIds: формы ввода', () => {
  it('JSON-массив строк', () => {
    assert.deepEqual(parseSeedIds('["id-1","id-2"]'), ['id-1', 'id-2']);
    assert.deepEqual(parseSeedIds('[ "id-1" , "id-2" ]'), ['id-1', 'id-2']);
  });

  it('разделители: запятые, пробелы, переводы строк', () => {
    assert.deepEqual(parseSeedIds('id-1,id-2'), ['id-1', 'id-2']);
    assert.deepEqual(parseSeedIds('id-1 id-2\nid-3\tid-4'), ['id-1', 'id-2', 'id-3', 'id-4']);
    assert.deepEqual(parseSeedIds('  id-1 ,\n  id-2  '), ['id-1', 'id-2']);
  });

  it('смешанный вид: JSON-массивы и разделители в одной строке', () => {
    assert.deepEqual(parseSeedIds('["id-1","id-2"] id-3, [ "id-4" ]'), [
      'id-1',
      'id-2',
      'id-3',
      'id-4',
    ]);
    assert.deepEqual(parseSeedIds('id-1,["id-2"]'), ['id-1', 'id-2']);
    assert.deepEqual(parseSeedIds('["id-1"],["id-2"]'), ['id-1', 'id-2']);
  });

  it('дубликаты отбрасываются с сохранением порядка первого появления', () => {
    assert.deepEqual(parseSeedIds('id-2,id-1,id-2\n["id-1","id-3"]'), ['id-2', 'id-1', 'id-3']);
  });

  it('пробелы внутри кавычек JSON обрезаются, пустые значения отбрасываются', () => {
    assert.deepEqual(parseSeedIds('[" id-1 ","  ","id-2"]'), ['id-1', 'id-2']);
    assert.deepEqual(parseSeedIds('id-1,,, id-2'), ['id-1', 'id-2']);
  });

  it('один id и ровно предел 20 id', () => {
    assert.deepEqual(parseSeedIds('id-1'), ['id-1']);
    const twenty = Array.from({ length: MAX_PROMPT_SEED_IDS }, (_unused, index) => `id-${index}`);
    assert.deepEqual(parseSeedIds(twenty.join(' ')), twenty);
    assert.equal(parseSeedIds(JSON.stringify(twenty)).length, MAX_PROMPT_SEED_IDS);
  });

  it('легаси-массив прямого вызова регистрации (обратная совместимость)', () => {
    assert.deepEqual(parseSeedIds(['id-1', ' id-2 ', 'id-1']), ['id-1', 'id-2']);
    assert.equal(parseSeedIds(Array.from({ length: MAX_PROMPT_SEED_IDS }, () => 'id')).length, 1);
  });
});

describe('parseSeedIds: ошибки ввода', () => {
  it('пустая строка, только пробелы и пустой JSON-массив', () => {
    assertInvalid(() => parseSeedIds(''), /seed_ids/, /пуст/);
    assertInvalid(() => parseSeedIds(' \n\t '), /seed_ids/, /пуст/);
    assertInvalid(() => parseSeedIds('[]'), /seed_ids/, /пуст/);
    assertInvalid(() => parseSeedIds('[" "]'), /seed_ids/, /пуст/);
  });

  it('незакрытый JSON-массив', () => {
    assertInvalid(() => parseSeedIds('["id-1","id-2"'), /seed_ids/, /незакрыт/i);
  });

  it('битый JSON: пропущенные запятая/кавычки', () => {
    assertInvalid(() => parseSeedIds('["id-1" "id-2"]'), /seed_ids/, /битый JSON/i, /кавычк/i);
    assertInvalid(() => parseSeedIds('[id-1,id-2]'), /seed_ids/, /битый JSON/i);
  });

  it('не строковый элемент JSON-массива', () => {
    assertInvalid(() => parseSeedIds('["id-1", 2]'), /seed_ids\[1\]/, /строков/i, /число/i);
    assertInvalid(() => parseSeedIds('[["id-1"]]'), /seed_ids\[0\]/, /строков/i, /массив/i);
  });

  it('больше предела 20 id', () => {
    const tooMany = Array.from({ length: MAX_PROMPT_SEED_IDS + 1 }, (_unused, index) => `id-${index}`);
    assertInvalid(() => parseSeedIds(tooMany.join(',')), /seed_ids/, /21/, /20/);
    assertInvalid(() => parseSeedIds(tooMany), /seed_ids/, /21/, /20/);
  });

  it('не строка и не массив (обход типов на прямом вызове)', () => {
    assertInvalid(() => parseSeedIds(42 as unknown as string), /seed_ids/, /число/);
  });
});

describe('parseRadiusArg: диапазон и формы', () => {
  it('дефолт 2 и допустимые значения строкой и числом', () => {
    assert.equal(parseRadiusArg(undefined), PROMPT_RADIUS_DEFAULT);
    for (const value of ['1', '2', '5', ' 3 ']) {
      assert.equal(parseRadiusArg(value), Number(value.trim()));
    }
    assert.equal(parseRadiusArg(4), 4);
  });

  it('вне диапазона 1..5 — ошибка с числом', () => {
    for (const value of ['0', '6', '-1']) assertInvalid(() => parseRadiusArg(value), /radius/, /1\.\.5/);
    assertInvalid(() => parseRadiusArg(9), /radius/, /9/, /1\.\.5/);
  });

  it('не целое число — ошибка формата', () => {
    for (const value of ['abc', '2.5', '', '3x']) {
      assertInvalid(() => parseRadiusArg(value), /radius/, /целое число/);
    }
    assertInvalid(() => parseRadiusArg(2.5), /radius/, /целое число/);
  });
});
