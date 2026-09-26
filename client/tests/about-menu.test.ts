/**
 * «О программе» больше не живёт в меню пользователя (задача a0cdd731
 * «Компоновка верхних меню»).
 *
 * Меню пользователя оставляет только «Администрирование» (админу),
 * «Настройки» и «Отключиться». Пункт «О программе» оттуда убран; его видимая
 * точка входа — кнопка на экране списка мыслесетей (`screens/networks.ts`),
 * поэтому функция остаётся достижимой без соединения с сервером.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildUserMenuItems } from '../src/renderer/screens/workspace-menus.js';
import { store } from '../src/renderer/state.js';
import type { CurrentUser } from '@etn/shared';

function me(isAdmin: boolean): CurrentUser {
  return {
    id: 'u1',
    username: 'tester',
    display_name: 'Tester',
    is_admin: isAdmin,
  } as CurrentUser;
}

afterEach(() => {
  store.update({ me: null });
});

describe('меню пользователя — «О программе» убрано (a0cdd731)', () => {
  it('не содержит «О программе» ни для обычного пользователя, ни для админа', () => {
    for (const isAdmin of [false, true]) {
      store.update({ me: me(isAdmin) });
      const labels = buildUserMenuItems().map((i) => i.label);
      assert.equal(labels.includes('О программе'), false, 'пункт убран из меню пользователя');
    }
  });

  it('строит меню без подключённого пользователя', () => {
    store.update({ me: null });
    const labels = buildUserMenuItems().map((i) => i.label);
    assert.deepEqual(labels, ['Настройки', 'Отключиться']);
  });
});
