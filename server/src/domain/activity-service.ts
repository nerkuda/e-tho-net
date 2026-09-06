/**
 * Activity-log domain service (задача f2eca5a4 «Журнал activity_log: запись,
 * миграция, REST /activity», требование b0c7a57c «activity_log — состав записи»,
 * операция 70dfe81d «/activity — лента, свёртка и обрезка»,
 * docs/03-server-api.md §13d).
 *
 * Долговременная история операций изменения сущностей сети. Таблица
 * `activity_log` (миграция 035) не ветвится — пишется в одну глобальную
 * «здесь и сейчас» запись на сеть, как и `object_locks` (миграция 034);
 * фиксация в слое остаётся только как снимок `layer_id`.
 *
 * Два публичных примитива:
 *   * {@link recordActivity} — добавить строку в журнал. Вызывается роутами
 *     и MCP-инструментами сразу после успешной мутации, параллельно с
 *     `emitDomainEvent`. Сбой записи **не отменяет** бизнес-операцию
 *     (требование b0c7a57c): ошибки логируются и поглощаются;
 *   * {@link listActivity} — прочитать ленту с фильтрами и пагинацией
 *     (стандартный envelope `{ data, meta: { total, offset, limit } }`).
 *
 * Захваты (`edit.*`), per-user real-time (`audience=user`) и операции чтения
 * в журнал не пишутся — требование b0c7a57c и граница b0c7a57c.
 */

import { randomUUID } from 'node:crypto';

import {
  ACTIVITY_TITLE_MAX,
  type ActivityAction,
  type ActivityEntityType,
  type ActivityListParams,
  type ActivityRow,
  type Comment,
  type Layer,
  type Link,
  type LinkType,
  type NetworkProperty,
  type Thought,
  type ThoughtType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { logger } from '../logger.js';
import {
  snapshotAttachment,
  snapshotComment,
  snapshotLayer,
  snapshotLink,
  snapshotLinkType,
  snapshotProperty,
  snapshotThought,
  snapshotThoughtType,
  truncateTitle,
} from './activity-snapshot.js';

/** Жёсткий потолок `limit` — общий с другими list-эндпоинтами (03-server-api.md §2). */
export const ACTIVITY_LIMIT_MAX = 200;
export const ACTIVITY_LIMIT_DEFAULT = 50;

/**
 * Параметры одной записи журнала. Все поля обязательны; пустой `layerId`
 * маркирует операции вне слоя (например, создание самой сети до S10).
 */
export interface RecordActivityInput {
  networkId: string;
  userId: string;
  action: ActivityAction | string;
  entityType: ActivityEntityType | string;
  entityId: string;
  /** Уже сформированный и обрезанный до {@link ACTIVITY_TITLE_MAX} снимок. */
  entityTitle: string;
  /** Снимок слоя на момент операции; `null` для базовой записи. */
  layerId: string | null;
}

/** Физическая строка `activity_log`. */
interface ActivityDbRow {
  id: string;
  network_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_title: string;
  layer_id: string | null;
  occurred_at_ms: number;
}

/** Преобразование физической строки в wire DTO. */
function toActivityRow(row: ActivityDbRow): ActivityRow {
  return {
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_title: row.entity_title,
    layer_id: row.layer_id,
    occurred_at_ms: row.occurred_at_ms,
  };
}

/**
 * Записать строку в `activity_log`. Не бросает: сбой записи в журнал
 * не должен отменять бизнес-операцию (требование b0c7a57c). Ошибка
 * пишется в общий лог и проглатывается.
 *
 * Запись идёт отдельной транзакцией от мутации — намеренно: журнал
 * вспомогательный, консистентность с `data.db` не требуется.
 */
export function recordActivity(
  ndb: NetworkDb,
  input: RecordActivityInput,
): void {
  const id = randomUUID();
  const occurredAtMs = Date.now();
  try {
    ndb.prepare(
      `INSERT INTO activity_log
         (id, network_id, user_id, action, entity_type, entity_id,
          entity_title, layer_id, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.networkId,
      input.userId,
      input.action,
      input.entityType,
      input.entityId,
      truncateTitle(input.entityTitle),
      input.layerId,
      occurredAtMs,
    );
  } catch (err) {
    logger.error(
      { err, network_id: input.networkId, action: input.action, entity_type: input.entityType, entity_id: input.entityId },
      'activity_log insert failed; бизнес-операция продолжается',
    );
  }
}

/** Нормализовать `limit`/`offset` для list-эндпоинта ленты. */
export function normalizeActivityPagination(params: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } {
  const limit = Math.min(
    ACTIVITY_LIMIT_MAX,
    Math.max(1, params.limit ?? ACTIVITY_LIMIT_DEFAULT),
  );
  const offset = Math.max(0, params.offset ?? 0);
  return { limit, offset };
}

/** Результат list-эндпоинта ленты: данные + общее число подходящих строк. */
export interface ActivityListResult {
  data: ActivityRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Прочитать ленту журнала активности с фильтрами и пагинацией
 * (REST `GET /activity`, MCP `etn.activity.list`).
 *
 * Фильтры комбинируются по AND; сортировка — `occurred_at_ms DESC` (как и
 * обещает операция 70dfe81d).
 */
export function listActivity(
  ndb: NetworkDb,
  params: ActivityListParams,
): ActivityListResult {
  const { limit, offset } = normalizeActivityPagination(params);
  const where: string[] = ['network_id = ?'];
  const args: unknown[] = [params.networkId];

  if (params.from_ms !== undefined) {
    where.push('occurred_at_ms >= ?');
    args.push(params.from_ms);
  }
  if (params.to_ms !== undefined) {
    where.push('occurred_at_ms <= ?');
    args.push(params.to_ms);
  }
  if (params.user_id !== undefined && params.user_id !== null && params.user_id !== '') {
    where.push('user_id = ?');
    args.push(params.user_id);
  }
  if (params.entity_type !== undefined && params.entity_type !== null && params.entity_type !== '') {
    where.push('entity_type = ?');
    args.push(params.entity_type);
  }
  if (params.entity_id !== undefined && params.entity_id !== null && params.entity_id !== '') {
    where.push('entity_id = ?');
    args.push(params.entity_id);
  }

  const whereClause = where.join(' AND ');

  const total = (
    ndb.prepare(`SELECT COUNT(*) AS c FROM activity_log WHERE ${whereClause}`).get(...args) as {
      c: number;
    }
  ).c;

  const page = ndb
    .prepare(
      `SELECT id, network_id, user_id, action, entity_type, entity_id,
              entity_title, layer_id, occurred_at_ms
       FROM activity_log
       WHERE ${whereClause}
       ORDER BY occurred_at_ms DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as ActivityDbRow[];

  return {
    data: page.map(toActivityRow),
    total,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// Удобные обёртки «записал + сразу собрал снимок» для типичных сценариев.
// Они не пытаются быть универсальными — все нужные поля уже есть в DTO,
// которое вернул мутирующий сервис (роут получает его до `recordActivity`).
// ---------------------------------------------------------------------------

/** Записать событие по мысли: роут передаёт результат `createThought`/`getThought`. */
export function recordThoughtActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    thought: Pick<Thought, 'id' | 'title' | 'type_id'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'thought',
    entityId: params.thought.id,
    entityTitle: snapshotThought(params.thought),
    layerId: params.layerId,
  });
}

/** Записать событие по связи. */
export function recordLinkActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    link: Pick<Link, 'id' | 'source_id' | 'target_id' | 'type_id'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'link',
    entityId: params.link.id,
    entityTitle: snapshotLink(params.link),
    layerId: params.layerId,
  });
}

/** Записать событие по типу мысли. */
export function recordThoughtTypeActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    type: Pick<ThoughtType, 'id' | 'name'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'thought_type',
    entityId: params.type.id,
    entityTitle: snapshotThoughtType(params.type),
    layerId: params.layerId,
  });
}

/** Записать событие по типу связи. */
export function recordLinkTypeActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    type: Pick<LinkType, 'id' | 'name_forward'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'link_type',
    entityId: params.type.id,
    entityTitle: snapshotLinkType(params.type),
    layerId: params.layerId,
  });
}

/** Записать событие по свойству реестра сети. */
export function recordPropertyActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    property: Pick<NetworkProperty, 'id' | 'name'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'property',
    entityId: params.property.id,
    entityTitle: snapshotProperty(params.property),
    layerId: params.layerId,
  });
}

/**
 * Записать событие по типу, когда меняется привязка свойства к типу
 * (создание/правка/удаление `type_property`). Сама привязка не выделена в
 * отдельный `entity_type` — пишем как обновление самого типа (требование
 * b0c7a57c). Имя берётся из переданной строки, чтобы не тянуть сюда типы
 * `ThoughtType`/`LinkType` с разным набором полей.
 */
export function recordTypePropertyActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    typeId: string;
    typeName: string;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'thought_type',
    entityId: params.typeId,
    entityTitle: `тип мысли «${params.typeName}»`,
    layerId: params.layerId,
  });
}

/** Записать событие по комментарию. */
export function recordCommentActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    comment: Pick<Comment, 'id' | 'owner_type' | 'body_md'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'comment',
    entityId: params.comment.id,
    entityTitle: snapshotComment(params.comment),
    layerId: params.layerId,
  });
}

/** Записать событие по вложению. */
export function recordAttachmentActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    attachment: {
      id: string;
      title?: string | null;
      url?: string | null;
      file_path?: string | null;
    };
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'attachment',
    entityId: params.attachment.id,
    entityTitle: snapshotAttachment(params.attachment),
    layerId: params.layerId,
  });
}

/** Записать событие по слою. */
export function recordLayerActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    action: ActivityAction;
    layer: Pick<Layer, 'id' | 'title'>;
    layerId: string | null;
  },
): void {
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: params.action,
    entityType: 'layer',
    entityId: params.layer.id,
    entityTitle: snapshotLayer(params.layer),
    layerId: params.layerId,
  });
}

/**
 * Записать обновление сущности-владельца, у которой поменялось значение
 * свойства. Используется в `setPropertyValue`/`setPropertyValues`/
 * `deletePropertyValue` — пишем одну строку про владельца, без отдельной
 * записи про само значение (требование b0c7a57c).
 */
export function recordOwnerActivity(
  ndb: NetworkDb,
  params: {
    networkId: string;
    userId: string;
    entityType: ActivityEntityType;
    entity: Pick<Thought, 'id' | 'title' | 'type_id'> | Pick<Link, 'id' | 'source_id' | 'target_id' | 'type_id'> | { id: string };
    layerId: string | null;
  },
): void {
  let title: string;
  if ('title' in params.entity) {
    title = snapshotThought(params.entity as Pick<Thought, 'title' | 'type_id'>);
  } else if ('source_id' in params.entity) {
    title = snapshotLink(params.entity as Pick<Link, 'source_id' | 'target_id' | 'type_id'>);
  } else {
    title = params.entity.id;
  }
  recordActivity(ndb, {
    networkId: params.networkId,
    userId: params.userId,
    action: 'updated',
    entityType: params.entityType,
    entityId: params.entity.id,
    entityTitle: title,
    layerId: params.layerId,
  });
}
