/**
 * Настройка «Первый день недели» в диалоге «Все настройки» — задача b5278f9a
 * (0.13.2, требование 1b77decd).
 *
 * Проверяется:
 *   - поле есть в разделе «Мыслесеть» и отражает `network.first_day_of_week`;
 *   - варианты — семь дней ISO 1=пн … 7=вс;
 *   - изменение уходит ОДНИМ `PATCH /networks/{id}` вместе с остальными полями
 *     раздела (не отдельным запросом) и обновляет `store.state.network`;
 *   - владелец и администратор редактируют, остальные видят поле read-only;
 *   - повторное «Применить» без правок ничего не пишет.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShimElement } from './dom-shim.js';

/** События `window` (каркас диалога слушает Esc/Ctrl+Enter). */
const windowListeners: Array<{ type: string; listener: (event: any) => void }> = [];

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

/** Запись `etn.networks.update` — предмет проверки. */
type NetworkPatch = { id: string; fields: Record<string, unknown> };

interface OpenOptions {
  firstDayOfWeek?: number;
  ownerId?: string;
  isAdmin?: boolean;
}

/** Монтирует диалог настроек на разделе «Мыслесеть». */
async function openSettings(
  patches: NetworkPatch[],
  options: OpenOptions = {},
): Promise<{ backdrop: ShimElement; store: typeof import('../src/renderer/state.js').store }> {
  installShim();
  const me = {
    id: 'u1',
    username: 'me',
    display_name: 'Me',
    is_admin: options.isAdmin === true,
  };
  const network = {
    id: 'n1',
    display_name: 'Сеть',
    description: null,
    when_to_use: null,
    conventions: null,
    examples: null,
    type_roles: {},
    owner_id: options.ownerId ?? 'u1',
    first_day_of_week: options.firstDayOfWeek ?? 1,
  };
  (globalThis as any).window.etn = {
    networks: {
      // Один PATCH: тест считает вызовы и проверяет пакет.
      update: async (id: string, fields: Record<string, unknown>) => {
        patches.push({ id, fields });
        return { ...network, ...fields };
      },
      setPreference: async () => undefined,
    },
    meta: { set: async () => undefined },
    ui: { setState: async () => undefined },
  };
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
  const { showSettingsDialog } = await import('../src/renderer/screens/settings.js');
  showSettingsDialog('network');
  const backdrop = ((globalThis as any).document.body as ShimElement).findAll(
    'dialog-backdrop',
  )[0];
  assert.ok(backdrop !== undefined, 'диалог настроек смонтирован');
  return { backdrop, store };
}

/** Поле выбора первого дня недели (единственный `<select>` раздела). */
function firstDaySelect(backdrop: ShimElement): ShimElement {
  const select = backdrop.findAll((el) => el.tagName === 'select')[0];
  assert.ok(select !== undefined, 'поле «Первый день недели» не найдено');
  return select!;
}

/** Кнопка футера по точной подписи. */
function footerButton(backdrop: ShimElement, label: string): ShimElement {
  const btn = backdrop
    .querySelectorAll('button')
    .find((b) => (b.textContent ?? '') === label);
  assert.ok(btn !== undefined, `кнопка «${label}» не найдена`);
  return btn!;
}

describe('настройка «Первый день недели» в диалоге «Все настройки» (b5278f9a)', () => {
  it('поле отражает значение сети, предлагает семь дней ISO 1=пн … 7=вс', async () => {
    const patches: NetworkPatch[] = [];
    const { backdrop } = await openSettings(patches, { firstDayOfWeek: 7 });
    const select = firstDaySelect(backdrop);
    assert.equal(select.value, '7', 'значение берётся из network.first_day_of_week');
    assert.deepEqual(
      select.children.map((o) => o.value),
      ['1', '2', '3', '4', '5', '6', '7'],
      'варианты — семь дней ISO',
    );
    assert.deepEqual(
      select.children.map((o) => o.textContent),
      [
        'Понедельник',
        'Вторник',
        'Среда',
        'Четверг',
        'Пятница',
        'Суббота',
        'Воскресенье',
      ],
    );
    assert.deepEqual(patches, [], 'открытие диалога ничего не пишет');
  });

  it('изменение уходит одним PATCH вместе с полями раздела и обновляет store', async () => {
    const patches: NetworkPatch[] = [];
    const { backdrop, store } = await openSettings(patches, { firstDayOfWeek: 1 });
    const select = firstDaySelect(backdrop);
    select.value = '7';
    select.emit('change');
    footerButton(backdrop, 'Применить').click();
    await wait(0);

    assert.equal(patches.length, 1, 'ровно один PATCH — одна транзакция на сервере');
    assert.equal(patches[0]!.id, 'n1');
    assert.equal(patches[0]!.fields['first_day_of_week'], 7, 'fdw в пакете');
    // Пакет несёт и остальные поля раздела — отдельного запроса нет.
    for (const key of ['display_name', 'description', 'when_to_use', 'conventions', 'examples', 'type_roles']) {
      assert.ok(key in patches[0]!.fields, `поле раздела «${key}» в том же пакете`);
    }
    assert.equal(store.state.network?.first_day_of_week, 7, 'store обновлён из ответа');

    // Повторное применение без правок — ничего не пишет.
    footerButton(backdrop, 'Применить').click();
    await wait(0);
    assert.equal(patches.length, 1, 'повторное «Применить» без правок ничего не пишет');
  });

  it('владелец и администратор редактируют, остальные — только смотрят', async () => {
    const ownerPatches: NetworkPatch[] = [];
    const owner = await openSettings(ownerPatches, { ownerId: 'u1' });
    assert.equal(firstDaySelect(owner.backdrop).disabled, false, 'владелец редактирует');

    const adminPatches: NetworkPatch[] = [];
    const admin = await openSettings(adminPatches, { ownerId: 'u2', isAdmin: true });
    assert.equal(firstDaySelect(admin.backdrop).disabled, false, 'админ редактирует');

    const memberPatches: NetworkPatch[] = [];
    const member = await openSettings(memberPatches, { ownerId: 'u2', isAdmin: false });
    assert.equal(firstDaySelect(member.backdrop).disabled, true, 'участник — read-only');
  });
});
