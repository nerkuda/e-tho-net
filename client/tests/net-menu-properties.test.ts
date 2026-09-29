/**
 * Pins the «Мыслесеть» menu composition (задача d4e23670, fd4d4927; заново —
 * задача a0cdd731 «Компоновка верхних меню»; команды открытия/создания
 * мыслесети убраны задачей a9cb53dd).
 *
 * Состав и порядок пунктов: счётчики каталогов и корзины, затем настройка/
 * статистика/участники/выход мыслесети, затем показ/скрытие редактора мысли.
 * Открытие/создание мыслесети переехали в меню пользователя (a9cb53dd).
 * Числа типов мыслей и типов связей берутся из store, числа свойств и корзины
 * передаются счётчиками. Терминология — по требованию fc00129d: «Свойства
 * мыслей», «Участники мыслесети», «Выйти из мыслесети».
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildNetMenuItems } from '../src/renderer/screens/workspace-menus.js';
import { store } from '../src/renderer/state.js';
import type { LinkType, Network, ThoughtType } from '@etn/shared';

const NETWORK: Network = {
  id: 'net-1',
  owner_id: 'u-1',
  display_name: 'Test',
  description: null,
  when_to_use: null,
  conventions: null,
  examples: null,
  type_roles: {},
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

function labels(counts = { properties: 0, trash: 0 }): string[] {
  return buildNetMenuItems(counts).map((item) => item.label);
}

afterEach(() => {
  store.update({
    network: null,
    me: null,
    thoughtTypes: [],
    linkTypes: [],
    editorPosition: 'right',
  });
});

describe('«Мыслесеть» menu — состав и счётчики (a0cdd731)', () => {
  it('держит порядок пунктов и подставляет счётчики', () => {
    store.update({
      network: NETWORK,
      me: { id: 'u-1', username: 'owner', display_name: 'Owner', is_admin: false },
      thoughtTypes: Array.from({ length: 3 }, () => ({})) as ThoughtType[],
      linkTypes: Array.from({ length: 5 }, () => ({})) as LinkType[],
    });
    assert.deepEqual(labels({ properties: 7, trash: 2 }), [
      'Типы мыслей (3)',
      'Типы связей (5)',
      'Свойства мыслей (7)',
      'Корзина (2)',
      '—',
      'Настройка мыслесети',
      'Статистика мыслесети',
      'Участники мыслесети',
      'Выйти из мыслесети',
      '—',
      'Скрыть редактор мысли',
    ]);
  });

  it('«Свойства мыслей» идёт сразу после «Типы связей» (не «Свойства»)', () => {
    store.update({
      network: NETWORK,
      me: { id: 'u-1', username: 'owner', display_name: 'Owner', is_admin: false },
    });
    const ls = labels();
    assert.equal(ls.indexOf('Свойства мыслей (0)'), ls.indexOf('Типы связей (0)') + 1);
    assert.equal(ls.indexOf('Свойства'), -1, 'старая подпись «Свойства» убрана');
    assert.equal(ls.indexOf('Участники сети'), -1, 'термин «сеть» заменён на «мыслесеть»');
  });

  it('«Статистика мыслесети» идёт между настройкой и участниками (c69b078d)', () => {
    store.update({
      network: NETWORK,
      me: { id: 'u-1', username: 'owner', display_name: 'Owner', is_admin: false },
    });
    const ls = labels();
    assert.equal(
      ls.indexOf('Статистика мыслесети'),
      ls.indexOf('Настройка мыслесети') + 1,
      'пункт статистики обязан идти сразу после «Настройка мыслесети»',
    );
    assert.equal(
      ls.indexOf('Участники мыслесети'),
      ls.indexOf('Статистика мыслесети') + 1,
      'пункт статистики обязан идти строго перед «Участники мыслесети»',
    );
  });

  it('владельцу доступен выход, а участники — только владельцу', () => {
    store.update({
      network: NETWORK,
      me: { id: 'u-1', username: 'owner', display_name: 'Owner', is_admin: false },
    });
    const owner = buildNetMenuItems({ properties: 0, trash: 0 });
    const ownerMembers = owner.find((i) => i.label === 'Участники мыслесети');
    const ownerLeave = owner.find((i) => i.label === 'Выйти из мыслесети');
    assert.equal(ownerMembers?.disabled, false);
    assert.equal(ownerLeave?.disabled, true, 'владелец не выходит из своей мыслесети');

    store.update({
      network: { ...NETWORK, owner_id: 'u-owner' },
      me: { id: 'u-other', username: 'other', display_name: 'Other', is_admin: false },
    });
    const other = buildNetMenuItems({ properties: 0, trash: 0 });
    assert.equal(
      other.find((i) => i.label === 'Участники мыслесети')?.disabled,
      true,
      'участники — только владельцу',
    );
    assert.equal(other.find((i) => i.label === 'Выйти из мыслесети')?.disabled, false);
  });

  it('подпись редактора зависит от его видимости', () => {
    store.update({ editorPosition: 'hidden' });
    assert.ok(labels().includes('Показать редактор мысли'));
    store.update({ editorPosition: 'right' });
    assert.ok(labels().includes('Скрыть редактор мысли'));
  });
});
