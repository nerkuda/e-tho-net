/**
 * Вложения показанной сущности ↔ открытый редактор (ошибка abd25adb).
 *
 * Вкладка «Вложения» открытого редактора показывает список и счётчик вложений
 * СВОЕЙ сущности. Набор вложений меняется двумя путями:
 *
 *  - **локально** — вставка картинки/файла из буфера в поле markdown
 *    (`editor/markdown-field.ts`), «Назначить иконкой мысли» из файла
 *    (`editor/editor.ts`), добавление/перенос/удаление на самой вкладке
 *    (`editor/attachments.ts`). Производители сами шлют локальный DOM-канал
 *    `etn:attachments-changed` с владельцем — своё realtime-эхо до рендерера не
 *    доходит (его отбрасывает G8-applier главного процесса), поэтому без этого
 *    канала вкладка не узнала бы о собственной правке;
 *  - **realtime** — `attachment.created/updated/deleted` от другого клиента или
 *    от MCP. `created` несёт полный снимок вложения с владельцем, а `updated` /
 *    `deleted` — ТОЛЬКО id (04-realtime.md §4.4), поэтому владельца приходится
 *    брать из индекса вложений, реально прочитанных для показанной сущности
 *    ({@link rememberShownAttachments} / {@link shownAttachmentOwner}).
 *    Неизвестный id означает, что вложения в показанном списке нет: устаревать
 *    нечему, вкладка прочитает список заново при следующем построении.
 *
 * Гейт ({@link attachmentChangeFacts} + сравнение владельца с показанной
 * сущностью в `editor/editor.ts`) отсекает изменения ЧУЖИХ сущностей: вкладка
 * показанной сущности не перечитывается на каждое вложение сети.
 */

import type { AttachmentOwnerType } from '@etn/shared';

/** Владелец вложения — мысль, связь или публикация (0.11.1, задача f37b468d:
 *  обложка публикации — новый тип владельца). Тип берётся из общего реестра
 *  `@etn/shared`, чтобы клиент не расходился с сервером. */
export type { AttachmentOwnerType };

/** Владелец вложения. */
export interface AttachmentOwner {
  ownerType: AttachmentOwnerType;
  ownerId: string;
}

/** Минимум вложения, нужный индексу показанных вложений. */
export interface ShownAttachment {
  id: string;
  owner_type: AttachmentOwnerType;
  owner_id: string;
}

/** Индекс: id вложения → владелец, для вложений показанной сущности. */
let shownAttachments = new Map<string, AttachmentOwner>();

/**
 * Запоминает вложения, прочитанные для показанной сущности (вызывается
 * загрузкой списка вкладки и её счётчиком). Индекс заменяется целиком: события
 * обязаны сверяться с тем, что видно на экране сейчас.
 */
export function rememberShownAttachments(rows: readonly ShownAttachment[]): void {
  const next = new Map<string, AttachmentOwner>();
  for (const row of rows) {
    next.set(row.id, { ownerType: row.owner_type, ownerId: row.owner_id });
  }
  shownAttachments = next;
}

/** Владелец вложения по id; `null` — такого вложения в показанном списке нет. */
export function shownAttachmentOwner(attachmentId: string): AttachmentOwner | null {
  return shownAttachments.get(attachmentId) ?? null;
}

/** Убирает вложение из индекса (удалено или перенесено в другую сущность). */
export function forgetShownAttachment(attachmentId: string): void {
  shownAttachments.delete(attachmentId);
}

/** Совпадают ли владельцы вложения. */
export function sameAttachmentOwner(a: AttachmentOwner, b: AttachmentOwner): boolean {
  return a.ownerType === b.ownerType && a.ownerId === b.ownerId;
}

// ---------------------------------------------------------------------------
// События вложений: id и владелец из `data`
// ---------------------------------------------------------------------------

/** Изменения вложений, на которые реагирует открытый редактор. */
export type AttachmentEventType =
  | 'attachment.created'
  | 'attachment.updated'
  | 'attachment.deleted';

const ATTACHMENT_EVENT_TYPES: readonly string[] = [
  'attachment.created',
  'attachment.updated',
  'attachment.deleted',
];

/** Сужает имя realtime-события до {@link AttachmentEventType}. */
export function isAttachmentEventType(type: string): type is AttachmentEventType {
  return ATTACHMENT_EVENT_TYPES.includes(type);
}

/**
 * Что удалось вычитать об изменении вложения. `ownerId`/`ownerType` — `null`,
 * когда событие владельца не несёт (у `deleted` его нет вовсе, у `updated` он
 * есть только в `changes` при переносе).
 */
export interface AttachmentChangeFacts {
  /** id изменённого вложения (`created` — id созданного); `null` — data без id. */
  attachmentId: string | null;
  /** Владелец из события; `null` — событие владельца не несёт. */
  ownerId: string | null;
  /**
   * Тип владельца из события; `null` — в `changes` переноса пришёл только
   * `owner_id`, а `owner_type` не менялся (тогда он совпадает с типом цели —
   * сверяющий берёт показанный тип).
   */
  ownerType: AttachmentOwnerType | null;
}

const NEUTRAL_FACTS: AttachmentChangeFacts = {
  attachmentId: null,
  ownerId: null,
  ownerType: null,
};

/** Факты об изменении вложения из `data` realtime-события. */
export function attachmentChangeFacts(
  type: AttachmentEventType,
  data: unknown,
): AttachmentChangeFacts {
  const payload = asRecord(data);
  if (payload === null) return NEUTRAL_FACTS;

  if (type === 'attachment.created') {
    // `created` несёт полный снимок вложения — владелец известен точно.
    const attachment = asRecord(payload['attachment']);
    if (attachment === null) return NEUTRAL_FACTS;
    return {
      attachmentId: asString(attachment['id']),
      ownerId: asString(attachment['owner_id']),
      ownerType: asString(attachment['owner_type']) as AttachmentOwnerType | null,
    };
  }

  const attachmentId = asString(payload['id']);
  const changes = asRecord(payload['changes']);
  return {
    attachmentId,
    ownerId: asString(changes?.['owner_id']),
    ownerType: asString(changes?.['owner_type']) as AttachmentOwnerType | null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
