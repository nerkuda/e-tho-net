/**
 * Сторож строки версий блокирующего диалога (ошибка ff1c5e44, элемент
 * интерфейса 8623b9ff, требование 92ba29de, сущность 89aad200).
 *
 * **Правило.** Третий элемент строки фактов — «требуется» — это диапазон той
 * стороны, которой не соответствует вторая:
 *
 *  - `server-outdated` (сервер старше клиента) — встроенный диапазон КЛИЕНТА
 *    `clientCompatibility` (`>=0.15.0 <0.16.0`): именно он объясняет блокировку
 *    и говорит администратору, какую версию сервера ставить;
 *  - `client-outdated`, включая `426 CLIENT_VERSION_UNSUPPORTED` — диапазон
 *    СЕРВЕРА `serverCompatibility` (`>=0.16.0 <0.17.0`): какого клиента
 *    допускает сервер.
 *
 * **Симптом регресса.** `compatibilityFactsText` подставляла
 * `serverCompatibility` для всех статусов. У уже выпущенного сервера 0.14.1
 * это `client_compatibility = ">=0.1.0"` — диапазон КЛИЕНТОВ старого сервера;
 * он противоречил причине «сервер старше клиента» (клиент 0.15.1 ему
 * удовлетворяет) и не подсказывал требуемую версию сервера (S2:
 * «Клиент 0.15.1, сервер 0.14.1, требуется >=0.1.0»).
 *
 * **Мутации, которые краснят:**
 *  - вернуть безусловную подстановку `text(result.serverCompatibility)` в
 *    `compatibilityFactsText` — краснеют behavioral-кейсы `server-outdated`;
 *  - заменить диапазон клиента на диапазон сервера только при пустом
 *    `clientCompatibility` — краснеет кейс «неизвестно, а не чужой диапазон»;
 *  - перепутать стороны для `client-outdated` — краснеет симметричный кейс.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CompatibilityResult } from '../src/main/ipc/contract.js';
import {
  compatibilityFactsText,
  compatibilityReasonKey,
  compatibilityReasonText,
} from '../src/renderer/lib/compatibility-reason.js';
import { t } from '../src/renderer/lib/i18n.js';

const CLIENT = '0.15.1';
/** Встроенный диапазон клиента 0.15.1 — требуемый диапазон СЕРВЕРА. */
const CLIENT_RANGE = '>=0.15.0 <0.16.0';
/** Диапазон КЛИЕНТОВ, который объявляет уже выпущенный сервер 0.14.1. */
const OLD_SERVER_CLIENT_RANGE = '>=0.1.0';
/** Диапазон КЛИЕНТОВ сервера 0.16.0 — требуемый диапазон КЛИЕНТА. */
const SERVER_CLIENT_RANGE = '>=0.16.0 <0.17.0';

/** Вердикт с реалистичными значениями S2 (живой прогон 2026-10-30). */
function verdict(overrides: Partial<CompatibilityResult> = {}): CompatibilityResult {
  return {
    status: 'server-outdated',
    banner: 'hidden',
    blocking: true,
    reason: 'server-outdated',
    clientVersion: CLIENT,
    clientCompatibility: CLIENT_RANGE,
    serverVersion: '0.14.1',
    serverCompatibility: OLD_SERVER_CLIENT_RANGE,
    recommendedClientVersion: null,
    downloadUrl: null,
    roleConfirmed: true,
    is_admin: true,
    serverReason: null,
    ...overrides,
  };
}

/** Третий элемент строки фактов (требуемый диапазон). */
function requiredRange(result: CompatibilityResult): string {
  // Версии сторон заменяются короткими метками: отрезаем словарный префикс и
  // получаем ровно то, что попало в «требуется %3», не завися от формулировки.
  const card: CompatibilityResult = { ...result, clientVersion: 'C', serverVersion: 'S' };
  const prefix = t('compatibility.facts', ['C', 'S', '']);
  const text = compatibilityFactsText(card);
  assert.ok(text.startsWith(prefix), `строка фактов начинается с «${prefix}»`);
  return text.slice(prefix.length);
}

describe('guard: строка фактов называет требуемый диапазон своей стороны (ff1c5e44)', () => {
  it('server-outdated: требуется встроенный диапазон клиента, а не диапазон клиентов сервера', () => {
    const result = verdict();
    const facts = compatibilityFactsText(result);
    assert.equal(
      requiredRange(result),
      CLIENT_RANGE,
      'в «требуется» — диапазон сервера, который принимает клиент',
    );
    assert.equal(
      facts,
      t('compatibility.facts', [CLIENT, '0.14.1', CLIENT_RANGE]),
      'строка версий целиком',
    );
    assert.equal(
      facts.includes(OLD_SERVER_CLIENT_RANGE),
      false,
      'диапазон клиентов старого сервера в строку не попадает',
    );
    assert.equal(
      compatibilityReasonKey(result),
      'compatibility.reason.serverOutdated',
      'текст согласован с причиной: сервер старше клиента',
    );
    assert.ok(compatibilityReasonText(result).includes('Сервер старше клиента'));
  });

  it('server-outdated без диапазона клиента: «неизвестно», а не чужой диапазон сервера', () => {
    const result = verdict({ clientCompatibility: null });
    assert.equal(
      requiredRange(result),
      t('compatibility.value.unknown'),
      'недостоверный диапазон — честное «неизвестно»',
    );
    assert.equal(
      compatibilityFactsText(result).includes(OLD_SERVER_CLIENT_RANGE),
      false,
      'подстановки диапазона клиентов сервера нет и в этом случае',
    );
  });

  it('client-outdated: требуется диапазон клиентов сервера (симметричная ветка)', () => {
    const result = verdict({
      status: 'client-outdated',
      reason: 'client-outdated',
      clientVersion: '0.14.1',
      clientCompatibility: '>=0.14.0 <0.15.0',
      serverVersion: '0.15.1',
      serverCompatibility: SERVER_CLIENT_RANGE,
    });
    assert.equal(requiredRange(result), SERVER_CLIENT_RANGE);
    assert.equal(
      compatibilityFactsText(result).includes('>=0.14.0 <0.15.0'),
      false,
      'диапазон клиента в «требуется» не подставляется',
    );
  });

  it('426 CLIENT_VERSION_UNSUPPORTED: требуется диапазон из details сервера', () => {
    const result = verdict({
      status: 'client-outdated',
      reason: 'client-outdated',
      serverVersion: null,
      serverCompatibility: SERVER_CLIENT_RANGE,
      serverReason: 'version-out-of-range',
    });
    assert.equal(requiredRange(result), SERVER_CLIENT_RANGE);
    assert.equal(compatibilityReasonKey(result), 'compatibility.reason.versionOutOfRange');
  });

  it('других подстановок диапазона в строке фактов нет (исходник)', () => {
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'renderer',
        'lib',
        'compatibility-reason.ts',
      ),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /text\(\s*result\.serverCompatibility\s*\)/,
      'безусловная подстановка serverCompatibility — регресс ff1c5e44',
    );
    assert.match(
      source,
      /result\.status\s*===\s*'server-outdated'/,
      'выбор диапазона обязан зависеть от статуса server-outdated',
    );
    assert.match(source, /clientCompatibility/, 'диапазон клиента читается');
    assert.match(source, /serverCompatibility/, 'диапазон сервера читается');
  });
});
