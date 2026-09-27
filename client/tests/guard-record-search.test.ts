/**
 * Сторож «Строка поиска записей — один переиспользуемый компонент»
 * (0.10.1, задача 46057359, требование 6).
 *
 * Правило: строка поиска дневниковых записей собирается ТОЛЬКО общим модулем
 * `lib/record-search.ts`. Экран (или будущий второй экран) не заводит ни
 * собственную модель настроек строки, ни свою функцию монтирования: иначе
 * поведение поиска записей разойдётся по экранам — а требование прямо
 * фиксирует «одинаковое поведение на любых экранах».
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertGuardClean, collectViolations } from './guard-helpers.js';

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'renderer',
);

/** Единственный разрешённый дом компонента строки поиска записей. */
const COMPONENT = 'lib/record-search.ts';

/** Признак второго монтирования строки поиска записей. */
const SECOND_MOUNT = /^(?:export\s+)?(?:async\s+)?function\s+mountRecordSearch\b/;

/** Признак второй модели настроек строки. */
const SECOND_SETTINGS_MODEL = /^(?:export\s+)?interface\s+RecordSearchSettings\b/;

/** Признак второго парсера/сериализатора настроек строки. */
const SECOND_SETTINGS_CODEC =
  /^(?:export\s+)?(?:function|const)\s+(?:parseRecordSearchSettings|serializeRecordSearchSettings|defaultRecordSearchSettings)\b/;

describe('guard: строка поиска записей — один переиспользуемый компонент', () => {
  it('второе монтирование строки поиска записей вне lib/record-search.ts запрещено', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-record-search-mount',
        description:
          'Строку поиска записей собирает только lib/record-search.ts ' +
          '(требование 46057359, п.6): своя сборка в экране разойдётся ' +
          'поведением с общим компонентом.',
        pattern: SECOND_MOUNT,
        allow: (rel) => rel === COMPONENT,
      },
    ]);
  });

  it('вторая модель настроек строки поиска записей запрещена', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'no-second-record-search-settings',
        description:
          'Модель настроек строки (`RecordSearchSettings`) и её парсер/' +
          'сериализатор живут только в lib/record-search.ts: общая модель — ' +
          'условие одинакового поведения на разных экранах.',
        pattern: SECOND_SETTINGS_MODEL,
        allow: (rel) => rel === COMPONENT,
      },
      {
        name: 'no-second-record-search-codec',
        description:
          'Парсер/сериализатор настроек строки (`parseRecordSearchSettings`/' +
          '`serializeRecordSearchSettings`/`defaultRecordSearchSettings`) ' +
          'объявляются только в lib/record-search.ts.',
        pattern: SECOND_SETTINGS_CODEC,
        allow: (rel) => rel === COMPONENT,
      },
    ]);
  });

  it('правила краснеют на умышленном нарушении', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-guard-record-search-'));
    try {
      fs.mkdirSync(path.join(dir, 'screens', 'fake'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'screens', 'fake', 'panel.ts'),
        [
          'export interface RecordSearchSettings {',
          '  includeInactive: boolean;',
          '}',
          'export function parseRecordSearchSettings(raw: unknown): RecordSearchSettings {',
          '  return { includeInactive: raw === true };',
          '}',
          'export function mountRecordSearch(): void {}',
        ].join('\n'),
        'utf8',
      );
      const names = new Set(
        collectViolations(dir, [
          { name: 'no-second-record-search-mount', description: '', pattern: SECOND_MOUNT },
          { name: 'no-second-record-search-settings', description: '', pattern: SECOND_SETTINGS_MODEL },
          { name: 'no-second-record-search-codec', description: '', pattern: SECOND_SETTINGS_CODEC },
        ]).map((v) => v.rule),
      );
      assert.ok(names.has('no-second-record-search-mount'), 'своё монтирование — нарушение');
      assert.ok(names.has('no-second-record-search-settings'), 'своя модель — нарушение');
      assert.ok(names.has('no-second-record-search-codec'), 'свой парсер — нарушение');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
