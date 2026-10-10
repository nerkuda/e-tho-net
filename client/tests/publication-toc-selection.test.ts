/**
 * Лента публикации: выделение текста подсвечивает его раздел в оглавлении
 * (ошибка d79f7254, 0.12.1).
 *
 * Обратное направление к переходу по клику работает; прежнее прямое (скролл →
 * оглавление) вело `updateCurrentSection`, но выделение текста его не
 * учитывало. Теперь выделение (`selectionchange`) находит охватывающий раздел
 * и назначает его текущим через ОБЩУЮ с `updateCurrentSection` запись
 * `applyCurrentAnchor`.
 *
 * Реальное выделение требует движка раскладки (нет в DOM-шиме) — проверяются
 * якоря исходника, как и у родственных замечаний приёмки
 * (`publications-acceptance-wave1.test.ts`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.readFileSync(
  path.join(CLIENT_ROOT, 'src', 'renderer', 'screens', 'publications', 'workspace.ts'),
  'utf8',
);

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

describe('лента публикации: выделение текста ведёт оглавление (ошибка d79f7254)', () => {
  it('слушатель выделения подключён и снимается при размонтировании', () => {
    assert.match(
      WS,
      /document\.addEventListener\('selectionchange', onSelectionChange\)/,
      'selectionchange подключён',
    );
    assert.match(
      WS,
      /document\.removeEventListener\('selectionchange', onSelectionChange\)/,
      'selectionchange снимается в destroy',
    );
  });

  it('обработчик выделения находит раздел узла и назначает его текущим', () => {
    const body = functionBody(WS, 'function onSelectionChange(');
    assert.ok(body.includes('window.getSelection'), 'берётся выделение окна');
    assert.ok(body.includes('isCollapsed'), 'пустое выделение игнорируется');
    assert.ok(body.includes('sectionAnchorForNode(selection.anchorNode)'), 'раздел — по узлу выделения');
    assert.ok(body.includes('applyCurrentAnchor('), 'назначение — общей записью текущего раздела');
  });

  it('раздел узла определяется как последний заголовок выше него, вне документа игнор', () => {
    const body = functionBody(WS, 'function sectionAnchorForNode(');
    assert.ok(body.includes('docHost.contains(el)'), 'узел вне ленты не учитывается');
    assert.ok(body.includes("querySelectorAll<HTMLElement>('.pub-doc-section')"), 'ищутся заголовки разделов');
    assert.ok(body.includes('topWithinDoc'), 'сравнение по вертикали документа');
  });

  it('прокрутка и выделение пишут текущий раздел ОДНИМ механизмом', () => {
    const scrollBody = functionBody(WS, 'function updateCurrentSection(');
    assert.ok(scrollBody.includes('applyCurrentAnchor('), 'скролл — через общий механизм');
    const anchorBody = functionBody(WS, 'function applyCurrentAnchor(');
    assert.ok(anchorBody.includes('pub-toc-current'), 'подсветка строки оглавления');
  });
});
