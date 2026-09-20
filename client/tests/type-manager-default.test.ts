/**
 * Unit tests for the binding-default column of the thought-type editor
 * (client/src/renderer/screens/type-manager.ts; 0.8.2, ADR «дефолт свойства
 * живёт на привязке», тех.проект 43870285).
 *
 * Колонка «По умолчанию» вкладки «Свойства» — редактор значения без режимов
 * «(общее)»/«частное»: заполнено = дефолт этой привязки, пусто = общее
 * значение стороны (очистка поля снимает override). Чистые хелперы:
 *  - {@link bindingDefaultPayload} — тело `setPropertyDefaultOverride` по виду
 *    значения привязки (связь — набор целей, скаляр — значение).
 *
 * Отбор типов для дефолт-пикера свойства-связи больше не отдельный хелпер: у
 * привязки-источника допустимые цели и у привязки-назначения допустимые
 * источники приходят из реестра привязок противоположной стороны
 * (`EffectiveTypeProperty.allowed_opposite_type_ids`, ошибка a6513df0) и
 * нормализуются общим `linkAllowedTypeIds` — тем же, что у поля значения в
 * редакторе мысли. Правило «сторона → допустимые типы» проверяется юнит-тестом
 * `editor-link-value-filter.test.ts`; здесь — что вкладка «Свойства» редактора
 * типа не вернулась к config-ключам.
 *
 * Pure logic — no DOM (client tests run without jsdom, per the existing
 * convention).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  bindingDefaultPayload,
  collectBindingDefaultWrites,
  type BindingDefaultDraft,
} from '../src/renderer/screens/type-manager.js';

function draft(overrides: Partial<BindingDefaultDraft> = {}): BindingDefaultDraft {
  return {
    propertyId: 'prop-1',
    valueType: 'link',
    initial: null,
    value: null,
    ...overrides,
  };
}

describe('bindingDefaultPayload — дефолт привязки редактора типа (0.8.2)', () => {
  it('свойство-связь: набор целей, пусто — null (общее стороны)', () => {
    assert.deepEqual(bindingDefaultPayload('link', ['t-1', 't-2']), ['t-1', 't-2']);
    assert.equal(bindingDefaultPayload('link', []), null);
    assert.equal(bindingDefaultPayload('link', null), null);
    assert.equal(bindingDefaultPayload('link', undefined), null);
  });

  it('скаляр: значение по виду свойства, пусто — null', () => {
    assert.equal(bindingDefaultPayload('text', 'Москва'), 'Москва');
    assert.equal(bindingDefaultPayload('number', 7), 7);
    assert.equal(bindingDefaultPayload('bool', false), false);
    assert.equal(bindingDefaultPayload('text', ''), null);
    assert.equal(bindingDefaultPayload('text', null), null);
  });
});

describe('collectBindingDefaultWrites — дефолты на «Применить и закрыть» (0.8.2)', () => {
  it('пишет только изменившиеся привязки: заполнение и сброс', () => {
    const writes = collectBindingDefaultWrites(
      [
        draft({ propertyId: 'p-set', initial: null, value: ['t-1'] }),
        draft({ propertyId: 'p-reset', initial: ['t-2'], value: null }),
        draft({ propertyId: 'p-same', initial: ['t-3'], value: ['t-3'] }),
        draft({ propertyId: 'p-untouched', initial: null, value: null }),
      ],
      new Set(['p-set', 'p-reset', 'p-same', 'p-untouched']),
    );
    assert.deepEqual(writes, [
      { propertyId: 'p-set', value: ['t-1'] },
      { propertyId: 'p-reset', value: null },
    ]);
  });

  it('не пишет дефолт свойства, которого больше нет в таблицах', () => {
    const writes = collectBindingDefaultWrites(
      [draft({ propertyId: 'p-gone', initial: null, value: ['t-1'] })],
      new Set(['p-other']),
    );
    assert.deepEqual(writes, []);
  });

  it('скалярное значение сравнивается по телу операции (пустая строка = пусто)', () => {
    const writes = collectBindingDefaultWrites(
      [
        draft({ propertyId: 'p-1', valueType: 'text', initial: null, value: 'Москва' }),
        // '' и null дают одинаковое тело (пусто/сброс) — записи нет.
        draft({ propertyId: 'p-2', valueType: 'text', initial: null, value: '' }),
      ],
      new Set(['p-1', 'p-2']),
    );
    assert.deepEqual(writes, [{ propertyId: 'p-1', value: 'Москва' }]);
  });
});

describe('дефолт-пикер редактора типа — общий источник ограничения (a6513df0)', () => {
  it('берёт допустимые типы из allowed_opposite_type_ids через общий linkAllowedTypeIds', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'type-manager.ts'),
      'utf8',
    );
    assert.ok(
      /linkAllowedTypeIds\(opts\.allowedOppositeTypeIds\)/.test(src),
      'ядро дефолта привязки зовёт общий хелпер отбора',
    );
    assert.ok(
      /allowedOppositeTypeIds: def\.allowed_opposite_type_ids/.test(src),
      'унаследованная таблица берёт набор из определения (реестр привязок)',
    );
    assert.ok(
      /allowedOppositeTypeIds: row\.allowedOppositeTypeIds/.test(src),
      'собственная таблица берёт набор из строки черновика',
    );
    assert.equal(
      /allowed_(target|source)_type_ids/.test(src),
      false,
      'вкладка «Свойства» редактора типа не читает config-ключи ограничения типов',
    );
  });
});
