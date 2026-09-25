/**
 * Диалог «Все настройки»: стабильная высота при переключении разделов —
 * ошибка 0ab63eac, требование 13464c39 «Стабильные размеры диалога: роли
 * S/M/L/XL, высота не зависит от вкладки».
 *
 * Симптом до правки: разделы левой навигации (Пользователь / Мыслесеть /
 * Клиент / Логирование) имеют разную высоту, диалог собирался из `body` +
 * `customFooter` и получал только `max-height` роли — при переключении раздела
 * окно «дёргалось», кнопки футера уезжали. Этап 1 дизайн-системы убрал класс
 * `dialog-box-tall`, фиксировавший высоту диалога с кастомным футером, но роль
 * фиксирует высоту только у вкладочных диалогов.
 *
 * Решение: каркас получил опцию `fixedHeight` (атрибут
 * `data-dialog-fixed-height`), высота диалога настроек фиксируется ролью, тело
 * прокручивается внутри. Левая навигация сохранена (спека элемента «Единый
 * диалог настроек»), вкладки каркаса для разделов не применяются.
 *
 * Диалог монтируется целиком под DOM-шимом, как в `settings-show-trash.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';
import { assembledStylesFile } from './renderer-css.js';

const CSS_PATH = assembledStylesFile();

/** События `window` (каркас диалога слушает Esc/Ctrl+Enter). */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

function installShim(): void {
  windowListeners.length = 0;
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

/** Монтирует диалог настроек на разделе «Пользователь» и отдаёт его подложку. */
async function openSettings(): Promise<ShimElement> {
  installShim();
  (globalThis as any).window.etn = {
    networks: {
      setPreference: async () => undefined,
      update: async () => {
        throw new Error('PATCH сети в этом тесте не ожидается');
      },
    },
    meta: { set: async () => undefined },
    ui: { setState: async () => undefined },
  };
  const { store } = await import('../src/renderer/state.js');
  store.update({
    networkId: 'n1',
    me: { id: 'u1', username: 'me', display_name: 'Me', is_admin: false },
    network: {
      id: 'n1',
      display_name: 'Сеть',
      description: null,
      when_to_use: null,
      conventions: null,
      examples: null,
      type_roles: {},
      owner_id: 'u1',
    },
    thoughtTypes: [],
    linkTypes: [],
    activeView: 'map',
  } as any);
  const { showSettingsDialog } = await import('../src/renderer/screens/settings.js');
  showSettingsDialog('user');
  const backdrop = ((globalThis as any).document.body as ShimElement).findAll(
    'dialog-backdrop',
  )[0];
  assert.ok(backdrop !== undefined, 'диалог настроек смонтирован');
  return backdrop;
}

/** Кнопка левой навигации по подписи раздела. */
function navButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop
    .findAll('settings-nav-item')
    .find((b) => (b.textContent ?? '') === label);
  assert.ok(btn !== undefined, `пункт навигации «${label}» найден`);
  return btn!;
}

/** Кнопка футера по точной подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop
    .querySelectorAll('button')
    .find((b) => (b.textContent ?? '') === label);
  assert.ok(btn !== undefined, `кнопка футера «${label}» найдена`);
  return btn!;
}

function box(backdrop: ShimElement): ShimElement {
  const found = backdrop.querySelector('.dialog-box');
  assert.ok(found !== null, 'бокс диалога найден');
  return found!;
}

describe('диалог «Все настройки»: стабильная высота (ошибка 0ab63eac)', () => {
  it('диалог фиксирует высоту ролью (data-dialog-fixed-height), а не авто-высотой', async () => {
    const backdrop = await openSettings();
    const found = box(backdrop);
    assert.equal(found.dataset['dialogSize'], 'l', 'роль размера — l');
    assert.equal(
      found.dataset['dialogFixedHeight'],
      'true',
      'высота диалога настроек фиксируется ролью, а не содержимым раздела',
    );
    // Высота приходит от CSS роли, inline-высоты нет.
    assert.equal(found.style.getPropertyValue('height'), '', 'inline-высота не выставляется');
  });

  it('переключение раздела меняет содержимое, но не высоту/роль диалога', async () => {
    const backdrop = await openSettings();
    const found = box(backdrop);
    const sizeBefore = found.dataset['dialogSize'];
    const fixedBefore = found.dataset['dialogFixedHeight'];
    const heightBefore = found.style.getPropertyValue('height');

    // Раздел «Пользователь» показан; переходим на «Клиент» (другая высота).
    navButton(backdrop, 'Клиент').click();

    const content = backdrop.findAll('settings-content')[0];
    assert.ok(content !== undefined, 'контейнер содержимого на месте');
    assert.ok(
      content!.flatText().includes('Тема'),
      'содержимое переключилось на раздел «Клиент»',
    );
    assert.equal(found.dataset['dialogSize'], sizeBefore, 'роль размера не изменилась');
    assert.equal(found.dataset['dialogFixedHeight'], fixedBefore, 'фиксация высоты сохранилась');
    assert.equal(
      found.style.getPropertyValue('height'),
      heightBefore,
      'inline-высота не появилась — высота не зависит от раздела',
    );
  });

  it('sticky-футер с «Применить / Отмена / Применить и закрыть» сохранён', async () => {
    const backdrop = await openSettings();
    footerButton(backdrop, 'Применить');
    footerButton(backdrop, 'Отмена');
    footerButton(backdrop, 'Применить и закрыть');
    // Футер — direct child бокса (вне прокручиваемого тела): не переключается
    // вместе с разделом.
    const footer = backdrop.findAll('settings-footer')[0];
    assert.ok(footer !== undefined, 'футер настроек на месте');
    assert.ok(box(backdrop).contains(footer!), 'футер лежит в боксе диалога, а не в теле');
  });

  it('CSS фиксирует высоту диалога с флагом (требование 13464c39)', () => {
    const css = readFileSync(CSS_PATH, 'utf8');
    assert.match(
      css,
      /\.dialog-box\[data-dialog-fixed-height='true'\]\s*\{[^}]*height:\s*min\(var\(--dialog-h/,
      'высота диалога настроек задана ролью в CSS',
    );
  });
});
