/**
 * Блокирующий диалог несовместимости версий (элемент 8623b9ff, задача
 * 0afec967, требование 4d3be6ca, сущность 89aad200).
 *
 * Покрыто:
 *  - состояния диалога для обеих блокировок (`client-outdated`,
 *    `server-outdated`);
 *  - разные причины по `details.reason` сервера (`version-missing`,
 *    `version-invalid`, `version-out-of-range`) из словаря
 *    `CLIENT_VERSION_ERROR_REASON` и общая формулировка без причины;
 *  - роль администратора: кнопка «Обновить сервер» — только при
 *    `is_admin: true`, иначе нейтральный текст «Обратитесь к администратору
 *    сервера»; кнопка открывает диалог обновления сервера (ca26c59d);
 *  - отсутствие кнопок «Отложить» и «Проверить»; закрытие крестиком и Esc
 *    блокировку не снимает;
 *  - «Повторить» переподключается к профилю, отказ повтора называет адрес и
 *    фактическую причину;
 *  - смена вердикта на неблокирующий закрывает диалог.
 *
 * Дом — общий DOM-шим (`dom-shim.ts`, конвенция `dialog-dirty-close.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CLIENT_VERSION_ERROR_REASON, EtnError } from '@etn/shared';

import { ShimElement } from './dom-shim.js';

const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
  };
  (globalThis as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type: string, listener: (event: any) => void) => {
      windowListeners.push({ type, listener });
    },
    removeEventListener: (type: string, listener: (event: any) => void) => {
      const index = windowListeners.findIndex((l) => l.type === type && l.listener === listener);
      if (index >= 0) windowListeners.splice(index, 1);
    },
  };
}

installShim();

const { initCompatibilityDialog, compatibilityDialogModel } = await import(
  '../src/renderer/lib/compatibility-dialog.js'
);
const { compatibilityFactsText, compatibilityReasonKey, compatibilityReasonText } = await import(
  '../src/renderer/lib/compatibility-reason.js'
);
const { closeDialog } = await import('../src/renderer/lib/dialog.js');
const { t } = await import('../src/renderer/lib/i18n.js');
import type {
  CompatibilityDialogDeps,
  CompatibilityDialogState,
} from '../src/renderer/lib/compatibility-dialog.js';
import type { CompatibilityResult } from '../src/main/ipc/contract.js';

const CLIENT = '0.15.1';
const RELEASE_PAGE = 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.2';

/** Блокирующий вердикт с реалистичными значениями (minor-окно 1f593647). */
function verdict(overrides: Partial<CompatibilityResult> = {}): CompatibilityResult {
  return {
    status: 'client-outdated',
    banner: 'hidden',
    blocking: true,
    reason: 'client-outdated',
    clientVersion: CLIENT,
    clientCompatibility: '>=0.15.0 <0.16.0',
    serverVersion: '0.16.0',
    serverCompatibility: '>=0.16.0 <0.17.0',
    recommendedClientVersion: null,
    downloadUrl: RELEASE_PAGE,
    roleConfirmed: true,
    is_admin: false,
    serverReason: null,
    ...overrides,
  };
}

function body(): ShimElement {
  return (globalThis as any).document.body as ShimElement;
}

/** Открытые диалоги (подложки) в порядке стека. */
function backdrops(): ShimElement[] {
  return body().children.filter((c) => c.classList.contains('dialog-backdrop'));
}

function drainDialogs(): void {
  for (let i = 0; i < 20; i += 1) closeDialog();
}

/** Подписи кнопок футера (пустой массив — футера нет). */
function footerLabels(dialog: ShimElement): string[] {
  const footer = dialog.querySelector('.dialog-footer');
  if (footer === null) return [];
  return footer.querySelectorAll('button').map((b) => b.textContent);
}

function buttonByLabel(dialog: ShimElement, label: string): ShimElement {
  const button = dialog.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(button !== undefined, `в диалоге есть кнопка «${label}»`);
  return button!;
}

/** Esc — всем слушателям keydown окна (диалог решает приоритет сам). */
function pressEscape(): void {
  const event = {
    key: 'Escape',
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  for (const { type, listener } of [...windowListeners]) {
    if (type === 'keydown') listener(event);
  }
}

/** Дождаться микрозадач обработчиков кнопок (async-повтор, копирование). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  update(next: CompatibilityDialogState): void;
  calls: {
    external: string[];
    retries: string[];
    copies: string[];
    serverUpdateOpens: number[];
  };
  stop(): void;
}

/** Контроллер диалога поверх поддельного store и IPC-зависимостей. */
function mount(
  initial: CompatibilityDialogState,
  overrides: Partial<CompatibilityDialogDeps> = {},
): Harness {
  let state = initial;
  const listeners = new Set<() => void>();
  const calls = {
    external: [] as string[],
    retries: [] as string[],
    copies: [] as string[],
    /** Сколько раз открывали диалог обновления сервера (ca26c59d). */
    serverUpdateOpens: [] as number[],
  };
  const stop = initCompatibilityDialog({
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openExternal: async (url) => {
      calls.external.push(url);
      return '';
    },
    openServerUpdate: () => {
      calls.serverUpdateOpens.push(1);
    },
    retry: async (profileId) => {
      calls.retries.push(profileId);
    },
    copyText: async (text) => {
      calls.copies.push(text);
    },
    loadProfiles: async () => [
      { id: 'p1', label: 'Сервер', baseUrl: 'http://localhost:3000' },
    ],
    ...overrides,
  });
  return {
    update(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
    calls,
    stop() {
      stop();
      drainDialogs();
    },
  };
}

const AUTHENTICATED: CompatibilityDialogState = {
  compatibility: verdict(),
  authenticated: true,
  profileId: 'p1',
};

describe('compatibilityDialogModel: состояния блокирующего диалога (8623b9ff)', () => {
  it('client-outdated: «Обновить клиент» (страница релиза) и «Повторить»', () => {
    const model = compatibilityDialogModel(verdict())!;
    assert.equal(model.title, 'compatibility.dialog.title');
    assert.equal(model.reasonKey, 'compatibility.reason.clientOutdated');
    assert.deepEqual(model.actions, ['retry', 'update-client']);
    assert.equal(model.contactAdmin, false);
    assert.equal(model.downloadUnavailable, false);
  });

  it('client-outdated без download_url: кнопки скачивания нет, это честно отмечено', () => {
    const model = compatibilityDialogModel(verdict({ downloadUrl: null }))!;
    assert.deepEqual(model.actions, ['retry']);
    assert.equal(model.downloadUnavailable, true);
  });

  it('server-outdated без администратора: нейтральный текст, обновления сервера нет', () => {
    const model = compatibilityDialogModel(
      verdict({ status: 'server-outdated', reason: 'server-outdated', is_admin: false }),
    )!;
    assert.equal(model.reasonKey, 'compatibility.reason.serverOutdated');
    assert.equal(model.contactAdmin, true);
    assert.deepEqual(model.actions, ['retry']);
    assert.equal(model.actions.includes('update-server'), false);
  });

  it('server-outdated администратор: «Обновить сервер» открывает диалог обновления', () => {
    const model = compatibilityDialogModel(
      verdict({ status: 'server-outdated', reason: 'server-outdated', is_admin: true }),
    )!;
    assert.deepEqual(model.actions, ['retry', 'update-server']);
    assert.equal(model.contactAdmin, false);
  });

  it('все три details.reason дают разные причины из словаря', () => {
    const keys = new Map<string, string>();
    const expected: Array<[string, string]> = [
      [CLIENT_VERSION_ERROR_REASON.missing, 'compatibility.reason.versionMissing'],
      [CLIENT_VERSION_ERROR_REASON.invalid, 'compatibility.reason.versionInvalid'],
      [CLIENT_VERSION_ERROR_REASON.outOfRange, 'compatibility.reason.versionOutOfRange'],
    ];
    for (const [reason, key] of expected) {
      const result = verdict({ serverReason: reason as never });
      assert.equal(compatibilityReasonKey(result), key);
      assert.equal(compatibilityDialogModel(result)!.reasonKey, key);
      keys.set(reason, compatibilityReasonText(result));
    }
    assert.equal(new Set(keys.values()).size, 3, 'тексты причин различаются');
  });

  it('без причины и с чужим значением — общая формулировка client-outdated', () => {
    assert.equal(compatibilityReasonKey(verdict()), 'compatibility.reason.clientOutdated');
    assert.equal(
      compatibilityReasonKey(verdict({ serverReason: 'toString' as never })),
      'compatibility.reason.clientOutdated',
      'унаследованный ключ объекта причиной не считается (класс ошибки 2edf8494)',
    );
  });

  it('неблокирующие вердикты модель не дают (диалог не показывается)', () => {
    for (const status of ['compatible', 'recommended-update', 'check-failed'] as const) {
      assert.equal(
        compatibilityDialogModel(
          verdict({ status, blocking: false, reason: null, banner: 'hidden' }),
        ),
        null,
      );
    }
  });

  it('строка версий: клиент, сервер, диапазон; неизвестное — «неизвестно»', () => {
    assert.equal(
      compatibilityFactsText(verdict()),
      t('compatibility.facts', [CLIENT, '0.16.0', '>=0.16.0 <0.17.0']),
    );
    const unknown = t('compatibility.value.unknown');
    assert.equal(
      compatibilityFactsText(
        verdict({ serverVersion: null, serverCompatibility: null }),
      ),
      t('compatibility.facts', [CLIENT, unknown, unknown]),
    );
  });
});

describe('initCompatibilityDialog: блокирующий диалог (0afec967)', () => {
  beforeEach(() => {
    installShim();
    drainDialogs();
  });

  it('до аутентификации диалог не показывается', () => {
    const harness = mount({ ...AUTHENTICATED, authenticated: false });
    try {
      assert.equal(backdrops().length, 0);
      harness.update({ ...AUTHENTICATED, authenticated: true });
      assert.equal(backdrops().length, 1, 'после аутентификации диалог появляется');
    } finally {
      harness.stop();
    }
  });

  it('крестика нет, Esc не закрывает, «Отложить» и «Проверить» отсутствуют', () => {
    const harness = mount(AUTHENTICATED);
    try {
      const dialog = backdrops()[0]!;
      const header = dialog.querySelector('.dialog-header');
      assert.ok(header !== null);
      assert.equal(header!.querySelectorAll('button').length, 0, 'крестика в заголовке нет');
      pressEscape();
      assert.equal(backdrops().length, 1, 'Esc блокировку не снимает');
      const labels = footerLabels(dialog);
      assert.deepEqual(labels, [t('compatibility.action.retry'), t('compatibility.action.updateClient')]);
      assert.equal(labels.includes(t('actions.cancel')), false);
      for (const forbidden of ['Отложить', 'Проверить']) {
        assert.equal(
          dialog.flatText().includes(forbidden),
          false,
          `кнопки/текста «${forbidden}» в диалоге нет`,
        );
      }
    } finally {
      harness.stop();
    }
  });

  it('client-outdated: «Обновить клиент» открывает страницу релиза без автозагрузки', async () => {
    const harness = mount(AUTHENTICATED);
    try {
      const dialog = backdrops()[0]!;
      assert.match(dialog.flatText(), /Версии клиента и сервера несовместимы/);
      assert.match(dialog.flatText(), /Клиент 0\.15\.1, сервер 0\.16\.0/);
      buttonByLabel(dialog, t('compatibility.action.updateClient')).click();
      await tick();
      assert.deepEqual(harness.calls.external, [RELEASE_PAGE]);
    } finally {
      harness.stop();
    }
  });

  it('успешный повтор открытия снимает строку прошлой ошибки (аналог b57910b5)', async () => {
    let attempt = 0;
    const harness = mount(AUTHENTICATED, {
      openExternal: async () => {
        attempt += 1;
        return attempt === 1 ? 'нет прав' : '';
      },
    });
    try {
      const dialog = backdrops()[0]!;
      buttonByLabel(dialog, t('compatibility.action.updateClient')).click();
      await tick();
      const error = dialog.querySelector('.error-text');
      assert.ok(error !== null, 'строка ошибки есть в диалоге');
      assert.equal(error!.hidden, false, 'неудачный клик показал причину');
      assert.ok(
        error!.textContent.includes(t('compatibility.openFailed', 'нет прав')),
        'в строке — причина отказа',
      );

      buttonByLabel(dialog, t('compatibility.action.updateClient')).click();
      await tick();
      assert.equal(
        error!.hidden,
        true,
        'после успешного открытия ложная ошибка не висит (замечание b57910b5)',
      );
    } finally {
      harness.stop();
    }
  });

  it('причина в диалоге зависит от details.reason сервера', () => {
    const harness = mount({
      ...AUTHENTICATED,
      compatibility: verdict({ serverReason: CLIENT_VERSION_ERROR_REASON.missing }),
    });
    try {
      assert.ok(
        backdrops()[0]!.flatText().includes(t('compatibility.reason.versionMissing')),
        'version-missing — своя формулировка',
      );
      harness.update({
        ...AUTHENTICATED,
        compatibility: verdict({ serverReason: CLIENT_VERSION_ERROR_REASON.invalid }),
      });
      assert.ok(
        backdrops()[0]!.flatText().includes(t('compatibility.reason.versionInvalid')),
        'version-invalid — своя формулировка',
      );
      harness.update({
        ...AUTHENTICATED,
        compatibility: verdict({ serverReason: CLIENT_VERSION_ERROR_REASON.outOfRange }),
      });
      assert.ok(
        backdrops()[0]!.flatText().includes(t('compatibility.reason.versionOutOfRange')),
        'version-out-of-range — своя формулировка',
      );
    } finally {
      harness.stop();
    }
  });

  it('server-outdated неадминистратору: «Обратитесь к администратору сервера» без кнопки обновления', () => {
    const harness = mount({
      ...AUTHENTICATED,
      compatibility: verdict({ status: 'server-outdated', reason: 'server-outdated', is_admin: false }),
    });
    try {
      const dialog = backdrops()[0]!;
      assert.ok(dialog.flatText().includes(t('compatibility.contactAdmin')));
      assert.equal(footerLabels(dialog).includes(t('compatibility.action.updateServer')), false);
    } finally {
      harness.stop();
    }
  });

  it('server-outdated администратору: «Обновить сервер» открывает диалог обновления', () => {
    const harness = mount({
      ...AUTHENTICATED,
      compatibility: verdict({ status: 'server-outdated', reason: 'server-outdated', is_admin: true }),
    });
    try {
      const dialog = backdrops()[0]!;
      assert.equal(dialog.flatText().includes(t('compatibility.contactAdmin')), false);
      buttonByLabel(dialog, t('compatibility.action.updateServer')).click();
      assert.deepEqual(
        harness.calls.serverUpdateOpens,
        [1],
        'кнопка открывает диалог обновления сервера (ca26c59d), а не пояснение',
      );
      assert.equal(backdrops().length, 1, 'блокирующий диалог остаётся открытым');
    } finally {
      harness.stop();
    }
  });

  it('«Повторить» переподключается к активному профилю', async () => {
    const harness = mount(AUTHENTICATED);
    try {
      buttonByLabel(backdrops()[0]!, t('compatibility.action.retry')).click();
      await tick();
      assert.deepEqual(harness.calls.retries, ['p1']);
    } finally {
      harness.stop();
    }
  });

  it('отказ повтора называет адрес и фактическую причину', async () => {
    const harness = mount(AUTHENTICATED, {
      retry: async () => {
        throw new EtnError('INTERNAL', 'Сетевая ошибка: fetch failed', {
          kind: 'connect-failed',
          reason: 'refused',
        });
      },
    });
    try {
      buttonByLabel(backdrops()[0]!, t('compatibility.action.retry')).click();
      await tick();
      const text = backdrops()[0]!.flatText();
      assert.match(text, /Не удалось подключиться к серверу/);
      assert.match(text, /http:\/\/localhost:3000/);
      assert.match(text, /соединение отклонено/);
    } finally {
      harness.stop();
    }
  });

  it('копирование версий кладёт строку версий в буфер', async () => {
    const harness = mount(AUTHENTICATED);
    try {
      buttonByLabel(backdrops()[0]!, t('compatibility.copyVersions')).click();
      await tick();
      assert.deepEqual(harness.calls.copies, [
        t('compatibility.facts', [CLIENT, '0.16.0', '>=0.16.0 <0.17.0']),
      ]);
      assert.ok(backdrops()[0]!.flatText().includes(t('compatibility.copied')));
    } finally {
      harness.stop();
    }
  });

  it('смена вердикта на неблокирующий закрывает диалог', () => {
    const harness = mount(AUTHENTICATED);
    try {
      assert.equal(backdrops().length, 1);
      harness.update({
        compatibility: verdict({ status: 'compatible', blocking: false, reason: null, banner: 'hidden' }),
        authenticated: true,
        profileId: 'p1',
      });
      assert.equal(backdrops().length, 0, 'совместимый вердикт снял блокировку');
    } finally {
      harness.stop();
    }
  });

  it('вердикт меняется без пересоздания диалога (содержимое живое)', () => {
    const harness = mount(AUTHENTICATED);
    try {
      const first = backdrops()[0]!;
      harness.update({
        compatibility: verdict({ status: 'server-outdated', reason: 'server-outdated', is_admin: true }),
        authenticated: true,
        profileId: 'p1',
      });
      assert.equal(backdrops().length, 1, 'второго диалога нет');
      assert.equal(backdrops()[0], first, 'тот же диалог');
      assert.ok(first.flatText().includes(t('compatibility.reason.serverOutdated')));
    } finally {
      harness.stop();
    }
  });
});
