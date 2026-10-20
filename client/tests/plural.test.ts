/**
 * Русское согласование числа (задача d23279f6, замечание верификатора:
 * «1 потомков» вместо «1 потомок»).
 *
 * Проверяются границы категорий: 1/21/101 — `one`, 2–4/22–24 — `few`,
 * 0/5–20/11–14/25–30 — `many`. Те же формы использует предупреждение панели
 * использования и диалоги удаления корзины.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pluralCategory, pluralRu } from '../src/renderer/lib/plural.js';

describe('pluralCategory: русские категории согласования', () => {
  it('one: 1, 21, 31, 101', () => {
    for (const n of [1, 21, 31, 101, 1001]) assert.equal(pluralCategory(n), 'one', String(n));
  });

  it('few: 2–4, 22–24, 102–104', () => {
    for (const n of [2, 3, 4, 22, 23, 24, 102, 104]) assert.equal(pluralCategory(n), 'few', String(n));
  });

  it('many: 0, 5–20, 11–14, 25–30', () => {
    for (const n of [0, 5, 10, 11, 12, 13, 14, 15, 20, 25, 30, 111]) {
      assert.equal(pluralCategory(n), 'many', String(n));
    }
  });

  it('отрицательные и дробные числа не ломают категорию', () => {
    assert.equal(pluralCategory(-1), 'one');
    assert.equal(pluralCategory(-3), 'few');
    assert.equal(pluralCategory(2.9), 'few');
  });
});

describe('pluralRu: готовая форма слова', () => {
  it('потомок / потомка / потомков', () => {
    assert.equal(pluralRu(1, 'потомок', 'потомка', 'потомков'), 'потомок');
    assert.equal(pluralRu(3, 'потомок', 'потомка', 'потомков'), 'потомка');
    assert.equal(pluralRu(5, 'потомок', 'потомка', 'потомков'), 'потомков');
    assert.equal(pluralRu(11, 'потомок', 'потомка', 'потомков'), 'потомков');
    assert.equal(pluralRu(21, 'потомок', 'потомка', 'потомков'), 'потомок');
  });
});
