/**
 * Тесты канала «перечитать значения свойств открытой карточки» (ошибка
 * ec5ba58c): имя события, полезная нагрузка и безопасность вне DOM.
 *
 * Сам сценарий «своя запись → список значений обновлён» держится на двух
 * концах канала: производители (значение свойства-связи из редактора, сверка
 * окрестности на холсте) и слушатель (таблица свойств). Здесь проверяется
 * общий контракт канала; проводка концов закреплена тестом
 * `zone-reconcile-wiring.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  notifyPropertyValuesRefreshed,
  PROPERTY_VALUES_REFRESHED_EVENT,
} from '../src/renderer/lib/property-values-refresh.js';

interface CapturedEvent {
  type: string;
  detail: unknown;
}

describe('канал перечитывания значений свойств', () => {
  it('вне DOM вызов безопасен', () => {
    // Node-окружение юнит-тестов: ни `document`, ни `CustomEvent` нет.
    assert.doesNotThrow(() => notifyPropertyValuesRefreshed('Связь'));
  });

  it('шлёт событие документа с ключом свойства', () => {
    const captured: CapturedEvent[] = [];
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousDocument = globals['document'];
    const previousCustomEvent = globals['CustomEvent'];
    globals['CustomEvent'] = class {
      constructor(
        public type: string,
        public init?: { detail?: unknown },
      ) {}
    };
    globals['document'] = {
      dispatchEvent: (event: { type: string; init?: { detail?: unknown } }) => {
        captured.push({ type: event.type, detail: event.init?.detail });
        return true;
      },
    };
    try {
      notifyPropertyValuesRefreshed('Связь');
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.type, PROPERTY_VALUES_REFRESHED_EVENT);
      assert.deepEqual(captured[0]?.detail, { key: 'Связь' });
      // Холст ключа не знает — шлёт «перечитать всё».
      notifyPropertyValuesRefreshed();
      assert.deepEqual(captured[1]?.detail, { key: '' });
    } finally {
      globals['document'] = previousDocument;
      globals['CustomEvent'] = previousCustomEvent;
    }
  });
});
