/**
 * Сворачивание заголовков в режиме ПРОСМОТРА записи «Дневника» (ошибка
 * c91a0067, 0.12.1).
 *
 * В правке заголовки сворачивались (гаттер CodeMirror, `commentCollapseExtension`),
 * в просмотре — нет: статичный `body_html` ленты не получал декоратор
 * `decorateCommentView`. Экран «Дневника» подключает тот же механизм (полоса-
 * гаттер `.md-collapse-rail`) с владельцем состояния — самим хроно-комментарием.
 *
 * Сам механизм сворачивания проверен поведенчески в `comment-collapse.test.ts`;
 * здесь фиксируется ПРОВОДКА экрана (chronicle.ts под Node не импортируется —
 * тянет Electron-каркас), поэтому проверяются якоря исходника.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(RENDERER, ...parts), 'utf8');
}

const CHRONICLE = read('screens', 'chronicle', 'chronicle.ts');
const RECORD_BODY = read('screens', 'chronicle', 'record-body.ts');

/** Тело функции от заголовка до закрывающей скобки баланса. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `в исходнике нет «${header}»`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `у «${header}» нет тела`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

describe('сворачивание заголовков в просмотре записи (ошибка c91a0067)', () => {
  it('экран подключает декоратор сворачивания к статичному просмотру записи', () => {
    const fill = functionBody(CHRONICLE, 'function fillRecordCard(');
    assert.match(
      fill,
      /decorateCommentView\(\s*recordView,\s*createCommentCollapseState\(collapseNetworkId, row\.id\)/,
      'просмотр записи декорируется, владелец состояния — сам комментарий',
    );
    assert.match(fill, /row\.body_html\.trim\(\) !== ''/, 'пустая запись не декорируется');
  });

  it('используется общий механизм сворачивания, а не своя реализация', () => {
    assert.match(
      CHRONICLE,
      /import \{[^}]*decorateCommentView[^}]*\} from '\.\.\/\.\.\/editor\/comment-collapse\.js'/,
      'декоратор — из общего модуля сворачивания',
    );
    assert.match(
      RECORD_BODY,
      /^\s*export function renderRecordView\(/m,
      'record-body отдаёт контейнер просмотра для декорирования',
    );
  });
});
