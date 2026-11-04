/**
 * UI наследования языков в диалоге «Все настройки» (задача 222666db,
 * ADR daab6ac4; контракт faba9ff4).
 *
 * Проверяется:
 *  - раздел «Клиент»: «использовать язык сетей» + конкретные языки, выбор
 *    уходит в профиль (`PUT /users/me/settings/app_language`) и применяется
 *    на лету;
 *  - раздел «Мыслесеть»: «язык сети» уходит полем `language` в тот же
 *    `PATCH /networks/{id}`, что и остальные поля;
 *  - старый сервер (0.15.1): серверных вариантов нет, остаётся локальный выбор
 *    с пояснением, поле языка сети скрыто.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { USER_SETTING_KEY } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

interface WindowListener {
  type: string;
  listener: (event: any) => void;
}

const windowListeners: WindowListener[] = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    activeElement: null,
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    setTimeout,
    clearTimeout,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OpenOptions {
  supported?: boolean;
  profileLanguage?: string | null;
}

interface Harness {
  backdrop: ShimElement;
  settingWrites: Array<{ key: string; value: unknown }>;
  patches: Array<{ id: string; fields: Record<string, unknown> }>;
}

/** Монтирует диалог настроек на нужном разделе. */
async function openSettings(
  section: 'client' | 'network',
  options: OpenOptions = {},
): Promise<Harness> {
  installShim();
  const supported = options.supported !== false;
  const settingWrites: Array<{ key: string; value: unknown }> = [];
  const patches: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let profileLanguage: string | null = options.profileLanguage ?? null;
  let networkLanguage: string | null = null;

  const me = { id: 'u1', username: 'me', display_name: 'Me', is_admin: false };
  const network = {
    id: 'n1',
    display_name: 'Сеть',
    description: null,
    when_to_use: null,
    conventions: null,
    examples: null,
    type_roles: {},
    owner_id: 'u1',
    first_day_of_week: 1,
    language: null,
  };
  (globalThis as any).window.etn = {
    networks: {
      update: async (id: string, fields: Record<string, unknown>) => {
        patches.push({ id, fields });
        if ('language' in fields) {
          networkLanguage = typeof fields['language'] === 'string' ? fields['language'] : null;
        }
        return { ...network, ...fields };
      },
      setPreference: async () => undefined,
    },
    me: {
      setSetting: async (key: string, value: unknown) => {
        settingWrites.push({ key, value });
        if (key === USER_SETTING_KEY.APP_LANGUAGE) {
          profileLanguage = typeof value === 'string' && value !== '' ? value : null;
        }
      },
      getLanguageSettings: async () => ({
        language: profileLanguage,
        networks: [
          {
            network_id: 'n1',
            language: profileLanguage ?? networkLanguage ?? 'ru',
            source: profileLanguage !== null ? 'user' : networkLanguage !== null ? 'network' : 'server',
            stored_language: networkLanguage,
            can_edit: true,
          },
        ],
      }),
    },
    meta: { get: async () => null, set: async () => undefined },
    ui: { setState: async () => undefined },
    logEvent: () => undefined,
  };

  const { appLanguageInternals } = await import('../src/renderer/lib/app-language.js');
  appLanguageInternals.reset();
  appLanguageInternals.setState({
    support: supported ? 'supported' : 'unsupported',
    language: options.profileLanguage ?? null,
    effective: supported
      ? { language: options.profileLanguage ?? 'ru', source: options.profileLanguage ? 'user' : 'server' }
      : null,
  });

  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: 'n1',
    me,
    network,
    thoughtTypes: [],
    linkTypes: [],
    activeView: 'map',
    showTrash: false,
    showInactive: false,
  } as any);

  const { applyLang } = await import('../src/renderer/lib/lang.js');
  applyLang('ru');

  const { showSettingsDialog } = await import('../src/renderer/screens/settings.js');
  showSettingsDialog(section);
  const backdrop = ((globalThis as any).document.body as ShimElement).findAll('dialog-backdrop')[0];
  assert.ok(backdrop !== undefined, 'диалог настроек смонтирован');
  return { backdrop, settingWrites, patches };
}

/** Радиокнопки по имени группы (свойство `name` ставит фасад choice-row). */
function radios(backdrop: ShimElement, name: string): ShimElement[] {
  return backdrop
    .findAll((el) => el.tagName === 'input')
    .filter((input) => (input as any).name === name);
}

function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop.querySelectorAll('button').find((b) => (b.textContent ?? '') === label);
  assert.ok(btn !== undefined, `кнопка «${label}» не найдена`);
  return btn!;
}

describe('«язык приложения» в разделе «Клиент» (222666db)', () => {
  it('предлагает наследование и языки, сохраняет в профиль и применяет на лету', async () => {
    const { backdrop, settingWrites } = await openSettings('client');
    const group = radios(backdrop, 'settings-app-lang');
    assert.deepEqual(
      group.map((input) => input.value),
      ['', 'ru', 'en', 'zh'],
      '«использовать язык сетей» + собранные каталоги',
    );
    assert.equal(group[0]!.checked, true, 'при пустом профиле выбран режим наследования');

    const english = group.find((input) => input.value === 'en');
    assert.ok(english !== undefined);
    english.checked = true;
    english.emit('change');
    footerButton(backdrop, 'Применить').click();
    await wait(20);

    assert.deepEqual(
      settingWrites,
      [{ key: USER_SETTING_KEY.APP_LANGUAGE, value: 'en' }],
      'выбор ушёл в профиль пользователя',
    );
    const { getLang } = await import('../src/renderer/lib/i18n.js');
    assert.equal(getLang(), 'en', 'интерфейс переключён без перезапуска');
  });

  it('старый сервер: локальный выбор с пояснением, серверных вариантов нет', async () => {
    const { backdrop } = await openSettings('client', { supported: false });
    assert.equal(radios(backdrop, 'settings-app-lang').length, 0, 'серверных вариантов нет');
    assert.equal(radios(backdrop, 'settings-lang').length, 3, 'остался локальный выбор');
    const text = backdrop.textContent ?? '';
    assert.ok(
      text.includes('Сервер не поддерживает хранение языка в профиле'),
      'пояснение о локальном режиме показано',
    );
  });
});

describe('«язык сети» в разделе «Мыслесеть» (222666db)', () => {
  it('уходит полем language в единый PATCH /networks/{id}', async () => {
    const { backdrop, patches } = await openSettings('network');
    const selects = backdrop.findAll((el) => el.tagName === 'select');
    assert.equal(selects.length, 2, 'первый день недели + язык сети');
    const languageSelect = selects.find((select) =>
      select.children.some((option) => option.value === ''),
    );
    assert.ok(languageSelect !== undefined, 'поле «Язык сети» найдено');
    assert.equal(languageSelect!.value, '', 'по умолчанию — язык сервера');

    languageSelect!.value = 'en';
    languageSelect!.emit('change');
    footerButton(backdrop, 'Применить').click();
    await wait(20);

    assert.equal(patches.length, 1, 'ровно один PATCH');
    assert.equal(patches[0]!.fields['language'], 'en', 'язык сети в пакете');
    const { store } = await import('../src/renderer/state.js');
    assert.equal(store.state.network?.language, 'en', 'store обновлён из ответа');
  });

  it('старый сервер: поле языка сети скрыто', async () => {
    const { backdrop } = await openSettings('network', { supported: false });
    assert.equal(
      backdrop.findAll((el) => el.tagName === 'select').length,
      1,
      'остался только выбор первого дня недели',
    );
  });
});
