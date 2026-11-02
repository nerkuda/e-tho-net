/**
 * Сторож маппинга системного языка (задача e6374cd1, сценарий b259ab45).
 *
 * Первое предпочтение ОС (`en-US`, `zh-Hans`, `de-DE`, …) сводится к коду
 * каталога: `en-*` → `en`, `zh-*` → `zh`, остальное → `ru`. Проверяется
 * корпус конструкций BCP-47, а не точечный пример: регистр, разделитель `_`,
 * редкие локали и мусорные значения не должны ронять детект.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapSystemLanguage } from '../src/main/system-locale.js';

describe('mapSystemLanguage: локаль ОС → каталог клиента', () => {
  it('английские теги любой страны/регистра → en', () => {
    for (const tag of ['en', 'en-US', 'en-GB', 'en-us', 'EN', 'en_US', 'en-Latn-US']) {
      assert.equal(mapSystemLanguage(tag), 'en', tag);
    }
  });

  it('китайские теги, включая письменность → zh', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hant-TW', 'zh_cn', 'ZH']) {
      assert.equal(mapSystemLanguage(tag), 'zh', tag);
    }
  });

  it('русский тег → ru, прочие локали и мусор — тоже ru (деградация)', () => {
    for (const tag of ['ru', 'ru-RU', 'de-DE', 'fr', 'ja-JP', 'eng', 'zhx', '']) {
      assert.equal(mapSystemLanguage(tag), 'ru', JSON.stringify(tag));
    }
  });

  it('пустое/отсутствующее значение не бросает — исходный ru', () => {
    assert.equal(mapSystemLanguage(null), 'ru');
    assert.equal(mapSystemLanguage(undefined), 'ru');
  });
});
