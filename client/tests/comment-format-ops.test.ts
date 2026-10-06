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
  relocatedSelection,
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

  it('каретка ВНУТРИ обёртки снимает формат (блокер проверки)', () => {
    const edit = toggleInline(snap('**hello**', 4), '**');
    assert.equal(apply('**hello**', edit.changes), 'hello');
    assert.deepEqual(edit.selection, { anchor: 2, head: 2 });
    assert.equal(isInlineActive(snap('**hello**', 4), '**'), true);
  });

  it('каретка внутри курсива снимает курсив', () => {
    const edit = toggleInline(snap('a *b* c', 4), '*');
    assert.equal(apply('a *b* c', edit.changes), 'a b c');
    assert.deepEqual(edit.selection, { anchor: 3, head: 3 });
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

describe('comment-format-ops: блочные команды на пустой каретке', () => {
  it('пустое поле: маркер вставляется, каретка — после него', () => {
    const cases: Array<[string, unknown, string, number]> = [
      ['- ', toggleBulletList(snap('', 0)), '- ', 2],
      ['1. ', toggleOrderedList(snap('', 0)), '1. ', 3],
      ['- [ ] ', toggleTaskList(snap('', 0)), '- [ ] ', 6],
      ['# ', toggleHeading(snap('', 0), 1), '# ', 2],
      ['> ', toggleBlockquote(snap('', 0)), '> ', 2],
    ];
    for (const [label, edit, expected, caret] of cases) {
      const typed = edit as { changes: unknown; selection: { anchor: number; head: number } };
      assert.equal(apply('', typed.changes), expected, `команда ${label}`);
      assert.deepEqual(typed.selection, { anchor: caret, head: caret }, `каретка ${label}`);
    }
  });

  it('каретка на пустой строке: маркер ставится в эту строку', () => {
    const bullet = toggleBulletList(snap('a\n\nb', 2));
    assert.equal(apply('a\n\nb', bullet.changes), 'a\n- \nb');
    assert.deepEqual(bullet.selection, { anchor: 4, head: 4 });

    const heading = toggleHeading(snap('a\n\nb', 2), 2);
    assert.equal(apply('a\n\nb', heading.changes), 'a\n## \nb');
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

describe('comment-format-ops: перепрокладка выделения (486d0ef1, 253b0dd3)', () => {
  it('сдвиг документа: выделение отображается на тот же фрагмент по смещению', () => {
    // Вставка «X » перед текстом: CM6 сдвинул выделение на +2.
    assert.deepEqual(
      relocatedSelection(snap('foo bar foo', 0, 3), snap('X foo bar foo', 2, 5)),
      { from: 2, to: 5 },
    );
  });

  it('перестановка на идентичный фрагмент: то же содержимое, другое место — null', () => {
    // Документ не менялся, но выделение переставлено на второй «foo».
    assert.equal(relocatedSelection(snap('foo bar foo', 0, 3), snap('foo bar foo', 8, 11)), null);
  });

  it('изменившееся содержимое выделения — null', () => {
    assert.equal(relocatedSelection(snap('abc def', 4, 7), snap('abc def', 0, 3)), null);
  });

  it('каретка: возвращается текущее положение (вставка идёт туда, где каретка)', () => {
    assert.deepEqual(relocatedSelection(snap('ab', 1, 1), snap('Qab', 2, 2)), { from: 2, to: 2 });
    assert.deepEqual(relocatedSelection(snap('ab', 1, 1), snap('ab', 0, 0)), { from: 0, to: 0 });
  });

  it('правка внутри выделения делает отображение неопределимым — null', () => {
    // Замена 'XYbZ' → 'QYbR' охватывает выделение 'Y' (позиция внутри участка),
    // содержимое при этом совпадает — позицию по сдвигу определить нельзя.
    assert.equal(relocatedSelection(snap('aXYbZc', 2, 3), snap('aQYbRc', 2, 3)), null);
  });
});
