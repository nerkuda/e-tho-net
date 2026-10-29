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
 * Runs an optional compatibility gate and then `getMe` (the RestClient
 * key-check); only once both resolve is `profileId` persisted as the active
 * server profile — every successful connect must survive a restart, not just
 * `addProfile`.
 *
 * `check` — проверка совместимости ДО первой авторизованной операции
 * (требование 4d3be6ca, задача 12fd5b0e): она бросает, когда подключение
 * запрещено (несовместимые версии) или когда `/version` недоступен
 * (`check-failed`). `getMe` тогда НЕ вызывается — ни один авторизованный запрос
 * не уходит. Порядок «check → getMe» сторожит `client/tests/compatibility.test.ts`.
 *
 * A rejected `check`/`getMe` leaves the previously active profile untouched.
 */
export async function connectAndActivate<T>(
  localDb: Pick<LocalDb, 'setActiveProfile'>,
  profileId: string,
  getMe: () => Promise<T>,
  check?: () => Promise<void>,
): Promise<T> {
  if (check !== undefined) await check();
  const me = await getMe();
  localDb.setActiveProfile(profileId);
  return me;
}
