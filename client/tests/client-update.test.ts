/**
 * Открытие страницы релиза клиента (задача 61cec451, требование d654473a,
 * компонент 60722bfd).
 *
 * Покрыто:
 *  - `parseReleasePageUrl`: принимается только абсолютный http(s)-адрес
 *    (страница релиза — `client_download_url`, требование e3ef572c); пустые,
 *    относительные и чужие схемы (`file:`, `javascript:`) отвергаются;
 *  - `openClientUpdatePage`: успех — нормализованный адрес уходит в системный
 *    браузер; отказ ОС — `{ ok: false, reason }` человеческим текстом;
 *    негодный адрес не доходит до открытия.
 *
 * Файл не скачивается, SHA-256 не проверяется, установщик не запускается —
 * это делает сервер (48312755) или пользователь вручную.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openClientUpdatePage, parseReleasePageUrl } from '../src/main/client-update.js';

const RELEASE_PAGE = 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.1';

describe('parseReleasePageUrl: страница релиза — только абсолютный http(s)', () => {
  it('принимает https-страницу релиза и http-адрес', () => {
    assert.equal(parseReleasePageUrl(RELEASE_PAGE), RELEASE_PAGE);
    assert.equal(
      parseReleasePageUrl('http://mirror.local/etn/releases/tag/v0.15.1'),
      'http://mirror.local/etn/releases/tag/v0.15.1',
    );
  });

  it('обрезает пробелы вокруг адреса', () => {
    assert.equal(parseReleasePageUrl(`  ${RELEASE_PAGE}  `), RELEASE_PAGE);
  });

  it('отвергает пустое значение и нестроковые входы', () => {
    assert.equal(parseReleasePageUrl(''), null);
    assert.equal(parseReleasePageUrl('   '), null);
    assert.equal(parseReleasePageUrl(null), null);
    assert.equal(parseReleasePageUrl(undefined), null);
    assert.equal(parseReleasePageUrl(42), null);
  });

  it('отвергает относительные адреса и чужие схемы', () => {
    assert.equal(parseReleasePageUrl('/releases/tag/v0.15.1'), null);
    assert.equal(parseReleasePageUrl('releases/tag/v0.15.1'), null);
    assert.equal(parseReleasePageUrl('file:///C:/ETN/setup.exe'), null);
    assert.equal(parseReleasePageUrl('javascript:alert(1)'), null);
    assert.equal(parseReleasePageUrl('obsidian://open?vault=etn'), null);
  });
});

describe('openClientUpdatePage: открыть страницу релиза в браузере', () => {
  it('успех: адрес уходит в системный браузер, файл не скачивается', async () => {
    const opened: string[] = [];
    const result = await openClientUpdatePage(RELEASE_PAGE, {
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(opened, [RELEASE_PAGE]);
  });

  it('отказ ОС: человеческая причина, без исключения наружу', async () => {
    const result = await openClientUpdatePage(RELEASE_PAGE, {
      openExternal: async () => {
        throw new Error('нет ассоциации для протокола');
      },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.reason, /Не удалось открыть/);
    assert.match(result.reason, /нет ассоциации для протокола/);
  });

  it('негодный адрес не доходит до открытия', async () => {
    let called = false;
    const result = await openClientUpdatePage('file:///C:/ETN/setup.exe', {
      openExternal: async () => {
        called = true;
      },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.match(result.reason, /http:\/\/ или https:\/\//);
    assert.equal(called, false, 'файл и чужие схемы в браузер не отдаются');
  });
});
