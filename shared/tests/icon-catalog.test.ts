/**
 * Тесты карты псевдонимов каталога иконок Lucide (ошибка 08b90470).
 *
 * `ICON_LIBRARY_ALIASES` и `canonicalIconLibraryName` сгенерированы
 * `shared/scripts/gen-icon-catalog.mjs`; клиентский поиск использует их,
 * чтобы находить значок по псевдониму, а хранить и валидировать —
 * каноническое имя.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalIconLibraryName,
  ICON_LIBRARY_ALIASES,
  ICON_LIBRARY_NAMES,
  isIconLibraryName,
} from '../src/index.js';

describe('каталог иконок: псевдонимы Lucide (08b90470)', () => {
  it('каноническое имя разрешается в себя, псевдоним — в каноническое', () => {
    assert.equal(canonicalIconLibraryName('home'), 'home');
    assert.equal(canonicalIconLibraryName('house'), 'home');
    assert.equal(canonicalIconLibraryName('definitely-not-a-lucide-icon'), null);
  });

  it('каждый псевдоним ведёт на допустимое каноническое имя и не совпадает с ним', () => {
    const canonical = new Set(ICON_LIBRARY_NAMES);
    const entries = Object.entries(ICON_LIBRARY_ALIASES);
    assert.ok(entries.length > 0, 'карта псевдонимов непустая');
    for (const [alias, target] of entries) {
      assert.equal(canonical.has(alias), false, `псевдоним «${alias}» совпал с каноническим именем`);
      assert.ok(canonical.has(target), `псевдоним «${alias}» ведёт на неизвестное имя «${target}»`);
    }
  });

  it('псевдоним не становится допустимым именем иконки для сервера', () => {
    assert.equal(isIconLibraryName('home'), true);
    assert.equal(isIconLibraryName('house'), false);
  });
});
