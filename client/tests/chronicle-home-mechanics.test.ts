/**
 * Лента «Дневника»: механика HOME (задача 5a002590 — прежние регрессы 810520c5).
 *
 *  1. `attachToRecord` больше НЕ перемещает и не «раскручивает» запись: порядок
 *     — только по дате/времени (требование c6ddc1ea), класс записи не участвует
 *     (ревизия 2026-10-09). Прокрутка к записи после привязки не нужна.
 *  2. `getHomeId` (`lib/home.ts`; до 0.15.4 — `getHome` экрана «Дневник»,
 *     задача 33ed043c вынесла резолвер в общий модуль) не кэширует отклонённый
 *     промис навсегда — повторной попытки не было, локальный путь вечно жил в
 *     fallback до перезагрузки экрана.
 *
 * Экран в node-тесте не поднимается (тянет `app.js`/редактор), поэтому проводка
 * проверяется структурно по исходнику.
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
const HOME_RESOLVER = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'home.ts'), 'utf8');

/** Тело функции верхнего уровня по её объявлению (стиль файла: `}` в первой колонке). */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `исходник содержит «${signature}»`);
  const body = src.slice(start);
  const end = body.indexOf('\n}\n');
  assert.ok(end >= 0, `у «${signature}» найдено тело`);
  return body.slice(0, end);
}

describe('chronicle: attachToRecord не перемещает запись (5a002590)', () => {
  it('привязка обновляет ленту без прокрутки к записи', () => {
    const fn = functionBody(CHRONICLE, 'async function attachToRecord(');
    assert.match(
      fn,
      /invalidateQueries\(queryKeys\.chronicleFeedAll\(\)\);[\s\S]*?await refreshFeedAndCalendar\(\);/,
      'локальная мутация гасит ключ ленты и ждёт свежий DOM',
    );
    assert.ok(!/firstBinding/.test(fn), 'прежняя логика первой привязки удалена');
    assert.ok(!/revealRecord/.test(fn), 'прокрутка к перемещённой записи не нужна');
  });

  it('функция revealRecord удалена за ненадобностью', () => {
    assert.ok(!/function revealRecord\(/.test(CHRONICLE), 'перемещения записи больше нет');
  });
});

describe('HOME-резолвер: сбой getHomeId не кэшируется навсегда', () => {
  it('catch сбрасывает homePromise и пробрасывает ошибку', () => {
    const fn = functionBody(HOME_RESOLVER, 'export async function getHomeId(');
    assert.match(
      fn,
      /\.catch\(\(err: unknown\) => \{[\s\S]*?homePromise = null;[\s\S]*?throw err;/,
      'при сбое промис сбрасывается — следующее обращение повторит попытку',
    );
  });

  it('резолвер живёт в общем модуле, а экран читает кеш оттуда', () => {
    assert.ok(
      !/function getHome\(/.test(CHRONICLE),
      'собственного резолвера HOME у экрана больше нет (единый модуль lib/home.ts)',
    );
    assert.match(
      CHRONICLE,
      /import \{ cachedHomeId, getHomeId, resetHomeCache \} from '\.\.\/\.\.\/lib\/home\.js';/,
      'экран берёт HOME из общего модуля',
    );
    assert.match(
      CHRONICLE,
      /return cachedHomeId\(store\.state\.networkId\);/,
      'синхронное чтение кеша привязано к текущей сети (ошибка ab4e499f)',
    );
  });
});
