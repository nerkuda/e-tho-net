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
import type { VersionResponse } from '@etn/shared';

import { verifyCompatibilityOnConnect, type CompatibilityGate } from '../compatibility.js';
import type { LocalDb, NewServerProfile } from '../db/local-db.js';

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

/**
 * Подключение профиля ровно в порядке требования 4d3be6ca (задача 12fd5b0e):
 * проверка совместимости (`GET /version`; при блокировке — один диагностический
 * `GET /me` для роли) → обычный `GET /me` → подтверждение роли → активация
 * профиля.
 *
 * Вынесено из `register.ts` в Electron-свободный модуль, чтобы ПОСЛЕДОВАТЕЛЬНОСТЬ
 * запросов проверялась юнит-тестом по массиву фактических вызовов, а не поиском
 * подстроки в исходнике (замечание верификатора 6).
 */
export async function connectProfileWithCompatibility<T>(
  localDb: Pick<LocalDb, 'setActiveProfile'>,
  profileId: string,
  rest: {
    getVersion(): Promise<VersionResponse>;
    getMe(): Promise<T>;
  },
  gate: CompatibilityGate,
): Promise<T> {
  const me = await connectAndActivate(
    localDb,
    profileId,
    () => rest.getMe(),
    () => verifyCompatibilityOnConnect(gate, rest),
  );
  // Тело обычного `/me` тоже несёт `is_admin`: администратор, подключившийся к
  // совместимому серверу, получит кнопку «Обновить сервер», если вердикт
  // заблокируется позже (426/переподключение) — 0afec967.
  gate.markRoleConfirmed(me);
  return me;
}

/**
 * Добавление нового профиля (`addProfile`, H2): СОХРАНЕНИЕ — всегда,
 * АКТИВАЦИЯ — только после успешной проверки и `GET /me` (задача 12fd5b0e).
 *
 * Профиль вставляется неактивным и активируется внутри `connect`
 * (`connectAndActivate`) — только когда подключение действительно состоялось.
 * Раньше `register.ts` вставлял его с `is_active: true` и вызывал
 * `setActiveProfile` ДО проверки: при блокирующем отказе сервер оставался
 * сохранённым И активным, хотя подключения не было (замечание верификатора 5).
 *
 * Вынесено из `register.ts` по той же причине, что и {@link connectAndActivate}:
 * модуль `register.ts` тянет `electron` и не грузится в `node --test`.
 */
export async function addProfileAndConnect<T>(
  localDb: Pick<LocalDb, 'insertProfile'>,
  profile: NewServerProfile,
  connect: (profileId: string) => Promise<T>,
): Promise<T> {
  localDb.insertProfile({ ...profile, is_active: false });
  return connect(profile.id);
}
