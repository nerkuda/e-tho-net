/**
 * Юнит-тесты каркаса локализации (задача 57f09136, требование 0e5ff1c6).
 *
 * Проверяется поведение `t`: подстановка позиционных параметров `%1`/`%2`,
 * fallback «нет ключа — вернуть ключ, не падать», реестр языков и переключение
 * (`registerLocale`/`setLang`/`availableLocales`/`onLangChange`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LANG,
  availableLocales,
  getLang,
  hasMessage,
  onLangChange,
  registerLocale,
  setLang,
  t,
} from '../src/renderer/lib/i18n.js';

/** Ключ, которого нет в словаре, — проверка fallback (в обход типа). */
function unknownKey(): never {
  return 'missing.key' as never;
}

describe('i18n: t и подстановки', () => {
  it('возвращает русский текст исходного каталога', () => {
    assert.equal(t('actions.cancel'), 'Отмена');
    assert.equal(t('actions.apply'), 'Применить');
    assert.equal(getLang(), DEFAULT_LANG);
  });

  it('подставляет позиционные параметры `%1`, `%2`', () => {
    assert.equal(t('actions.closeShortcut', 'Esc'), 'Закрыть (Esc)');
    assert.equal(t('actions.searchShortcut', 'Ctrl+Shift+F'), 'Поиск… (Ctrl+Shift+F)');
    registerLocale('zz', { 'errors.prefix': 'Сбой %1 при %2' });
    setLang('zz');
    assert.equal(t('errors.prefix', ['записи', 'чтении']), 'Сбой записи при чтении');
    assert.equal(t('errors.prefix', 'записи'), 'Сбой записи при %2');
    assert.equal(getLang(), 'zz');
    setLang(DEFAULT_LANG);
  });

  it('не падает на неизвестном ключе — возвращает сам ключ', () => {
    assert.equal(t(unknownKey()), 'missing.key');
  });

  it('неполный каталог добирает строки из исходного языка', () => {
    registerLocale('zz2', { 'actions.cancel': 'Cancel' });
    setLang('zz2');
    assert.equal(t('actions.cancel'), 'Cancel');
    assert.equal(t('actions.close'), 'Закрыть', 'нет перевода — берётся ru');
    setLang(DEFAULT_LANG);
  });
});

describe('i18n: реестр языков', () => {
  it('неизвестный код не переключает язык', () => {
    assert.equal(setLang('nope'), false);
    assert.equal(getLang(), DEFAULT_LANG);
  });

  it('исходный `ru` зарегистрирован и имеет имя для выбора', () => {
    const locales = availableLocales();
    assert.ok(locales.some((l) => l.code === DEFAULT_LANG));
    assert.equal(locales.find((l) => l.code === DEFAULT_LANG)?.name, 'Русский');
    assert.ok(hasMessage(DEFAULT_LANG, 'actions.apply'));
  });

  it('смена языка уведомляет подписчиков', () => {
    const seen: string[] = [];
    const off = onLangChange((lang) => seen.push(lang));
    registerLocale('zz3', { 'actions.cancel': 'X' });
    setLang('zz3');
    off();
    setLang(DEFAULT_LANG);
    assert.deepEqual(seen, ['zz3']);
  });
});
