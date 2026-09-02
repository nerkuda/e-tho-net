/**
 * Persists the active server profile only on a successful connect (defect
 * «клиент не запоминает сервер, к которому был подключен перед закрытием»).
 *
 * Split out of `register.ts` on purpose: that module imports `electron`
 * (`ipcMain`) transitively through `safe-storage.js`, which cannot be loaded
 * outside an Electron runtime — so this tiny piece of logic could not be unit
 * tested if it stayed there. This file has no Electron dependency and runs
 * under the plain `node --test` harness.
 */
import type { LocalDb } from '../db/local-db.js';

/**
 * Runs `getMe` (the RestClient key-check) and, only once it resolves,
 * persists `profileId` as the active server profile — every successful
 * connect must survive a restart, not just `addProfile`. A rejected `getMe`
 * leaves the previously active profile untouched.
 */
export async function connectAndActivate<T>(
  localDb: Pick<LocalDb, 'setActiveProfile'>,
  profileId: string,
  getMe: () => Promise<T>,
): Promise<T> {
  const me = await getMe();
  localDb.setActiveProfile(profileId);
  return me;
}
