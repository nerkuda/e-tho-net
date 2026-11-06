/**
 * Плюрализация (задача e6374cd1; ранее — d23279f6 «1 потомков»).
 *
 * Проверяются:
 * - категории `Intl.PluralRules` по языкам: ru `one/few/many/other`, en
 *   `one/other`, zh `other`; дробные в ru — `other`;
 * - `tp(key, n, params?)`: выбор формы, подстановка `%1` (число) и `%2`;
 * - инвариант: для любого числа корпуса категория входит в набор форм ключа,
 *   поэтому `tp` никогда не возвращает пустую строку.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { DEFAULT_LANG, getLang, registerLocale, setLang, tp } from '../src/renderer/lib/i18n.js';
import { pluralCategory } from '../src/renderer/lib/plural.js';
import { ruPlurals } from '../src/renderer/lib/locales/ru.js';

/** Категории, которые обязан поддерживать язык (правила ICU). */
const EXPECTED: Record<string, readonly string[]> = {
  ru: ['one', 'few', 'many', 'other'],
  en: ['one', 'other'],
  zh: ['other'],
};

describe('pluralCategory: категории ICU по языкам', () => {
  it('ru: one 1/21, few 2–4/22–24, many 0/5–20/11–14', () => {
    for (const n of [1, 21, 31, 101, 1001]) assert.equal(pluralCategory('ru', n), 'one', String(n));
    for (const n of [2, 3, 4, 22, 23, 24, 102, 104]) {
      assert.equal(pluralCategory('ru', n), 'few', String(n));
    }
    for (const n of [0, 5, 10, 11, 12, 13, 14, 15, 20, 25, 30, 111]) {
      assert.equal(pluralCategory('ru', n), 'many', String(n));
    }
  });

  it('ru: дробные числа — other (1,5 потомка, а не потомков)', () => {
    for (const n of [0.5, 1.5, 2.5, 5.25]) {
      assert.equal(pluralCategory('ru', n), 'other', String(n));
    }
  });

  it('ru: отрицательные числа не ломают категорию', () => {
    assert.equal(pluralCategory('ru', -1), 'one');
    assert.equal(pluralCategory('ru', -3), 'few');
  });

  it('en: one только 1, остальное other', () => {
    assert.equal(pluralCategory('en', 1), 'one');
    for (const n of [0, 2, 3, 11, 21, 1.5]) {
      assert.equal(pluralCategory('en', n), 'other', String(n));
    }
  });

  it('zh: единственная категория other', () => {
    for (const n of [0, 1, 2, 5, 11, 1.5, 100]) {
      assert.equal(pluralCategory('zh', n), 'other', String(n));
    }
  });
});

describe('tp: форма ключа и подстановки', () => {
  after(() => {
    setLang(DEFAULT_LANG);
  });

  it('русские формы слова «потомок»', () => {
    assert.equal(tp('plurals.child', 1), 'потомок');
    assert.equal(tp('plurals.child', 3), 'потомка');
    assert.equal(tp('plurals.child', 5), 'потомков');
    assert.equal(tp('plurals.child', 11), 'потомков');
    assert.equal(tp('plurals.child', 21), 'потомок');
    assert.equal(tp('plurals.child', 1.5), 'потомка');
  });

  it('%1 — само число, %2 — первый дополнительный параметр', () => {
    // «Внимание: 3 потомка останется…» — число подставлено из n.
    assert.equal(
      tp('plurals.orphanedChildren', 3),
      'Внимание: 3 потомка останется без родителей.',
    );
    registerLocale('zzp', {}, {
      'plurals.child': { one: '%2 child (%1)', other: '%2 children (%1)' },
    });
    setLang('zzp');
    assert.equal(tp('plurals.child', 1, 'title'), 'title child (1)');
    assert.equal(tp('plurals.child', 2, 'title'), 'title children (2)');
    assert.equal(getLang(), 'zzp');
    setLang(DEFAULT_LANG);
  });

  it('каталог без своих форм добирает формы исходного ru', () => {
    registerLocale('zzq', {});
    setLang('zzq');
    assert.equal(tp('plurals.child', 3), 'потомка');
    setLang(DEFAULT_LANG);
  });

  it('инвариант корпуса: у каждого ключа есть форма для любой категории языка', () => {
    const corpus = [0, 1, 2, 3, 4, 5, 10, 11, 12, 21, 22, 25, 100, 101, 111, 1.5, 2.5];
    for (const key of Object.keys(ruPlurals) as Array<keyof typeof ruPlurals>) {
      for (const n of corpus) {
        const category = pluralCategory(DEFAULT_LANG, n);
        assert.ok(
          EXPECTED[DEFAULT_LANG]?.includes(category),
          `категория ${category} вне набора ru для ${String(n)}`,
        );
        const text = tp(key, n);
        assert.ok(text !== key && text.trim() !== '', `пустая форма ${String(key)} для ${String(n)}`);
      }
    }
  });
});
