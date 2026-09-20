/**
 * Юнит-тесты полей общих дефолтов редактора свойства-связи (задача 99312ffa).
 *
 * Решение пользователя (2026-09-20): поля общих дефолтов сторон называются
 * «Значение по умолчанию для всех типов» и стоят **сразу под** своими
 * таблицами («Типы источников» / «Типы назначений»); тултипы — дословно по
 * решению; на оба поля распространяются ограничения типов противоположной
 * таблицы (та же модель a6513df0, что у колонки «Значение по умолчанию» строк
 * таблиц). Источник ограничения — живой черновик (`draft.typeRows`), пусто —
 * без ограничений.
 *
 * Чистая логика: {@link commonSideDefaultSpec} и {@link linkSideColumnParts}
 * не трогают DOM, поэтому тесты идут без jsdom (как прочие тесты
 * property-manager). Связка рендера со спецификацией проверяется по исходнику,
 * как в editor-link-value-filter.test.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  COMMON_SIDE_DEFAULT_LABEL,
  commonSideDefaultSpec,
  linkSideColumnParts,
  type TypeRowDraft,
} from '../src/renderer/screens/property-manager.js';

/** Строка таблицы привязок для тестов. */
function makeRow(overrides: Partial<TypeRowDraft> = {}): TypeRowDraft {
  return {
    id: 'bind-1',
    thoughtTypeId: 'tt-1',
    required: false,
    defaultValue: null,
    side: 'source',
    dirty: false,
    initialDefaultValue: null,
    ...overrides,
  };
}

describe('commonSideDefaultSpec — подпись и тултип (задача 99312ffa)', () => {
  it('подпись одинаковая у обеих сторон: «Значение по умолчанию для всех типов»', () => {
    assert.equal(COMMON_SIDE_DEFAULT_LABEL, 'Значение по умолчанию для всех типов');
    assert.equal(commonSideDefaultSpec([], 'source').label, COMMON_SIDE_DEFAULT_LABEL);
    assert.equal(commonSideDefaultSpec([], 'target').label, COMMON_SIDE_DEFAULT_LABEL);
  });

  it('тултип под «Типами источников» — дословно', () => {
    assert.equal(
      commonSideDefaultSpec([], 'source').tooltip,
      'Значение по умолчанию для источников любых типов. Может быть переопределено значениями в строках таблицы выше',
    );
  });

  it('тултип под «Типами назначений» — дословно', () => {
    assert.equal(
      commonSideDefaultSpec([], 'target').tooltip,
      'Значение по умолчанию для назначений любых типов. Может быть переопределено значениями в строках таблицы выше',
    );
  });
});

describe('commonSideDefaultSpec — ограничения типов из противоположной таблицы (99312ffa)', () => {
  it('дефолт источников фильтруется по типам назначений', () => {
    const rows = [
      makeRow({ thoughtTypeId: 'tt-src', side: 'source' }),
      makeRow({ thoughtTypeId: 'tt-dst-a', side: 'target' }),
      makeRow({ thoughtTypeId: 'tt-dst-b', side: 'target' }),
    ];
    assert.deepEqual(commonSideDefaultSpec(rows, 'source').allowedTypeIds, ['tt-dst-a', 'tt-dst-b']);
  });

  it('дефолт назначений фильтруется по типам источников', () => {
    const rows = [
      makeRow({ thoughtTypeId: 'tt-src-a', side: 'source' }),
      makeRow({ thoughtTypeId: 'tt-src-b', side: 'source' }),
      makeRow({ thoughtTypeId: 'tt-dst', side: 'target' }),
    ];
    assert.deepEqual(commonSideDefaultSpec(rows, 'target').allowedTypeIds, ['tt-src-a', 'tt-src-b']);
  });

  it('пустая противоположная таблица — без ограничений', () => {
    const onlyTarget = [makeRow({ thoughtTypeId: 'tt-dst', side: 'target' })];
    assert.deepEqual(commonSideDefaultSpec(onlyTarget, 'target').allowedTypeIds, []);
    const onlySource = [makeRow({ thoughtTypeId: 'tt-src', side: 'source' })];
    assert.deepEqual(commonSideDefaultSpec(onlySource, 'source').allowedTypeIds, []);
    assert.deepEqual(commonSideDefaultSpec([], 'source').allowedTypeIds, []);
  });

  it('дубли и пустые id отбрасываются', () => {
    const rows = [
      makeRow({ thoughtTypeId: 'tt-dst', side: 'target' }),
      makeRow({ thoughtTypeId: 'tt-dst', side: 'target' }),
      makeRow({ thoughtTypeId: '', side: 'target' }),
    ];
    assert.deepEqual(commonSideDefaultSpec(rows, 'source').allowedTypeIds, ['tt-dst']);
  });
});

describe('linkSideColumnParts — общий дефолт сразу под своей таблицей (99312ffa)', () => {
  it('порядок частей: имя стороны → таблица типов → общий дефолт', () => {
    const nameField = { id: 'name' } as unknown as HTMLElement;
    const tableHost = { id: 'table' } as unknown as HTMLElement;
    const commonDefaultHost = { id: 'default' } as unknown as HTMLElement;
    assert.deepEqual(
      linkSideColumnParts({ nameField, tableHost, commonDefaultHost }),
      [nameField, tableHost, commonDefaultHost],
    );
  });
});

describe('renderLinkBody — связка рендера со спецификацией (99312ffa)', () => {
  const src = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'property-manager.ts'),
    'utf8',
  );

  it('старые названия полей больше не встречаются', () => {
    assert.equal(
      /Общее для источников|Общее для назначений/.test(src),
      false,
      'поля переименованы в «Значение по умолчанию для всех типов»',
    );
  });

  it('обе колонки собираются через linkSideColumnParts с общим дефолтом своей стороны', () => {
    assert.ok(/linkSideColumnParts\(\{/.test(src), 'колонки сторон используют общий порядок частей');
    assert.ok(
      /commonDefaultHost: sourceDefaultsHost/.test(src),
      'под «Типами источников» — общий дефолт источников',
    );
    assert.ok(
      /commonDefaultHost: targetDefaultsHost/.test(src),
      'под «Типами назначений» — общий дефолт назначений',
    );
    assert.ok(
      /buildCommonSideDefaultField\('source'\)/.test(src) &&
        /buildCommonSideDefaultField\('target'\)/.test(src),
      'дефолты обеих сторон строятся общим билдером',
    );
  });

  it('общий дефолт получает отбор по противоположной таблице из живой спецификации', () => {
    assert.ok(
      /allowed_opposite_type_ids:\s*spec\.allowedTypeIds/.test(src),
      'пикер общего дефолта фильтруется по allowedTypeIds спецификации',
    );
    assert.ok(
      /commonSideDefaultSpec\(draft\.typeRows,\s*side\)/.test(src),
      'источник ограничения — живой черновик draft.typeRows',
    );
  });

  it('правка строк таблиц пересобирает общие дефолты (onRowsChanged)', () => {
    assert.ok(/onRowsChanged\?\.\(\)/.test(src), 'add/removeRow уведомляют об изменении строк');
    assert.ok(/refreshCommonDefaults/.test(src), 'общие дефолты пересобираются по уведомлению');
  });
});
