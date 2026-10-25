/**
 * Текст отказа подключения к серверу (ошибка 390e9746, заказчик на свежем
 * клиенте).
 *
 * Симптом: при выборе сохранённого, но «погашенного» сервера клиент показывал
 * общую «затычку» («сервер недоступен, попробуйте позже»), а заказчик ждёт
 * сообщения о фактической причине и адресе. Валидационная подсказка «Введите
 * адрес сервера…» к этому пути не относится — адрес сохранён.
 *
 * Тест — регресс на формулировку: сообщение всегда называет адрес и
 * различимую причину (отказ в соединении / таймаут / DNS / недоступность сети /
 * отказ в доступе) и НИКОГДА не подставляет подсказку ввода адреса.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { describeConnectFailure } from '../src/renderer/lib/connect-failure.js';

const DEAD_URL = 'http://127.0.0.1:19777';
const LABEL = 'Мой сервер';

/** Ошибка, которую main отдаёт после исчерпания повторов к мёртвому серверу. */
function refusedError(): EtnError {
  return new EtnError('INTERNAL', 'Сетевая ошибка: fetch failed', {
    kind: 'connect-failed',
    reason: 'refused',
  });
}

const VALIDATION_HINT = /Введите адрес сервера/;
const TECHNICAL = /fetch|ECONN|ETIMEDOUT|HTTP \d|INTERNAL|IPC/i;

describe('describeConnectFailure: причина вместо «затычки» (390e9746)', () => {
  it('отказ в соединении: метка, адрес и причина — без подсказки ввода адреса', () => {
    const text = describeConnectFailure(refusedError(), { label: LABEL, baseUrl: DEAD_URL });
    assert.equal(
      text,
      `Не удалось подключиться к серверу «${LABEL}» (${DEAD_URL}): ` +
        'соединение отклонено — сервер не запущен или порт закрыт',
    );
    assert.equal(VALIDATION_HINT.test(text), false, 'подсказка валидации не должна появляться');
    assert.equal(TECHNICAL.test(text), false, `технический текст в сообщении: «${text}»`);
  });

  it('метка совпадает с адресом (умолчание addProfile) — адрес не дублируется', () => {
    const text = describeConnectFailure(refusedError(), { label: DEAD_URL, baseUrl: DEAD_URL });
    assert.equal(
      text,
      `Не удалось подключиться к серверу ${DEAD_URL}: ` +
        'соединение отклонено — сервер не запущен или порт закрыт',
    );
  });

  it('пустой метки нет — форма нового подключения тоже называет адрес', () => {
    const text = describeConnectFailure(refusedError(), { baseUrl: DEAD_URL });
    assert.equal(
      text,
      `Не удалось подключиться к серверу ${DEAD_URL}: ` +
        'соединение отклонено — сервер не запущен или порт закрыт',
    );
  });

  it('причины различимы: таймаут, DNS, недоступность сети, сброс, прочее', () => {
    const expected: Record<string, string> = {
      timeout: 'сервер не ответил за отведённое время',
      dns: 'адрес не найден — проверьте имя хоста',
      unreachable: 'сервер недоступен по сети — проверьте подключение',
      reset: 'соединение сброшено сервером',
      other: 'не удалось определить причину отказа',
    };
    for (const [reason, phrase] of Object.entries(expected)) {
      const err = new EtnError('INTERNAL', 'Сетевая ошибка: fetch failed', {
        kind: 'connect-failed',
        reason,
      });
      const text = describeConnectFailure(err, { baseUrl: DEAD_URL });
      assert.equal(text, `Не удалось подключиться к серверу ${DEAD_URL}: ${phrase}`);
    }
  });

  it('сброс соединения — самостоятельная причина со словом «сброс» (390e9746)', () => {
    // Решение заказчика: сброс сокета (undici UND_ERR_SOCKET «other side
    // closed» и родственные) — не общая «недоступность», пользователь должен
    // видеть факт сброса.
    const err = new EtnError('INTERNAL', 'Сетевая ошибка: fetch failed', {
      kind: 'connect-failed',
      reason: 'reset',
    });
    const text = describeConnectFailure(err, { baseUrl: DEAD_URL });
    assert.equal(text, `Не удалось подключиться к серверу ${DEAD_URL}: соединение сброшено сервером`);
    assert.match(text, /сброс|сброшено/);
  });

  it('отказ в доступе — из кода сервера, а не «сервер недоступен»', () => {
    const denied = describeConnectFailure(
      new EtnError('UNAUTHORIZED', 'Недействительный или отсутствующий API-key.'),
      { label: LABEL, baseUrl: DEAD_URL },
    );
    assert.equal(
      denied,
      `Не удалось подключиться к серверу «${LABEL}» (${DEAD_URL}): ` +
        'сервер отклонил API-key — проверьте ключ',
    );

    const throttled = describeConnectFailure(new EtnError('RATE_LIMITED', 'Слишком много'), {
      baseUrl: DEAD_URL,
    });
    assert.match(throttled, /слишком много неудачных попыток входа/);
  });

  it('структурный разбор: конверт IPC/plain-объект и неизвестная причина', () => {
    const plain = {
      code: 'INTERNAL',
      message: 'Сетевая ошибка: fetch failed',
      details: { kind: 'connect-failed', reason: 'dns' },
    };
    assert.match(describeConnectFailure(plain, { baseUrl: DEAD_URL }), /адрес не найден/);
    // Незнакомая причина не превращается в пустоту и не выдумывается.
    const unknown = {
      code: 'INTERNAL',
      message: 'x',
      details: { kind: 'connect-failed', reason: 'quasar' },
    };
    assert.match(describeConnectFailure(unknown, { baseUrl: DEAD_URL }), /не удалось определить причину отказа/);
  });

  it('унаследованные ключи reason из серверных details не дают мусор (2edf8494)', () => {
    // `reason in REASON_KEYS` пропускал `toString`/`__proto__`: в UI попадал
    // «function toString() { [native code] }» / «[object Object]». Теперь
    // проверяются только СОБСТВЕННЫЕ ключи карты — честный `other`.
    const garbage = /function|\[object Object\]/;
    for (const reason of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      const err = new EtnError('INTERNAL', 'Сетевая ошибка: fetch failed', {
        kind: 'connect-failed',
        reason,
      });
      const text = describeConnectFailure(err, { baseUrl: DEAD_URL });
      assert.equal(
        text,
        `Не удалось подключиться к серверу ${DEAD_URL}: не удалось определить причину отказа`,
        `reason «${reason}» — нейтральная причина`,
      );
      assert.equal(garbage.test(text), false, `мусор в сообщении: «${text}»`);
    }
  });

  it('серверный текст бизнес-ошибки сохраняется, технические огрызки — нет', () => {
    const business = describeConnectFailure(
      new EtnError('VALIDATION_ERROR', 'Версия сервера несовместима с клиентом.'),
      { baseUrl: DEAD_URL },
    );
    assert.equal(
      business,
      `Не удалось подключиться к серверу ${DEAD_URL}: Версия сервера несовместима с клиентом.`,
    );

    const raw = describeConnectFailure(new Error('HTTP 404: <html>not found</html>'), {
      baseUrl: DEAD_URL,
    });
    assert.equal(
      raw,
      `Не удалось подключиться к серверу ${DEAD_URL}: не удалось определить причину отказа`,
    );
  });
});
