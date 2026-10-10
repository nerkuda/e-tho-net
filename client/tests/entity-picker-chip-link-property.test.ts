/**
 * Чип-поле: предзаданное значение варианта-свойства-связи показывает ИМЯ, а не
 * UUID (ошибка fb4173d9, 0.11.1).
 *
 * У варианта-свойства-связи нет облачка мысли (`cloud`) — только `title` и
 * `linkEnd`. Прежний `renderChips` читал лишь `byId.get(value)?.cloud` и падал в
 * фолбэк `{ id: value, title: value }`, поэтому чип предзаданного источника
 * текстов показывал сырой id свойства. Тест строит чип-поле с предзаданным
 * значением БЕЗ открытия пикера и проверяет: подпись — имя свойства, знак —
 * значок конца связи; UUID не светится.
 *
 * DOM-шим — общий (`dom-shim.ts`), сборка окружения — по образцу
 * `entity-picker.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntityOption } from '../src/renderer/lib/entity-picker.js';
import { buildEntityChipField } from '../src/renderer/lib/entity-picker.js';
import { ShimElement } from './dom-shim.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROPERTY_ID = '11111111-2222-4333-8444-555555555555';
const PROPERTY_NAME = 'Источники текста';

/** Вариант-свойство-связь: имя + значок конца связи, облачка мысли НЕТ. */
const LINK_PROPERTY_OPTION: EntityOption = {
  id: PROPERTY_ID,
  title: PROPERTY_NAME,
  selectable: true,
  linkEnd: { direction: 'down', width: 2, style: 'solid', color: '#e08a3c' },
  linkProperty: { propertyId: PROPERTY_ID, side: 'source', key: PROPERTY_NAME },
};

function installShim(): void {
  const body = new ShimElement('body');
  (globalThis as any).HTMLElement = ShimElement;
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    body,
    documentElement: new ShimElement('html'),
    activeElement: body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.innerWidth = 1200;
  win.innerHeight = 800;
  win.etn = { ui: { getState: async () => null, setState: async () => undefined } };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dispatchEvent = () => undefined;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Чип в поле: облачко профиля `chip` (`.prop-ref-cloud`). */
function chips(root: ShimElement): ShimElement[] {
  return root.findAll((el) => el.className.includes('prop-ref-cloud'));
}

describe('чип-поле: имя варианта-свойства-связи вместо UUID (fb4173d9)', () => {
  it('предзаданное значение + initialOptions: имя и значок сразу, без открытия пикера', () => {
    installShim();
    const field = buildEntityChipField({
      getValues: () => [PROPERTY_ID],
      onChange: () => undefined,
      loadOptions: () => [LINK_PROPERTY_OPTION],
      initialOptions: [LINK_PROPERTY_OPTION],
    });
    const root = field.root as unknown as ShimElement;

    // Никаких await: чип обязан быть верным уже при первом построении.
    const chip = chips(root)[0];
    assert.ok(chip !== undefined, 'чип значения построен');
    assert.ok(chip.flatText().includes(PROPERTY_NAME), 'чип показывает имя свойства');
    assert.ok(!chip.flatText().includes(PROPERTY_ID), 'UUID свойства в чипе не светится');

    // Значок конца связи (стрелка) — на месте слота значка, как в строках списка.
    const sign = chip.findAll((el) => el.className.includes('property-list-link-icon'))[0];
    assert.ok(sign !== undefined, 'у чипа есть значок конца связи');
    assert.equal(sign.getAttribute('data-direction'), 'down', 'направление значка — сторона-источник');
  });

  it('cloudOf с названием (рецепт публикации) не подавляет значок свойства (ошибка 382e3478)', () => {
    installShim();
    const field = buildEntityChipField({
      getValues: () => [PROPERTY_ID],
      onChange: () => undefined,
      loadOptions: () => [LINK_PROPERTY_OPTION],
      initialOptions: [LINK_PROPERTY_OPTION],
      // Рецепт публикации передаёт облачко ради КАНОНИЧЕСКОГО имени свойства
      // (`cloudOf` возвращает `{id, title}` без значка). Знак чипа обязан
      // прийти из реестра (`linkEnd` варианта), а не подмениться глифом мысли.
      cloudOf: (value) => ({ id: value, title: PROPERTY_NAME }),
    });
    const root = field.root as unknown as ShimElement;

    const chip = chips(root)[0];
    assert.ok(chip !== undefined, 'чип значения построен');
    assert.ok(chip.flatText().includes(PROPERTY_NAME), 'чип показывает имя свойства');
    const sign = chip.findAll((el) => el.className.includes('property-list-link-icon'))[0];
    assert.ok(sign !== undefined, 'чип свойства несёт значок реестра, а не глиф мысли');
    assert.equal(sign.getAttribute('data-direction'), 'down', 'направление значка — сторона-источник');
  });

  it('без initialOptions имя появляется после загрузки каталога (тот же резолв, не только предзагрузка)', async () => {
    installShim();
    const field = buildEntityChipField({
      getValues: () => [PROPERTY_ID],
      onChange: () => undefined,
      loadOptions: () => [LINK_PROPERTY_OPTION],
    });
    const root = field.root as unknown as ShimElement;
    await flush();

    const chip = chips(root)[0];
    assert.ok(chip !== undefined, 'чип значения построен');
    assert.ok(chip.flatText().includes(PROPERTY_NAME), 'после загрузки каталога чип показывает имя');
    assert.ok(!chip.flatText().includes(PROPERTY_ID), 'UUID не светится и без initialOptions');
  });

  it('структурный вариант без linkEnd тоже подписан именем, а не id', () => {
    installShim();
    const structural: EntityOption = {
      id: '55555555-6666-4777-8888-999999999999',
      title: 'Родители',
      selectable: true,
      linkProperty: { propertyId: '55555555-6666-4777-8888-999999999999', side: 'source', key: 'Родители' },
    };
    const field = buildEntityChipField({
      getValues: () => [structural.id],
      onChange: () => undefined,
      loadOptions: () => [structural],
      initialOptions: [structural],
    });
    const root = field.root as unknown as ShimElement;
    const chip = chips(root)[0];
    assert.ok(chip !== undefined, 'чип построен');
    assert.ok(chip.flatText().includes('Родители'), 'чип показывает имя структурного варианта');
    assert.ok(!chip.flatText().includes(structural.id), 'UUID не светится');
  });
});
