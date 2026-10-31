/**
 * Drafts and offline handling (H19, 07-client-electron.md §5;
 * 09-scenarios.md J).
 *
 * - edits to the permanent comment body and the thought title are mirrored
 *   into the local `drafts` table while typing (debounced);
 * - on successful send the draft is deleted;
 * - while the realtime connection is down the UI blocks saves (the edit stays
 *   a draft, the status bar shows 🔴);
 * - on a REAL (re)connect, pending drafts are re-sent automatically (idempotent
 *   `Client-Request-Id` machinery on the server prevents double-applies). The
 *   first `connected` of a session counts too: it flushes drafts typed in THIS
 *   session while the link was down. A confirmed liveness probe
 *   (`suspect → connected`) also flushes the drafts typed while the probe was
 *   in flight — otherwise they would be lost silently (ошибка 351068ed п.1);
 *   the «Соединение восстановлено» toast still never fires for a probe
 *   (fb9d6058, п.4 решений);
 * - обслуживание сервера (`serverMaintenance` активен) — не восстановление:
 *   сервер в обновлении принимает сокет и сразу закрывает его кодом 1012,
 *   поэтому `connected` мигает многократно. Пока состояние активно, ни досыл
 *   черновиков, ни тост «Соединение восстановлено» не запускаются, а отказ
 *   записи `SERVER_UPDATING` останавливает волну без красного тоста (задача
 *   479e37ed, блокер приёмки);
 * - drafts never survive a client restart: the main process purges every
 *   unfinished row right after opening the local DB, before the window exists
 *   (решение пользователя 2026-10-29, fb9d6058). The renderer only reports the
 *   purge count once (`reportStartupPurge`);
 * - a draft whose target is gone for good (`NOT_FOUND`) is terminal: marked
 *   `failed`, never retried, text kept until the next launch (fb9d6058);
 * - version conflicts keep the draft, mark it `conflict` and notify the user
 *   ONCE — a conflicting draft is never retried on later connects until the
 *   entity is edited again (ошибка 5726744b).
 */

import { CLIENT_META_KEY, EtnError } from '@etn/shared';

import { errText, isConnectionLostError, isDuplicateError, isServerUpdatingError } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { findPermanentComment } from './lib/permanent-comment.js';
import { t } from './lib/i18n.js';
import { notice, toast } from './lib/notice.js';
import { pluralRu } from './lib/plural.js';
import { serverMaintenanceText } from './lib/server-maintenance-text.js';
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
export type DraftSendOutcome = 'sent' | 'skipped' | 'conflict' | 'failed' | 'unusable';

let lastConnected = false;
let initialized = false;
/** `true` once the active network was connected at least once this session. */
let hadConnection = false;
/** Previous per-network statuses (draft retries are per network, de34b35b). */
let prevByNetwork: Record<string, RtStatus> = {};

/**
 * Status-specific warning shown when the active connection drops (de34b35b).
 *
 * Обслуживание сервера — отдельная причина (задача 479e37ed, сценарий
 * 610169a5): close `1012`/кадр `maintenance` НЕ выдаётся за «переподключение
 * или сетевую аварию». Когда main подтвердил состояние обслуживания, текст
 * говорит «сервер обновляется» и называет срок из `retry_after`.
 */
function linkLossMessage(status: RtStatus): string {
  const maintenanceText = serverMaintenanceText(store.state.serverMaintenance);
  if (maintenanceText !== null) return maintenanceText;
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
    const map = store.state.rtStatusByNetwork;
    // Предыдущий статус АКТИВНОЙ сети снимается ДО перезаписи `prevByNetwork`
    // (fb9d6058, ловушка реализации): иначе переход `suspect → connected` не
    // отличить от настоящего восстановления после обрыва.
    const activeId = store.state.networkId;
    const prevActive = activeId === null ? undefined : prevByNetwork[activeId];
    // Обслуживание сервера (блокер приёмки 479e37ed): во время обновления
    // сервер принимает сокет и сразу закрывает его кодом 1012, поэтому статус
    // успевает мигнуть `connected` десяток раз. Открытие сокета — не
    // восстановление: ни досыл черновиков, ни тост «Соединение восстановлено»
    // в обслуживании не запускаются, иначе пользователь получает 12 волн
    // красных тостов и ложное «восстановлено» при «Сервер: обновление».
    const maintenance = store.state.serverMaintenance;
    const inMaintenance = maintenance !== null && maintenance.active === true;
    // Per-network recovery (de34b35b): drafts of EVERY network are re-sent,
    // not just the active one. The first connect of a session counts too — a
    // draft typed in THIS session while the link was down must be flushed
    // (H19); rows left by previous runs are purged in main before the window
    // exists (fb9d6058). A confirmed liveness probe (`suspect → connected`)
    // flushes too: the draft typed while the probe was in flight would
    // otherwise sit pending until a REAL drop and be purged on the next launch
    // — silent loss under the «отправится после восстановления связи» promise
    // (ошибка 351068ed п.1). Only the «Соединение восстановлено» toast stays
    // suppressed — the probe is not a recovery on the messaging level.
    for (const [nid, status] of Object.entries(map)) {
      if (!inMaintenance && status === 'connected' && prevByNetwork[nid] !== 'connected') {
        void retryPendingDrafts(nid);
      }
    }
    prevByNetwork = { ...map };

    const status = getRtStatus(store.state);
    const connected = status === 'connected';
    if (connected && !lastConnected) {
      // Recovery notice only after a real loss: the very first connect of a
      // session and a probe answered in time must not claim «Соединение
      // восстановлено» (de34b35b, fb9d6058). Мигание сокета в обслуживании —
      // тоже не восстановление (блокер приёмки 479e37ed).
      // Восстановление связи — важное сообщение (доступность сервера), поэтому
      // тост, а не рутинная строка статус-бара (задача 28d22b8a).
      if (!inMaintenance && hadConnection && prevActive !== 'suspect') {
        toast(t('realtime.link.recovered'), 'success');
      }
      hadConnection = true;
    } else if (status === 'suspect') {
      // Проба живости только отправлена — потери связи ещё нет, и на входе в
      // `suspect` пользователю НЕ сообщаем ничего (fb9d6058 п.4). Сообщение
      // появится, только если проба не подтвердит живость (ветка ниже).
    } else if (!connected && (lastConnected || prevActive === 'suspect')) {
      // Реальный обрыв (connected → reconnecting/offline) либо проба, не
      // подтвердившая живость за свой дедлайн (suspect → reconnecting/offline).
      // Текст «Проверяем связь» — именно подтверждённое подозрение; вход в
      // `suspect` молчит.
      notice(linkLossMessage(prevActive === 'suspect' ? 'suspect' : status), 'warning');
    }
    if (connected) hadConnection = true;
    lastConnected = connected;
  });
  void reportStartupPurge();
}

/**
 * Форма слова «черновик» для счётчика (fb9d6058): сами формы — в словаре
 * (`drafts.noun.*`), выбор — `pluralRu`; литералов кириллицы в модуле нет
 * (сторож i18n).
 */
function draftNoun(count: number): string {
  return pluralRu(count, t('drafts.noun.one'), t('drafts.noun.few'), t('drafts.noun.many'));
}

/**
 * Одно стартовое сообщение о чистке черновиков прошлых запусков (fb9d6058,
 * п.5 решений). Main удаляет их сразу после открытия local.db и ДО создания
 * окна, поэтому показать сообщение сам не может: счётчик ждёт в `client_meta`,
 * renderer читает его при старте, показывает ОДИН раз и очищает ключ.
 * Пустой черновик терять нечего — счётчик считает только строки с текстом.
 */
export async function reportStartupPurge(): Promise<void> {
  try {
    const raw = await etn.meta.get(CLIENT_META_KEY.DRAFTS_PURGED_COUNT);
    if (raw === null || raw === '') return;
    // Ключ очищается при ЛЮБОМ значении, включая 0 (замечание приёмки к
    // 351068ed): main пишет счётчик при каждом старте, прочитанное значение
    // отработано и следующему запуску не принадлежит. Иначе «0» оставался бы
    // в client_meta навсегда.
    await etn.meta.set(CLIENT_META_KEY.DRAFTS_PURGED_COUNT, '');
    const count = Number(raw);
    if (!Number.isInteger(count) || count <= 0) return;
    notice(t('drafts.startup.purged', [count, draftNoun(count)]), 'warning');
  } catch {
    // Локальное хранилище недоступно — сообщать нечего.
  }
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
 * REAL connection recovery (de34b35b). Per-network: a background tab that came
 * back online must flush its own drafts, not only the visible one.
 *
 * ONE wave per network at a time (ошибка 351068ed п.2). Two `connected` events
 * in a row used to start two overlapping waves: the second one carried a stale
 * `draftList` snapshot and re-sent a row the first wave had just deleted,
 * producing a false `VERSION_CONFLICT` toast («запись изменена в другом
 * месте»). A repeat call while a wave runs only schedules ONE more pass after
 * it finishes: that pass re-reads the queue instead of replaying a snapshot,
 * so rows typed during the wave still get sent.
 *
 * A draft whose send hits `VERSION_CONFLICT` is marked `conflict` on the FIRST
 * attempt and therefore disappears from the `pending` queue: later connects do
 * not retry it and do not repeat the notice. The user gets ONE clear message;
 * the text stays intact until the entity is edited again (then the draft is
 * re-based by the next `saveDraft` upsert). That breaks the «comment version
 * mismatch» loop at client start (ошибка 5726744b).
 *
 * A draft whose target is gone for good (`NOT_FOUND`) is marked `failed` and
 * also leaves the queue — forever (fb9d6058). Both terminal classes are
 * reported by ONE aggregated message per wave, with a counter and no uuid or
 * server English; the draft text is never deleted silently.
 */
export async function retryPendingDrafts(networkId?: string): Promise<void> {
  const target = networkId ?? store.state.networkId;
  if (target === null) return;
  const running = retryWaves.get(target);
  if (running !== undefined) {
    retryRerun.add(target);
    return running;
  }
  const wave = (async () => {
    try {
      await runRetryWave(target);
    } catch {
      // Волна не должна оставлять отвергнутый промис в реестре: иначе
      // следующие вызовы получают его вечно, а `initDrafts` — unhandled
      // rejection (замечание приёмки к 351068ed).
    } finally {
      // Запись снимается ДО возможного повторного прохода: тот создаёт новую
      // волну и кладёт в реестр собственный промис.
      retryWaves.delete(target);
    }
    if (retryRerun.delete(target)) await retryPendingDrafts(target);
  })();
  retryWaves.set(target, wave);
  return wave;
}

const fieldWritesInFlight = new Map<string, number>();

/** Ключ поля правки — тот же, что у строки черновика (без профиля). */
function draftFieldKey(key: {
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
}): string {
  return `${key.networkId}|${key.entityType}|${key.entityId}|${key.field}`;
}

/**
 * Регистрирует PATCH, уже летящий по полю, которое зеркалится в черновики
 * (ошибка 351068ed, блокер п.1). Пока запись не завершена, волна досыла НЕ
 * отправляет черновик этого поля: второй PATCH с той же `If-Match`-версией
 * дал бы ложный `VERSION_CONFLICT` — проиграла волна (тост «запись изменена в
 * другом месте») или сохранение (ошибка коммита с английским текстом).
 *
 * Вызывают оба места зеркалирования: `editor/comments.ts` (`comment` /
 * `comment-new`) и `editor/editor.ts` (заголовок `thought`). Регистрация
 * охватывает и успешную очистку черновиков (`clearDraftsFor`), поэтому окно
 * «PATCH завершился, строка ещё pending» тоже закрыто. Функция снятия
 * идемпотентна; повторные входы по тому же ключу считаются.
 */
export function beginDraftFieldWrite(key: {
  networkId: string;
  entityType: DraftKind;
  entityId: string;
  field: string;
}): () => void {
  const k = draftFieldKey(key);
  fieldWritesInFlight.set(k, (fieldWritesInFlight.get(k) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (fieldWritesInFlight.get(k) ?? 1) - 1;
    if (left <= 0) fieldWritesInFlight.delete(k);
    else fieldWritesInFlight.set(k, left);
  };
}

/** Летит ли PATCH по этому полю прямо сейчас (см. {@link beginDraftFieldWrite}). */
function isDraftFieldWriteInFlight(draft: DraftRecord): boolean {
  return fieldWritesInFlight.has(draftFieldKey(draft));
}

/** One wave per network: the in-flight promise (351068ed п.2). */
const retryWaves = new Map<string, Promise<void>>();
/** Сети, для которых во время волны запрошен ЕЩЁ один проход по свежей очереди. */
const retryRerun = new Set<string>();

/** Один проход по `pending`-очереди сети; терминальные исходы — агрегатом. */
async function runRetryWave(target: string): Promise<void> {
  let drafts: DraftRecord[];
  try {
    drafts = await listDrafts(target, 'pending');
  } catch {
    return;
  }
  if (drafts.length === 0) return;
  let conflicts = 0;
  let unavailable = 0;
  let unusable = 0;
  // Терминальные черновики этой волны уже вышли из очереди `pending` —
  // повторной волны для них не будет. Поэтому агрегат показывается и при
  // обрыве связи посреди досылки (fb9d6058, замечание верификатора).
  const reportTerminalDrafts = (): void => {
    if (unavailable > 0) {
      notice(t('drafts.failed.unavailable', [unavailable, draftNoun(unavailable)]), 'warning');
    }
    if (unusable > 0) {
      // Локальный дефект черновика (битый конверт/неизвестный тип): ретрай не
      // поможет — строка переведена в терминальный `failed` (351068ed п.8).
      notice(t('drafts.failed.unusable', [unusable, draftNoun(unusable)]), 'warning');
    }
    if (conflicts > 0) notice(t('drafts.conflict.kept'), 'warning');
  };
  for (const draft of drafts) {
    // PATCH этого поля уже летит сохранением (проба живости запустила волну
    // посреди записи): второй PATCH с той же base_version дал бы ложный
    // VERSION_CONFLICT. Строка остаётся `pending`; успешное сохранение удалит
    // её через `clearDraftsFor`, неуспешное — отправит следующая волна
    // (ошибка 351068ed, блокер п.1).
    if (isDraftFieldWriteInFlight(draft)) continue;
    try {
      const outcome = await sendDraft(draft);
      if (outcome === 'conflict') conflicts += 1;
      else if (outcome === 'failed') unavailable += 1;
      else if (outcome === 'unusable') unusable += 1;
    } catch (err) {
      // Обслуживание сервера (блокер приёмки 479e37ed): запись отклонена
      // штатным `SERVER_UPDATING` — это не сбой досыла. Волну останавливаем
      // без красного тоста (пользователь уже видит «Сервер: обновление» со
      // сроком), текст остаётся в черновике до восстановления сервера.
      if (isServerUpdatingError(err)) {
        reportTerminalDrafts();
        return;
      }
      notice(t('drafts.retry.failed', draftRetryErrorText(err)), 'error');
      // Соединение оборвалось посреди досылки: остальные строки отправлять
      // бессмысленно, они уйдут на следующем восстановлении связи. Агрегат за
      // уже обработанные терминальные черновики — ДО выхода из волны.
      if (isConnectionLostError(err)) {
        reportTerminalDrafts();
        return;
      }
    }
  }
  reportTerminalDrafts();
}

/**
 * Пользовательский текст сбоя досылки (351068ed п.7). Серверные сообщения
 * английские и адресованы API — в тосте они не показываются. Русские ветки
 * `errText` сохраняются только для распознанных классов (обрыв связи,
 * недоступный сервер, обслуживание); всё остальное, включая локальные сбои БД
 * с английским SQLite-текстом, получает общую русскую формулировку
 * (замечание приёмки: класс «английский текст в тосте»).
 */
function draftRetryErrorText(err: unknown): string {
  if (isConnectionLostError(err)) return t('errors.connectionLost');
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'INTERNAL' || code === 'SERVER_UPDATING') {
    return errText(err);
  }
  return t('drafts.retry.rejected');
}

/** True when the failure is an `If-Match` version conflict. */
function isVersionConflict(err: unknown): boolean {
  if (err instanceof EtnError && err.code === 'VERSION_CONFLICT') return true;
  // Structural fallback: тесты и частичные мосты отдают не EtnError, а объект
  // с `code` (тот же контракт конверта IPC).
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'VERSION_CONFLICT';
}

/**
 * True when the failure is terminal on its own: the target row does not exist
 * in the current layer/session (`NOT_FOUND`). Terminal ONLY for `NOT_FOUND`
 * (fb9d6058 п.3 решений): other 4xx stay retryable — the layer may be switched
 * back, the entity may be restored from the trash or re-created, and blocking
 * such a draft forever would lose the user's text without any way back.
 * No existence pre-check is made: the first response decides.
 */
function isTargetUnavailable(err: unknown): boolean {
  if (err instanceof EtnError && err.code === 'NOT_FOUND') return true;
  // Structural fallback — same envelope contract as {@link isVersionConflict}.
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'NOT_FOUND';
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

/**
 * Stops auto-retrying a draft whose target is unreachable for good (fb9d6058).
 * `failed` is terminal: the row leaves the `pending` queue, so no connect
 * retries it and no wave repeats the message. `conflict` is NOT used here —
 * it is reserved for «версия разошлась» (5726744b). The text stays in
 * local.db until the next launch's startup purge (п.1 решений): потерять его
 * молча нельзя, показать в GUI пока негде.
 */
async function markDraftFailed(draftId: string): Promise<void> {
  try {
    await etn.ui.draftSetStatus(draftId, 'failed');
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
      if (isTargetUnavailable(err)) {
        await markDraftFailed(draft.id);
        return 'failed';
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
      // Конверт черновика создаёт сам клиент. Синтаксически битый JSON или
      // чужая структура не станут отправляемыми ни при каком восстановлении
      // связи: раньше `JSON.parse` бросал на каждом connect — вечный ретрай с
      // техническим английским (351068ed п.8). Теперь это терминальный
      // `failed`; текст строки цел до чистки при следующем запуске.
      let parsed: { ownerType: 'thought' | 'link'; ownerId: string; bodyMd: string };
      try {
        parsed = JSON.parse(value) as typeof parsed;
      } catch {
        await markDraftFailed(draft.id);
        return 'unusable';
      }
      const valid =
        (parsed.ownerType === 'thought' || parsed.ownerType === 'link') &&
        typeof parsed.ownerId === 'string' &&
        typeof parsed.bodyMd === 'string';
      if (!valid) {
        await markDraftFailed(draft.id);
        return 'unusable';
      }
      try {
        return await writeFile(() =>
          etn.comments.create(networkId, parsed.ownerType, parsed.ownerId, {
            kind: 'permanent',
            body_md: parsed.bodyMd,
          }),
        );
      } catch (err) {
        if (!isDuplicateError(err)) throw err;
        // Постоянный комментарий уже создан: первая попытка дошла до сервера,
        // а её ответ потерялся в обрыве связи (или запись сделал другой клиент).
        // Повторять create на каждом переподключении и уведомлять о сбое
        // нельзя — сверяем текст (ошибка ecdb2e7a).
        const existing = await findPermanentComment({
          networkId,
          ownerType: parsed.ownerType,
          ownerId: parsed.ownerId,
        });
        // Отказ есть, а комментарий не читается (гонка со снятием, чужой
        // слой): показываем исходную ошибку, текст черновика цел.
        if (existing === null) throw err;
        if (existing.body_md === parsed.bodyMd) {
          // Сервер уже хранит ровно этот текст — черновик выполнен.
          await etn.ui.draftDelete(draft.id);
          return 'sent';
        }
        // Серверный текст другой: не затираем его молча — черновик остаётся
        // конфликтным (как при VERSION_CONFLICT): пользователь получит одно
        // уведомление и сам решит, чей текст нужен.
        await markDraftConflict(draft.id);
        return 'conflict';
      }
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
      // Неизвестный тип черновика: не игнорировать молча и не ретраить вечно
      // (351068ed п.8) — тип не появится от восстановления связи, поэтому
      // строка терминальна (`failed`), а пользователь получает одно русское
      // сообщение на волну. Явная ветка `transclusion` выше обязана
      // существовать: её удаление уводит сюда и краснит тест.
      await markDraftFailed(draft.id);
      return 'unusable';
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
