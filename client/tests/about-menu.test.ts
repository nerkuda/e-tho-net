/**
 * «О программе» в меню пользователя (ошибка 0e623d4c).
 *
 * Пункт был потерян при перекомпоновке верхних меню (задача a0cdd731) и
 * возвращён в меню пользователя. Прежняя точка входа — кнопка на экране списка
 * мыслесетей (`screens/networks.ts`) — сохранена, поэтому диалог достижим и без
 * подключения к серверу.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('меню пользователя — «О программе» возвращено (0e623d4c)', () => {
  it('содержит «О программе» и для обычного пользователя, и для админа', () => {
    for (const isAdmin of [false, true]) {
      store.update({ me: me(isAdmin) });
      const item = buildUserMenuItems().find((i) => i.label === 'О программе');
      assert.ok(item !== undefined, 'пункт «О программе» есть в меню пользователя');
      assert.equal(typeof item?.onClick, 'function', 'пункт открывает диалог (обработчик есть)');
    }
  });

  it('идёт перед «Отключиться» — последний пункт остаётся разрушающим', () => {
    store.update({ me: me(false) });
    const labels = buildUserMenuItems().map((i) => i.label);
    assert.ok(
      labels.indexOf('О программе') < labels.indexOf('Отключиться'),
      '«О программе» стоит до «Отключиться»',
    );
  });

  it('прежняя точка входа на экране списка мыслесетей сохранена', () => {
    const networks = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'renderer', 'screens', 'networks.ts'),
      'utf8',
    );
    assert.ok(
      networks.includes('showAboutDialog()'),
      'на экране списка мыслесетей должна остаться кнопка «О программе»',
    );
  });
});
