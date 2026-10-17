/**
 * Кэш ИМЁН мыслей по id для строки-представления отбора (ошибка d17a8bfd;
 * требование 9d5e3c4e «представления сущностей, без ID», деградация —
 * нейтральный плейсхолдер без сырого UUID).
 *
 * Композер фразы (`lib/filter-phrase.ts`) — ЧИСТАЯ функция: ни DOM, ни сети.
 * Имена ссылок на мысли он получает резолвером `thoughtName(id)`, а наполняет
 * кэш ЭТОТ модуль — ДОГРУЗКА ВНЕ композера. По образцу кэша пользователей
 * (`lib/users.ts`): пока имя неизвестно, фраза рисует плейсхолдер, а как только
 * батч `etn.thoughts.resolve` вернётся, подписчики перерисовывают фразу —
 * имена появляются САМИ, без действий пользователя (иначе класс дефекта «фраза
 * с ID до первого клика»).
 *
 * Почему кэш, а не чтение на каждую отрисовку: одно определение отбора может
 * ссылаться на десятки мыслей, фраза пересобирается на каждую правку, а resolve
 * — сетевой вызов с серверным лимитом батча. Кэш схлопывает дубли и не
 * повторяет запрос для уже разрешённых (или уже запрошенных) id.
 *
 * Модуль намеренно не привязан к сети/host: `networkId` приходит в вызове
 * догрузки — как у остальных сетевых точек рендерера.
 */

import { etn } from './etn.js';

/**
 * Предел одного пакетного `etn.thoughts.resolve` (серверный лимит батча) —
 * тот же, что у догрузки облачков значения (`lib/filter-value.ts`).
 */
export const THOUGHT_NAME_RESOLVE_BATCH = 100;

interface CacheState {
  /** id → название мысли (последнее известное). */
  byId: Map<string, string>;
  /** id, для которых запрос уже отправлен (успех ИЛИ сбой) — повтор не долбим. */
  attempted: Set<string>;
  /** id в текущем полёте (дедупликация одновременных вызовов). */
  inflight: Set<string>;
  /** Слушатели: кэш перешёл в новое состояние. */
  listeners: Set<() => void>;
}

const state: CacheState = {
  byId: new Map(),
  attempted: new Set(),
  inflight: new Set(),
  listeners: new Set(),
};

/** Название мысли по id; `null` — ещё не загружено / мысль недоступна. */
export function resolveThoughtName(id: string | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null;
  const name = state.byId.get(id);
  return name === undefined || name === '' ? null : name;
}

/** Уведомить подписчиков о переходе кэша. */
function notify(): void {
  for (const listener of state.listeners) listener();
}

/**
 * Догрузить имена перечисленных мыслей (best-effort, без ожидания). Уже
 * известные/запрошенные/пустые id и контекстные токены (`$…`) пропускаются;
 * остальные уходят пакетами не длиннее {@link THOUGHT_NAME_RESOLVE_BATCH}.
 * Сбой сети имя не «портит» — id помечается запрошенным, чтобы фраза не
 * устраивала шторм повторов при каждой перерисовке.
 */
export function requestThoughtNames(networkId: string, ids: readonly string[]): void {
  if (networkId === '') return;
  const missing: string[] = [];
  for (const id of ids) {
    if (id === '' || id.startsWith('$')) continue;
    if (state.byId.has(id) || state.attempted.has(id) || state.inflight.has(id)) continue;
    state.inflight.add(id);
    missing.push(id);
  }
  if (missing.length === 0) return;
  for (let i = 0; i < missing.length; i += THOUGHT_NAME_RESOLVE_BATCH) {
    const batch = missing.slice(i, i + THOUGHT_NAME_RESOLVE_BATCH);
    void etn.thoughts
      .resolve(networkId, batch)
      .then((refs) => {
        let changed = false;
        for (const ref of refs) {
          if (ref.title === '') continue;
          state.byId.set(ref.id, ref.title);
          changed = true;
        }
        for (const id of batch) {
          state.inflight.delete(id);
          state.attempted.add(id);
        }
        if (changed) notify();
      })
      .catch(() => {
        // Сеть/слой недоступны — имя остаётся неизвестным (фраза покажет
        // плейсхолдер), повтор не зацикливаем: id уже помечен запрошенным.
        for (const id of batch) {
          state.inflight.delete(id);
          state.attempted.add(id);
        }
      });
  }
}

/** Подписка на наполнение кэша. Возвращает функцию отписки. */
export function subscribe(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/** Тестовый хук — очистить кэш между юнит-тестами. */
export function __resetForTests(): void {
  state.byId.clear();
  state.attempted.clear();
  state.inflight.clear();
  state.listeners.clear();
}
