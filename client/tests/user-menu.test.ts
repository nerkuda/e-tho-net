/**
 * Состав меню пользователя после компоновки верхних меню (задача a0cdd731).
 *
 * Остаются только «Администрирование» (пользователю с правами админа сервера),
 * «Настройки» (объединённый диалог на вкладке «Пользователь») и «Отключиться».
 * «Открыть мыслесеть (список)»/«Создать мыслесеть» переехали в меню
 * «Мыслесеть», «О программе» — на экран списка мыслесетей.
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

describe('меню пользователя — состав (a0cdd731)', () => {
  it('обычный пользователь: «Настройки» и «Отключиться»', () => {
    store.update({ me: me(false) });
    assert.deepEqual(
      buildUserMenuItems().map((i) => i.label),
      ['Настройки', 'Отключиться'],
    );
  });

  it('админ: «Администрирование», разделитель, затем «Настройки» и «Отключиться»', () => {
    store.update({ me: me(true) });
    assert.deepEqual(
      buildUserMenuItems().map((i) => i.label),
      ['Администрирование', '—', 'Настройки', 'Отключиться'],
    );
  });

  it('«Отключиться» — разрушающее действие и последний пункт', () => {
    store.update({ me: me(false) });
    const items = buildUserMenuItems();
    const last = items[items.length - 1];
    assert.equal(last?.label, 'Отключиться');
    assert.equal(last?.danger, true);
  });

  it('команд открытия/создания мыслесети в меню нет', () => {
    store.update({ me: me(false) });
    const labels = buildUserMenuItems().map((i) => i.label);
    assert.equal(labels.includes('Открыть сеть (список)'), false);
    assert.equal(labels.includes('Создать сеть'), false);
  });
});
