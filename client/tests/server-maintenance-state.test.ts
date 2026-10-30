/**
 * Состояние обслуживания сервера в главном процессе (задача 479e37ed).
 *
 * Проверяются инварианты модуля: нормализация конверта, идемпотентность
 * повторного входа, сохранение момента начала эпизода, уведомления только на
 * изменения и выход по подтверждению восстановления.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SERVER_MAINTENANCE_RETRY_AFTER_SECONDS,
  ServerMaintenanceState,
  type ServerMaintenanceInfo,
} from '../src/main/server-maintenance.js';

describe('ServerMaintenanceState — обслуживание сервера (479e37ed)', () => {
  it('нормализует конверт: дробный retry_after округляется вверх, пустая версия — null', () => {
    const state = new ServerMaintenanceState(() => 1000);
    const info = state.enter({ retry_after: 12.2, target_version: '  ' }, 'rest');
    assert.deepEqual(info, {
      retry_after: 13,
      target_version: null,
      since: 1000,
      source: 'rest',
    });
    assert.equal(state.isActive(), true);
  });

  it('нечисловой/нулевой retry_after заменяется паузой по умолчанию', () => {
    const state = new ServerMaintenanceState(() => 1);
    assert.equal(
      state.enter({ retry_after: 0, target_version: null }, 'realtime').retry_after,
      DEFAULT_SERVER_MAINTENANCE_RETRY_AFTER_SECONDS,
    );
    const other = new ServerMaintenanceState(() => 1);
    assert.equal(
      other.enter({ retry_after: Number.NaN, target_version: null }, 'rest').retry_after,
      DEFAULT_SERVER_MAINTENANCE_RETRY_AFTER_SECONDS,
    );
  });

  it('повторный вход с теми же значениями не сдвигает начало и не уведомляет', () => {
    let clock = 500;
    const state = new ServerMaintenanceState(() => clock);
    const seen: Array<ServerMaintenanceInfo | null> = [];
    state.subscribe((info) => seen.push(info));

    state.enter({ retry_after: 60, target_version: '0.15.2' }, 'realtime');
    clock = 900;
    const again = state.enter({ retry_after: 60, target_version: '0.15.2' }, 'realtime');

    assert.equal(again.since, 500, 'начало эпизода сохранено');
    assert.equal(seen.length, 1, 'уведомление одно — значения не изменились');
  });

  it('изменившиеся retry_after/target_version доезжают до подписчика', () => {
    const state = new ServerMaintenanceState(() => 1);
    const seen: Array<ServerMaintenanceInfo | null> = [];
    state.subscribe((info) => seen.push(info));

    state.enter({ retry_after: 60, target_version: null }, 'realtime');
    state.enter({ retry_after: 30, target_version: '0.16.0' }, 'rest');

    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.retry_after, 30);
    assert.equal(seen[1]?.target_version, '0.16.0');
    assert.equal(seen[1]?.source, 'rest');
  });

  it('leave возвращает признак восстановления и уведомляет один раз', () => {
    const state = new ServerMaintenanceState(() => 1);
    const seen: Array<ServerMaintenanceInfo | null> = [];
    state.subscribe((info) => seen.push(info));

    assert.equal(state.leave(), false, 'нечего снимать — восстановления не было');
    state.enter({ retry_after: 5, target_version: null }, 'rest');
    assert.equal(state.leave(), true);
    assert.equal(state.leave(), false);
    assert.equal(state.isActive(), false);
    assert.deepEqual(seen, [expectInfo(), null]);
  });

  it('исключение подписчика не ломает состояние и остальных слушателей', () => {
    const state = new ServerMaintenanceState(() => 1);
    let secondCalled = false;
    state.subscribe(() => {
      throw new Error('boom');
    });
    state.subscribe(() => {
      secondCalled = true;
    });
    state.enter({ retry_after: 5, target_version: null }, 'realtime');
    assert.equal(secondCalled, true);
    assert.equal(state.isActive(), true);
  });
});

/** Снимок первого уведомления (значения проверяются в тесте `enter`). */
function expectInfo(): ServerMaintenanceInfo {
  return { retry_after: 5, target_version: null, since: 1, source: 'rest' };
}
