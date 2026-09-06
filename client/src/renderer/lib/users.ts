/**
 * User-name cache for authorship rendering (задача 04cd9794 «Вкладка
 * Метаданные и колонки автора в Хронике»).
 *
 * DTO авторства выдают только `created_by`/`updated_by` как UUID; DTO
 * пользователя (`User` из `@etn/shared`) живёт отдельно. Резолвить имя по
 * id на лету для каждой строки дорого: для таблицы хроники это десятки
 * запросов. Поэтому:
 *
 *  - текущий пользователь — всегда известен (`state.me`) и резолвится без
 *    сети;
 *  - остальные пользователи — best-effort через `etn.admin.listUsers()`
 *    (требует админа; для не-админа запрос тихо отказывается, кэш остаётся
 *    пустым, UI падает обратно на показ UUID).
 *
 * Кэш обновляется по мере появления новых запросов и реактивно
 * перерисовывает все узлы, которые показали «неизвестен» для только что
 * загруженного пользователя.
 */

import type { User } from '@etn/shared';

import { etn } from './etn.js';
import { store } from '../state.js';

interface CacheState {
  byId: Map<string, User>;
  /** Pending fetch so concurrent callers share one network roundtrip. */
  pending: Promise<void> | null;
  /** Listeners notified when the cache transitions. */
  listeners: Set<() => void>;
}

const state: CacheState = {
  byId: new Map(),
  pending: null,
  listeners: new Set(),
};

/**
 * Seeds the cache with the current user so `resolve()` never falls back to
 * "неизвестен" for the actor. Idempotent; cheap; safe to call repeatedly.
 * `CurrentUser` is a thinner projection of `User` — for fields it omits
 * (is_first_user, disabled, created_at, updated_at) we pass best-effort
 * defaults; the cache is only used to render a display name, not the full
 * profile.
 */
export function seedCurrentUser(): void {
  const me = store.state.me;
  if (me === null) return;
  if (state.byId.has(me.id)) return;
  state.byId.set(me.id, {
    id: me.id,
    username: me.username,
    display_name: me.display_name,
    is_admin: me.is_admin,
    is_first_user: false,
    disabled: false,
    created_at: '',
    updated_at: '',
  });
}

/**
 * Kicks off a best-effort fetch of the user list. Resolves immediately when
 * the cache is already populated or the fetch fails (non-admin user, no
 * network, etc.); the caller never has to await this — UI can subscribe via
 * {@link subscribe} for re-rendering when the cache fills in.
 */
export function ensureLoaded(): void {
  seedCurrentUser();
  if (state.pending !== null) return;
  // Avoid retry storms — only fetch when the cache is empty AND we have no
  // pending promise. Users that join later (the admin path) are not handled
  // here; the «Вкладка Метаданные» does not require a live user roster.
  if (state.byId.size > 1) return;
  const promise = etn.admin
    .listUsers()
    .then((users) => {
      for (const user of users) state.byId.set(user.id, user);
    })
    .catch(() => {
      // Non-admin user, network down — fall back to id-only display.
    })
    .finally(() => {
      state.pending = null;
      for (const listener of state.listeners) listener();
    });
  state.pending = promise;
}

/**
 * Resolves a user id to a best-effort display name. Returns `null` when the
 * user is genuinely unknown (cache empty AND not the current user) — UI then
 * shows "неизвестен" with the id alongside.
 */
export function resolve(userId: string | null | undefined): string | null {
  if (userId === null || userId === undefined || userId === '') return null;
  const user = state.byId.get(userId);
  if (user === undefined) return null;
  return user.display_name ?? user.username;
}

/**
 * Subscribes to cache transitions. The listener fires when the admin list
 * fetch settles (success OR failure) and again whenever `ensureLoaded()`
 * completes another fetch. Returns an unsubscribe function.
 */
export function subscribe(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/** Test hook — clears the cache between unit tests. */
export function __resetForTests(): void {
  state.byId.clear();
  state.pending = null;
  state.listeners.clear();
}
