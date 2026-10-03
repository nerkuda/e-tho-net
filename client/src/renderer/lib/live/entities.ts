/**
 * Кэш сущностей слоя данных (этап G1 тех.проекта `269016e2`).
 *
 * Плоский Map «`тип:id` → сущность» — единый нормализованный источник данных
 * для будущих экранов: мысль, связь, публикация, полка, вложение, комментарий,
 * каталоги типов/свойств, отборы. Снимки запросов (`query-registry.ts`) —
 * производные проекции этого кэша.
 *
 * Две несущие идеи:
 *
 * 1. **Версия/seq на запись.** Каждая запись несёт `seq` (номер события шины,
 *    которым она пришла) и `version` (версия самой сущности). Патч со `seq`
 *    СТАРШЕ уже лежащего в кэше игнорируется — событие, пришедшее с опозданием,
 *    не откатывает более свежее состояние (дедуп роутера, `event-router.ts`).
 *
 * 2. **Structural sharing.** Патч сливается поверх прежней сущности
 *    поверхностно: неизменённые поля сохраняют ТУ ЖЕ ссылку, а если не
 *    изменилось ни одно поле — возвращается прежний объект целиком. Это даёт
 *    дешёвое сравнение ссылок (`===`) там, где раньше требовалось глубокое.
 */

import { derived, writable, type Readable, type StoreLike } from './reactive.js';

/** Роды сущностей, живущих в нормализованном кэше. */
export type EntityKind =
  | 'thought'
  | 'link'
  | 'publication'
  | 'shelf'
  | 'attachment'
  | 'comment'
  | 'thought-type'
  | 'link-type'
  | 'property-definition'
  | 'property-registry'
  | 'thought-type-view'
  | 'saved-filter'
  | 'network';

/** Полный ключ записи кэша: `тип:id`. */
export type EntityKey = string;

/** Одна запись кэша сущностей. */
export interface EntityRecord {
  kind: EntityKind;
  id: string;
  /** Текущее значение сущности (после структурного слияния патчей). */
  entity: unknown;
  /** Версия сущности (`entity.version`), 0 — неизвестна. */
  version: number;
  /** Номер последнего применённого события шины, `-1` — запись из REST. */
  seq: number;
}

/** Ключ записи по роду и id. */
export function entityKey(kind: EntityKind, id: string): EntityKey {
  return `${kind}:${id}`;
}

const records = new Map<EntityKey, EntityRecord>();

/**
 * Сущности с optimistic-мутацией В ПОЛЁТЕ (B1 техпроекта 269016e2). Пока
 * REST-ответ не подтвердил мутацию, события шины по этой сущности к кэшу НЕ
 * применяются (broadcast-to-all приносит своё событие и автору — оно могло бы
 * перетереть оптимистичное значение раньше подтверждения). После подтверждения
 * истина — REST-ответ (`commitEntity` пишет без `seq` и проходит).
 *
 * Ключ набора — {@link entityKey}.
 */
const pendingMutations = new Set<EntityKey>();

/** Пометить оптимистичную мутацию сущности как начатую. */
export function beginEntityMutation(kind: EntityKind, id: string): void {
  pendingMutations.add(entityKey(kind, id));
}

/** Снять пометку оптимистичной мутации (подтверждена или откатана). */
export function endEntityMutation(kind: EntityKind, id: string): void {
  pendingMutations.delete(entityKey(kind, id));
}

/** Идёт ли по сущности оптимистичная мутация (события шины буферизуются). */
export function isEntityMutationPending(kind: EntityKind, id: string): boolean {
  return pendingMutations.has(entityKey(kind, id));
}

/** Снять все пометки (смена сети/разбор сессии, тесты). */
export function clearPendingMutations(): void {
  pendingMutations.clear();
}

/** Ревизия кэша — тикает на каждой фактической правке (для реактивных срезов). */
const revision = writable(0);

/** Реактивная ревизия кэша: подписчик узнаёт, что что-то изменилось. */
export const entitiesRevision: StoreLike<number> = revision;

function bump(): void {
  revision.update((n) => n + 1);
}

/** Читать запись кэша (или `undefined`). */
export function getRecord(kind: EntityKind, id: string): EntityRecord | undefined {
  return records.get(entityKey(kind, id));
}

/** Читать значение сущности из кэша. */
export function getEntity<T = unknown>(kind: EntityKind, id: string): T | undefined {
  return records.get(entityKey(kind, id))?.entity as T | undefined;
}

/** Реактивный срез сущности по ключу. */
export function entityStore<T = unknown>(kind: EntityKind, id: string): Readable<T | undefined> {
  return derived(entitiesRevision, () => getEntity<T>(kind, id));
}

/** Все записи кэша (снимок для тестов и диагностики). */
export function entitiesSnapshot(): EntityRecord[] {
  return [...records.values()];
}

/** Число записей в кэше. */
export function entitiesSize(): number {
  return records.size;
}

/** Опции записи сущности в кэш. */
export interface PutEntityOptions {
  /** Номер события шины; `-1` — данные пришли не из realtime (REST/MCP). */
  seq?: number;
  /** Версия сущности, если её нет в самом объекте. */
  version?: number;
}

function readVersion(entity: unknown, fallback: number | undefined): number {
  if (typeof entity === 'object' && entity !== null && 'version' in entity) {
    const v = (entity as { version?: unknown }).version;
    if (typeof v === 'number') return v;
  }
  return fallback ?? 0;
}

/**
 * Версия входящей записи, если её можно определить (`undefined` — у сущности
 * нет поля `version` и явная версия не передана). Нужна для дедупа B1: правило
 * «версия ≤ кэшированной → игнор» применяется ТОЛЬКО к версионируемым
 * сущностям, иначе патчи сущностей без версии (вложения и т.п.) не проходили бы.
 */
function readVersionMaybe(entity: unknown, explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit;
  if (typeof entity === 'object' && entity !== null && 'version' in entity) {
    const v = (entity as { version?: unknown }).version;
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * Устарела ли входящая версия (≤ уже лежащей). Дедуп B1 по версии сущности:
 * событие шины или REST-ответ со версией не новее кэшированной не откатывает
 * состояние (гонка «событие ↔ REST-ответ»). Срабатывает, только когда ОБЕ
 * версии известны и положительны.
 */
function isStaleVersion(incoming: number | undefined, cached: number): boolean {
  return incoming !== undefined && incoming > 0 && cached > 0 && incoming <= cached;
}

/** Идёт ли пометка optimistic-мутации для записи (события шины буферизуем). */
function isBusEvent(opts: PutEntityOptions): boolean {
  return opts.seq !== undefined && opts.seq !== -1;
}

/**
 * Положить сущность целиком (ответ REST-мутации, полный снимок события).
 * Если новая сущность поверхностно равна прежней — прежняя ссылка
 * переиспользуется (structural sharing).
 */
export function putEntity(kind: EntityKind, id: string, entity: unknown, opts: PutEntityOptions = {}): EntityRecord {
  const key = entityKey(kind, id);
  const prev = records.get(key);
  const seq = opts.seq ?? -1;
  if (prev !== undefined && seq !== -1 && seq < prev.seq) return prev;
  // B1: событие шины по сущности с optimistic-мутацией в полёте не применяем —
  // истину даст REST-ответ (пишет без seq).
  if (prev !== undefined && isBusEvent(opts) && isEntityMutationPending(kind, id)) return prev;

  const version = readVersion(entity, opts.version);
  if (prev !== undefined && isStaleVersion(readVersionMaybe(entity, opts.version), prev.version)) {
    return prev;
  }
  if (prev !== undefined && shallowEqual(prev.entity, entity)) {
    // Тело не изменилось — обновляем только метаданные, ссылку сохраняем.
    if (prev.seq === seq && prev.version === version) return prev;
    const next: EntityRecord = { kind, id, entity: prev.entity, version, seq };
    records.set(key, next);
    return next;
  }
  const next: EntityRecord = { kind, id, entity, version, seq };
  records.set(key, next);
  bump();
  return next;
}

/**
 * Патч сущности: поверхностное слияние полей. Возвращает запись кэша (прежнюю,
 * если патч не изменил ни одного поля или пришёл со старым `seq`).
 */
export function patchEntity(
  kind: EntityKind,
  id: string,
  patch: Record<string, unknown>,
  opts: PutEntityOptions = {},
): EntityRecord | undefined {
  const key = entityKey(kind, id);
  const prev = records.get(key);
  const seq = opts.seq ?? -1;
  if (prev !== undefined && seq !== -1 && seq < prev.seq) return prev;
  // B1: событие шины по сущности с optimistic-мутацией в полёте — буферизуем
  // (не применяем), истину даст REST-ответ.
  if (prev !== undefined && isBusEvent(opts) && isEntityMutationPending(kind, id)) return prev;
  if (prev === undefined) {
    // Патчить нечего — кладём патч как сущность (частичная запись).
    return putEntity(kind, id, { id, ...patch }, opts);
  }
  // Дедуп B1 по версии: патч не новее кэшированного не откатывает состояние.
  // Версия берётся ТОЛЬКО явная — `opts.version` (роутер событий) или поле
  // `version` самого патча. Слитое значение для этого не годится: оно несёт
  // СТАРУЮ версию, и патчи без версии (оформление и т.п.) отбраковывались бы.
  const incomingPatchVersion =
    opts.version ?? (typeof patch['version'] === 'number' ? (patch['version'] as number) : undefined);
  if (isStaleVersion(incomingPatchVersion, prev.version)) return prev;
  const merged = mergeShallow(prev.entity, patch);
  const version = opts.version ?? readVersion(merged, prev.version);
  if (merged === prev.entity && prev.seq === seq && prev.version === version) return prev;
  const next: EntityRecord = { kind, id, entity: merged, version, seq };
  records.set(key, next);
  if (merged !== prev.entity) bump();
  return next;
}

/** Удалить сущность из кэша. Возвращает `true`, если запись была. */
export function removeEntity(kind: EntityKind, id: string): boolean {
  const removed = records.delete(entityKey(kind, id));
  if (removed) bump();
  return removed;
}

/**
 * Восстановить запись из снимка (для optimistic-откатов): `null` —
 * снимок отсутствия (удалить запись).
 */
export function restoreRecord(kind: EntityKind, id: string, snapshot: EntityRecord | null): void {
  const key = entityKey(kind, id);
  if (snapshot === null) {
    if (records.delete(key)) bump();
    return;
  }
  records.set(key, snapshot);
  bump();
}

/** Полностью очистить кэш (смена сети/разбор сессии). */
export function clearEntities(): void {
  pendingMutations.clear();
  if (records.size === 0) return;
  records.clear();
  bump();
}

// ---------------------------------------------------------------------------
// Structural sharing helpers
// ---------------------------------------------------------------------------

/** Поверхностное слияние: неизменённые поля сохраняют прежнюю ссылку. */
function mergeShallow(base: unknown, patch: Record<string, unknown>): unknown {
  if (typeof base !== 'object' || base === null) return { ...patch };
  const source = base as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(patch)) {
    if (!Object.is(source[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return base;
  return { ...source, ...patch };
}

/** Поверхностное равенство двух значений-объектов. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(ao[key], bo[key])) return false;
  }
  return true;
}
