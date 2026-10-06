/**
 * Юнит-тесты чистых преобразований команд форматирования комментария
 * (0.12.1, задача ab0c4470, ТП1): `editor/comment-format-ops.ts`.
 *
 * Модуль не зависит от DOM и CodeMirror, поэтому проверяются сами
 * преобразования выделения/блока (DoD: «тесты преобразования выделения/блока»).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blockMarker,
  canMoveLine,
  canOutdent,
  indentLines,
  insertCodeBlock,
  insertHtmlComment,
  insertSeparator,
  insertTable,
  isBlockMarkerActive,
  isHeadingActive,
  isInlineActive,
  moveLine,
  toggleBlockquote,
  toggleBulletList,
  toggleHeading,
  toggleInline,
  toggleOrderedList,
  toggleTaskList,
} from '../src/renderer/editor/comment-format-ops.js';

/** Снимок редактора: каретка в `caret` или выделение `[from, to)`. */
function snap(text: string, from: number, to: number = from) {
  return { text, from, to };
}

/** Применяет правки к тексту (в порядке убывания from — как CM6). */
function apply(text: string, changes: unknown): string {
  const list = (
    Array.isArray(changes) ? changes : [changes]
  ) as Array<{ from: number; to: number; insert: string }>;
  const ordered = [...list].sort((a, b) => b.from - a.from);
  for (const change of ordered) {
    text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  }
  return text;
}

describe('comment-format-ops: внутристрочные команды', () => {
  it('оборачивает выделение и ставит выделение на текст', () => {
    const edit = toggleInline(snap('hello', 0, 5), '**');
    assert.equal(apply('hello', edit.changes), '**hello**');
    assert.deepEqual(edit.selection, { anchor: 2, head: 7 });
  });

  it('снимает маркеры, когда они снаружи выделения', () => {
    const edit = toggleInline(snap('**hello**', 2, 7), '**');
    assert.equal(apply('**hello**', edit.changes), 'hello');
    assert.deepEqual(edit.selection, { anchor: 0, head: 5 });
  });

  it('при каретке вставляет пустую пару и ставит каретку между маркерами', () => {
    const bold = toggleInline(snap('', 0), '**');
    assert.equal(apply('', bold.changes), '****');
    assert.deepEqual(bold.selection, { anchor: 2, head: 2 });

    const underline = toggleInline(snap('', 0), '<u>', '</u>');
    assert.equal(apply('', underline.changes), '<u></u>');
    assert.deepEqual(underline.selection, { anchor: 3, head: 3 });
  });

  it('isInlineActive отражает обёрнутость выделения/каретки', () => {
    assert.equal(isInlineActive(snap('**hello**', 2, 7), '**'), true);
    assert.equal(isInlineActive(snap('hello', 0, 5), '**'), false);
    assert.equal(isInlineActive(snap('****', 2), '**'), true);
    assert.equal(isInlineActive(snap('hello', 3), '**'), false);
  });
});

describe('comment-format-ops: заголовки', () => {
  it('ставит заголовок и переключает уровень', () => {
    assert.equal(apply('text', toggleHeading(snap('text', 0), 1).changes), '# text');
    assert.equal(apply('# text', toggleHeading(snap('# text', 0), 2).changes), '## text');
  });

  it('повторный вызов снимает заголовок', () => {
    assert.equal(apply('## text', toggleHeading(snap('## text', 0), 2).changes), 'text');
    assert.equal(isHeadingActive(snap('## text', 3), 2), true);
    assert.equal(isHeadingActive(snap('text', 3), 2), false);
  });

  it('заголовок применяется к каждой выделенной строке', () => {
    const edit = toggleHeading(snap('a\nb', 0, 3), 1);
    assert.equal(apply('a\nb', edit.changes), '# a\n# b');
  });
});

describe('comment-format-ops: списки', () => {
  it('маркированный список и его снятие', () => {
    assert.equal(apply('a\nb', toggleBulletList(snap('a\nb', 0, 3)).changes), '- a\n- b');
    assert.equal(apply('- a\n- b', toggleBulletList(snap('- a\n- b', 0, 7)).changes), 'a\nb');
    assert.equal(isBlockMarkerActive(snap('- a', 0), blockMarker.bullet), true);
  });

  it('нумерованный список нумерует подряд', () => {
    assert.equal(apply('a\nb\nc', toggleOrderedList(snap('a\nb\nc', 0, 5)).changes), '1. a\n2. b\n3. c');
  });

  it('список задач и переоформление из маркированного', () => {
    assert.equal(apply('- a', toggleTaskList(snap('- a', 0, 3)).changes), '- [ ] a');
    assert.equal(apply('- [ ] a', toggleTaskList(snap('- [ ] a', 0, 7)).changes), 'a');
  });

  it('цитата', () => {
    assert.equal(apply('a\nb', toggleBlockquote(snap('a\nb', 0, 3)).changes), '> a\n> b');
    assert.equal(apply('> a', toggleBlockquote(snap('> a', 0, 3)).changes), 'a');
  });

  it('сохраняет отступ строк', () => {
    assert.equal(apply('  a', toggleBulletList(snap('  a', 0, 3)).changes), '  - a');
  });
});

describe('comment-format-ops: блоки-вставки', () => {
  it('блок кода оборачивает выделенные строки', () => {
    const edit = insertCodeBlock(snap('a\nb', 0, 3));
    assert.equal(apply('a\nb', edit.changes), '```\na\nb\n```');
  });

  it('блок кода при каретке вставляет пустой блок с кареткой внутри', () => {
    const edit = insertCodeBlock(snap('', 0));
    assert.equal(apply('', edit.changes), '```\n\n```');
    assert.deepEqual(edit.selection, { anchor: 4, head: 4 });
  });

  it('разделитель вставляется отдельной строкой', () => {
    assert.equal(apply('a', insertSeparator(snap('a', 1)).changes), 'a\n---\n');
  });

  it('таблица вставляется шаблоном', () => {
    const edit = insertTable(snap('', 0));
    assert.equal(apply('', edit.changes), '|  |  |\n| --- | --- |\n|  |  |');
  });

  it('HTML-комментарий оборачивает выделение и вставляется пустым', () => {
    assert.equal(apply('req', insertHtmlComment(snap('req', 0, 3)).changes), '<!-- req -->');
    const empty = insertHtmlComment(snap('', 0));
    assert.equal(apply('', empty.changes), '<!--  -->');
    assert.deepEqual(empty.selection, { anchor: 5, head: 5 });
  });
});

describe('comment-format-ops: перемещение строк и сдвиг', () => {
  it('перемещает строку вверх и сохраняет выделение на ней', () => {
    const edit = moveLine(snap('a\nb\nc', 2), 'up');
    assert.ok(edit !== null);
    assert.equal(apply('a\nb\nc', edit.changes), 'b\na\nc');
    assert.deepEqual(edit.selection, { anchor: 0, head: 0 });
  });

  it('перемещает строку вниз', () => {
    const edit = moveLine(snap('a\nb\nc', 0), 'down');
    assert.ok(edit !== null);
    assert.equal(apply('a\nb\nc', edit.changes), 'b\na\nc');
    assert.deepEqual(edit.selection, { anchor: 2, head: 2 });
  });

  it('границы: сверху/снизу перемещать нечего (null)', () => {
    assert.equal(moveLine(snap('a\nb', 0), 'up'), null);
    assert.equal(moveLine(snap('a\nb', 2), 'down'), null);
    assert.equal(canMoveLine(snap('a\nb', 0), 'up'), false);
    assert.equal(canMoveLine(snap('a\nb', 0), 'down'), true);
  });

  it('конечный перевод строки не даёт «переехать» последней строке', () => {
    assert.equal(moveLine(snap('a\nb\n', 2), 'down'), null);
  });

  it('сдвиг вправо/влево и применимость снятия отступа', () => {
    assert.equal(apply('a', indentLines(snap('a', 0), 'in').changes), '  a');
    assert.equal(apply('  a', indentLines(snap('  a', 0), 'out').changes), 'a');
    assert.equal(canOutdent(snap('  a', 0)), true);
    assert.equal(canOutdent(snap('a', 0)), false);
  });
});
