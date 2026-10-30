/**
 * Единый текст состояния обслуживания сервера (задача 479e37ed).
 *
 * Одна и та же фраза показывается в индикаторе статус-бара, тосте входа в
 * обслуживание и предупреждении о потерянной связи — поэтому она вынесена в
 * общий помощник и проверяется здесь: `retry_after` переводится в секунды без
 * технических терминов, отсутствие срока даёт отдельную формулировку.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serverMaintenanceText } from '../src/renderer/lib/server-maintenance-text.js';

describe('serverMaintenanceText — единая фраза обслуживания (479e37ed)', () => {
  it('обслуживания нет — текста нет', () => {
    assert.equal(serverMaintenanceText(null), null);
    assert.equal(serverMaintenanceText({ active: false }), null);
  });

  it('срок из retry_after подставляется числом секунд', () => {
    assert.equal(
      serverMaintenanceText({ active: true, retry_after: 30 }),
      'Сервер обновляется, вернётся примерно через 30 с',
    );
  });

  it('без пригодного срока — формулировка без числа', () => {
    assert.equal(
      serverMaintenanceText({ active: true }),
      'Сервер обновляется, ожидаем восстановления',
    );
    assert.equal(
      serverMaintenanceText({ active: true, retry_after: 0 }),
      'Сервер обновляется, ожидаем восстановления',
    );
  });

  it('текст не путает обслуживание с недоступностью сервера', () => {
    const text = serverMaintenanceText({ active: true, retry_after: 12 }) ?? '';
    assert.doesNotMatch(text, /недоступен|нет соединения|ошибк/i);
  });
});
