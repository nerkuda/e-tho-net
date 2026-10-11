/**
 * «+ мысль» в слоте дневниковой записи умеет СОЗДАВАТЬ новые мысли (ошибка
 * 0c3a8b69).
 *
 * Экран «Дневник» в node-тесте не поднимается (тянет `app.js`/редактор),
 * поэтому проводка проверяется структурно по исходнику — как в
 * `chronicle-home-mechanics.test.ts`. Красный до фикса: диалог открывался с
 * `allowCreate: false`, и нового пути создания в `pickAndAttach` не было.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const RENDERER_ROOT = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
const CHRONICLE = fs.readFileSync(
  path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
  'utf8',
);

/** Тело функции верхнего уровня по её объявлению (стиль файла: `}` в первой колонке). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

describe('Дневник: «+ мысль» создаёт новые мысли (ошибка 0c3a8b69)', () => {
  it('pickAndAttach открывает диалог с включённым созданием', () => {
    const fn = functionBody(CHRONICLE, 'async function pickAndAttach(');
    assert.match(fn, /allowCreate: true/, 'диалог «+ мысль» допускает создание мысли');
    assert.ok(!/allowCreate: false/.test(fn), 'прежний запрет создания снят');
  });

  it('новая мысль из результата диалога создаётся и привязывается', () => {
    const fn = functionBody(CHRONICLE, 'async function pickAndAttach(');
    // Найденные мысли не пересоздаются — идут в привязку как есть.
    assert.match(fn, /if \(item\.kind === 'existing'\)/, 'существующая мысль берётся как есть');
    assert.match(fn, /etn\.thoughts\.create\(/, 'новая мысль создаётся через API создания мысли');
    assert.match(
      fn,
      /await attachToRecord\(rowId, thoughtIds\)/,
      'обе ветки (найденные + созданные) уходят в привязку к записи',
    );
  });

  it('родителями новой мысли становятся мысли-владельцы записи', () => {
    const fn = functionBody(CHRONICLE, 'async function pickAndAttach(');
    assert.match(fn, /recordParentThoughtIds\(networkId, rowId\)/, 'владельцы записи читаются');
    assert.match(fn, /op: 'link_parents'/, 'созданной мысли ставятся родители');
    const helper = functionBody(CHRONICLE, 'async function recordParentThoughtIds(');
    assert.match(
      helper,
      /target\.owner_type === 'thought'[\s\S]*?etn\.links\.get\(networkId, target\.owner_id\)/,
      'чипс-связь даёт родителя-источник (паритет с parentThoughtIds)',
    );
  });
});
