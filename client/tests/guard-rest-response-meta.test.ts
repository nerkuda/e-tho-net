/**
 * Сторож привязки `meta` ответа к самому ответу (ошибка 90811979).
 *
 * Правило: `RestClient` не держит метаданные последнего ответа в общем
 * изменяемом поле. `meta` едет вместе с `data` одного ответа (`requestEnvelope`)
 * и читается только оттуда. Причина — гонка разбора: несколько запросов
 * завершаются вперемешку, и общий слот достаётся читателю уже от ЧУЖОГО ответа
 * (полоса отборов получала пустой `meta.effective`, молча теряла отборы типа и
 * оставляла нижнюю зону карты пустой до ручного переключения режима).
 *
 * Проверка статическая: разбор исходника клиента без запуска сети.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLIENT_TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REST_CLIENT_TS = path.join(
  path.resolve(CLIENT_TEST_DIR, '..', '..'),
  'client',
  'src',
  'main',
  'net',
  'rest-client.ts',
);

describe('сторож: meta ответа RestClient привязана к своему ответу (90811979)', () => {
  const src = fs.readFileSync(REST_CLIENT_TS, 'utf8');

  it('общего поля с meta последнего ответа больше нет', () => {
    assert.equal(
      src.includes('lastMeta'),
      false,
      'rest-client.ts снова держит meta в общем поле — вернётся гонка разбора (ошибка 90811979)',
    );
  });

  it('конверт ответа (data + meta) несёт сам запрос', () => {
    assert.match(src, /interface ResponseEnvelope<T>/);
    assert.match(src, /requestEnvelope<T>/);
    // `parseResponse` возвращает конверт, а не пишет в состояние класса.
    assert.match(src, /parseResponse<T>\(res: Response\): Promise<ResponseEnvelope<T>>/);
  });
});
