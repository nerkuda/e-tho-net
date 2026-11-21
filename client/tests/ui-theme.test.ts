/**
 * Тема и режим интерфейса (требование 219d030c, задача 0e4a52cd; ADR de24adef).
 *
 * Проверяется клиентская семантика механизма:
 *  - реестр тем (`THEME_NAMES`, подписи из словаря) и разбор значений;
 *  - живое применение: `data-theme`/`data-mode` на корне + стор + фон окна;
 *  - кэш установки с владельцем: чужой кэш не применяется, до ответа сервера —
 *    дефолт `current` + тёмный, затем серверные значения;
 *  - серверное значение побеждает и перезаписывает кэш;
 *  - неизвестная сборке тема сервера → `current`, серверное значение не
 *    затирается;
 *  - старый сервер (`NOT_FOUND`) и отказ записи (`422`) — локальное применение
 *    с отложенной синхронизацией;
 *  - повтор отложенной записи при следующем входе;
 *  - разовая миграция старого `client_meta.theme` (это РЕЖИМ) → `ui_mode`.
 *
 * Мутационные ожидания: если сервер перестаёт побеждать кэш, чужой кэш
 * применяется или миграция пишет `ui_theme` вместо `ui_mode`, тесты краснеют.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CLIENT_META_KEY, USER_SETTING_KEY } from '@etn/shared';

import {
  applyUiTheme,
  FOREIGN_UI_DEFAULT,
  initTheme,
  parseUiMode,
  parseUiTheme,
  readUiThemeCache,
  THEME_NAMES,
  themeOptions,
} from '../src/renderer/lib/theme.js';
import {
  changeUiMode,
  changeUiTheme,
  getUiThemeState,
  initUiTheme,
  isUiThemeApiSupported,
  uiThemeInternals,
} from '../src/renderer/lib/ui-theme.js';
import { store } from '../src/renderer/state.js';

/** Записи `meta.set` (кэш темы/режима, владелец, маркеры, фон окна). */
let metaWrites: Array<{ key: string; value: string }>;
/** Содержимое `client_meta`. */
let metaStore: Map<string, string>;
/** Записи `PUT /users/me/settings/{key}`. */
let settingWrites: Array<{ key: string; value: unknown }>;
/** Хранимые настройки «сервера». */
let serverSettings: Record<string, unknown>;
/** Отказ `GET /users/me/settings` (старый сервер/офлайн). */
let getError: unknown;
/** Отказ `PUT /users/me/settings/{key}` (офлайн/422). */
let putError: unknown;
/** Записи фона окна в главный процесс. */
let windowBackgrounds: string[];
/** Цвет `body` для вычисления фона окна (`null` — DOM без body). */
let bodyBackground: string | null;

function applyServer() {
  return {
    settingWrites,
    settings: serverSettings,
  };
}

beforeEach(() => {
  metaWrites = [];
  metaStore = new Map();
  settingWrites = [];
  serverSettings = {};
  getError = null;
  putError = null;
  windowBackgrounds = [];
  bodyBackground = null;

  const documentElement = { dataset: {} as Record<string, string> };
  (globalThis as unknown as { document: unknown }).document = {
    documentElement,
    body: bodyBackground === null ? null : {},
  };
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
    backgroundColor: bodyBackground,
  });
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
        getSettings: async () => {
          if (getError !== null) throw getError;
          return applyServer().settings;
        },
        setSetting: async (key: string, value: unknown) => {
          if (putError !== null) throw putError;
          settingWrites.push({ key, value });
          serverSettings[key] = value;
        },
      },
      system: {
        setWindowBackground: async (color: string) => {
          windowBackgrounds.push(color);
        },
      },
    },
  };
  uiThemeInternals.reset();
  store.resetNetwork();
  store.update({ theme: 'light', uiTheme: 'current' });
});

/** Текущая применённая пара: атрибуты корня и стор. */
function applied(): { theme: string; mode: string; datasetTheme: string; datasetMode: string } {
  return {
    theme: store.state.uiTheme,
    mode: store.state.theme,
    datasetTheme:
      (
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } };
        }
      ).document.documentElement.dataset['theme'] ?? '',
    datasetMode:
      (
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } };
        }
      ).document.documentElement.dataset['mode'] ?? '',
  };
}

function cacheWrites(): string[] {
  return metaWrites
    .filter((write) => write.key === CLIENT_META_KEY.UI_THEME)
    .map((write) => write.value);
}

describe('реестр тем и разбор значений (0e4a52cd)', () => {
  it('реестр — шесть тем, подписи из словаря без дублей и в порядке реестра', () => {
    assert.deepEqual(THEME_NAMES, [
      'current',
      'blue-topaz',
      'catppuccin',
      'nordic',
      'retronotes',
      'wasp',
    ]);
    const options = themeOptions();
    assert.deepEqual(
      options.map((option) => option.value),
      [...THEME_NAMES],
      'порядок вариантов совпадает с реестром',
    );
    const labels = options.map((option) => option.label);
    assert.ok(
      labels.every((label) => label.trim() !== ''),
      'каждая тема имеет подпись из словаря',
    );
    assert.equal(new Set(labels).size, labels.length, 'подписи тем не повторяются');
  });

  it('неизвестное имя темы деградирует к current, режим — только dark/light', () => {
    assert.equal(parseUiTheme('wasp'), 'wasp');
    assert.equal(parseUiTheme('future-theme'), 'current', 'тема сервера новее сборки');
    assert.equal(parseUiTheme(null), 'current');
    assert.equal(parseUiMode('dark'), 'dark');
    assert.equal(parseUiMode('light'), 'light');
    assert.equal(parseUiMode('DARK'), 'light', 'регистр значения не угадывается');
    assert.equal(parseUiMode(null), 'light');
  });
});

describe('живое применение темы и режима', () => {
  it('ставит data-theme/data-mode, обновляет стор и сообщает фон окна', async () => {
    bodyBackground = 'rgb(12, 12, 12)';
    (globalThis as unknown as { document: { body: unknown } }).document.body = {};
    applyUiTheme({ theme: 'retronotes', mode: 'dark' });

    assert.deepEqual(applied(), {
      theme: 'retronotes',
      mode: 'dark',
      datasetTheme: 'retronotes',
      datasetMode: 'dark',
    });
    assert.deepEqual(windowBackgrounds, ['#0c0c0c'], 'фон окна — вычисленный --bg темы');
    assert.equal(
      metaStore.get(CLIENT_META_KEY.UI_WINDOW_BG),
      '#0c0c0c',
      'фон окна кэшируется для следующего запуска',
    );
  });

  it('initTheme применяет кэш установки до первого экрана', async () => {
    metaStore.set(CLIENT_META_KEY.UI_THEME, 'catppuccin');
    metaStore.set(CLIENT_META_KEY.UI_MODE, 'dark');
    await initTheme();
    assert.equal(applied().theme, 'catppuccin');
    assert.equal(applied().mode, 'dark');
    assert.equal(applied().datasetTheme, 'catppuccin');
    assert.equal(applied().datasetMode, 'dark');
  });

  it('пустой кэш — current и светлый (прежний дефолт установки)', async () => {
    await initTheme();
    assert.equal(applied().theme, 'current');
    assert.equal(applied().mode, 'light');
  });
});

describe('серверный слой: кэш с владельцем и приоритет сервера', () => {
  it('серверное значение побеждает кэш и перезаписывает его с владельцем', async () => {
    metaStore.set(CLIENT_META_KEY.UI_THEME, 'nordic');
    metaStore.set(CLIENT_META_KEY.UI_MODE, 'light');
    metaStore.set(CLIENT_META_KEY.UI_THEME_OWNER, 'user-1');
    serverSettings[USER_SETTING_KEY.UI_THEME] = 'wasp';
    serverSettings[USER_SETTING_KEY.UI_MODE] = 'dark';

    await initUiTheme('user-1');

    assert.equal(applied().theme, 'wasp', 'тема профиля применена поверх кэша');
    assert.equal(applied().mode, 'dark');
    assert.deepEqual(cacheWrites(), ['wasp'], 'кэш перезаписан серверным значением');
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_OWNER), 'user-1');
    assert.equal(isUiThemeApiSupported(), true);
  });

  it('кэш другого пользователя не применяется: дефолт current + тёмный', async () => {
    metaStore.set(CLIENT_META_KEY.UI_THEME, 'nordic');
    metaStore.set(CLIENT_META_KEY.UI_MODE, 'light');
    metaStore.set(CLIENT_META_KEY.UI_THEME_OWNER, 'user-1');
    getError = Object.assign(new Error('offline'), { code: 'ETIMEDOUT' });

    await initUiTheme('user-2');

    assert.equal(applied().theme, FOREIGN_UI_DEFAULT.theme);
    assert.equal(applied().mode, FOREIGN_UI_DEFAULT.mode);
    assert.equal(applied().mode, 'dark', 'до ответа сервера чужой кэш не используется');
  });

  it('после ответа сервера кэш чужого пользователя перезаписывается его значениями', async () => {
    metaStore.set(CLIENT_META_KEY.UI_THEME, 'nordic');
    metaStore.set(CLIENT_META_KEY.UI_MODE, 'light');
    metaStore.set(CLIENT_META_KEY.UI_THEME_OWNER, 'user-1');
    serverSettings[USER_SETTING_KEY.UI_THEME] = 'catppuccin';
    serverSettings[USER_SETTING_KEY.UI_MODE] = 'light';

    await initUiTheme('user-2');

    assert.equal(applied().theme, 'catppuccin');
    assert.equal(applied().mode, 'light');
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_OWNER), 'user-2');
    assert.deepEqual(cacheWrites(), ['catppuccin']);
  });

  it('неизвестная сборке тема сервера: применяется current, значение не затирается', async () => {
    serverSettings[USER_SETTING_KEY.UI_THEME] = 'neon-future';
    serverSettings[USER_SETTING_KEY.UI_MODE] = 'dark';

    await initUiTheme('user-1');

    assert.equal(applied().theme, 'current', 'деградация к текущей теме');
    assert.equal(applied().mode, 'dark');
    assert.equal(getUiThemeState().unknownTheme, 'neon-future');
    assert.deepEqual(settingWrites, [], 'серверное значение не перезаписывается');
  });

  it('старый сервер (NOT_FOUND): выбор применяется локально, режим unsupported', async () => {
    getError = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    metaStore.set(CLIENT_META_KEY.UI_THEME, 'retronotes');
    metaStore.set(CLIENT_META_KEY.UI_MODE, 'dark');
    metaStore.set(CLIENT_META_KEY.UI_THEME_OWNER, 'user-1');

    await initUiTheme('user-1');
    const synced = await changeUiTheme('wasp');

    assert.equal(isUiThemeApiSupported(), false);
    assert.equal(synced, false, 'UI обязан показать «синхронизация отложена»');
    assert.equal(applied().theme, 'wasp', 'выбор применён локально');
    assert.equal(getUiThemeState().syncDeferred, true);
    assert.equal(
      metaStore.get(CLIENT_META_KEY.UI_THEME_PENDING),
      'theme',
      'маркер хранит часть выбора',
    );
  });

  it('отказ записи (422): применено локально, маркер отложенной синхронизации', async () => {
    putError = Object.assign(new Error('unknown theme'), { code: 'VALIDATION_ERROR' });
    await initUiTheme('user-1');
    const synced = await changeUiMode('dark');

    assert.equal(synced, false);
    assert.equal(applied().mode, 'dark');
    assert.equal(isUiThemeApiSupported(), true, '422 не делает сервер «старым»');
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_PENDING), 'mode');
  });

  it('повтор отложенной записи при следующем входе', async () => {
    metaStore.set(CLIENT_META_KEY.UI_THEME, 'retronotes');
    metaStore.set(CLIENT_META_KEY.UI_MODE, 'dark');
    metaStore.set(CLIENT_META_KEY.UI_THEME_OWNER, 'user-1');
    metaStore.set(CLIENT_META_KEY.UI_THEME_PENDING, 'theme,mode');
    metaStore.set(CLIENT_META_KEY.UI_THEME_MIGRATED, 'true');

    await initUiTheme('user-1');

    assert.deepEqual(
      settingWrites.map((write) => write.key).sort(),
      [USER_SETTING_KEY.UI_MODE, USER_SETTING_KEY.UI_THEME].sort(),
      'локальный выбор доехал до сервера',
    );
    assert.deepEqual(
      settingWrites,
      [
        { key: USER_SETTING_KEY.UI_MODE, value: 'dark' },
        { key: USER_SETTING_KEY.UI_THEME, value: 'retronotes' },
      ],
      'записаны значения кэша, а не дефолт',
    );
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_PENDING), '', 'маркер снят');
    assert.equal(applied().theme, 'retronotes');
  });

  it('changeUiTheme/changeUiMode пишут серверные ключи и живой выбор', async () => {
    await initUiTheme('user-1');
    assert.equal(await changeUiTheme('wasp'), true);
    assert.equal(await changeUiMode('dark'), true);

    assert.deepEqual(settingWrites, [
      { key: USER_SETTING_KEY.UI_THEME, value: 'wasp' },
      { key: USER_SETTING_KEY.UI_MODE, value: 'dark' },
    ]);
    assert.equal(applied().theme, 'wasp');
    assert.equal(applied().mode, 'dark');
    assert.equal(getUiThemeState().serverTheme, 'wasp');
  });
});

describe('миграция старого client_meta.theme (режим → ui_mode)', () => {
  it('пишет ui_mode, а не ui_theme, и ставит маркер theme_migrated', async () => {
    metaStore.set(CLIENT_META_KEY.THEME, 'dark');

    await initUiTheme('user-1');

    assert.deepEqual(settingWrites, [{ key: USER_SETTING_KEY.UI_MODE, value: 'dark' }]);
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_MIGRATED), 'true');
    assert.equal(
      serverSettings[USER_SETTING_KEY.UI_THEME],
      undefined,
      'старый клиент не знал темы — ui_theme не пишется',
    );
    assert.equal(applied().mode, 'dark', 'мигрированный режим применён');
  });

  it('сервер уже знает режим — миграция помечается без записи', async () => {
    metaStore.set(CLIENT_META_KEY.THEME, 'dark');
    serverSettings[USER_SETTING_KEY.UI_MODE] = 'light';

    await initUiTheme('user-1');

    assert.deepEqual(settingWrites, []);
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_MIGRATED), 'true');
    assert.equal(applied().mode, 'light', 'серверное значение побеждает');
  });

  it('сбой записи не ставит маркер: перенос повторяется при следующем входе', async () => {
    metaStore.set(CLIENT_META_KEY.THEME, 'dark');
    putError = Object.assign(new Error('offline'), { code: 'ETIMEDOUT' });

    await initUiTheme('user-1');
    assert.notEqual(metaStore.get(CLIENT_META_KEY.UI_THEME_MIGRATED), 'true');
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_PENDING), 'mode');
    assert.equal(applied().mode, 'dark', 'выбор из кэша применён локально');

    putError = null;
    await initUiTheme('user-1');
    assert.deepEqual(
      settingWrites,
      [{ key: USER_SETTING_KEY.UI_MODE, value: 'dark' }],
      'переносится только режим: тему пользователь не выбирал',
    );
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_MIGRATED), 'true');
    assert.equal(metaStore.get(CLIENT_META_KEY.UI_THEME_PENDING), '', 'маркер снят');
  });

  it('кэш читается вместе с владельцем и старым режимом', async () => {
    metaStore.set(CLIENT_META_KEY.THEME, 'dark');
    const cache = await readUiThemeCache();
    assert.deepEqual(cache, { theme: 'current', mode: 'dark', owner: null });
  });
});
