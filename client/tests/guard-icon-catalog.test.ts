/**
 * Сторож единства каталога имён иконок вида `icon_kind='icon'`
 * (ADR 2b655b29, требование ead91183, задача 610a440e; псевдонимы — ошибка
 * 08b90470).
 *
 * Правило: каталог допустимых имён ОДИН — экспорт `ICON_LIBRARY_NAMES` из
 * `@etn/shared`. По нему сервер валидирует поле `icon`, а клиентский фасад
 * `lib/ui/icon.ts` собирает свой runtime-каталог из той же библиотеки
 * `lucide`. Сторож краснеет, если наборы разошлись: фасад обновлён без
 * перегенерации shared-каталога (`node shared/scripts/gen-icon-catalog.mjs`)
 * или наоборот — тогда клиент предложит имя, которое сервер отвергнет
 * (или наоборот).
 *
 * Здесь же стерегутся псевдонимы: карта `ICON_LIBRARY_ALIASES` не должна
 * пересекаться с каноническими именами, каждый псевдоним обязан вести на
 * существующее каноническое имя, а поиск фасада — находить значок по
 * псевдониму, возвращая каноническое имя (в БД хранится только оно).
 *
 * Входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ICON_LIBRARY_ALIASES,
  ICON_LIBRARY_NAMES,
  canonicalIconLibraryName,
  isIconLibraryName,
} from '@etn/shared';

import { loadIconCatalog, searchIconCatalog } from '../src/renderer/lib/ui/icon.js';

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

  it('псевдонимы не пересекаются с каноническими именами и ведут на них (08b90470)', () => {
    const canonical = new Set(ICON_LIBRARY_NAMES);
    const entries = Object.entries(ICON_LIBRARY_ALIASES);
    assert.ok(entries.length > 0, 'карта псевдонимов Lucide непустая');
    for (const [alias, target] of entries) {
      assert.equal(canonical.has(alias), false, `псевдоним «${alias}» совпал с каноническим именем`);
      assert.ok(canonical.has(target), `псевдоним «${alias}» ведёт на неизвестное имя «${target}»`);
    }
  });

  it('поиск по каждому псевдониму находит канонический значок (08b90470)', () => {
    const canonical = new Set(ICON_LIBRARY_NAMES);
    for (const [alias, target] of Object.entries(ICON_LIBRARY_ALIASES)) {
      const hits = searchIconCatalog(ICON_LIBRARY_NAMES, alias);
      assert.ok(hits.includes(target), `поиск «${alias}» не нашёл канонический «${target}»`);
      assert.ok(hits.every((name) => canonical.has(name)), 'поиск отдаёт только канонические имена');
    }
  });

  it('canonicalIconLibraryName разрешает канонические имена и псевдонимы', () => {
    assert.equal(canonicalIconLibraryName('home'), 'home');
    assert.equal(canonicalIconLibraryName('house'), 'home');
    assert.equal(canonicalIconLibraryName('definitely-not-a-lucide-icon'), null);
    // Псевдоним НЕ становится допустимым именем для сервера/БД.
    assert.equal(isIconLibraryName('house'), false);
  });
});
