/**
 * Деградация языка и автодетект на старте (задача e6374cd1).
 *
 * Проверяется поведение `lib/lang.ts` поверх шима `document`/`window.etn`:
 * - каталог недоступен (en/zh ещё не собраны) — эффективный язык `ru`,
 *   `document.lang` НЕ выставляется в недоступный код, в журнал уходит
 *   `ui.i18n.locale_unavailable`, состояние видно настройкам;
 * - сохранённый доступный язык (тестовая локаль) применяется;
 * - пустой `client_meta.lang` — детект ОС от main, детект не персистится.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_LANG } from '../src/renderer/lib/i18n.js';
import { registerTestLocale, TEST_LOCALE_CODE } from '../src/renderer/lib/locales/test.js';

/** События журнала, которые отправил renderer. */
const events: Array<{ name: string; data?: Record<string, unknown> }> = [];

/** Сохранённый язык в client_meta шима. */
let storedLang: string | null = null;
/** Что отдаёт автодетект ОС (main уже свёл тег к коду каталога). */
let preferred: string | null = 'ru';
/** Записи в client_meta (детект не должен сюда писать). */
const writes: Array<{ key: string; value: string }> = [];

const documentElement: { lang: string } = { lang: '' };

function shimNodeGlobals(): void {
  (globalThis as unknown as { document: unknown }).document = { documentElement };
  (globalThis as unknown as { window: unknown }).window = {
    etn: {
      meta: {
        get: async () => storedLang,
        set: async (key: string, value: string) => {
          writes.push({ key, value });
        },
      },
      system: {
        preferredLanguage: async () => preferred,
      },
      logEvent: (name: string, data?: Record<string, unknown>) => {
        events.push({ name, data });
      },
    },
  };
}

describe('lang: деградация и автодетект', () => {
  it('недоступный каталог: эффективный ru, document.lang = ru, событие журнала', async () => {
    shimNodeGlobals();
    documentElement.lang = '';
    const { applyLang, unavailableLang } = await import('../src/renderer/lib/lang.js');
    assert.equal(applyLang('zh'), false);
    assert.equal(unavailableLang(), 'zh');
    assert.equal(documentElement.lang, DEFAULT_LANG, 'недоступный код не выставляется');
    assert.ok(
      events.some((e) => e.name === 'ui.i18n.locale_unavailable' && e.data?.['lang'] === 'zh'),
      'деградация записана в журнал',
    );
  });

  it('доступный каталог очищает состояние деградации и ставит document.lang', async () => {
    const { applyLang, unavailableLang } = await import('../src/renderer/lib/lang.js');
    assert.equal(applyLang(DEFAULT_LANG), true);
    assert.equal(unavailableLang(), null);
    assert.equal(documentElement.lang, DEFAULT_LANG);
  });

  it('пустой client_meta: язык ОС от main, детект не персистится', async () => {
    writes.length = 0;
    storedLang = null;
    preferred = 'ru';
    documentElement.lang = '';
    const { initLang, unavailableLang } = await import('../src/renderer/lib/lang.js');
    await initLang();
    assert.equal(documentElement.lang, DEFAULT_LANG);
    assert.equal(unavailableLang(), null);
    assert.deepEqual(writes, [], 'детект ОС не записывается в client_meta');
  });

  it('язык ОС en без каталога: деградация на ru с сообщением, без записи', async () => {
    writes.length = 0;
    storedLang = null;
    preferred = 'en';
    documentElement.lang = '';
    const { initLang, unavailableLang } = await import('../src/renderer/lib/lang.js');
    await initLang();
    assert.equal(documentElement.lang, DEFAULT_LANG);
    assert.equal(unavailableLang(), 'en');
    assert.deepEqual(writes, []);
  });

  it('сохранённый доступный язык (тестовая локаль) применяется', async () => {
    registerTestLocale();
    storedLang = TEST_LOCALE_CODE;
    documentElement.lang = '';
    const { initLang, unavailableLang } = await import('../src/renderer/lib/lang.js');
    await initLang();
    assert.equal(documentElement.lang, TEST_LOCALE_CODE);
    assert.equal(unavailableLang(), null);
  });
});
