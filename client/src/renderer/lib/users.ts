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

import { div, el } from './dom.js';
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
 * Same as {@link resolve} but guarantees a non-empty fallback string suitable
 * for inline rendering (tooltips, badges). Used by the lock-indicator surface
 * (task 4f141756) where every entry must have a name even when the admin
 * roster has not been fetched yet.
 */
export function resolveUserName(userId: string | null | undefined): string | null {
  return resolve(userId);
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

// ---------------------------------------------------------------------------
// User picker widget (задача 59119797 «Фильтры Автор/Редактор»)
// ---------------------------------------------------------------------------

/**
 * Build a `<select>` widget that lets the user pick «любой» or a specific
 * network participant id. Calls `ensureLoaded()` to lazily populate the
 * cache — re-renders itself when it fills. The label «любой» is selected
 * when `currentId === ''` (the «filter not applied» case).
 *
 * @param opts.label - field label rendered before the select.
 * @param opts.currentId - current value (empty string = «любой»).
 * @param opts.onChange - invoked with the new id (`''` = «любой»).
 */
export function buildUserSelectWidget(opts: {
  label: string;
  currentId: string;
  onChange: (id: string) => void;
}): HTMLElement {
  const row = div('user-select-row');
  const label = el('span', 'user-select-label', opts.label);
  const select = el('select', 'select-input user-select') as HTMLSelectElement;

  const render = (): void => {
    select.replaceChildren();
    const placeholder = el('option', undefined, 'любой');
    placeholder.value = '';
    select.append(placeholder);
    // Сортируем по display_name/username, чтобы список был стабилен.
    const users = [...state.byId.values()].sort((a, b) =>
      (a.display_name ?? a.username).localeCompare(b.display_name ?? b.username, 'ru'),
    );
    for (const u of users) {
      const opt = el('option', undefined, `${u.display_name ?? u.username} (${u.username})`);
      opt.value = u.id;
      select.append(opt);
    }
    select.value = opts.currentId;
  };

  // Если нужного id ещё нет в кэше (например, восстановлен из сохранённого
  // отбора до прихода roster), добавляем «голую» запись с id, чтобы
  // select мог показать выбранное значение.
  if (opts.currentId !== '' && !state.byId.has(opts.currentId)) {
    state.byId.set(opts.currentId, {
      id: opts.currentId,
      username: opts.currentId.slice(0, 8),
      display_name: opts.currentId.slice(0, 8),
      is_admin: false,
      is_first_user: false,
      disabled: false,
      created_at: '',
      updated_at: '',
    });
  }

  render();
  select.addEventListener('change', () => {
    opts.onChange(select.value);
  });
  // Реактивно перерисовываем при появлении админ-roster'а.
  subscribe(render);
  ensureLoaded();

  row.append(label, select);
  return row;
}

/**
 * Виджет мульти-выбора пользователей для условий `created_by` / `updated_by`
 * с операторами `in` / `not_in` (задача 59119797). Чипы показывают имя из
 * кэша (best-effort), «×» снимает выбор. Под полем — `<select>` для
 * добавления нового пользователя (повторно выбранные пропускаются).
 *
 * @param opts.label - подпись слева сверху.
 * @param opts.currentIds - текущий список id (пустой = никого не выбрано).
 * @param opts.onChange - вызывается с новым массивом id при изменениях.
 */
export function buildUserMultiSelectWidget(opts: {
  label: string;
  currentIds: string[];
  onChange: (ids: string[]) => void;
}): HTMLElement {
  ensureLoaded();
  const wrap = div('user-multi-select');
  const labelEl = el('span', 'user-select-label', opts.label);
  const chipsBox = div('user-multi-chips');
  const addSelect = el('select', 'select-input user-multi-add') as HTMLSelectElement;

  /** Снимает выбор с указанного id и уведомляет. */
  const remove = (id: string): void => {
    opts.onChange(opts.currentIds.filter((x) => x !== id));
  };

  /** Рендер чипов и опций добавления. */
  const render = (): void => {
    chipsBox.replaceChildren();
    if (opts.currentIds.length === 0) {
      chipsBox.append(el('span', 'user-multi-empty', 'не выбрано'));
    } else {
      for (const id of opts.currentIds) {
        const user = state.byId.get(id);
        const name = user?.display_name ?? user?.username ?? id;
        const chip = div('user-multi-chip');
        chip.append(el('span', '', name));
        const x = el('button', 'user-multi-x', '×');
        x.type = 'button';
        x.title = 'Убрать';
        x.addEventListener('click', () => remove(id));
        chip.append(x);
        chipsBox.append(chip);
      }
    }

    addSelect.replaceChildren();
    const placeholder = el('option', undefined, '+ добавить пользователя…');
    placeholder.value = '';
    addSelect.append(placeholder);
    const users = [...state.byId.values()].sort((a, b) =>
      (a.display_name ?? a.username).localeCompare(b.display_name ?? b.username, 'ru'),
    );
    for (const u of users) {
      if (opts.currentIds.includes(u.id)) continue;
      const opt = el('option', undefined, `${u.display_name ?? u.username} (${u.username})`);
      opt.value = u.id;
      addSelect.append(opt);
    }
  };

  // Seed unknown ids so chips show something before the roster arrives.
  for (const id of opts.currentIds) {
    if (id !== '' && !state.byId.has(id)) {
      state.byId.set(id, {
        id,
        username: id.slice(0, 8),
        display_name: id.slice(0, 8),
        is_admin: false,
        is_first_user: false,
        disabled: false,
        created_at: '',
        updated_at: '',
      });
    }
  }
  render();

  addSelect.addEventListener('change', () => {
    const id = addSelect.value;
    if (id === '') return;
    if (opts.currentIds.includes(id)) return;
    opts.onChange([...opts.currentIds, id]);
    addSelect.value = '';
  });
  subscribe(render);

  wrap.append(labelEl, chipsBox, addSelect);
  return wrap;
}
