/**
 * Юнит-тест канонических имён свойств для чипов публикации (задача 7cfaba7c,
 * п.3): у свойства-связи в каталоге две стороны-варианта с общим id значения,
 * поэтому имя чипа берётся с прямой стороны, а не с последней попавшей.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntityOption } from '../src/renderer/lib/entity-picker.js';
import { propertyChipTitles } from '../src/renderer/screens/publications/recipe.js';

describe('публикации: канонические имена свойств для чипа (7cfaba7c, п.3)', () => {
  it('при двух сторонах побеждает source (прямое имя)', () => {
    const options: EntityOption[] = [
      { id: 'p1', title: 'Обратное имя', linkProperty: { propertyId: 'p1', side: 'target', key: 'rev' } },
      { id: 'p1', title: 'Прямое имя', linkProperty: { propertyId: 'p1', side: 'source', key: 'fwd' } },
      { id: 'p2', title: 'Другая связь', linkProperty: { propertyId: 'p2', side: 'target', key: 'x' } },
    ];
    const titles = propertyChipTitles(options);
    assert.equal(titles.get('p1'), 'Прямое имя');
    assert.equal(titles.get('p2'), 'Другая связь');
  });

  it('порядок вариантов не влияет на результат', () => {
    const options: EntityOption[] = [
      { id: 'p1', title: 'Прямое', linkProperty: { propertyId: 'p1', side: 'source', key: 'f' } },
      { id: 'p1', title: 'Обратное', linkProperty: { propertyId: 'p1', side: 'target', key: 'r' } },
    ];
    assert.equal(propertyChipTitles(options).get('p1'), 'Прямое');
  });
});
