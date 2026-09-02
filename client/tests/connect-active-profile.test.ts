/**
 * Regression test for defect «клиент не запоминает сервер, к которому был
 * подключен перед закрытием» (1ebc6115-1bed-42e8-b0a5-54bcc7603d5e).
 *
 * Root cause: `connectProfile` (client/src/main/ipc/register.ts) — used both
 * by `server.connect` and internally by `addProfile` — never persisted
 * `is_active` itself; only `addProfile` called `LocalDb.setActiveProfile`
 * explicitly. Re-selecting an already-saved profile via `server.connect`
 * (onboarding screen, choosing a server that isn't the last one added) left
 * the DB flag on whichever profile was added last, so the next launch
 * reconnected to the wrong server.
 *
 * `connectAndActivate` (client/src/main/ipc/connect-active-profile.ts) is the
 * extracted fix, used verbatim by `register.ts`'s `connectProfile` for both
 * the `server.connect` and `addProfile` paths: it runs `getMe` and only on
 * success persists the profile as active.
 *
 * A real `LocalDb` is not used here: `client/tests` never load the real
 * `better-sqlite3` binary — per repo convention (see `ws-client.test.ts` /
 * `ws-layer-control.test.ts`'s `makeFakeDb()`), because `npm -w @etn/client
 * run rebuild:native` (mandatory post-install step, AGENTS.md) swaps the
 * repo-root `better-sqlite3` prebuild for Electron's ABI, which a plain
 * `node --test` process cannot load (`NODE_MODULE_VERSION` mismatch). A
 * minimal fake reproducing `setActiveProfile`/`getActiveProfile`'s documented
 * semantics (`local-db.ts`: "Atomically activates `id` and deactivates every
 * other profile") is the established pattern for this package.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { LocalDb } from '../src/main/db/local-db.js';
import { connectAndActivate } from '../src/main/ipc/connect-active-profile.js';

/** In-memory fake mirroring `LocalDb.{set,get}ActiveProfile` (07-client-electron.md §3.1). */
function makeFakeProfileStore(): Pick<LocalDb, 'setActiveProfile' | 'getActiveProfile'> & {
  activeId: string | null;
} {
  return {
    activeId: null,
    setActiveProfile(id: string | null) {
      this.activeId = id;
    },
    getActiveProfile() {
      // Only `id` matters for these assertions; the rest of the row shape is
      // irrelevant to the defect under test.
      return this.activeId === null ? null : ({ id: this.activeId } as ReturnType<LocalDb['getActiveProfile']>);
    },
  };
}

describe('connectAndActivate (server_profiles.is_active persistence)', () => {
  let db: ReturnType<typeof makeFakeProfileStore>;

  beforeEach(() => {
    db = makeFakeProfileStore();
  });

  it('reconnecting to an earlier-added profile persists it as active', async () => {
    // Mirrors two `addProfile` calls: B is added after A, so B is active —
    // same state the bug left the DB in.
    db.setActiveProfile('a');
    db.setActiveProfile('b');
    assert.equal(db.getActiveProfile()?.id, 'b');

    // User now selects the *earlier* profile A from the onboarding list —
    // the `server.connect` path, i.e. `connectAndActivate` without a prior
    // explicit `setActiveProfile` call (unlike `addProfile`).
    const me = await connectAndActivate(db, 'a', async () => ({ id: 'user-1' }));

    assert.deepEqual(me, { id: 'user-1' });
    assert.equal(db.getActiveProfile()?.id, 'a', 'A must now be the persisted active profile');
  });

  it('a failed connect does not change the persisted active profile', async () => {
    db.setActiveProfile('a');

    await assert.rejects(
      connectAndActivate(db, 'b', async () => {
        throw new Error('401 Unauthorized');
      }),
      /401/,
    );

    assert.equal(db.getActiveProfile()?.id, 'a', 'active profile must be unchanged on failure');
  });
});
