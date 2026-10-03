/**
 * Mutator-слой (этап G1 тех.проекта `269016e2`).
 *
 * Обёртки клиентских мутаций кладут REST-ответ в тот же нормализованный кэш,
 * куда роутер событий кладёт чужие изменения. За счёт этого «своя правка» и
 * «чужая правка» сходятся в одной точке данных — эхо-подавление сервера
 * (`gateway.ts`: сокет того же client_id не получает своё событие) перестаёт
 * быть проблемой экранов.
 *
 * Здесь же — стандартизованный optimistic-хелпер `snapshot → apply → rollback`:
 * интерфейс меняется мгновенно, при ошибке мутации состояние откатывается к
 * снимку.
 */

import {
  getRecord,
  patchEntity,
  putEntity,
  removeEntity,
  restoreRecord,
  type EntityKind,
  type EntityRecord,
  type PutEntityOptions,
} from './entities.js';
import { queryKeys } from './query-keys.js';
import type { LocalMutationSignal } from './query-registry.js';
import { invalidateQueries, setQueryData } from './query-registry.js';

/**
 * Положить результат мутации в кэш запроса по ключу (статус `fresh`).
 * Подписчики запроса увидят свежие данные без перезапроса.
 */
export function putMutationResult<T>(key: string, data: T): void {
  setQueryData(key, data);
}

/**
 * Положить сущность из REST-ответа мутации в нормализованный кэш и в её
 * запись-проекцию `entity:@kind:@id`. Возвращает запись кэша.
 */
export function commitEntity(
  kind: EntityKind,
  id: string,
  entity: unknown,
  opts: PutEntityOptions = {},
): EntityRecord {
  const record = putEntity(kind, id, entity, opts);
  setQueryData(queryKeys.entity(kind, id), record.entity);
  return record;
}

/** Удалить сущность из кэша и погасить её запись-проекцию. */
export function commitEntityRemoval(kind: EntityKind, id: string): void {
  removeEntity(kind, id);
  setQueryData(queryKeys.entity(kind, id), undefined);
}

/**
 * Точечный патч сущности из ответа мутации (PATCH-ответы несут только
 * изменённые поля). Значение записи-проекции синхронизируется.
 */
export function commitEntityPatch(
  kind: EntityKind,
  id: string,
  patch: Record<string, unknown>,
  opts: PutEntityOptions = {},
): void {
  const record = patchEntity(kind, id, patch, opts);
  setQueryData(queryKeys.entity(kind, id), record?.entity);
}

/** Инвалидировать перечисленные префиксы ключей после мутации. */
export function invalidateAfterMutation(
  prefixes: readonly string[],
  cause?: unknown,
): string[] {
  const touched: string[] = [];
  for (const prefix of prefixes) touched.push(...invalidateQueries(prefix, cause));
  return touched;
}

// ---------------------------------------------------------------------------
// Локальные сигналы публикаций (свои правки до B1)
// ---------------------------------------------------------------------------
//
// Эхо-подавление сервера ещё включено (отменяется в B1 тех.проекта 269016e2):
// чужие изменения приходят роутером, но СВОИ производители обязаны уведомить
// открытую сборку публикации сами. Инвалидируем префикс `pub-assembly` целиком:
// рефетч идёт только активным наблюдателям (открытых сборок обычно 1–2), а
// решение «перечитать / пометить stale / править блок» принимает подписчик
// рабочей области по причине-сигналу. Точность «какая именно публикация» —
// после B1/G5.

/**
 * Сигнал «состав публикации мог измениться»: своё ребро (link-ops) или значение
 * свойства-связи (properties.ts). Рабочая область пометит живой текст устаревшим
 * («Остаётся + подсветка»), сборку НЕ перечитывая.
 *
 * `thoughtIds` — мысли, которых коснулась правка (владелец значения свойства,
 * концы изменённого ребра). Передача из G4 (задача 8a039ea3): рабочая область
 * сверяет их с текущей сборкой (`assemblyHasThought`) и НЕ зажигает stale, если
 * ни одна из них в сборку не входит, — правка постороннего свойства/связи не
 * должна помечать документ устаревшим. Без списка (владелец-связь или
 * неизвестный случай) поведение прежнее — консервативный stale.
 */
export function signalPublicationCompositionChanged(
  thoughtIds?: readonly string[],
  opts: { mayChangeComposition?: boolean } = {},
): void {
  invalidateQueries(queryKeys.publicationAssemblyAll(), {
    local: 'publication-composition',
    data: {
      ...(thoughtIds === undefined || thoughtIds.length === 0
        ? {}
        : { thought_ids: [...thoughtIds] }),
      // Признак «правка может изменить состав отбора публикации, даже если
      // изменённой сущности в текущей сборке НЕТ» (передача G5→G6, симметрично
      // «входу» в отбор G3). Нужен для свойств-критериев рецепта: значение
      // свойства может ВВЕСТИ мысль в сборку, поэтому проверка «есть ли мысль в
      // сборке» недостаточна и stale зажигается безусловно.
      ...(opts.mayChangeComposition === true ? { may_change_composition: true } : {}),
    },
  } satisfies LocalMutationSignal);
}

/**
 * Сигнал «сохранён ПОСТОЯННЫЙ комментарий мысли/связи» (своя правка из
 * редактора). `bodyMd` едет в сигнале, чтобы под stale рабочая область правила
 * блок точечно, без перечитывания сборки.
 */
export function signalPermanentCommentSaved(
  ownerId: string,
  bodyMd: string,
  kind = 'permanent',
): void {
  invalidateQueries(queryKeys.publicationAssemblyAll(), {
    local: 'comment-saved',
    id: ownerId,
    data: { body_md: bodyMd, kind },
  } satisfies LocalMutationSignal);
}

/**
 * Сигнал «сохранены поля мысли» (заголовок/синонимы/тип/активность): мысль в
 * текущей сборке помечает живой текст устаревшим (заголовок влияет на отбор),
 * вне сборки — ничего.
 */
export function signalThoughtSaved(
  thoughtId: string,
  changes: Record<string, unknown>,
): void {
  invalidateQueries(queryKeys.publicationAssemblyAll(), {
    local: 'thought-saved',
    id: thoughtId,
    data: { changes },
  } satisfies LocalMutationSignal);
}

/** Опции optimistic-обёртки. */
export interface OptimisticOptions<S, T> {
  /** Снять снимок затрагиваемого состояния (до изменения). */
  snapshot: () => S;
  /** Применить оптимистичное изменение. */
  apply: () => void;
  /** Откатить к снимку при ошибке мутации. */
  rollback: (snapshot: S) => void;
  /** Сама мутация (REST-запрос). */
  execute: () => Promise<T>;
}

/**
 * Выполнить мутацию оптимистично: применить изменение, дождаться REST-ответа,
 * при ошибке — откатить к снимку и пробросить ошибку дальше.
 */
export async function runOptimistic<S, T>(opts: OptimisticOptions<S, T>): Promise<T> {
  const snap = opts.snapshot();
  opts.apply();
  try {
    return await opts.execute();
  } catch (error) {
    opts.rollback(snap);
    throw error;
  }
}

/**
 * Оптимистичный патч сущности: снимок записи → патч кэша → мутация, при
 * ошибке — восстановление снимка (вплоть до удаления, если записи не было).
 */
export async function optimisticEntityPatch<T>(
  kind: EntityKind,
  id: string,
  patch: Record<string, unknown>,
  execute: () => Promise<T>,
): Promise<T> {
  const snapshot: EntityRecord | null = getRecord(kind, id) ?? null;
  return runOptimistic<EntityRecord | null, T>({
    snapshot: () => snapshot,
    apply: () => {
      patchEntity(kind, id, patch);
    },
    rollback: (snap) => {
      restoreRecord(kind, id, snap);
    },
    execute,
  });
}
