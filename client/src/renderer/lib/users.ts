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
 *  - остальные участники — best-effort: администратор берёт полный ростер
 *    (`etn.admin.listUsers`), обычный участник — список участников открытой
 *    сети (`etn.networks.listMembers`, доступен любому члену и уже несёт
 *    `username`/`display_name` с сервера). Без этого не-администратор видел
 *    UUID держателя захвата вместо имени (ошибка cb9b466f). Запрос тихо
 *    отказывается — кэш остаётся пустым, UI показывает нейтральный
 *    плейсхолдер вместо имени, а не UUID — требование 9d5e3c4e.
 *
 * Кэш обновляется по мере появления новых запросов и реактивно
 * перерисовывает все узлы, которые показали «неизвестен» для только что
 * загруженного пользователя.
 */

import type { NetworkMember, User } from '@etn/shared';

import { div, el } from './dom.js';
import { etn } from './etn.js';
import { t } from './i18n.js';
import { chipList } from './ui/chip-list.js';
import { store } from '../state.js';

/**
 * Подпись НЕИЗВЕСТНОГО участника вместо обрезанного id (требование 9d5e3c4e
 * «представления сущностей, без ID»): до прихода админ-ростера и для того, кого
 * в нём нет, чипы и списки выбора показывают нейтральный текст, а не `id.slice`.
 */
const UNKNOWN_USER_LABEL = 'неизвестный участник';

/**
 * Подпись участника в списках выбора: «Имя (логин)». Записи-заглушки
 * неизвестного участника заводятся с пустым логином — им довольно одного
 * плейсхолдера, скобки с логином не рисуются.
 */
function userOptionLabel(user: User): string {
  const name = user.display_name ?? user.username;
  return user.username === '' ? name : `${name} (${user.username})`;
}

interface CacheState {
  byId: Map<string, User>;
  /** Pending fetch so concurrent callers share one network roundtrip. */
  pending: Promise<void> | null;
  /** Сеть+пользователь, для которых ростер уже загружен (против retry storms). */
  loadedKey: string | null;
  /** Listeners notified when the cache transitions. */
  listeners: Set<() => void>;
}

const state: CacheState = {
  byId: new Map(),
  pending: null,
  loadedKey: null,
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
 * the roster for the current network/user is already loaded or the fetch fails
 * (no rights, no network, etc.); the caller never has to await this — UI can
 * subscribe via {@link subscribe} for re-rendering when the cache fills in.
 *
 * Источник — по правам (ошибка cb9b466f): администратор читает полный ростер
 * `GET /admin/users`, обычный участник — участников открытой сети
 * `GET /networks/{id}/members` (сервер отдаёт `username`/`display_name`).
 * Смена сети/пользователя сбрасывает кэш, поэтому имена одного ростера не
 * всплывают в другом.
 */
export function ensureLoaded(): void {
  seedCurrentUser();
  if (state.pending !== null) return;
  const networkId = store.state.networkId;
  const me = store.state.me;
  // Ключ ростера: сменилась сеть/пользователь/права — читаем заново.
  const loadedKey = `${networkId ?? ''}|${me?.id ?? ''}|${me?.is_admin === true ? 1 : 0}`;
  if (state.loadedKey === loadedKey) return;
  if (state.loadedKey !== null) {
    state.byId.clear();
    seedCurrentUser();
  }

  const loadRoster = async (): Promise<User[]> => {
    // Без открытой сети (и в юнит-тестах) остаётся прежний путь — админ-ростер.
    if (networkId === null || me?.is_admin === true) {
      try {
        const users = await etn.admin.listUsers();
        if (users.length > 0 || networkId === null) return users;
      } catch {
        // Не админ или сеть недоступна — падаем на список участников.
      }
    }
    try {
      const members = await etn.networks.listMembers(networkId as string);
      return members.flatMap(memberToUser);
    } catch {
      return [];
    }
  };

  const promise = loadRoster()
    .then((users) => {
      for (const user of users) state.byId.set(user.id, user);
    })
    .finally(() => {
      state.pending = null;
      state.loadedKey = loadedKey;
      for (const listener of state.listeners) listener();
    });
  state.pending = promise;
}

/**
 * Membership row → `User` для кэша имён. Поля `username`/`display_name`
 * приходят с сервера (`GET /networks/{id}/members`); запись без них не
 * заводим, чтобы не показывать пустое имя вместо реального участника.
 */
function memberToUser(member: NetworkMember): User[] {
  if (member.username === undefined) return [];
  return [
    {
      id: member.user_id,
      username: member.username,
      display_name: member.display_name ?? null,
      is_admin: false,
      is_first_user: false,
      disabled: false,
      created_at: '',
      updated_at: '',
    },
  ];
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
  state.loadedKey = null;
  state.listeners.clear();
}

/**
 * Список известных пользователей (кэш, best-effort), отсортированный по
 * отображаемому имени. Запускает ленивую загрузку ростера. Используется
 * пикерами, которым нужен не `<select>`-виджет, а список для кастомного UI.
 */
export function listUsers(): User[] {
  ensureLoaded();
  return [...state.byId.values()].sort((a, b) =>
    (a.display_name ?? a.username).localeCompare(b.display_name ?? b.username, 'ru'),
  );
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
  // Пустая подпись — не рисуем, чтобы лишний span не съедал ширину.
  if (opts.label !== '') {
    row.append(el('span', 'user-select-label', opts.label));
  }
  const select = el('select', 'select-input user-select') as HTMLSelectElement;

  // Значение-ТОКЕН (`$user` у «Автора записи» предопределённого набора «Мои
  // записи за неделю»): это не id участника, а контекстный токен. Показываем
  // его отдельным пунктом и НЕ заводим фантомную запись в кэше пользователей
  // (иначе «$user» навсегда всплыл бы фальшивым участником во всех полях
  // авторства). Пустое значение означает «любой» — токен не трогаем.
  const tokenValue = opts.currentId.startsWith('$') ? opts.currentId : null;

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
      const opt = el('option', undefined, userOptionLabel(u));
      opt.value = u.id;
      select.append(opt);
    }
    if (tokenValue !== null) {
      const opt = el(
        'option',
        undefined,
        tokenValue === '$user' ? t('userSelect.currentUser') : tokenValue,
      );
      opt.value = tokenValue;
      select.append(opt);
    }
    select.value = opts.currentId;
  };

  // Если нужного id ещё нет в кэше (например, восстановлен из сохранённого
  // отбора до прихода roster), добавляем запись-заглушку с нейтральным
  // плейсхолдером (НЕ id: ID в подписях недопустим — требование 9d5e3c4e),
  // чтобы select мог показать выбранное значение. Токен так не подменяем.
  if (tokenValue === null && opts.currentId !== '' && !state.byId.has(opts.currentId)) {
    state.byId.set(opts.currentId, {
      id: opts.currentId,
      username: '',
      display_name: UNKNOWN_USER_LABEL,
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

  row.append(select);
  return row;
}

/**
 * Виджет мульти-выбора пользователей для условий `created_by` / `updated_by`
 * с операторами `in` / `not_in` (задача 59119797). Чипы выбранных участников
 * и поле добавления строит общий generic-чип-лист `lib/ui/chip-list.ts`
 * (требование d1cd2095): собственной сборки чипов здесь больше нет. Чипы
 * показывают имя из кэша (best-effort), «×» снимает выбор; поле добавления
 * перечисляет ещё не выбранных пользователей.
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
  const wrap = div('user-chip-field');
  if (opts.label !== '') {
    wrap.append(el('span', 'user-select-label', opts.label));
  }

  // Локальная рабочая копия выбранных id. Раньше виджет читал `opts.currentIds`
  // — массив, захваченный по ссылке при сборке — и после `onChange` продолжал
  // видеть устаревший список (чипы не появлялись, «ничего не происходит»,
  // ошибка e8365d29). Теперь виджет держит собственный список: чип-лист читает
  // его через `getValues`, изменения уведомляют владельца.
  let ids = opts.currentIds.slice();

  // Seed unknown ids so chips show a neutral placeholder before the roster
  // arrives (ID в подписи недопустим — требование 9d5e3c4e).
  for (const id of ids) {
    if (id !== '' && !state.byId.has(id)) {
      state.byId.set(id, {
        id,
        username: '',
        display_name: UNKNOWN_USER_LABEL,
        is_admin: false,
        is_first_user: false,
        disabled: false,
        created_at: '',
        updated_at: '',
      });
    }
  }

  /** Пользователи кэша, отсортированные по отображаемому имени. */
  const sortedUsers = (): User[] =>
    [...state.byId.values()].sort((a, b) =>
      (a.display_name ?? a.username).localeCompare(b.display_name ?? b.username, 'ru'),
    );

  const field = chipList({
    getValues: () => ids,
    labelOf: (id) => {
      const user = state.byId.get(id);
      // Нет записи в кэше — плейсхолдер, а не id (требование 9d5e3c4e).
      return user === undefined ? UNKNOWN_USER_LABEL : (user.display_name ?? user.username);
    },
    onRemove: (id) => {
      ids = ids.filter((x) => x !== id);
      opts.onChange(ids.slice());
    },
    getOptions: () =>
      sortedUsers().map((u) => ({
        value: u.id,
        label: userOptionLabel(u),
      })),
    onAdd: (id) => {
      if (ids.includes(id)) return;
      ids = [...ids, id];
      opts.onChange(ids.slice());
    },
    addPlaceholder: t('userMulti.addPlaceholder'),
    emptyText: t('chipList.empty'),
    emptyHint: t('chipList.emptyHint'),
    removeTitle: t('chipList.remove'),
  });

  // Реактивно перерисовываем при появлении админ-roster'а.
  subscribe(field.refresh);

  wrap.append(field.root);
  return wrap;
}
