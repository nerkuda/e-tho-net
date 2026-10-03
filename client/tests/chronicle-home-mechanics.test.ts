/**
 * Регресс ошибки 810520c5: три родственных дефекта HOME-механики ленты дневника.
 *
 *   1. `attachToRecord` — первая содержательная привязка выводит запись из
 *      HOME-блока вниз, а лента остаётся прокрученной (перемещённая запись вне
 *      вида). Симметрично 368747a6 (там сброс добавлен только для detach).
 *   2. `insertCreatedRecord` считала класс строки по модульному `homeId`: при
 *      `homeId === null` место в ленте расходилось с серверным (тот же корень,
 *      что 89409d57, поправленный только для перестановки).
 *   3. `getHome` кэшировала отклонённый промис навсегда — повторной попытки не
 *      было, локальный путь вечно жил в fallback до перезагрузки экрана.
 *
 * Экран в node-тесте не поднимается (тянет `app.js`/редактор), поэтому проводка
 * проверяется структурно по исходнику — конвенция соседних регрессов
 * (`chronicle-realtime-detach-scroll`, `chronicle-realtime-reorder-home`).
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

describe('chronicle HOME: attachToRecord показывает перемещённую запись (ошибка 810520c5)', () => {
  it('факт первой привязки считается по разрешённому HOME', () => {
    const fn = functionBody(CHRONICLE, 'async function attachToRecord(');
    assert.match(
      fn,
      /const home = homeId \?\? \(await getHome\(\)\.catch\(\(\) => null\)\);/,
      'HOME берётся разрешённый, а не модульный напрямую',
    );
    assert.match(
      fn,
      /firstBinding =[\s\S]*?home !== null[\s\S]*?tg\.owner_id !== home/,
      'первая привязка — запись, где не было не-HOME целей',
    );
  });

  it('перемещённая вниз запись показывается после обновления ленты, обычные правки не трогаются', () => {
    const fn = functionBody(CHRONICLE, 'async function attachToRecord(');
    // G6: локальная мутация гасит ключ слоя и ДОЖИДАЕТСЯ свежего DOM
    // (`refreshFeedAndCalendar` — тот же путь, что у отложенного перезапроса),
    // и только потом прокручивает ленту при смене блока.
    assert.match(
      fn,
      /invalidateQueries\(queryKeys\.chronicleFeedAll\(\)\);[\s\S]*?await refreshFeedAndCalendar\(\);[\s\S]*?if \(firstBinding\) revealRecord\(rowId\);/,
      'прокрутка к записи — после обновления ленты и только для перемещения',
    );
    assert.ok(
      !/revealRecord\(rowId\);[\s\S]*?await refreshFeedAndCalendar\(\)/.test(fn),
      'revealRecord не вызывается до обновления ленты',
    );
  });

  it('revealRecord прокручивает к карточке, а при её отсутствии — сбрасывает к началу', () => {
    const fn = functionBody(CHRONICLE, 'function revealRecord(');
    assert.match(fn, /querySelector<HTMLElement>\(`\[\$\{TABLE_ROW_KEY_ATTR\}/, 'ищет карточку по ключу строки');
    assert.match(fn, /card\.scrollIntoView\(\{ block: 'center' \}\)/, 'карточка найдена — к ней');
    assert.match(fn, /feedWrap\.scrollTop = 0;/, 'карточки нет — лента с начала');
  });
});

describe('chronicle HOME: insertCreatedRecord использует разрешённый HOME (ошибка 810520c5)', () => {
  it('класс строки считается по homeId ?? getHome(), недоступный HOME → полный путь', () => {
    const fn = functionBody(CHRONICLE, 'async function insertCreatedRecord(');
    assert.match(
      fn,
      /const home = homeId \?\? \(await getHome\(\)\.catch\(\(\) => null\)\);/,
      'HOME берётся разрешённый',
    );
    assert.match(
      fn,
      /if \(home === null\) \{[\s\S]*?slot = null;[\s\S]*?await reload\(\);[\s\S]*?return;/,
      'недоступный HOME — слот убирается, лента перезагружается',
    );
    assert.match(
      fn,
      /insertRowByDay\([\s\S]*?home\s*\)/,
      'вставка идёт по разрешённому home',
    );
    assert.ok(
      !/insertRowByDay\([\s\S]*?homeId,/.test(fn),
      'локальная вставка не передаёт модульный homeId напрямую',
    );
  });

  it('вызывающий дожидается вставки (иначе повисший промис/гонка со слотом)', () => {
    assert.match(
      CHRONICLE,
      /await insertCreatedRecord\(localRow\);/,
      'ensureSlot дожидается локальной вставки',
    );
  });
});

describe('chronicle HOME: сбой getHome не кэшируется навсегда (ошибка 810520c5)', () => {
  it('catch сбрасывает homePromise и пробрасывает ошибку', () => {
    const fn = functionBody(CHRONICLE, 'async function getHome(');
    assert.match(
      fn,
      /\.catch\(\(err: unknown\) => \{[\s\S]*?homePromise = null;[\s\S]*?throw err;/,
      'при сбое промис сбрасывается — следующее обращение повторит попытку',
    );
  });
});
