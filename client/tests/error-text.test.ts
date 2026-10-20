/**
 * Дружелюбные сообщения об ошибках (ошибка de34b35b, замечания заказчика
 * после проверки GUI): единый маппинг `lib/dom.ts::errText`.
 *
 * Правило: технические слова и коды (`fetch`, `ECONN*`, `ETIMEDOUT`,
 * `AbortError`, «запрос», «сокет», «WebSocket», «REST») не попадают к
 * пользователю; `connection-lost` и `INTERNAL`/сырые сетевые сбои получают
 * человеческие формулировки, бизнес-ошибки — свой серверный текст.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { errText, isConnectionLostError } from '../src/renderer/lib/dom.js';

const CONNECTION_LOST = 'нет соединения с сервером';
const SERVER_UNAVAILABLE = 'сервер недоступен, попробуйте позже';

/** Слова, которых не должно быть в дружелюбном сообщении. */
const TECHNICAL_RE = /запрос|IPC|fetch|abort|сокет|WebSocket|REST|ECONN|ETIMEDOUT|stack/i;

function assertFriendly(text: string): void {
  assert.equal(TECHNICAL_RE.test(text), false, `техническое слово в сообщении: «${text}»`);
  assert.equal(/INTERNAL|VALIDATION_ERROR|DUPLICATE|LOCKED|VERSION_CONFLICT/.test(text), false);
}

describe('errText: дружелюбные сообщения', () => {
  it('connection-lost (details.kind) → «нет соединения с сервером»', () => {
    const err = new EtnError('INTERNAL', 'Нет связи с сервером — запрос отменён', {
      kind: 'connection-lost',
      networkId: 'n1',
    });
    assert.equal(isConnectionLostError(err), true);
    const text = errText(err);
    assert.equal(text, CONNECTION_LOST);
    assertFriendly(text);
  });

  it('connection-lost распознаётся структурно (plain-объект после IPC)', () => {
    const err = { code: 'INTERNAL', message: 'socket closed', details: { kind: 'connection-lost' } };
    assert.equal(isConnectionLostError(err), true);
    assert.equal(errText(err), CONNECTION_LOST);
  });

  it('INTERNAL без признака связи → «сервер недоступен, попробуйте позже»', () => {
    const text = errText(new EtnError('INTERNAL', 'SQLITE_BUSY: database is locked'));
    assert.equal(text, SERVER_UNAVAILABLE);
    assertFriendly(text);
  });

  it('сырые сетевые ошибки не показывают технический текст', () => {
    for (const message of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:3000',
      'read ECONNRESET',
      'ETIMEDOUT',
      'Сетевая ошибка',
      'The operation was aborted',
    ]) {
      const text = errText(new Error(message));
      assert.equal(text, SERVER_UNAVAILABLE, `сообщение «${message}»`);
      assertFriendly(text);
    }
    const abortLike = new Error('The operation was aborted');
    abortLike.name = 'AbortError';
    assert.equal(errText(abortLike), SERVER_UNAVAILABLE);
  });

  it('бизнес-ошибки сохраняют серверный текст', () => {
    for (const [code, message] of [
      ['VALIDATION_ERROR', 'Поле «Название» обязательно'],
      ['DUPLICATE', 'Мысль с таким названием уже есть'],
      ['LOCKED', 'Объект редактирует другой пользователь'],
      ['VERSION_CONFLICT', 'Версия устарела — перечитайте объект'],
    ] as const) {
      assert.equal(errText(new EtnError(code, message)), message);
    }
  });

  it('не-Error значения приводятся к строке (совместимость)', () => {
    assert.equal(errText('строка'), 'строка');
  });
});
