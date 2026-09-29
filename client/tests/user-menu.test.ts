/**
 * Состав меню пользователя после компоновки верхних меню (задача a0cdd731),
 * возврата пункта «О программе» (ошибка 0e623d4c) и переноса в него команд
 * открытия/создания мыслесети (задача a9cb53dd, решение пользователя
 * 2026-09-29: это команды уровня пользователя).
 *
 * Состав: «Открыть мыслесеть (список)» и «Создать мыслесеть» — перед
 * «Настройки», за разделителем; «Администрирование» (пользователю с правами
 * админа сервера); «Настройки» (объединённый диалог на вкладке «Пользователь»),
 * «О программе» и «Отключиться».
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

describe('меню пользователя — состав (a0cdd731, 0e623d4c, a9cb53dd)', () => {
  it('обычный пользователь: открытие/создание мыслесети, разделитель, «Настройки», «О программе», «Отключиться»', () => {
    store.update({ me: me(false) });
    assert.deepEqual(
      buildUserMenuItems().map((i) => i.label),
      [
        'Открыть мыслесеть (список)',
        'Создать мыслесеть',
        '—',
        'Настройки',
        'О программе',
        'Отключиться',
      ],
    );
  });

  it('админ: «Администрирование», разделитель, затем открытие/создание мыслесети и остальные пункты', () => {
    store.update({ me: me(true) });
    assert.deepEqual(
      buildUserMenuItems().map((i) => i.label),
      [
        'Администрирование',
        '—',
        'Открыть мыслесеть (список)',
        'Создать мыслесеть',
        '—',
        'Настройки',
        'О программе',
        'Отключиться',
      ],
    );
  });

  it('команды открытия/создания мыслесети стоят перед «Настройки» за разделителем (a9cb53dd)', () => {
    for (const isAdmin of [false, true]) {
      store.update({ me: me(isAdmin) });
      const labels = buildUserMenuItems().map((i) => i.label);
      const settings = labels.indexOf('Настройки');
      assert.equal(labels[settings - 1], '—', 'перед «Настройки» — разделитель');
      assert.equal(labels[settings - 2], 'Создать мыслесеть');
      assert.equal(labels[settings - 3], 'Открыть мыслесеть (список)');
    }
  });

  it('«Отключиться» — разрушающее действие и последний пункт', () => {
    store.update({ me: me(false) });
    const items = buildUserMenuItems();
    const last = items[items.length - 1];
    assert.equal(last?.label, 'Отключиться');
    assert.equal(last?.danger, true);
  });
});
