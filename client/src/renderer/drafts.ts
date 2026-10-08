/**
 * Drafts and offline handling (H19, 07-client-electron.md §5;
 * 09-scenarios.md J).
 *
 * - edits to the permanent comment body and the thought title are mirrored
 *   into the local `drafts` table while typing (debounced);
 * - on successful send the draft is deleted;
 * - while the realtime connection is down the UI blocks saves (the edit stays
 *   a draft, the status bar shows 🔴);
 * - on reconnect, pending drafts are re-sent automatically (idempotent
 *   `Client-Request-Id` machinery on the server prevents double-applies);
 *   version conflicts keep the draft and notify the user.
 */

import { errText } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { notice } from './lib/notice.js';
import { isConnected } from './realtime.js';
import { store } from './state.js';

/** Draft entity types supported by the retry loop. */
export type DraftKind = 'comment' | 'comment-new' | 'thought' | 'transclusion';

/** A pending draft as returned by `ui.draftList`. */
export interface DraftRecord {
  id: string;
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
  value: string | null;
  baseVersion: number | null;
  status: string;
  createdAt: string;
}

let lastConnected = false;
let initialized = false;

/** Initializes the offline detection + retry loop. Called once at boot. */
export function initDrafts(): void {
  if (initialized) return;
  initialized = true;
  lastConnected = isConnected();
  store.subscribe(() => {
    const connected = isConnected();
    if (connected && !lastConnected) {
      notice('Соединение восстановлено.', 'success');
      void retryPendingDrafts();
    } else if (!connected && lastConnected && store.state.rtStatus === 'offline') {
      notice('Соединение потеряно — правки сохраняются как черновики.', 'warning');
    }
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
 * Removes every draft of an edit target (all fields). Used after a successful
 * save: the tracked draft id may be null (a debounce that resolved after the
 * blur) or point at a row the upsert replaced — deleting by key sweeps whatever
 * actually exists.
 */
export async function clearDraftsFor(
  networkId: string,
  entityType: DraftKind,
  entityId: string,
): Promise<void> {
  let drafts: DraftRecord[];
  try {
    drafts = (await etn.ui.draftList(networkId)) as DraftRecord[];
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
 * Finds the draft for a specific edit target, or null. Returns the newest
 * matching row together with the version it was based on, so callers can tell
 * a pending edit (base version still current) from a stale one.
 */
export async function findDraft(
  networkId: string,
  entityType: DraftKind,
  entityId: string,
): Promise<{ id: string; value: string; baseVersion: number | null } | null> {
  let drafts: DraftRecord[];
  try {
    drafts = (await etn.ui.draftList(networkId)) as DraftRecord[];
  } catch {
    return null;
  }
  const hits = drafts.filter(
    (d) => d.entityType === entityType && d.entityId === entityId && d.value !== null,
  );
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
  notice(
    'Нет соединения — правка сохранена как черновик и отправится после восстановления связи.',
    'warning',
  );
}

/** Re-sends every pending draft of the open network. */
export async function retryPendingDrafts(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  let drafts: DraftRecord[];
  try {
    drafts = (await etn.ui.draftList(networkId)) as DraftRecord[];
  } catch {
    return;
  }
  if (drafts.length === 0) return;
  for (const draft of drafts) {
    try {
      await sendDraft(draft);
    } catch (err) {
      notice(`Черновик не отправлен: ${errText(err)}`, 'error');
    }
  }
}

/** Sends one draft according to its entity type; deletes it on success. */
async function sendDraft(draft: DraftRecord): Promise<void> {
  const networkId = draft.networkId;
  const value = draft.value;
  if (value === null) {
    await etn.ui.draftDelete(draft.id);
    return;
  }
  switch (draft.entityType) {
    case 'comment': {
      if (draft.baseVersion === null) return; // cannot If-Match without a version
      await etn.comments.update(networkId, draft.entityId, { body_md: value }, draft.baseVersion);
      await etn.ui.draftDelete(draft.id);
      break;
    }
    case 'comment-new': {
      const parsed = JSON.parse(value) as {
        ownerType: 'thought' | 'link';
        ownerId: string;
        bodyMd: string;
      };
      await etn.comments.create(networkId, parsed.ownerType, parsed.ownerId, {
        kind: 'permanent',
        body_md: parsed.bodyMd,
      });
      await etn.ui.draftDelete(draft.id);
      break;
    }
    case 'thought': {
      if (draft.field !== 'title' || draft.baseVersion === null) return;
      await etn.thoughts.update(networkId, draft.entityId, { title: value }, draft.baseVersion);
      await etn.ui.draftDelete(draft.id);
      break;
    }
    case 'transclusion':
      // Черновики правок источников трансклюзий НЕ переотправляются этим
      // циклом: правка источника — это правка раздела тела постоянного
      // комментария, её надо писать в контексте блока («Единая запись»,
      // `commitTransclusionEdit`). Строка остаётся в хранилище и
      // восстанавливается при следующем входе в правку поля; удаляется там же —
      // после успешной единой записи (или по `Esc`).
      break;
    default:
      // Неизвестный тип черновика: не игнорировать молча — неизвестная строка
      // не отправлена, и это должно быть видно (явная ветка `transclusion`
      // выше обязана существовать: её нейтрализация уводит сюда и краснит тест).
      throw new Error(`Неизвестный тип черновика: ${String(draft.entityType)}`);
  }
}

/**
 * Тестовый шов узкой логики переотправки одного черновика (ветки `switch`).
 * Экспортируется ради юнит-проверки ветки `transclusion` без поднятия UI и
 * реального цикла: удаление этой ветки обязано красить тест.
 */
export const draftsInternals = { sendDraft };

/** Convenience import for tests without DOM usage. */
export function draftsEnabled(): boolean {
  return initialized;
}
