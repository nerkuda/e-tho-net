/**
 * Регрессионное доказательство по ошибке e5cee08e («Ctrl-наведение на эллипсы
 * показывает связи без фильтра типов связей карты») и задаче 7e9ec8bf
 * («эффективный фильтр: карта и превью согласованы по show_on_map»).
 *
 * Проверяемый инвариант: единственный вызов превью соседей
 * (`etn.thoughts.neighbors(...)` внутри `resolveNeighborsPreview` в
 * `canvas/canvas.ts`) несёт `linkFilter`, полученный РЕЗОЛВОМ эффективного
 * фильтра (`resolveEffectiveCanvasLinkFilter`, `lib/effective-link-filter.ts`):
 * явное предпочтение холста, иначе живой дефолт из `show_on_map` — ровно тот
 * набор `type_ids` + `include_structural`, которым сервер рисует саму карту.
 * Чтения `store.state.canvasLinkFilter` напрямую здесь быть не должно: без
 * живого дефолта превью при незаданном предпочтении показывало все связи.
 *
 * Почему проверка структурная (по исходнику), а не прогоном: `canvas.ts`
 * импортирует весь DOM-слой холста и поднимается в node:test только с шимами
 * (см. соседние renderer-* тесты). Поведение резолва на проводе проверяют
 * `effective-link-filter.test.ts` (цепочка + кэш) и `rest-client.test.ts`
 * (client → `link_type_id`/`include_structural` в query); серверный отбор
 * соседей — `server/tests/*`. Здесь пинится именно ПРОВОДКА, которая была
 * потеряна между слоями.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const CANVAS_TS = path.resolve(import.meta.dirname, '..', 'src', 'renderer', 'canvas', 'canvas.ts');

const PREVIEW_CALL = /etn\.thoughts\.neighbors\([\s\S]{0,300}/;

/** Исходник без комментариев: домен превью упоминается и в JSDoc. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Тело функции по сигнатуре (до закрывающей скобки в 1-й колонке). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected ${signature} to be defined`);
  const stop = src.indexOf('\n}\n', start);
  assert.ok(stop > start, `expected ${signature} body to be closed`);
  return src.slice(start, stop);
}

/** Инвариант проводки: один вызов превью, и он несёт резолвнутый фильтр карты. */
function wiringProblems(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const problems: string[] = [];
  const calls = source.match(/etn\.thoughts\.neighbors\(/g) ?? [];
  if (calls.length !== 1) {
    problems.push(
      `etn.thoughts.neighbors(...) вызывается ${calls.length} раз(а): ` +
        'превью соседей обязано идти через одну точку, иначе фильтр карты ' +
        'легко потерять на одном из путей (ошибка e5cee08e)',
    );
  }
  const body = functionBody(source, 'async function resolveNeighborsPreview(');
  if (!body.includes('resolveEffectiveCanvasLinkFilter(')) {
    problems.push(
      'превью не резолвит эффективный фильтр типов связей карты ' +
        '(resolveEffectiveCanvasLinkFilter, задача 7e9ec8bf)',
    );
  }
  if (body.includes('store.state.canvasLinkFilter')) {
    problems.push(
      'превью читает store.state.canvasLinkFilter напрямую: явное предпочтение ' +
        'надо отдавать резолверу, иначе теряется живой дефолт по show_on_map',
    );
  }
  const call = body.match(PREVIEW_CALL)?.[0];
  if (call === undefined || !call.includes('linkFilter')) {
    problems.push('единственный вызов превью не передаёт linkFilter');
  }
  return problems;
}

describe('canvas: превью соседей при Ctrl-наведении подчиняется эффективному фильтру карты (e5cee08e, 7e9ec8bf)', () => {
  const source = fs.readFileSync(CANVAS_TS, 'utf8');

  it('единственный вызов etn.thoughts.neighbors(...) несёт резолвнутый фильтр холста', () => {
    assert.deepEqual(wiringProblems(source), []);
  });

  it('инвариант краснеет, если из вызова превью убрать linkFilter', () => {
    const broken = source.replace(/\n(\s*)undefined,\n\s*linkFilter,\n/, '\n');
    assert.notEqual(broken, source, 'подстановка обязана что-то менять');
    assert.ok(
      wiringProblems(broken).some((p) => p.includes('не передаёт linkFilter')),
      'снятие linkFilter обязано ловиться',
    );
  });

  it('инвариант краснеет на обходном чтении store.state.canvasLinkFilter', () => {
    const bypass = source.replace(
      /const linkFilter = await resolveEffectiveCanvasLinkFilter\((\w+)\);/,
      'const linkFilter = store.state.canvasLinkFilter;',
    );
    assert.notEqual(bypass, source, 'подстановка обязана что-то менять');
    assert.ok(
      wiringProblems(bypass).some((p) => p.includes('напрямую')),
      'прямое чтение фильтра обязано ловиться',
    );
  });

  it('инвариант краснеет на обходном вызове превью без фильтра', () => {
    const bypass = `${source}\nasync function sneaky(id) {\n  return etn.thoughts.neighbors('n', id, 'parents', 10);\n}\n`;
    assert.ok(
      wiringProblems(bypass).some((p) => p.includes('раз(а)')),
      'вызов в обход точки обязан ловиться',
    );
  });
});
