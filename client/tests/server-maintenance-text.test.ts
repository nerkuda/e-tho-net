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

import { activeServerMaintenanceText, serverMaintenanceText } from '../src/renderer/lib/server-maintenance-text.js';

describe('serverMaintenanceText — единая фраза обслуживания (479e37ed)', () => {
  it('обслуживания нет — текста нет', () => {
    assert.equal(serverMaintenanceText(null), null);
    assert.equal(serverMaintenanceText({ active: false }), null);
  });

  it('активный текст всегда есть: неактивное состояние отсекает serverMaintenanceText', () => {
    // `activeServerMaintenanceText` зовут только после проверки `active`, поэтому
    // у него нет «пустой» ветки, а у индикатора — недостижимого fallback
    // (замечание приёмки: `?? t('realtime.tip.maintenanceNoRetry')`).
    assert.equal(
      activeServerMaintenanceText({ active: true, retry_after: 300 }),
      serverMaintenanceText({ active: true, retry_after: 300 }),
    );
    assert.equal(
      activeServerMaintenanceText({ active: true }),
      serverMaintenanceText({ active: true }),
    );
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
