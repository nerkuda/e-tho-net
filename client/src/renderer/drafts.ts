/**
 * Drafts and offline handling (H19, 07-client-electron.md §5;
 * 09-scenarios.md J).
 *
 * - edits to the permanent comment body and the thought title are mirrored
 *   into the local `drafts` table while typing (debounced);
 * - on successful send the draft is deleted;
 * - while the realtime connection is down the UI blocks saves (the edit stays
 *   a draft, the status bar shows 🔴);
 * - on (re)connect, pending drafts are re-sent automatically (idempotent
 *   `Client-Request-Id` machinery on the server prevents double-applies);
 *   version conflicts keep the draft, mark it `conflict` and notify the user
 *   ONCE — a conflicting draft is never retried on later connects until the
 *   entity is edited again (ошибка 5726744b).
 */

import { EtnError } from '@etn/shared';

import { errText, isConnectionLostError } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { t } from './lib/i18n.js';
import { notice } from './lib/notice.js';
import { isConnected } from './realtime.js';
import { getRtStatus, store, type RtStatus } from './state.js';

/** Draft entity types supported by the retry loop. */
export type DraftKind = 'comment' | 'comment-new' | 'thought' | 'transclusion';

/** Stored draft lifecycle (mirrors the main-process `DraftStatus`). */
export type DraftStatus = 'pending' | 'conflict' | 'sent' | 'failed';

/** Which stored drafts to read (mirrors {@link DraftListFilter}). */
export type DraftListFilter = 'pending' | 'conflict' | 'all';

/** A pending draft as returned by `ui.draftList`. */
export interface DraftRecord {
  id: string;
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
  value: string | null;
  baseVersion: number | null;
  status: DraftStatus;
  createdAt: string;
}

/** Outcome of sending one draft through the retry loop. */
export type DraftSendOutcome = 'sent' | 'skipped' | 'conflict';

let lastConnected = false;
let initialized = false;
/** `true` once the active network was connected at least once this session. */
let hadConnection = false;
/** Previous per-network statuses (draft retries are per network, de34b35b). */
let prevByNetwork: Record<string, RtStatus> = {};

/** Status-specific warning shown when the active connection drops (de34b35b). */
function linkLossMessage(status: RtStatus): string {
  switch (status) {
    case 'suspect':
      return t('realtime.link.lostSuspect');
    case 'reconnecting':
      return t('realtime.link.lostReconnecting');
    case 'offline':
      return t('realtime.link.lostOffline');
    default:
      return t('realtime.link.lost');
  }
}

/** Initializes the offline detection + retry loop. Called once at boot. */
export function initDrafts(): void {
  if (initialized) return;
  initialized = true;
  lastConnected = isConnected();
  hadConnection = lastConnected;
  prevByNetwork = { ...store.state.rtStatusByNetwork };
  store.subscribe(() => {
    // Per-network recovery (de34b35b): drafts of EVERY network are re-sent,
    // not just the active one. The first connect of a session counts too — a
    // draft left from the previous run must be flushed (H19). A draft that hit
    // VERSION_CONFLICT is marked `conflict` after that first attempt and is
    // therefore absent from later `pending` lists: no per-launch loop
    // (ошибка 5726744b).
    const map = store.state.rtStatusByNetwork;
    for (const [nid, status] of Object.entries(map)) {
      // The very first `connected` of a session also flushes: a draft left by
      // the previous run must be sent on launch (H19). Repeated snapshots with
      // the same status are no-ops (`prev` is already `connected`).
      if (status === 'connected' && prevByNetwork[nid] !== 'connected') {
        void retryPendingDrafts(nid);
      }
    }
    prevByNetwork = { ...map };

    const connected = isConnected();
    if (connected && !lastConnected) {
      // Recovery notice only after a real loss: the very first connect must
      // not claim «Соединение восстановлено» (de34b35b).
      if (hadConnection) notice(t('realtime.link.recovered'), 'success');
      hadConnection = true;
    } else if (!connected && lastConnected) {
      // One notice per connected → not-connected transition; the status text
      // follows the CURRENT state, so suspect→reconnecting→offline does not
      // spam the user.
      notice(linkLossMessage(getRtStatus(store.state)), 'warning');
    }
    if (connected) hadConnection = true;
    lastConnected = connected;
  });
}

/**
 * Saves (upserts) a draft for an edit in progress. Returns the draft id.
 */
export async function saveDraft(input: {
  networkId: string;
  entityType: DraftKind;
  entityId: string;
  field: string;
  value: string;
  baseVersion: number | null;
}): Promise<string> {
  return etn.ui.draftSave({
    networkId: input.networkId,
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    value: input.value,
    baseVersion: input.baseVersion,
  });
}

/** Removes a draft (called after a successful send). */
export async function clearDraft(draftId: string | null): Promise<void> {
  if (draftId === null) return;
  try {
    await etn.ui.draftDelete(draftId);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Lists stored drafts of a network. `filter` defaults to `pending` — the
 * auto-retry queue; `all` also returns conflict drafts (they are kept but not
 * retried).
 */
export async function listDrafts(
  networkId: string,
  filter: DraftListFilter = 'pending',
): Promise<DraftRecord[]> {
  return (await etn.ui.draftList(networkId, filter)) as DraftRecord[];
}

/**
 * Removes every draft of an edit target (all fields, all statuses). Used after
 * a successful save: the tracked draft id may be null (a debounce that resolved
 * after the blur) or point at a row the upsert replaced — deleting by key
 * sweeps whatever actually exists. Conflict drafts of the field are superseded
 * by an explicit save too (ошибка 5726744b), so they are swept as well.
 */
export async function clearDraftsFor(
  networkId: string,
  entityType: DraftKind,
  entityId: string,
): Promise<void> {
  let drafts: DraftRecord[];
  try {
    drafts = await listDrafts(networkId, 'all');
  } catch {
    return;
  }
  for (const draft of drafts) {
    if (draft.entityType === entityType && draft.entityId === entityId) {
      await etn.ui.draftDelete(draft.id).catch(() => undefined);
    }
  }
}

/**
 * All drafts of a specific edit target, newest last. `filter` defaults to
 * `pending`; `all` is used by the "dead draft" cleanup at editor open.
 */
export async function findDrafts(
  networkId: string,
  entityType: DraftKind,
  entityId: string,
  filter: DraftListFilter = 'pending',
): Promise<DraftRecord[]> {
  let drafts: DraftRecord[];
  try {
    drafts = await listDrafts(networkId, filter);
  } catch {
    return [];
  }
  return drafts.filter(
    (d) => d.entityType === entityType && d.entityId === entityId && d.value !== null,
  );
}

/**
 * Finds the draft for a specific edit target, or null. Returns the newest
 * matching row together with the version it was based on, so callers can tell
 * a pending edit (base version still current) from a stale one. Only `pending`
 * rows are eligible: a conflict draft must not be restored into a field (its
 * text lost against the server version) — it is kept in storage for a future
 * edit (ошибка 5726744b).
 */
export async function findDraft(
  networkId: string,
  entityType: DraftKind,
  entityId: string,
): Promise<{ id: string; value: string; baseVersion: number | null } | null> {
  const hits = await findDrafts(networkId, entityType, entityId, 'pending');
  const hit = hits.at(-1);
  if (hit === undefined || hit.value === null) return null;
  return { id: hit.id, value: hit.value, baseVersion: hit.baseVersion };
}

/** True when saves are allowed right now (H19 blocking). */
export function canSave(): boolean {
  return isConnected();
}

/* ------------------------------------------------------------------ *
 * Черновики правок источников трансклюзий (задача 6a085e01)
 *
 * Ключ черновика = владелец поля + источник + раздел: `entityType` =
 * `'transclusion'`, `entityId` = ключ владельца поля (`ownerKey`), `field` =
 * `sourceId#section` — тот же формат, что у ключа вложенного редактора блока
 * (`blockEditorKey`), поэтому потоки «правка блока» и «черновик» сходятся без
 * преобразований. Хранилище — существующая таблица `drafts` (тот же механизм,
 * что у черновиков комментария/заголовка); отдельного хранилища нет.
 * ------------------------------------------------------------------ */

/** Поле-компонент ключа черновика источника: `sourceId#section` (ключ блока). */
export function sourceDraftField(sourceId: string, section: string | null): string {
  return `${sourceId}#${section ?? ''}`;
}

/** Разбирает поле черновика источника обратно на источник и раздел. */
export function parseSourceDraftField(field: string): { sourceId: string; section: string | null } {
  const at = field.indexOf('#');
  if (at <= 0) return { sourceId: field, section: null };
  const section = field.slice(at + 1);
  return { sourceId: field.slice(0, at), section: section === '' ? null : section };
}

/** Черновик правки источника трансклюзии (владелец поля + источник + раздел). */
export interface SourceDraftRecord {
  id: string;
  sourceId: string;
  section: string | null;
  value: string;
  baseVersion: number | null;
}

/**
 * Сохраняет (upsert) черновик текста источника трансклюзии. Возвращает id
 * строки — для адресной очистки после успешной записи.
 */
export async function saveSourceDraft(input: {
  networkId: string;
  ownerKey: string;
  sourceId: string;
  section: string | null;
  value: string;
  baseVersion?: number | null;
}): Promise<string> {
  return saveDraft({
    networkId: input.networkId,
    entityType: 'transclusion',
    entityId: input.ownerKey,
    field: sourceDraftField(input.sourceId, input.section),
    value: input.value,
    baseVersion: input.baseVersion ?? null,
  });
}

/** Все черновики источников поля (`ownerKey`), в порядке хранения. */
export async function listSourceDrafts(
  networkId: string,
  ownerKey: string,
): Promise<SourceDraftRecord[]> {
  let drafts: DraftRecord[];
  try {
    drafts = (await etn.ui.draftList(networkId)) as DraftRecord[];
  } catch {
    return [];
  }
  return drafts
    .filter((d) => d.entityType === 'transclusion' && d.entityId === ownerKey && d.value !== null)
    .map((d) => ({
      id: d.id,
      ...parseSourceDraftField(d.field),
      value: d.value as string,
      baseVersion: d.baseVersion,
    }));
}

/**
 * Черновик конкретного блока (владелец поля + источник + раздел), либо `null`.
 * Нужен восстановлению: при монтаже вложенного редактора источник проверяется
 * на черновик — текст черновика возвращается вместо загруженного.
 */
export async function findSourceDraft(
  networkId: string,
  ownerKey: string,
  sourceId: string,
  section: string | null,
): Promise<{ id: string; value: string; baseVersion: number | null } | null> {
  const field = sourceDraftField(sourceId, section);
  const hits = (await listSourceDrafts(networkId, ownerKey)).filter(
    (d) => sourceDraftField(d.sourceId, d.section) === field,
  );
  const hit = hits.at(-1);
  return hit === undefined ? null : { id: hit.id, value: hit.value, baseVersion: hit.baseVersion };
}

/**
 * Удаляет черновики источников поля. Без `keys` — все черновики владельца
 * (`Esc`: правка отброшена целиком); с `keys` (ключи блоков `sourceId#section`)
 * — только перечисленные (успешно записанные источники при частичном сбое
 * «Единой записи»).
 */
export async function clearSourceDrafts(
  networkId: string,
  ownerKey: string,
  keys?: readonly string[],
): Promise<void> {
  const all = await listSourceDrafts(networkId, ownerKey);
  const wanted = keys === undefined ? null : new Set(keys);
  for (const draft of all) {
    if (wanted !== null && !wanted.has(sourceDraftField(draft.sourceId, draft.section))) continue;
    await etn.ui.draftDelete(draft.id).catch(() => undefined);
  }
}

/** Blocks a save while offline: notifies and keeps the draft. */
export function offlineNotice(): void {
  const status = getRtStatus(store.state);
  const key =
    status === 'suspect'
      ? 'drafts.offline.suspect'
      : status === 'reconnecting'
        ? 'drafts.offline.reconnecting'
        : status === 'offline'
          ? 'drafts.offline.offline'
          : 'drafts.offline.default';
  notice(t(key), 'warning');
}

/**
 * Re-sends pending drafts of `networkId` (default: the active network) after a
 * connection recovery (de34b35b). Per-network: a background tab that came back
 * online must flush its own drafts, not only the visible one.
 *
 * A draft whose send hits `VERSION_CONFLICT` is marked `conflict` on the FIRST
 * attempt and therefore disappears from the `pending` queue: later connects do
 * not retry it and do not repeat the notice. The user gets ONE clear message;
 * the text stays intact until the entity is edited again (then the draft is
 * re-based by the next `saveDraft` upsert). That breaks the «comment version
 * mismatch» loop at client start (ошибка 5726744b).
 */
export async function retryPendingDrafts(networkId?: string): Promise<void> {
  const target = networkId ?? store.state.networkId;
  if (target === null) return;
  let drafts: DraftRecord[];
  try {
    drafts = await listDrafts(target, 'pending');
  } catch {
    return;
  }
  if (drafts.length === 0) return;
  let conflicts = 0;
  for (const draft of drafts) {
    try {
      if ((await sendDraft(draft)) === 'conflict') conflicts += 1;
    } catch (err) {
      notice(t('drafts.retry.failed', errText(err)), 'error');
      // Соединение оборвалось посреди досылки: остальные строки отправлять
      // бессмысленно, они уйдут на следующем восстановлении связи.
      if (isConnectionLostError(err)) return;
    }
  }
  if (conflicts > 0) notice(t('drafts.conflict.kept'), 'warning');
}

/** True when the failure is an `If-Match` version conflict. */
function isVersionConflict(err: unknown): boolean {
  if (err instanceof EtnError && err.code === 'VERSION_CONFLICT') return true;
  // Structural fallback: тесты и частичные мосты отдают не EtnError, а объект
  // с `code` (тот же контракт конверта IPC).
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'VERSION_CONFLICT';
}

/**
 * Stops auto-retrying a draft after a version conflict. The text is NOT
 * deleted — решением оркестратора текст пользователя не теряем.
 */
async function markDraftConflict(draftId: string): Promise<void> {
  try {
    await etn.ui.draftSetStatus(draftId, 'conflict');
  } catch {
    // best-effort: не отметили — следующий connect попробует ещё раз
  }
}

/** Sends one draft according to its entity type; deletes it on success. */
async function sendDraft(draft: DraftRecord): Promise<DraftSendOutcome> {
  const networkId = draft.networkId;
  const value = draft.value;
  if (value === null) {
    await etn.ui.draftDelete(draft.id);
    return 'skipped';
  }
  /** Runs a write that has no `If-Match` alternative: a conflict is final. */
  const writeFile = async (write: () => Promise<unknown>): Promise<DraftSendOutcome> => {
    try {
      await write();
    } catch (err) {
      if (isVersionConflict(err)) {
        await markDraftConflict(draft.id);
        return 'conflict';
      }
      throw err;
    }
    await etn.ui.draftDelete(draft.id);
    return 'sent';
  };
  switch (draft.entityType) {
    case 'comment': {
      // Без версии-основы `If-Match` отправить нельзя: черновик не станет
      // отправляемым сам, поэтому сразу помечается конфликтным (текст цел).
      if (draft.baseVersion === null) {
        await markDraftConflict(draft.id);
        return 'conflict';
      }
      return writeFile(() =>
        etn.comments.update(networkId, draft.entityId, { body_md: value }, draft.baseVersion as number),
      );
    }
    case 'comment-new': {
      const parsed = JSON.parse(value) as {
        ownerType: 'thought' | 'link';
        ownerId: string;
        bodyMd: string;
      };
      return writeFile(() =>
        etn.comments.create(networkId, parsed.ownerType, parsed.ownerId, {
          kind: 'permanent',
          body_md: parsed.bodyMd,
        }),
      );
    }
    case 'thought': {
      if (draft.field !== 'title') return 'skipped';
      if (draft.baseVersion === null) {
        await markDraftConflict(draft.id);
        return 'conflict';
      }
      return writeFile(() =>
        etn.thoughts.update(networkId, draft.entityId, { title: value }, draft.baseVersion as number),
      );
    }
    case 'transclusion':
      // Черновики правок источников трансклюзий НЕ переотправляются этим
      // циклом: правка источника — это правка раздела тела постоянного
      // комментария, её надо писать в контексте блока («Единая запись»,
      // `commitTransclusionEdit`). Строка остаётся в хранилище и
      // восстанавливается при следующем входе в правку поля; удаляется там же —
      // после успешной единой записи (или по `Esc`).
      return 'skipped';
    default:
      // Неизвестный тип черновика: не игнорировать молча — неизвестная строка
      // не отправлена, и это должно быть видно (явная ветка `transclusion`
      // выше обязана существовать: её нейтрализация уводит сюда и краснит тест).
      throw new Error(t('drafts.unknownType', String(draft.entityType)));
  }
}

/**
 * Тестовый шов узкой логики переотправки одного черновика (ветки `switch`).
 * Экспортируется ради юнит-проверки ветки `transclusion` без поднятия UI и
 * реального цикла: удаление этой ветки обязано красить тест.
 */
export const draftsInternals = { sendDraft };

/* ------------------------------------------------------------------ *
 * Debounce-зеркало правки поля (ошибки 5726744b, 1b5446af)
 *
 * Раньше каждый редактор держал свой `setTimeout` и `draftId`. Таймер не
 * отменял уже начавшуюся асинхронную запись, поэтому строка, пришедшая ПОСЛЕ
 * сохранения/отмены, оставалась «вечным» черновиком с устаревшей
 * `baseVersion` — источник цикла `comment version mismatch`. Здесь:
 * `settle()` увеличивает поколение, и запись, начатая до него, удаляет свою
 * строку по возвращении id; `dispose()` досылает несохранённый текст, а не
 * теряет его; `flush()` пишет финальный текст (перед «Единой записью» или
 * офлайн-уходом) строго после начатых записей — опоздавшая запись не может
 * лечь поверх более новой.
 * ------------------------------------------------------------------ */

/** Поле правки, которое зеркалится в черновики. */
export interface DraftMirrorTarget {
  networkId: string;
  entityType: DraftKind;
  entityId: string;
  field: string;
  baseVersion: number | null;
}

/** Параметры {@link createDraftMirror}. */
export interface DraftMirrorOptions {
  /** Цель правки читается В МОМЕНТ записи: id/версия могут смениться. */
  target: () => DraftMirrorTarget | null;
  /** Кодирование текста поля в значение черновика (`comment-new` — JSON). */
  encode?: (raw: string) => string;
  /**
   * Текст читается В МОМЕНТ записи, а не в `schedule`: потоку, который
   * сигналит «поле изменилось» без текста (блоки трансклюзий), нужен последний
   * текст документа, набранный после сигнала.
   */
  read?: () => string | null;
  /** Задержка зеркалирования, мс (по умолчанию 800). */
  delayMs?: number;
  /** Идентификатор записанной строки (для адресной очистки после отправки). */
  onWritten?: (id: string) => void;
}

/** Рукоятка зеркала правки поля. */
export interface DraftMirror {
  /**
   * Отложить запись текста (очередная правка перепланирует таймер). Текст
   * обязателен, если у зеркала нет `read`.
   */
  schedule(raw?: string): void;
  /**
   * Правка подтверждена (сохранена) или отменена: отложенная запись гасится,
   * уже начавшаяся — удалит свою строку по возвращении id.
   */
  settle(): void;
  /**
   * Записать текст немедленно и дождаться записи. Финальный текст (перед
   * «Единой записью»/офлайн-уходом) встаёт в очередь ПОСЛЕ начатых записей,
   * поэтому опоздавшая запись не перетрёт его. Без аргумента берётся `read`
   * (или отложенный текст).
   */
  flush(raw?: string): Promise<void>;
  /** Редактор выгружается: отложенный текст дописывается, а не теряется. */
  dispose(): void;
}

/**
 * Удаляет опоздавшую строку черновика, только если она всё ещё хранит ЗНАЧЕНИЕ
 * этой записи. Upsert идёт по ключу поля и НЕ меняет id строки, поэтому слепое
 * удаление по id снесло бы более новое значение, записанное после (замечание
 * верификатора к ошибке 1b5446af).
 */
async function dropDraftIfOwn(networkId: string, id: string, value: string): Promise<void> {
  let rows: DraftRecord[];
  try {
    rows = await listDrafts(networkId, 'all');
  } catch {
    return;
  }
  const row = rows.find((d) => d.id === id);
  if (row === undefined || row.value !== value) return;
  await clearDraft(id);
}

/** Создаёт debounce-зеркало текста поля в таблицу черновиков. */
export function createDraftMirror(opts: DraftMirrorOptions): DraftMirror {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  let generation = 0;
  // Записи одного зеркала идут строго по очереди: опоздавшая запись не может
  // лечь поверх более новой (flush) — она завершится до её старта.
  let chain: Promise<void> = Promise.resolve();
  const run = (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  /** Текущий текст: явно переданный либо прочитанный из источника в момент вызова. */
  const currentText = (raw: string | undefined): string | null =>
    raw ?? (opts.read === undefined ? pending : opts.read());

  const write = async (generationAtSchedule: number | null, raw: string): Promise<void> => {
    const target = opts.target();
    if (target === null) return;
    let value: string;
    let id: string;
    try {
      value = opts.encode === undefined ? raw : opts.encode(raw);
      id = await saveDraft({ ...target, value });
    } catch {
      // Локальное хранилище недоступно — правка не должна ломать поле.
      return;
    }
    if (generationAtSchedule !== null && generationAtSchedule !== generation) {
      // Правка уже сохранена/отменена — строка опоздала, это мусор с
      // устаревшей baseVersion (источник вечного конфликта). Удаляем только
      // свою строку: более новое значение того же ключа остаётся.
      await dropDraftIfOwn(target.networkId, id, value);
      return;
    }
    opts.onWritten?.(id);
  };

  return {
    schedule(raw?: string): void {
      if (opts.read === undefined) {
        if (raw === undefined) return;
        pending = raw;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const value = opts.read === undefined ? pending : opts.read();
        pending = null;
        if (value === null) return;
        // Поколение фиксируется В МОМЕНТ срабатывания: задача пойдёт в очередь
        // и может стартовать уже после `settle`/`flush`.
        const generationAtFire = generation;
        void run(() => write(generationAtFire, value));
      }, opts.delayMs ?? 800);
    },
    settle(): void {
      generation += 1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
    async flush(raw?: string): Promise<void> {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const value = currentText(raw);
      pending = null;
      // Начатые записи стали неактуальны: они удалят свои строки, а финальный
      // текст встанет в очередь после них и не будет перетёрт.
      generation += 1;
      if (value === null) {
        await chain;
        return;
      }
      await run(() => write(null, value));
    },
    dispose(): void {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      const value = currentText(undefined);
      pending = null;
      if (value !== null) {
        const generationAtDispose = generation;
        void run(() => write(generationAtDispose, value));
      }
    },
  };
}

/**
 * Зеркало черновика текста источника трансклюзии (задача `6a085e01`, ошибка
 * `1b5446af`). Одно место, где строится ключ черновика: `entityType` =
 * `'transclusion'`, `entityId` = владелец-сущность поля (без id комментария,
 * ошибка `6d4d60ef`), `field` = `sourceId#section`.
 *
 * `read` читает последний текст блока в момент записи (сигнал «блок грязный»
 * приходит без текста); `flush` — финальный текст перед «Единой записью» или
 * офлайн-уходом.
 */
export function createSourceDraftMirror(opts: {
  networkId: string;
  /** Владелец-сущность поля; `undefined` — ключа нет, зеркало не пишет. */
  ownerKey: () => string | undefined;
  sourceId: string;
  section: string | null;
  read: () => string | null;
  delayMs?: number;
}): DraftMirror {
  return createDraftMirror({
    target: () => {
      const ownerKey = opts.ownerKey();
      if (ownerKey === undefined) return null;
      return {
        networkId: opts.networkId,
        entityType: 'transclusion',
        entityId: ownerKey,
        field: sourceDraftField(opts.sourceId, opts.section),
        baseVersion: null,
      };
    },
    read: opts.read,
    delayMs: opts.delayMs,
  });
}

/** Convenience import for tests without DOM usage. */
export function draftsEnabled(): boolean {
  return initialized;
}
