/**
 * Настройка сети «Показывать содержимое корзины» в диалоге настроек — задача
 * 77923b49 (0.8.2).
 *
 * Регрессия, которую проверяет тест: галочка жила в черновике и в проверке
 * «грязности», но у неё НЕ было ветки применения — «Применить» не писал
 * preference, настройка не сохранялась и экраны не перечитывались (настройка
 * была мертва). Путь у неё тот же, что у «Показывать неактуальные мысли и
 * связи»: `etn.networks.setPreference(networkId, PREF_KEY.SHOW_TRASH, value)`
 * → `store.update({ showTrash })` → перезапрос карты и деревьев «Структур».
 *
 * Диалог монтируется целиком под DOM-шимом (`showSettingsDialog('network')`),
 * проверяются: галочка отражает store, переключение+«Применить» пишет
 * preference и обновляет store, повторное применение без правок не пишет
 * ничего.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Записи `etn.networks.setPreference` — предмет проверки. */
type PrefWrite = { networkId: string; key: string; value: unknown };

/** Монтирует диалог настроек на разделе «Мыслесеть» и отдаёт его подложку. */
async function openSettings(
  writes: PrefWrite[],
  initial: { showTrash: boolean; showInactive: boolean },
): Promise<{ backdrop: ShimElement; store: typeof import('../src/renderer/state.js').store }> {
  installShim();
  (globalThis as any).window.etn = {
    networks: {
      setPreference: async (networkId: string, key: string, value: unknown) => {
        writes.push({ networkId, key, value });
      },
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
    showTrash: initial.showTrash,
    showInactive: initial.showInactive,
  } as any);
  const { showSettingsDialog } = await import('../src/renderer/screens/settings.js');
  showSettingsDialog('network');
  const backdrop = ((globalThis as any).document.body as ShimElement).findAll(
    'dialog-backdrop',
  )[0];
  assert.ok(backdrop !== undefined, 'диалог настроек смонтирован');
  return { backdrop, store };
}

/** Галочка «Показывать содержимое корзины в этой сети». */
function trashCheckbox(backdrop: ShimElement): ShimElement {
  for (const row of backdrop.findAll('ui-choice-row')) {
    const label = row.children.map((c) => c.textContent ?? '').join(' ');
    if (label.includes('содержимое корзины')) {
      const input = row.children.find((c) => c.tagName.toLowerCase() === 'input');
      assert.ok(input !== undefined, `в строке нет input: ${label}`);
      return input!;
    }
  }
  assert.fail('галочка «Показывать содержимое корзины» не найдена в диалоге');
}

/** Кнопка футера по точной подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop
    .querySelectorAll('button')
    .find((b) => (b.textContent ?? '') === label);
  assert.ok(btn !== undefined, `кнопка «${label}» не найдена`);
  return btn!;
}

describe('настройка «Показывать содержимое корзины» в диалоге настроек (77923b49)', () => {
  it('галочка отражает store и своё значение по умолчанию (включено)', async () => {
    const writes: PrefWrite[] = [];
    const { backdrop } = await openSettings(writes, { showTrash: true, showInactive: false });
    const box = trashCheckbox(backdrop);
    assert.equal(box.checked, true, 'дефолт настройки — корзина показывается');
    // Рядом с неактуальными, в группе «Видимость».
    const titles = backdrop.findAll('settings-section-title').map((t) => t.textContent);
    assert.ok(titles.includes('Видимость'), `группа «Видимость» на месте: ${titles.join(', ')}`);
    assert.deepEqual(writes, [], 'открытие диалога ничего не пишет');
  });

  it('выключение + «Применить» пишет preference show_trash и обновляет store', async () => {
    const writes: PrefWrite[] = [];
    const { backdrop, store } = await openSettings(writes, {
      showTrash: true,
      showInactive: false,
    });
    const box = trashCheckbox(backdrop);
    box.checked = false;
    box.emit('change');
    footerButton(backdrop, 'Применить').click();
    await wait(0);

    assert.deepEqual(writes, [{ networkId: 'n1', key: 'show_trash', value: false }]);
    assert.equal(store.state.showTrash, false, 'store переключён — экраны перечитают данные');
    // Повторное применение без правок — не пишет (черновик синхронизирован).
    footerButton(backdrop, 'Применить').click();
    await wait(0);
    assert.equal(writes.length, 1, 'повторное «Применить» без правок ничего не пишет');
    // Обратное включение — тем же путём.
    box.checked = true;
    box.emit('change');
    footerButton(backdrop, 'Применить').click();
    await wait(0);
    assert.deepEqual(writes[1], { networkId: 'n1', key: 'show_trash', value: true });
    assert.equal(store.state.showTrash, true);
  });

  it('настройка неактуальных остаётся в том же диалоге и пишется своим ключом', async () => {
    const writes: PrefWrite[] = [];
    const { backdrop, store } = await openSettings(writes, {
      showTrash: true,
      showInactive: false,
    });
    for (const row of backdrop.findAll('ui-choice-row')) {
      const label = row.children.map((c) => c.textContent ?? '').join(' ');
      if (!label.includes('неактуальные мысли')) continue;
      const input = row.children.find((c) => c.tagName.toLowerCase() === 'input');
      assert.ok(input !== undefined);
      input!.checked = true;
      input!.emit('change');
    }
    footerButton(backdrop, 'Применить').click();
    await wait(0);
    assert.deepEqual(writes, [{ networkId: 'n1', key: 'show_inactive', value: true }]);
    assert.equal(store.state.showInactive, true);
  });
});
