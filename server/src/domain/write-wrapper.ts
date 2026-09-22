/**
 * Обёртка записи домена (ADR 162d8e7a, задача 8b2efe2d, веха 9 версии 0.8.2).
 *
 * Единственный путь записи в `data.db` сети. Раньше «транзакция → событие →
 * журнал активности → аудит» оркестрировались вручную в каждом мутирующем
 * роуте и MCP-инструменте (~150 мест), и ручной шаг забывали: `purgeTrash`
 * удалял пачкой без транзакции (ошибка ac8a684b), `runWriteTool` в
 * `mcp/context.ts` транзакцию не открывал вовсе, а MCP-ветка
 * `unlink_parents`/`unlink_children` журналировала фальшивый DTO
 * (ошибка e8959ae7).
 *
 * {@link runWrite} открывает транзакцию, вызывает изменение и **после
 * успешного коммита** публикует real-time события, пишет журнал активности
 * и (опционально) аудит. Порядок «сначала коммит, потом событие» — свойство
 * обёртки, а не дисциплины вызывающего: событие о невыполненной записи уйти
 * не может, а сбой посреди изменения откатывает его целиком.
 *
 * Данные для журнала (и payload событий) обёртка берёт из **результата**
 * записи — `WriteOutcome` собирается внутри транзакции из значений, которые
 * вернули доменные функции, а не из аргументов вызова (требование
 * 7f526da1). Писать в БД в обход обёртки запрещено (ADR 162d8e7a).
 *
 * Транспорт (`emit`/`audit`) обёртка получает из фасада: домен не зависит
 * от REST и MCP, каждый фасад поставляет свой `WriteFx`.
 */

import type {
  ActivityAction,
  Comment,
  Layer,
  Link,
  LinkType,
  NetworkProperty,
  RealtimeAudience,
  RealtimeEventMap,
  RealtimeEventType,
  Thought,
  ThoughtType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  recordAttachmentActivity,
  recordCommentActivity,
  recordLayerActivity,
  recordLinkActivity,
  recordLinkTypeActivity,
  recordOwnerActivity,
  recordPropertyActivity,
  recordThoughtActivity,
  recordThoughtTypeActivity,
  recordTypePropertyActivity,
} from './activity-service.js';

/**
 * Опции публикации одного события (mirror {@link EmitDomainEventOptions}):
 * аудитория доставки и/или слой, которому событие приписывается. Фасад
 * применяет их своим транспортом.
 */
export interface WriteEventOptions {
  audience?: RealtimeAudience;
  layerId?: string;
}

/** Одно real-time событие, публикуемое после коммита. */
export type AnyWriteEvent = {
  [E in RealtimeEventType]: {
    type: E;
    data: RealtimeEventMap[E];
    options?: WriteEventOptions;
  };
}[RealtimeEventType];

/**
 * Одна запись журнала активности — из результата записи. Различается
 * вариантом по типу сущности; снимок/заголовок строки строит
 * `activity-service` (те же `record*Activity`-обёртки, что раньше вызывали
 * фасады напрямую).
 */
export type WriteActivityEntry =
  | { kind: 'thought'; action: ActivityAction; thought: Pick<Thought, 'id' | 'title' | 'type_id'> }
  | {
      kind: 'link';
      action: ActivityAction;
      link: Pick<Link, 'id' | 'source_id' | 'target_id' | 'type_id'>;
    }
  | {
      kind: 'comment';
      action: ActivityAction;
      comment: Pick<Comment, 'id' | 'owner_type' | 'body_md'>;
    }
  | {
      kind: 'attachment';
      action: ActivityAction;
      attachment: {
        id: string;
        title?: string | null;
        url?: string | null;
        file_path?: string | null;
      };
    }
  | { kind: 'thought-type'; action: ActivityAction; type: Pick<ThoughtType, 'id' | 'name'> }
  | { kind: 'link-type'; action: ActivityAction; type: Pick<LinkType, 'id' | 'name_forward'> }
  | { kind: 'property'; action: ActivityAction; property: Pick<NetworkProperty, 'id' | 'name'> }
  | { kind: 'type-property'; action: ActivityAction; typeId: string; typeName: string }
  | {
      kind: 'owner';
      entityType: 'thought' | 'link';
      entity:
        | Pick<Thought, 'id' | 'title' | 'type_id'>
        | Pick<Link, 'id' | 'source_id' | 'target_id' | 'type_id'>
        | { id: string };
    }
  | { kind: 'layer'; action: ActivityAction; layer: Pick<Layer, 'id' | 'title'> };

/** Запись аудита — форма определяется фасадом (для MCP — одна строка на вызов). */
export interface WriteAuditEntry {
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
}

/** Итог записи: результат + события + журнал + аудит. */
export interface WriteOutcome<T> {
  result: T;
  events?: readonly AnyWriteEvent[];
  activity?: readonly WriteActivityEntry[];
  audit?: WriteAuditEntry;
}

/** Эмиттер реального времени фасада. */
export type WriteEmit = <E extends RealtimeEventType>(
  type: E,
  data: RealtimeEventMap[E],
  options?: WriteEventOptions,
) => void;

/**
 * Транспорт и контекст записи, поставляемые фасадом (REST или MCP):
 * сеть, актор, слой сессии, эмиттер событий и (опционально) запись аудита.
 */
export interface WriteFx {
  networkId: string;
  userId: string;
  layerId: string | null;
  emit: WriteEmit;
  audit?: (entry: WriteAuditEntry) => void;
}

/**
 * Действие журнала для update-события: только пометка на удаление имеет
 * выделенные действия `trashed`/`restored`, прочие правки — `updated`
 * (требование b0c7a57c — так же писали REST-роуты и MCP-диспетчер).
 */
export function actionOfChanges(
  changes: { marked_for_deletion?: boolean } | undefined,
): 'trashed' | 'restored' | 'updated' {
  if (changes?.marked_for_deletion === true) return 'trashed';
  if (changes?.marked_for_deletion === false) return 'restored';
  return 'updated';
}

/** Применить одну запись журнала — диспетчеризация по варианту. */
function applyActivityEntry(
  ndb: NetworkDb,
  fx: WriteFx,
  entry: WriteActivityEntry,
  occurredAtMs: number,
): void {
  const base = {
    networkId: fx.networkId,
    userId: fx.userId,
    layerId: fx.layerId,
    occurredAtMs,
  };
  switch (entry.kind) {
    case 'thought':
      recordThoughtActivity(ndb, { ...base, action: entry.action, thought: entry.thought });
      return;
    case 'link':
      recordLinkActivity(ndb, { ...base, action: entry.action, link: entry.link });
      return;
    case 'comment':
      recordCommentActivity(ndb, { ...base, action: entry.action, comment: entry.comment });
      return;
    case 'attachment':
      recordAttachmentActivity(ndb, {
        ...base,
        action: entry.action,
        attachment: entry.attachment,
      });
      return;
    case 'thought-type':
      recordThoughtTypeActivity(ndb, { ...base, action: entry.action, type: entry.type });
      return;
    case 'link-type':
      recordLinkTypeActivity(ndb, { ...base, action: entry.action, type: entry.type });
      return;
    case 'property':
      recordPropertyActivity(ndb, { ...base, action: entry.action, property: entry.property });
      return;
    case 'type-property':
      recordTypePropertyActivity(ndb, {
        ...base,
        action: entry.action,
        typeId: entry.typeId,
        typeName: entry.typeName,
      });
      return;
    case 'owner':
      recordOwnerActivity(ndb, { ...base, entityType: entry.entityType, entity: entry.entity });
      return;
    case 'layer':
      recordLayerActivity(ndb, { ...base, action: entry.action, layer: entry.layer });
      return;
  }
}

/**
 * Единая обёртка записи домена: «транзакция → событие → журнал → аудит».
 *
 * 1. `fn` исполняется внутри `ndb.transaction` — вложенные транзакции
 *    доменных функций складываются в savepoints; исключение откатывает
 *    изменение целиком, и никакое событие/журнал/аудит не исполняется.
 * 2. После коммита публикуются события `outcome.events` (в порядке списка),
 *    затем пишутся строки `outcome.activity` и (при наличии) `outcome.audit`.
 * 3. Возвращается `outcome.result`.
 *
 * Сбой записи журнала/аудита не отменяет бизнес-операцию — `recordActivity`
 * и `recordAudit` поглощают ошибки сами (требование b0c7a57c, 05 §6.1).
 */
export function runWrite<T>(ndb: NetworkDb, fx: WriteFx, fn: () => WriteOutcome<T>): T {
  let outcome!: WriteOutcome<T>;
  ndb.transaction(() => {
    outcome = fn();
  });
  for (const ev of outcome.events ?? []) {
    // `ev` — объединение пар (type, data); в цикле корреляция пары
    // теряется. `RealtimeEventMap[RealtimeEventType]` — объединение всех
    // payload-типов, поэтому приведение безопасно: фасад получает ровно
    // ту же пару, которую вернула запись.
    fx.emit(ev.type, ev.data as RealtimeEventMap[RealtimeEventType], ev.options);
  }
  const activityEntries = outcome.activity ?? [];
  if (activityEntries.length > 0) {
    // Строки журнала получают монотонно возрастающие метки времени от одной
    // базы: порядок исхода в ленте детерминирован, а не зависит от
    // случайного UUID при равенстве миллисекунд (`ORDER BY occurred_at_ms,
    // id` в listActivity).
    const baseMs = Date.now();
    for (let i = 0; i < activityEntries.length; i += 1) {
      applyActivityEntry(ndb, fx, activityEntries[i]!, baseMs + i);
    }
  }
  if (outcome.audit !== undefined && fx.audit !== undefined) {
    fx.audit(outcome.audit);
  }
  return outcome.result;
}
