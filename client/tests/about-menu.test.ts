/**
 * Tests for the «О программе» entry points (task 4cba7d74, 08-ui-spec.md
 * §8.2): the user menu always carries the About item — non-danger, in the
 * last group together with the danger «Отключиться» — both for a regular
 * user and for an admin (whose menu has the extra «Администрирование»
 * group). The About dialog itself needs no server connection, so the menu
 * must build with `me === null` too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

describe('buildUserMenuItems — «О программе»', () => {
  it('shows the About item before the danger «Отключиться» for a regular user', () => {
    store.update({ me: me(false) });
    const labels = buildUserMenuItems().map((i) => i.label);
    const aboutIdx = labels.indexOf('О программе');
    const logoutIdx = labels.indexOf('Отключиться');
    assert.ok(aboutIdx !== -1, 'the menu must contain «О программе»');
    assert.ok(logoutIdx !== -1, 'the menu must contain «Отключиться»');
    assert.ok(aboutIdx < logoutIdx, '«О программе» comes before «Отключиться»');
    // A separator must group the two entries apart from the network commands.
    assert.equal(labels[aboutIdx - 1], '—', 'the About entry starts a new group');
  });

  it('keeps the About item with the admin menu layout', () => {
    store.update({ me: me(true) });
    const items = buildUserMenuItems();
    const labels = items.map((i) => i.label);
    const about = items[labels.indexOf('О программе')];
    const logout = items[labels.indexOf('Отключиться')];
    assert.equal(about.danger, undefined, '«О программе» is not a danger entry');
    assert.equal(logout.danger, true, '«Отключиться» stays danger');
    assert.ok(labels.indexOf('Администрирование') !== -1, 'admin layout expected');
  });

  it('builds without a logged-in user (no server connection)', () => {
    store.update({ me: null });
    const labels = buildUserMenuItems().map((i) => i.label);
    assert.ok(labels.includes('О программе'));
  });
});
