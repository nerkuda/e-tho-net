/**
 * Pins the «Мыслесеть» submenu composition (task d4e23670, fd4d4927,
 * spec thought 328d0f98 «Подменю «Мыслесеть»»): the «Свойства» entry
 * sits immediately below «Типы связей», separated from the network section by
 * a separator (it shares the catalogue group with the type managers).
 *
 * 0.8.2 (задача 6ebde54e): команда снова называется «Свойства» (в 0.8.1 была
 * «Свойства и связи») и открывает общий список свойств. «Типы связей» — дерево,
 * открывающее редактор свойства-связи.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildNetMenuItems } from '../src/renderer/screens/workspace-menus.js';
import { store } from '../src/renderer/state.js';

function labels(): string[] {
  return buildNetMenuItems(0)
    .map((item) => ('label' in item ? (item.label as string) : '──'));
}

afterEach(() => {
  store.update({ network: null, me: null });
});

describe('«Мыслесеть» menu — «Свойства» entry (d4e23670, fd4d4927, 6ebde54e)', () => {
  it('lists «Свойства» right after «Типы связей» for an open network', () => {
    store.update({
      network: {
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
      },
      me: {
        id: 'u-1',
        username: 'owner',
        display_name: 'Owner',
        is_admin: false,
      },
    });
    const ls = labels();
    const idxLinkTypes = ls.indexOf('Типы связей');
    const idxProps = ls.indexOf('Свойства');
    assert.ok(idxLinkTypes >= 0, '«Типы связей» must be in the menu');
    assert.ok(idxProps >= 0, '«Свойства» must be in the menu');
    assert.equal(idxProps, idxLinkTypes + 1, '«Свойства» must follow «Типы связей» directly');
    assert.equal(
      ls.indexOf('Свойства и связи'),
      -1,
      'команда «Свойства и связи» убрана (в 0.8.2 снова «Свойства», задача 6ebde54e)',
    );
  });

  it('still shows «Свойства» for a non-owner (it is a network-wide setting)', () => {
    store.update({
      network: {
        id: 'net-1',
        owner_id: 'u-owner',
        display_name: 'Test',
        description: null,
        when_to_use: null,
        conventions: null,
        examples: null,
        type_roles: {},
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
      },
      me: {
        id: 'u-other',
        username: 'other',
        display_name: 'Other',
        is_admin: false,
      },
    });
    const ls = labels();
    assert.ok(ls.includes('Свойства'));
    assert.ok(ls.includes('Типы связей'));
  });
});
