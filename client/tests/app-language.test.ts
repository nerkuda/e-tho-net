/**
 * «Язык приложения» из профиля пользователя (ADR daab6ac4 §2–5, задачи
 * faba9ff4 и 222666db).
 *
 * Проверяется клиентская семантика:
 *  - серверное значение побеждает кэш `client_meta.lang` и перезаписывает его;
 *  - разовая миграция кэша в профиль, когда профиль ещё пуст;
 *  - осознанное наследование (`null` после миграции) не перезаписывается;
 *  - кадры сокета `ready`/`settings.language` применяются только для активной
 *    сети;
 *  - переключение активной сети пересчитывает эффективный язык;
 *  - старый сервер без маршрута (`NOT_FOUND`) — локальный режим без падения;
 *  - офлайн-сохранение применяет выбор локально и возвращает «не синхронизировано»;
 *  - недоступный каталог деградирует по правилу «точный тег → основной подтег → ru».
 *
 * Мутационные ожидания: если серверное значение не побеждает кэш или миграция
 * перезаписывает `null`, тесты 1 и 4 краснеют.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CLIENT_META_KEY, USER_SETTING_KEY, type UserLanguageSettings } from '@etn/shared';

import {
  appLanguageInternals,
  applyServerLanguageFrame,
  changeAppLanguage,
  getAppLanguageState,
  initAppLanguage,
  isLanguageApiSupported,
  syncLanguageForNetwork,
} from '../src/renderer/lib/app-language.js';
import { DEFAULT_LANG, getLang } from '../src/renderer/lib/i18n.js';
import { applyLang, unavailableLang } from '../src/renderer/lib/lang.js';
import { store } from '../src/renderer/state.js';

/** Записи `meta.set` (кэш языка и маркер миграции). */
let metaWrites: Array<{ key: string; value: string }>;
/** `document.documentElement` шима: реально показанный язык. */
let documentElement: { lang: string };
/** Содержимое `client_meta`. */
let metaStore: Map<string, string>;
/** Записи `PUT /users/me/settings/{key}`. */
let settingWrites: Array<{ key: string; value: unknown }>;
/** Хранимый язык профиля на «сервере» (резолвинг повторяет серверный). */
let serverProfileLanguage: string | null;
/** Эффективные языки сетей, когда профиль наследует. */
let networkRows: UserLanguageSettings['networks'];
/** Отказ `GET /users/me/language-settings` (старый сервер/офлайн). */
let getError: unknown;
/** Отказ `PUT /users/me/settings/app_language` (офлайн-сохранение). */
let putError: unknown;

/** Ответ сервера по текущему состоянию: профиль побеждает, затем сети. */
function currentSettings(): UserLanguageSettings {
  return {
    language: serverProfileLanguage,
    networks: networkRows.map((row) =>
      serverProfileLanguage === null
        ? row
        : { ...row, language: serverProfileLanguage, source: 'user' as const },
    ),
  };
}

function entry(
  networkId: string,
  language: string,
  source: 'user' | 'network' | 'server' = 'server',
) {
  return {
    network_id: networkId,
    language,
    source,
    stored_language: source === 'server' ? null : language,
    can_edit: true,
  };
}

beforeEach(() => {
  metaWrites = [];
  metaStore = new Map();
  settingWrites = [];
  serverProfileLanguage = null;
  networkRows = [];
  getError = null;
  putError = null;

  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { lang: '' },
  };
  documentElement = (globalThis as unknown as { document: { documentElement: { lang: string } } })
    .document.documentElement;
  (globalThis as unknown as { window: unknown }).window = {
    etn: {
      meta: {
        get: async (key: string) => metaStore.get(key) ?? null,
        set: async (key: string, value: string) => {
          metaWrites.push({ key, value });
          metaStore.set(key, value);
        },
      },
      me: {
        getLanguageSettings: async () => {
          if (getError !== null) throw getError;
          return currentSettings();
        },
        setSetting: async (key: string, value: unknown) => {
          if (putError !== null) throw putError;
          settingWrites.push({ key, value });
          if (key === USER_SETTING_KEY.APP_LANGUAGE) {
            serverProfileLanguage =
              typeof value === 'string' && value.trim() !== '' ? value : null;
          }
        },
      },
      logEvent: () => undefined,
    },
  };
  appLanguageInternals.reset();
  store.resetNetwork();
  applyLang(DEFAULT_LANG);
});

/** Записи кэша `client_meta.lang`. */
function cacheWrites(): string[] {
  return metaWrites.filter((w) => w.key === CLIENT_META_KEY.LANG).map((w) => w.value);
}

describe('язык приложения: профиль, кэш и миграция (faba9ff4)', () => {
  it('серверное значение побеждает кэш и перезаписывает его', async () => {
    metaStore.set(CLIENT_META_KEY.LANG, 'ru');
    serverProfileLanguage = 'en';
    store.update({ networkId: 'n1' });

    await initAppLanguage();

    assert.equal(getLang(), 'en', 'язык профиля применён поверх кэша ru');
    assert.deepEqual(cacheWrites(), ['en'], 'кэш перезаписан серверным значением');
    assert.equal(isLanguageApiSupported(), true);
  });

  it('миграция: кэш переносится в пустой профиль один раз', async () => {
    metaStore.set(CLIENT_META_KEY.LANG, 'en');
    networkRows = [entry('n1', 'ru')];
    store.update({ networkId: 'n1' });

    await initAppLanguage();

    assert.deepEqual(
      settingWrites,
      [{ key: USER_SETTING_KEY.APP_LANGUAGE, value: 'en' }],
      'локальный выбор перенесён в профиль',
    );
    assert.equal(getLang(), 'en', 'перенесённый язык применён');
    assert.equal(
      metaStore.get(CLIENT_META_KEY.LANG_MIGRATED),
      'true',
      'флаг миграции поставлен',
    );
  });

  it('миграция не перезаписывает явный язык профиля', async () => {
    metaStore.set(CLIENT_META_KEY.LANG, 'en');
    serverProfileLanguage = 'ru';
    networkRows = [entry('n1', 'ru')];
    store.update({ networkId: 'n1' });

    await initAppLanguage();

    assert.deepEqual(settingWrites, [], 'профиль не тронут');
    assert.equal(getLang(), 'ru', 'побеждает значение профиля');
    assert.deepEqual(cacheWrites(), ['ru'], 'кэш приведён к серверному значению');
    assert.equal(metaStore.get(CLIENT_META_KEY.LANG_MIGRATED), 'true');
  });

  it('осознанное наследование (null) после миграции не перезаписывается', async () => {
    metaStore.set(CLIENT_META_KEY.LANG, 'ru');
    metaStore.set(CLIENT_META_KEY.LANG_MIGRATED, 'true');
    networkRows = [entry('n1', 'zh', 'network')];
    store.update({ networkId: 'n1' });

    await initAppLanguage();

    assert.deepEqual(settingWrites, [], 'null в профиле означает наследование');
    assert.equal(getLang(), 'zh', 'применён язык сети');
    assert.deepEqual(cacheWrites(), ['zh'], 'кэш — последний эффективный язык');
  });

  it('переключение активной сети пересчитывает эффективный язык', async () => {
    networkRows = [entry('n1', 'ru'), entry('n2', 'en', 'network')];
    store.update({ networkId: 'n1' });
    await initAppLanguage();
    assert.equal(getLang(), 'ru');

    store.update({ networkId: 'n2' });
    await syncLanguageForNetwork('n2');

    assert.equal(getLang(), 'en', 'язык новой активной сети применён без перезапуска');
  });

  it('старый сервер без контракта: локальный режим, интерфейс не падает', async () => {
    getError = { code: 'NOT_FOUND', message: 'Route not found' };
    metaStore.set(CLIENT_META_KEY.LANG, 'ru');

    await initAppLanguage();

    assert.equal(isLanguageApiSupported(), false, 'функциональность помечена недоступной');
    assert.equal(getLang(), 'ru', 'интерфейс остался на кэше');
    assert.deepEqual(settingWrites, [], 'на старый сервер ничего не пишется');
  });

  it('офлайн-сохранение: выбор применяется локально, синхронизация отложена', async () => {
    serverProfileLanguage = 'ru';
    await initAppLanguage();
    assert.equal(isLanguageApiSupported(), true);

    putError = new Error('network down');
    const synced = await changeAppLanguage('en');

    assert.equal(synced, false, 'синхронизация не подтверждена');
    assert.equal(getLang(), 'en', 'выбор применён на этом клиенте');
    assert.equal(cacheWrites().at(-1), 'en', 'выбор сохранён в кэш');
  });

  it('смена «наследовать» подтверждается сервером и применяет язык сети', async () => {
    serverProfileLanguage = 'en';
    networkRows = [entry('n1', 'ru')];
    store.update({ networkId: 'n1' });
    await initAppLanguage();
    assert.equal(getLang(), 'en');

    const synced = await changeAppLanguage(null);

    assert.equal(synced, true);
    assert.equal(serverProfileLanguage, null, 'в профиль записано наследование');
    assert.equal(getLang(), 'ru', 'применён серверный эффективный язык сети');
  });
});

describe('язык приложения: кадры сокета и деградация каталога', () => {
  it('кадр активной сети применяется, чужой — только кэшируется', () => {
    appLanguageInternals.setState({ support: 'supported', language: null });
    store.update({ networkId: 'n1' });

    applyServerLanguageFrame({ networkId: 'n1', language: 'en', source: 'network' });
    assert.equal(getLang(), 'en', 'кадр активной сети переключил интерфейс');

    applyServerLanguageFrame({ networkId: 'n2', language: 'zh', source: 'network' });
    assert.equal(getLang(), 'en', 'кадр чужой сети не меняет активный интерфейс');
    assert.equal(getAppLanguageState().effective?.language, 'en');
  });

  it('точный тег → основной подтег → ru (ADR §2)', () => {
    assert.equal(applyLang('zh-Hans'), true, 'zh-Hans обслуживается каталогом zh');
    assert.equal(getLang(), 'zh');
    assert.equal(documentElement.lang, 'zh', 'document.lang = реально показанный');
    assert.equal(unavailableLang(), null);

    assert.equal(applyLang('ja'), false, 'каталога ja нет — деградация');
    assert.equal(getLang(), DEFAULT_LANG);
    assert.equal(unavailableLang(), 'ja', 'состояние деградации видно настройкам');
  });
});
