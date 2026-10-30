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
  isMaintenanceEndedByVersion,
  type ServerMaintenanceInfo,
} from '../src/main/server-maintenance.js';

describe('ServerMaintenanceState — обслуживание сервера (479e37ed)', () => {
  it('нормализует конверт: дробный retry_after округляется вверх, пустая версия — null', () => {
    const state = new ServerMaintenanceState(() => 1000);
    const info = state.enter({ retry_after: 12.2, target_version: '  ' }, 'rest');
    assert.deepEqual(info, {
      retry_after: 13,
      target_version: null,
      entry_version: null,
      since: 1000,
      source: 'rest',
    });
    assert.equal(state.isActive(), true);
  });

  it('версия процесса на входе фиксируется первым непустым значением эпизода', () => {
    const state = new ServerMaintenanceState(() => 1);
    // Первый вход (кадр без известной версии) — базовой ещё нет.
    state.enter({ retry_after: 60, target_version: null }, 'realtime');
    // Второй вход того же эпизода доносит версию от проверки совместимости.
    state.enter({ retry_after: 60, target_version: null }, 'rest', '0.15.1');
    assert.equal(state.get()?.entry_version, '0.15.1');
    // Третий вход НЕ перезаписывает базу: после обновления `/version` вернёт
    // новую версию, и подмена базы выдала бы «смены не было».
    state.enter({ retry_after: 60, target_version: null }, 'rest', '0.15.2');
    assert.equal(state.get()?.entry_version, '0.15.1', 'база эпизода неизменна');
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
  return { retry_after: 5, target_version: null, entry_version: null, since: 1, source: 'rest' };
}

/**
 * Выход из обслуживания по успешному `GET /me` (вердикт повторной приёмки
 * 479e37ed). `/me` — чтение, сервер в обслуживании отвечает на него 200:
 * доказательством конца обслуживания служит только смена версии процесса.
 */
describe('isMaintenanceEndedByVersion — правило выхода по /me (479e37ed)', () => {
  const entry = { target_version: null, entry_version: '0.15.1' } as const;

  it('та же версия процесса — НЕ выход (сервер в обслуживании отвечает на /me 200)', () => {
    assert.equal(isMaintenanceEndedByVersion(entry, '0.15.1'), false);
  });

  it('версия процесса изменилась — выход (target_version неизвестна)', () => {
    assert.equal(isMaintenanceEndedByVersion(entry, '0.15.2'), true);
  });

  it('target_version известна: версия не меньше неё — выход', () => {
    const withTarget = { target_version: '0.15.2', entry_version: '0.15.1' } as const;
    assert.equal(isMaintenanceEndedByVersion(withTarget, '0.15.2'), true);
    assert.equal(isMaintenanceEndedByVersion(withTarget, '0.15.10'), true, 'сравнение числовое, не строковое');
    assert.equal(isMaintenanceEndedByVersion(withTarget, '0.16.0'), true);
  });

  it('target_version известна, версия ниже и не менялась — НЕ выход', () => {
    const withTarget = { target_version: '0.15.2', entry_version: '0.15.1' } as const;
    assert.equal(isMaintenanceEndedByVersion(withTarget, '0.15.1'), false);
    // Другая версия процесса (например откат на более старую) — уже выход:
    // обслуживание закончилось другим процессом, а не тем, что его объявил.
    assert.equal(isMaintenanceEndedByVersion(withTarget, '0.15.0-rc.1'), true);
  });

  it('версия процесса отличается от базы и при известной target — выход', () => {
    // Сервер мог обновиться на версию, которую не объявлял в кадре.
    const withTarget = { target_version: '0.15.2', entry_version: '0.15.1' } as const;
    assert.equal(isMaintenanceEndedByVersion(withTarget, '0.15.3'), true);
  });

  it('версия не прочитана или база неизвестна — НЕ выход: без доказательства состояние остаётся', () => {
    assert.equal(isMaintenanceEndedByVersion(entry, null), false);
    assert.equal(isMaintenanceEndedByVersion({ target_version: null, entry_version: null }, '0.15.2'), false);
    assert.equal(isMaintenanceEndedByVersion({ target_version: null, entry_version: null }, null), false);
  });

  it('неразборчивая target_version не даёт ложного выхода: решает смена версии от базы', () => {
    const weird = { target_version: 'garbage', entry_version: '0.15.1' } as const;
    assert.equal(isMaintenanceEndedByVersion(weird, '0.15.1'), false);
    assert.equal(isMaintenanceEndedByVersion(weird, '0.15.2'), true);
  });
});
