/**
 * Сторож единства каталога имён иконок вида `icon_kind='icon'`
 * (ADR 2b655b29, требование ead91183, задача 610a440e).
 *
 * Правило: каталог допустимых имён ОДИН — экспорт `ICON_LIBRARY_NAMES` из
 * `@etn/shared`. По нему сервер валидирует поле `icon`, а клиентский фасад
 * `lib/ui/icon.ts` собирает свой runtime-каталог из той же библиотеки
 * `lucide`. Сторож краснеет, если наборы разошлись: фасад обновлён без
 * перегенерации shared-каталога (`node shared/scripts/gen-icon-catalog.mjs`)
 * или наоборот — тогда клиент предложит имя, которое сервер отвергнет
 * (или наоборот).
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ICON_LIBRARY_NAMES, isIconLibraryName } from '@etn/shared';

import { loadIconCatalog } from '../src/renderer/lib/ui/icon.js';

describe('guard: каталог имён иконок shared ↔ фасад (610a440e)', () => {
  it('набор имён фасада совпадает с ICON_LIBRARY_NAMES из @etn/shared', async () => {
    const catalog = await loadIconCatalog();
    assert.ok(ICON_LIBRARY_NAMES.length > 100, 'shared-каталог Lucide непустой');
    // Оба набора отсортированы и дедуплицированы по каноническому имени.
    assert.deepEqual(
      [...catalog.names],
      [...ICON_LIBRARY_NAMES],
      'каталог фасада разошёлся с shared — перегенерируй: node shared/scripts/gen-icon-catalog.mjs',
    );
  });

  it('каждое имя shared-каталога рендерится фасадом', async () => {
    const catalog = await loadIconCatalog();
    const missing = ICON_LIBRARY_NAMES.filter((name) => catalog.node(name) === null);
    assert.deepEqual(missing, [], `имена без значка в фасаде: ${missing.join(', ')}`);
  });

  it('isIconLibraryName согласован с фасадом', async () => {
    const catalog = await loadIconCatalog();
    assert.ok(isIconLibraryName('search'));
    assert.equal(isIconLibraryName('definitely-not-a-lucide-icon'), false);
    // Имя есть в каталоге фасада тогда и только тогда, когда его принимает shared.
    for (const name of ['search', 'book-open', 'waypoints']) {
      assert.equal(isIconLibraryName(name), catalog.node(name) !== null);
    }
  });
});
