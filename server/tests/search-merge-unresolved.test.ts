/**
 * Дедупликация диагностики `unresolved` при legacy-merge поиска
 * (задача 1169ae37, требование b7fdab20).
 *
 * Legacy `scope=thoughts` (03-server-api.md §12) — это ДВА прогона одного и того
 * же AST (`names` + `texts`), поэтому один неразрешимый токен приезжал из обоих
 * ответов и дублировался в выдаче (живой прогон давал `length: 2`). Выдача
 * схлопывает диагностику по (`path`, `token`, `reason`), а порядок записей —
 * по первому появлению.
 *
 * Тест заодно фиксирует, что поле объявлено в ОБЩЕМ контракте
 * (`SearchResponse.unresolved`, `TokenIssue[]`): фикстуры типизированы
 * `SearchResponse` из `@etn/shared` — без переноса поля в shared этот файл не
 * собрался бы.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SearchNameHit, SearchResponse, TokenIssue } from '@etn/shared';

import { mergeSearchResponses } from '../src/routes/search.js';

/** Хит группы `by_names` (единственная группа, нужная проверкам счётчиков). */
function nameHit(id: string): SearchNameHit {
  return {
    thought_id: id,
    title: id,
    icon: null,
    icon_kind: 'emoji',
    icon_attachment_id: null,
    fg_color: null,
    bg_color: null,
    font_bold: null,
    font_italic: null,
    font_underline: null,
    font_strike: null,
    type_id: null,
    active: true,
    snippet: id,
    highlights: [],
  };
}

/** Ответ точки поиска: одна группа и необязательная диагностика токенов. */
function response(names: SearchNameHit[], unresolved?: TokenIssue[]): SearchResponse {
  return {
    by_names: names,
    by_texts: [],
    by_links: [],
    by_chrono: [],
    meta: { total_in_group: { names: names.length, texts: 0, links: 0, chronology: 0 } },
    ...(unresolved !== undefined ? { unresolved } : {}),
  };
}

const ISSUE: TokenIssue = {
  path: 'filter.children[0].value',
  token: '$weekStart-1d',
  reason: 'time_context_required',
  message: 'Токен времени не разрешился: у сети не задан первый день недели.',
};

describe('1169ae37: merge поиска не дублирует unresolved', () => {
  it('один и тот же токен из двух прогонов scope=thoughts → одна запись', () => {
    const merged = mergeSearchResponses(response([nameHit('a')], [ISSUE]), response([], [ISSUE]));
    assert.deepEqual(merged.unresolved, [ISSUE]);
  });

  it('разные проблемы сохраняются, порядок — по первому появлению', () => {
    const other: TokenIssue = { ...ISSUE, path: 'filter.children[1].value' };
    const third: TokenIssue = { ...ISSUE, token: '$now', reason: 'unknown_token' };
    const merged = mergeSearchResponses(
      response([], [ISSUE, other]),
      response([], [ISSUE, third]),
    );
    assert.deepEqual(merged.unresolved, [ISSUE, other, third]);
  });

  it('ключ — (path, token, reason): тот же токен с другим текстом пояснения схлопывается', () => {
    const echo: TokenIssue = { ...ISSUE, message: 'тот же токен, другое пояснение' };
    const merged = mergeSearchResponses(response([], [ISSUE]), response([], [echo]));
    assert.deepEqual(merged.unresolved, [ISSUE], 'первое появление выигрывает');
  });

  it('без диагностики поле не выставляется', () => {
    const merged = mergeSearchResponses(response([nameHit('a')]), response([nameHit('b')]));
    assert.equal(merged.unresolved, undefined);
  });

  it('группы и счётчики складываются как раньше', () => {
    const merged = mergeSearchResponses(
      response([nameHit('a')], [ISSUE]),
      response([nameHit('b')], [ISSUE]),
    );
    assert.deepEqual(
      merged.by_names.map((hit) => hit.thought_id),
      ['a', 'b'],
    );
    assert.equal(merged.meta.total_in_group.names, 2);
  });
});
