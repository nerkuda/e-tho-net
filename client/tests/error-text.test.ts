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
const ACTION_CANCELLED = 'действие отменено';

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
    ]) {
      const text = errText(new Error(message));
      assert.equal(text, SERVER_UNAVAILABLE, `сообщение «${message}»`);
      assertFriendly(text);
    }
  });

  it('пользовательская отмена — «действие отменено», не сетевой сбой', () => {
    const abortLike = new Error('The operation was aborted');
    abortLike.name = 'AbortError';
    assert.equal(errText(abortLike), ACTION_CANCELLED);

    // Plain DOMException-shaped object (contextBridge теряет класс, имя живёт).
    assert.equal(errText({ name: 'AbortError', message: 'Aborted' }), ACTION_CANCELLED);

    // Сообщение без имени тоже распознаётся; «ECONNABORTED» — сетевой сбой.
    assert.equal(errText(new Error('aborted')), ACTION_CANCELLED);
    assert.equal(errText(new Error('read ECONNABORTED')), SERVER_UNAVAILABLE);
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

  it('422 по стороне свойства-связи — пользовательский текст, без source/target/side (d9bc6012)', () => {
    // Серверный текст адресован API/агентам: в нём `side`, `source`, `target`.
    // Пользователю показываем формулировку по машиночитаемому `details.reason`.
    const required = errText(
      new EtnError(
        'VALIDATION_ERROR',
        'имя свойства «см. также» адресует обе стороны связи, и обе стороны живые — укажите side',
        { field: 'side', reason: 'side-required', allowed: ['source', 'target'] },
      ),
    );
    assert.equal(required, 'у свойства есть связи с обеих сторон — выберите сторону');
    assert.doesNotMatch(required, /source|target|side/i);

    const mismatch = errText(
      new EtnError(
        'VALIDATION_ERROR',
        'сторона «target» не совпадает с фактическим направлением рёбер свойства «см. также»',
        { field: 'side', reason: 'side-mismatch', actual_side: 'source' },
      ),
    );
    assert.equal(
      mismatch,
      'с выбранной стороны связей нет — значение уже изменили, обновите карточку',
    );
    assert.doesNotMatch(mismatch, /source|target|side/i);
  });

  it('422 коллизии display-имён — русский текст по details.reason (d9bc6012, круг 2)', () => {
    // Сервер отвечает английской фразой API-уровня; пользователь видит
    // формулировку словаря по машиночитаемой причине, без внутренних терминов.
    const text = errText(
      new EtnError('VALIDATION_ERROR', 'property name "связано с" is ambiguous', {
        field: 'property',
        reason: 'property-ambiguous',
        name: 'связано с',
        candidates: [],
      }),
    );
    assert.equal(text, 'имя свойства неоднозначно — его используют несколько свойств сети');
    assert.doesNotMatch(text, /ambiguous|source|target|side/i);
  });

  it('422 по стороне без details.reason (сервер старше 0.14.1) — всё равно без внутренних терминов', () => {
    const text = errText(
      new EtnError('VALIDATION_ERROR', 'имя свойства «X» адресует обе стороны — укажите side', {
        field: 'side',
      }),
    );
    assert.equal(text, 'у свойства есть связи с обеих сторон — выберите сторону');
    assert.doesNotMatch(text, /source|target|side/i);
  });

  it('не-Error значения приводятся к строке (совместимость)', () => {
    assert.equal(errText('строка'), 'строка');
  });
});
