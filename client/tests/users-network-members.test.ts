/**
 * Кэш имён участников для показа держателя захвата (ошибка cb9b466f).
 *
 * Не-администратор не имеет доступа к `GET /admin/users`, поэтому имена
 * должны приходить из `GET /networks/{id}/members` — сервер уже отдаёт там
 * `username`/`display_name`. Без этого бейдж/тост «Редактирует <uuid>»
 * показывал UUID вместо имени.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

let adminCalls = 0;
let memberCalls = 0;

const MEMBER_USER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ME_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function mockEtn(): void {
  (globalThis as any).window = {
    etn: {
      admin: {
        listUsers: async () => {
          adminCalls += 1;
          throw new Error('admin only');
        },
      },
      networks: {
        listMembers: async (networkId: string) => {
          memberCalls += 1;
          assert.equal(networkId, 'net-1');
          return [
            {
              network_id: 'net-1',
              user_id: ME_ID,
              role: 'member',
              added_at: '',
              added_by: '',
              username: 'me',
              display_name: 'Я',
            },
            {
              network_id: 'net-1',
              user_id: MEMBER_USER_ID,
              role: 'member',
              added_at: '',
              added_by: '',
              username: 'bob',
              display_name: 'Борис',
            },
          ];
        },
      },
    },
  };
}

mockEtn();

const { store } = await import('../src/renderer/state.js');
const users = await import('../src/renderer/lib/users.js');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('users: имена участников сети для не-администратора', () => {
  it('резолвит имя из listMembers, не обращаясь к админ-ростеру', async () => {
    users.__resetForTests();
    adminCalls = 0;
    memberCalls = 0;
    store.update({
      networkId: 'net-1',
      me: { id: ME_ID, username: 'me', display_name: 'Я', is_admin: false },
    });

    users.ensureLoaded();
    await flush();

    assert.equal(adminCalls, 0, 'не-админ не ходит в /admin/users');
    assert.equal(memberCalls, 1, 'ростер взят из участников сети');
    assert.equal(users.resolve(MEMBER_USER_ID), 'Борис');
    assert.equal(users.resolve(ME_ID), 'Я');
  });

  it('смена сети перечитывает ростер и не смешивает имена', async () => {
    users.__resetForTests();
    adminCalls = 0;
    store.update({
      networkId: 'net-1',
      me: { id: ME_ID, username: 'me', display_name: 'Я', is_admin: false },
    });
    users.ensureLoaded();
    await flush();
    assert.equal(users.resolve(MEMBER_USER_ID), 'Борис');

    // Другая сеть — свой состав; старые имена не должны резолвиться.
    (globalThis as any).window.etn.networks.listMembers = async () => [];
    store.update({ networkId: 'net-2' });
    users.ensureLoaded();
    await flush();
    assert.equal(users.resolve(MEMBER_USER_ID), null);
  });
});
