/**
 * Сторож общего списка свойств (задача 6ebde54e, версия 0.8.2).
 *
 * Правила, введённые задачей:
 *  1. Список свойств — один общий модуль `lib/property-list.ts`; параллельных
 *     построителей строк в экранах нет (`buildAttachEntries` исчез,
 *     локальные сортировка/фильтр реестра исчезли).
 *  2. В строках списка нет кнопки-крестика удаления — удаление живёт в
 *     контекстном меню.
 *  3. Команда меню «Мыслесеть» называется «Свойства» (не «Свойства и связи»).
 *
 * Мета-стандарт «Правило без теста-сторожа не считается введённым»; сторож
 * подключён зелёным в том же изменении, которое вводит правила.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { assertGuardClean } from './guard-helpers.js';

const RENDERER_ROOT = resolve(import.meta.dirname, '..', 'src', 'renderer');

describe('сторож общего списка свойств (задача 6ebde54e)', () => {
  it('в экранах нет параллельных построителей/фильтров списка свойств', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'second-property-row-builder',
        description:
          'второй построитель строк свойств: список строится общим модулем ' +
          'lib/property-list.ts (buildPropertyListRows), локальные — запрещены',
        pattern: /(?:export\s+)?function\s+(?:buildAttachEntries|attachEntryBlockReason|sortRegistryRows|annotateRows|filterRegistryRows)\b/,
      },
    ]);
  });

  it('в строках списка нет кнопки-крестика удаления', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'property-list-delete-cross',
        description:
          'крестик удаления в строке общего списка свойств: удаление — командой ' +
          'контекстного меню, а не кнопкой (задача 6ebde54e, требование 8)',
        pattern: /button\('✕'/,
        include: (rel) => rel === 'lib/property-list.ts',
      },
    ]);
  });

  it('команда меню «Мыслесеть» называется «Свойства»', () => {
    assertGuardClean(RENDERER_ROOT, [
      {
        name: 'property-menu-old-label',
        description:
          'старая подпись «Свойства и связи»: в 0.8.2 команда снова «Свойства» ' +
          '(задача 6ebde54e)',
        pattern: /'Свойства и связи'/,
        include: (rel) => rel === 'screens/workspace-menus.ts',
      },
    ]);
  });

  it('оба потребителя берут список из общего модуля', () => {
    for (const file of ['screens/property-manager.ts', 'screens/type-manager.ts']) {
      const src = readFileSync(resolve(RENDERER_ROOT, file), 'utf8');
      assert.ok(
        src.includes("from '../lib/property-list.js'"),
        `${file} импортирует общий список свойств`,
      );
      assert.ok(src.includes('buildPropertyList({'), `${file} собирает список общим компонентом`);
    }
  });
});
