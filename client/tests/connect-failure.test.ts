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

import { CLIENT_VERSION_ERROR_REASON, EtnError } from '@etn/shared';

import { describeConnectFailure } from '../src/renderer/lib/connect-failure.js';
import type { CompatibilityResult } from '../src/main/ipc/contract.js';

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

describe('describeConnectFailure: несовместимые версии (0afec967)', () => {
  /** Вердикт проверки совместимости в том виде, в каком его кладёт main. */
  function verdict(overrides: Partial<CompatibilityResult> = {}): CompatibilityResult {
    return {
      status: 'client-outdated',
      banner: 'hidden',
      blocking: true,
      reason: 'client-outdated',
      clientVersion: '0.15.1',
      clientCompatibility: '>=0.15.0 <0.16.0',
      serverVersion: '0.16.0',
      serverCompatibility: '>=0.16.0 <0.17.0',
      recommendedClientVersion: null,
      downloadUrl: null,
      roleConfirmed: true,
      is_admin: false,
      serverReason: null,
      ...overrides,
    };
  }

  /** Отказ подключения, как его бросает `verifyCompatibilityOnConnect`. */
  function refusal(result: CompatibilityResult): EtnError {
    return new EtnError(
      'CLIENT_VERSION_UNSUPPORTED',
      `Клиент ${result.clientVersion} несовместим с сервером: технический текст main.`,
      { kind: 'client-compatibility', result },
    );
  }

  it('client-outdated: человеческая причина и версии вместо технической строки main', () => {
    const text = describeConnectFailure(refusal(verdict()), { baseUrl: DEAD_URL });
    assert.equal(
      text,
      `Не удалось подключиться к серверу ${DEAD_URL}: ` +
        'версии несовместимы — Клиент не подходит серверу — работа с этим сервером ' +
        'невозможна. Клиент 0.15.1, сервер 0.16.0, требуется >=0.16.0 <0.17.0',
    );
    assert.equal(
      text.includes('технический текст main'),
      false,
      'техническое сообщение main в интерфейс не попадает',
    );
  });

  it('server-outdated: сервер старше клиента, диапазон клиента назван', () => {
    const text = describeConnectFailure(
      refusal(
        verdict({
          status: 'server-outdated',
          reason: 'server-outdated',
          serverVersion: '0.14.1',
          serverCompatibility: null,
        }),
      ),
      { label: LABEL, baseUrl: DEAD_URL },
    );
    assert.equal(
      text,
      `Не удалось подключиться к серверу «${LABEL}» (${DEAD_URL}): ` +
        'версии несовместимы — Сервер старше клиента — работа с этим сервером невозможна. ' +
        'Клиент 0.15.1, сервер 0.14.1, требуется неизвестно',
    );
  });

  it('причина берётся из details.reason сервера — все три различаются', () => {
    const expected: Array<[string, RegExp]> = [
      [CLIENT_VERSION_ERROR_REASON.missing, /Сервер не получил версию клиента/],
      [CLIENT_VERSION_ERROR_REASON.invalid, /не смог разобрать присланную версию/],
      [CLIENT_VERSION_ERROR_REASON.outOfRange, /вне диапазона, допущенного сервером/],
    ];
    const texts = new Set<string>();
    for (const [reason, pattern] of expected) {
      const text = describeConnectFailure(refusal(verdict({ serverReason: reason as never })), {
        baseUrl: DEAD_URL,
      });
      assert.match(text, pattern, `причина ${reason} названа`);
      texts.add(text);
    }
    assert.equal(texts.size, 3, 'формулировки причин различаются');
  });

  it('битые details не ломают сообщение: остаётся серверный текст', () => {
    const broken = new EtnError('CLIENT_VERSION_UNSUPPORTED', 'Сервер отклонил версию клиента.', {
      kind: 'client-compatibility',
      result: null,
    });
    assert.equal(
      describeConnectFailure(broken, { baseUrl: DEAD_URL }),
      `Не удалось подключиться к серверу ${DEAD_URL}: Сервер отклонил версию клиента.`,
    );
  });
});
