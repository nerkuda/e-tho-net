/**
 * Баннер рекомендованной версии клиента (элемент ed068706, компонент 06d88619,
 * задача b57910b5, сущность 89aad200).
 *
 * Покрыто:
 *  - модель: `recommended-update` (обе версии, действия), нейтральный
 *    `unknown` без кнопок и БЕЗ формулировки «обновлений нет» (DoD),
 *    `hidden`/`compatible` и блокировки — баннера нет;
 *  - рендер: тексты и кнопки, отсутствие действий у `unknown`, скрытие хоста;
 *  - контроллер: показ только после аутентификации, «Позже» до следующего
 *    вердикта (сценарий dde6d22d), сброс на новом вердикте/переподключении,
 *    открытие страницы релиза, честная ошибка клика и её неприменимость к
 *    устаревшему вердикту.
 *
 * Дом — общий DOM-шим (`dom-shim.ts`, конвенция `compatibility-dialog.test.ts`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

(globalThis as any).document = {
  createElement: (tag: string) => new ShimElement(tag),
  createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
  documentElement: new ShimElement('html'),
  body: new ShimElement('body'),
};

const { createUpdateBannerHost, initUpdateBanner, renderUpdateBanner, updateBannerModel } =
  await import('../src/renderer/lib/update-banner.js');
const { t } = await import('../src/renderer/lib/i18n.js');
import type { UpdateBannerDeps } from '../src/renderer/lib/update-banner.js';
import type { CompatibilityResult } from '../src/main/ipc/contract.js';

const CLIENT = '0.15.0';
const RECOMMENDED = '0.15.1';
const RELEASE_PAGE = 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.1';

/** Вердикт с реалистичными значениями (minor-окно 1f593647). */
function verdict(overrides: Partial<CompatibilityResult> = {}): CompatibilityResult {
  return {
    status: 'recommended-update',
    banner: 'recommended-update',
    blocking: false,
    reason: null,
    clientVersion: CLIENT,
    clientCompatibility: '>=0.15.0 <0.16.0',
    serverVersion: '0.15.1',
    serverCompatibility: '>=0.15.0 <0.16.0',
    recommendedClientVersion: RECOMMENDED,
    downloadUrl: RELEASE_PAGE,
    roleConfirmed: true,
    is_admin: false,
    serverReason: null,
    ...overrides,
  };
}

/** Хост баннера: рабочее пространство берёт его из фабрики модуля. */
function makeHost(): ShimElement {
  return createUpdateBannerHost() as unknown as ShimElement;
}

/** Кнопки баннера по подписям (пустой массив — действий нет). */
function buttonLabels(host: ShimElement): string[] {
  return host.querySelectorAll('button').map((b) => b.textContent);
}

function buttonByLabel(host: ShimElement, label: string): ShimElement {
  const found = host.querySelectorAll('button').find((b) => b.textContent === label);
  assert.ok(found !== undefined, `в баннере есть кнопка «${label}»`);
  return found!;
}

/** Текст баннера целиком (заголовок + вторая строка + пояснение). */
function bannerText(host: ShimElement): string {
  return host.textContent;
}

// ---------------------------------------------------------------------------
// Модель
// ---------------------------------------------------------------------------

describe('updateBannerModel: проекция вердикта на баннер', () => {
  it('recommended-update: обе версии, обе кнопки', () => {
    const model = updateBannerModel(verdict());
    assert.ok(model !== null);
    assert.equal(model!.state, 'recommended-update');
    assert.equal(model!.title, t('updateBanner.available', RECOMMENDED));
    assert.equal(model!.subtitle, t('updateBanner.current', CLIENT));
    assert.equal(model!.note, null);
    assert.equal(model!.canUpdate, true);
    assert.equal(model!.canDismiss, true);
  });

  it('compatible и блокирующие статусы — баннера нет (блокировка — диалог)', () => {
    assert.equal(updateBannerModel(null), null);
    assert.equal(
      updateBannerModel(verdict({ status: 'compatible', banner: 'hidden' })),
      null,
      'при compatible рекомендаций нет — баннер скрыт',
    );
    assert.equal(
      updateBannerModel(
        verdict({
          status: 'client-outdated',
          banner: 'hidden',
          blocking: true,
          reason: 'client-outdated',
        }),
      ),
      null,
      'блокировку показывает диалог 8623b9ff, баннер рядом не нужен',
    );
    assert.equal(
      updateBannerModel(
        verdict({
          status: 'server-outdated',
          banner: 'hidden',
          blocking: true,
          reason: 'server-outdated',
        }),
      ),
      null,
    );
  });

  it('check-failed: нейтральное «не удалось проверить», без кнопок', () => {
    const model = updateBannerModel(
      verdict({
        status: 'check-failed',
        banner: 'unknown',
        blocking: false,
        reason: 'check-failed',
        serverVersion: null,
        serverCompatibility: null,
        recommendedClientVersion: null,
        downloadUrl: null,
      }),
    );
    assert.ok(model !== null);
    assert.equal(model!.state, 'unknown');
    assert.equal(model!.title, t('updateBanner.unknown'));
    assert.equal(model!.subtitle, '');
    assert.equal(model!.note, null);
    assert.equal(model!.canUpdate, false);
    assert.equal(model!.canDismiss, false);
    // DoD задачи: unknown не выглядит как «обновлений нет».
    assert.ok(
      model!.title.includes('Не удалось проверить'),
      'unknown обязан честно называть неудачную проверку',
    );
    assert.ok(
      !/обновлений нет|обновлений не найдено/i.test(model!.title),
      'unknown не должен читаться как «обновлений нет»',
    );
  });

  it('нет download_url — кнопки обновления нет, есть пояснение', () => {
    const model = updateBannerModel(verdict({ downloadUrl: null }));
    assert.ok(model !== null);
    assert.equal(model!.canUpdate, false);
    assert.equal(model!.canDismiss, true);
    assert.equal(model!.note, t('compatibility.downloadUnavailable'));
  });

  it('recommended-update без рекомендованной версии — баннера нет', () => {
    assert.equal(updateBannerModel(verdict({ recommendedClientVersion: null })), null);
    assert.equal(updateBannerModel(verdict({ recommendedClientVersion: '   ' })), null);
  });

  it('«Позже» скрывает баннер до следующего вердикта', () => {
    assert.equal(updateBannerModel(verdict(), { dismissed: true }), null);
  });
});

// ---------------------------------------------------------------------------
// Рендер
// ---------------------------------------------------------------------------

describe('renderUpdateBanner: разметка и действия', () => {
  it('recommended-update: обе версии и кнопки «Позже»/«Обновить клиент»', () => {
    const host = makeHost();
    const calls: string[] = [];
    renderUpdateBanner(host as unknown as HTMLElement, {
      model: updateBannerModel(verdict()),
      error: null,
      onUpdate: () => calls.push('update'),
      onDismiss: () => calls.push('dismiss'),
    });

    assert.equal(host.hidden, false);
    assert.ok(host.className.split(' ').includes('update-banner'), 'хост — полоса баннера');
    const text = bannerText(host);
    assert.ok(text.includes(t('updateBanner.available', RECOMMENDED)), 'видна рекомендованная версия');
    assert.ok(text.includes(t('updateBanner.current', CLIENT)), 'видна текущая версия клиента');
    // Главное действие — крайним справа (словарь кнопок).
    assert.deepEqual(buttonLabels(host), [t('updateBanner.dismiss'), t('compatibility.action.updateClient')]);

    buttonByLabel(host, t('updateBanner.dismiss')).click();
    buttonByLabel(host, t('compatibility.action.updateClient')).click();
    assert.deepEqual(calls, ['dismiss', 'update']);
  });

  it('unknown: нейтральный текст без действий', () => {
    const host = makeHost();
    renderUpdateBanner(host as unknown as HTMLElement, {
      model: updateBannerModel(
        verdict({
          status: 'check-failed',
          banner: 'unknown',
          blocking: false,
          reason: 'check-failed',
        }),
      ),
      error: null,
      onUpdate: () => undefined,
      onDismiss: () => undefined,
    });
    assert.equal(host.hidden, false);
    assert.equal(buttonLabels(host).length, 0, 'у unknown кнопок нет');
    assert.ok(bannerText(host).includes(t('updateBanner.unknown')));
  });

  it('модель отсутствует — хост очищен и скрыт', () => {
    const host = makeHost();
    renderUpdateBanner(host as unknown as HTMLElement, {
      model: updateBannerModel(verdict()),
      error: null,
      onUpdate: () => undefined,
      onDismiss: () => undefined,
    });
    renderUpdateBanner(host as unknown as HTMLElement, {
      model: null,
      error: null,
      onUpdate: () => undefined,
      onDismiss: () => undefined,
    });
    assert.equal(host.hidden, true);
    assert.equal(host.childNodes.length, 0);
    assert.equal(
      host.classList.contains('update-banner'),
      false,
      'селектор .update-banner означает «баннер виден»',
    );
  });

  it('ошибка открытия страницы релиза — строкой в баннере', () => {
    const host = makeHost();
    const message = t('compatibility.openFailed', 'нет прав');
    renderUpdateBanner(host as unknown as HTMLElement, {
      model: updateBannerModel(verdict()),
      error: message,
      onUpdate: () => undefined,
      onDismiss: () => undefined,
    });
    assert.ok(bannerText(host).includes(message));
  });
});

// ---------------------------------------------------------------------------
// Контроллер
// ---------------------------------------------------------------------------

interface FakeStore {
  deps: Pick<UpdateBannerDeps, 'getState' | 'subscribe'>;
  update(patch: Partial<{ compatibility: CompatibilityResult | null; authenticated: boolean }>): void;
}

/** Стор-заглушка: снимок + подписка, как `store` рендерера. */
function fakeStore(initial: {
  compatibility: CompatibilityResult | null;
  authenticated: boolean;
}): FakeStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    deps: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    update: (patch) => {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('initUpdateBanner: показ по состоянию', () => {
  let host: ShimElement;

  beforeEach(() => {
    host = makeHost();
  });

  it('до аутентификации баннер не показывается, после — показывается', () => {
    const store = fakeStore({ compatibility: verdict(), authenticated: false });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    assert.equal(host.hidden, true, 'на экране подключения баннера нет');

    store.update({ authenticated: true });
    assert.equal(host.hidden, false);
    assert.equal(host.querySelectorAll('.update-banner-title').length, 1);
    dispose();
  });

  it('«Позже» скрывает баннер, новый вердикт (переподключение) показывает снова', () => {
    const current = verdict();
    const store = fakeStore({ compatibility: current, authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    assert.equal(host.hidden, false);

    buttonByLabel(host, t('updateBanner.dismiss')).click();
    assert.equal(host.hidden, true, '«Позже» скрывает баннер');

    // Обновление store без смены вердикта «Позже» не сбрасывает.
    store.update({ authenticated: true });
    assert.equal(host.hidden, true);

    // Переподключение публикует новый вердикт тем же содержимым — баннер снова
    // виден (сценарий dde6d22d: флаг сбрасывается на подключении).
    store.update({ compatibility: verdict() });
    assert.equal(host.hidden, false);
    dispose();
  });

  it('«Позже» переживает пересборку рабочего пространства (новый контроллер)', () => {
    const current = verdict();
    const store = fakeStore({ compatibility: current, authenticated: true });
    const disposeFirst = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    buttonByLabel(host, t('updateBanner.dismiss')).click();
    disposeFirst();
    assert.equal(host.hidden, true);

    // Рабочее пространство пересобралось: тот же вердикт — нового напоминания нет.
    const rebuilt = makeHost();
    const disposeSecond = initUpdateBanner(rebuilt as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    assert.equal(rebuilt.hidden, true, 'пересборка workspace не сбрасывает «Позже»');

    // Новый вердикт (переподключение) — напоминание снова.
    store.update({ compatibility: verdict() });
    assert.equal(rebuilt.hidden, false);
    disposeSecond();
  });

  it('смена рекомендации показывает баннер независимо от «Позже»', () => {    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    buttonByLabel(host, t('updateBanner.dismiss')).click();
    assert.equal(host.hidden, true);

    store.update({
      compatibility: verdict({ recommendedClientVersion: '0.15.2' }),
    });
    assert.equal(host.hidden, false);
    assert.ok(bannerText(host).includes(t('updateBanner.available', '0.15.2')));
    dispose();
  });

  it('отключение (вердикт null) скрывает баннер — вердикт не старше подключения', () => {
    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    assert.equal(host.hidden, false);
    store.update({ compatibility: null });
    assert.equal(host.hidden, true);
    dispose();
  });

  it('«Обновить клиент» открывает страницу релиза', async () => {
    const opened: string[] = [];
    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async (url) => {
        opened.push(url);
        return '';
      },
    });
    buttonByLabel(host, t('compatibility.action.updateClient')).click();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(opened, [RELEASE_PAGE]);
    assert.equal(host.hidden, false, 'баннер не исчезает после открытия страницы');
    dispose();
  });

  it('ошибка открытия страницы релиза видна в баннере', async () => {
    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => 'нет прав',
    });
    buttonByLabel(host, t('compatibility.action.updateClient')).click();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(bannerText(host).includes(t('compatibility.openFailed', 'нет прав')));
    dispose();
  });

  it('успешный повтор снимает строку прошлой ошибки (замечание b57910b5)', async () => {
    let attempt = 0;
    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => {
        attempt += 1;
        return attempt === 1 ? 'нет прав' : '';
      },
    });

    buttonByLabel(host, t('compatibility.action.updateClient')).click();
    await Promise.resolve();
    await Promise.resolve();
    const failure = t('compatibility.openFailed', 'нет прав');
    assert.ok(bannerText(host).includes(failure), 'первый клик честно показал ошибку');

    // Второй клик открыл страницу — прошлая строка ошибки не должна висеть.
    buttonByLabel(host, t('compatibility.action.updateClient')).click();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(
      !bannerText(host).includes(failure),
      'после успешного открытия ложной ошибки в баннере нет',
    );
    assert.equal(host.hidden, false, 'баннер и рекомендация остаются на месте');
    dispose();
  });

  it('ошибка открытия устаревшего вердикта не попадает в новый баннер', async () => {
    let fail: ((reason: string) => void) | null = null;
    const pending = new Promise<string>((resolve) => {
      fail = resolve;
    });
    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: () => pending,
    });
    buttonByLabel(host, t('compatibility.action.updateClient')).click();

    // Пока браузер открывался, пришёл новый вердикт (переподключение).
    store.update({ compatibility: verdict({ recommendedClientVersion: '0.15.2' }) });
    fail!('нет прав');
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(
      !bannerText(host).includes(t('compatibility.openFailed', 'нет прав')),
      'ошибка прошлого вердикта не показывается поверх нового',
    );
    dispose();
  });

  it('отписка снимает подписку и очищает хост', () => {
    const store = fakeStore({ compatibility: verdict(), authenticated: true });
    const dispose = initUpdateBanner(host as unknown as HTMLElement, {
      ...store.deps,
      openExternal: async () => '',
    });
    dispose();
    assert.equal(host.hidden, true);
    assert.equal(host.childNodes.length, 0);
    // После отписки обновления store не перерисовывают снятый баннер.
    store.update({ compatibility: verdict({ recommendedClientVersion: '0.15.2' }) });
    assert.equal(host.hidden, true);
  });
});
