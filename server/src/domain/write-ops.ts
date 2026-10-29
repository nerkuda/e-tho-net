/**
 * Операции записи, переведённые в write-пул (задача c8920d04, ADR ca3a9218,
 * тех.проект 0df7ccd6).
 *
 * Модуль — «половина воркера» и общий исход записи: композиция результата
 * (что именно изменилось) и раскладка его по двум транспортам WriteFx:
 *
 *   * журнал активности (`data.db` сети) — пишет ядро обёртки
 *     {@link runWriteCore} после коммита, в соединении того, кто исполнял
 *     транзакцию (в воркере — его собственное соединение);
 *   * публикация real-time событий и строка аудита (`_system.db`) — половина
 *     ГЛАВНОГО потока (ADR 162d8e7a, ADR ca3a9218): событие уходит строго после
 *     коммита. Поэтому {@link composeThoughtsWrite} возвращает события наружу
 *     плоским списком, а не публикует их; выбор «пул или главный поток» и
 *     фан-аут делает фасад — {@link import('./heavy-write.js').runThoughtsWrite}.
 *     Модуль намеренно НЕ знает про пул: его импортирует и воркер (исполнитель),
 *     и фасад (диспетчер).
 *
 * **Этапность.** Переведены: батч-запись мыслей (`etn.thoughts.write`,
 * {@link composeThoughtsWrite}), единичное создание REST-пути `POST /thoughts`
 * ({@link composeThoughtCreate}, задача c744e05c) и батчевые REST-пути —
 * {@link composeThoughtBatch} (`POST /thoughts/batch`) и
 * {@link composeThoughtCopyOutcome} (`POST /thoughts/copy-batch`, задача
 * b9c70dd8). Непереведённые пути записи (единичные мутации REST/MCP) идут как
 * раньше — синхронно через `runWrite`. Кросс-сетевой резолв
 * `cross_network_ref` воркер не умеет (он открывает чужую сеть и потому
 * применяет миграции) — такие батчи записи мыслей остаются синхронными
 * (`poolable: false`), см. {@link thoughtsBatchNeedsMainThread}.
 */

import {
  EtnError,
  isCrossNetworkAddress,
  type McpThoughtWriteParams,
  type Thought,
  type ThoughtBatchFailure,
  type ThoughtBatchResult,
  type ThoughtCopyResult,
  type ThoughtCreateInput,
} from '@etn/shared';

import type {
  WriteThoughtBatchPayload,
  WriteThoughtCopyPayload,
  WriteThoughtPayload,
  WriteThoughtsPayload,
} from '../contracts.js';
import type { NetworkDb } from '../db/network-db.js';
import {
  type AttachmentFileCopy,
  type AttachmentFileCopier,
  getAttachment,
} from './attachment-service.js';
import { getComment, listComments } from './comment-service.js';
import type { CrossNetworkAccessContext } from './cross-network-ref-service.js';
import { createLink, deleteLink, findLinksBetween, getLink } from './link-service.js';
import {
  applyBulkThoughtOp,
  BULK_THOUGHT_OPS,
  type BulkThoughtOp,
} from './thought-bulk-service.js';
import { copyThoughtsBatch, makeCopyFileCopier } from './thought-copy-service.js';
import { createThought, deleteThought, getThought, getThoughtOrThrow } from './thought-service.js';
import { writeThoughts, type ThoughtWriteResult } from './thought-write-service.js';
import {
  runWriteCore,
  type AnyWriteEvent,
  type WriteActivityEntry,
  type WriteOutcome,
} from './write-wrapper.js';

/** Контракт задачи write-пула. */
export type {
  WriteTask,
  WriteTaskContext,
  WriteThoughtBatchPayload,
  WriteThoughtCopyPayload,
  WriteThoughtPayload,
  WriteThoughtsPayload,
} from '../contracts.js';

/**
 * Исход задачи `write.thoughts`, который возвращает write-воркер: результат
 * записи и события, собранные ВНУТРИ транзакции. События пересекают границу
 * потока только вместе с успешным ответом, поэтому «событие раньше коммита»
 * невозможно; публикует их главный поток — фасад
 * ({@link import('./heavy-write.js').runThoughtsWrite}).
 */
export interface ThoughtsWriteOutcome {
  result: ThoughtWriteResult;
  events: readonly AnyWriteEvent[];
}

/**
 * Исход задачи `write.thought` (единичное создание мысли REST-путём) — зеркало
 * {@link ThoughtsWriteOutcome}: результат записи и события, собранные ВНУТРИ
 * транзакции. Публикует их главный поток по факту ответа воркера.
 */
export interface ThoughtCreateOutcome {
  result: Thought;
  events: readonly AnyWriteEvent[];
}

/**
 * Композиция единичного создания мысли — ровно то, что делал REST-роут
 * `POST /thoughts` до переноса (задача c744e05c). Порядок событий и записей
 * журнала сохранён дословно, чтобы ответ и real-time-эффекты не изменились:
 *
 *   1. `thought.created` на созданную мысль (+ строка журнала);
 *   2. `comment.created`, ЕСЛИ в теле запроса был явный `comment` (шаблон типа
 *      `comment_template_md` исторически события не порождал — поведение
 *      сохранено);
 *   3. `link.created` на рёбра link-дефолтов типа (ошибка 8655842b) и на связь
 *      `create_link`.
 *
 * Всё исполняется в одной транзакции вызывающего (`runWriteCore`): сбой связи
 * `create_link` откатывает и мысль, и её постоянный комментарий.
 */
export function composeThoughtCreate(
  ndb: NetworkDb,
  payload: WriteThoughtPayload,
): WriteOutcome<Thought> {
  const input: ThoughtCreateInput = payload.input;
  // Рёбра link-дефолтов типа при создании мысли — в события (ошибка 8655842b):
  // иначе они появлялись без `link.created`.
  const defaultLinkIds: string[] = [];
  const created = createThought(ndb, input, payload.actorUserId, defaultLinkIds);
  const events: AnyWriteEvent[] = [{ type: 'thought.created', data: { thought: created } }];
  const activity: WriteActivityEntry[] = [
    { kind: 'thought', action: 'created', thought: created },
  ];
  // Постоянный комментарий из тела запроса (0.12.1, задача aa79c82d): создан
  // доменом в этой же транзакции — публикуем событие и запись журнала, как это
  // делает REST-роут комментариев. Без этого подписчики не увидели бы
  // комментарий в реальном времени (ср. ошибка 8655842b для link-дефолтов).
  if (input.comment !== undefined) {
    const createdComment = listComments(ndb, 'thought', created.id).find(
      (c) => c.kind === 'permanent',
    );
    if (createdComment !== undefined) {
      events.push({ type: 'comment.created', data: { comment: createdComment } });
      activity.push({ kind: 'comment', action: 'created', comment: createdComment });
    }
  }
  for (const linkId of defaultLinkIds) {
    const link = getLink(ndb, linkId);
    if (link !== null) {
      events.push({ type: 'link.created', data: { link } });
      activity.push({ kind: 'link', action: 'created', link });
    }
  }
  if (input.create_link) {
    // Mirrors createLinkForNewThought's source/target calc (thought-service.ts):
    // parent: target sources a link to the new thought; child: the new thought
    // sources a link to target.
    const link = findLinksBetween(
      ndb,
      input.create_link.direction === 'parent'
        ? input.create_link.target_thought_id
        : created.id,
      input.create_link.direction === 'parent'
        ? created.id
        : input.create_link.target_thought_id,
      input.create_link.type_id,
    )[0];
    if (link) {
      events.push({ type: 'link.created', data: { link } });
      activity.push({ kind: 'link', action: 'created', link });
    }
  }
  return { result: created, events, activity };
}

/**
 * Исход батч-записи мыслей: результат + события + журнал (аудит — фасада).
 * `events` собираются ВНУТРИ транзакции из результата записи, поэтому событие
 * о невыполненной записи уйти не может (требование 7f526da1); журнал пишет
 * ядро обёртки после коммита.
 */
export function composeThoughtsWrite(
  ndb: NetworkDb,
  payload: WriteThoughtsPayload,
  crossNetworkAccess?: CrossNetworkAccessContext,
): WriteOutcome<ThoughtWriteResult> {
  // Кросс-сетевой контекст (задача 7849008a, спека п.6): `properties` элемента
  // может нести адрес вида `cross_network_ref` — его запись делает живой резолв
  // цели в чужой сети, как в REST-роуте.
  const written = writeThoughts(
    ndb,
    payload.input,
    payload.actorUserId,
    crossNetworkAccess,
  );

  // Real-time events — one per actually-affected entity (per task spec); журнал
  // — из результата записи. Собираем исход здесь, исполняет обёртка после
  // коммита.
  const events: AnyWriteEvent[] = [];
  const activity: WriteActivityEntry[] = [];
  for (const item of written.items) {
    // `reused` пропускает ТОЛЬКО событие самой мысли: вложенные блоки
    // (`comment`/`chronicle`/`links`/`properties`/`attachments`) записаны и
    // обязаны дать события и журнал (ошибка d3da79e0).
    if (item.thought_action !== 'reused') {
      if (item.thought_action === 'created') {
        const thought = getThoughtOrThrow(ndb, item.id);
        events.push({ type: 'thought.created', data: { thought } });
        activity.push({ kind: 'thought', action: 'created', thought });
      } else {
        // 'updated' — also covers the 'set_active' scenario: a batch item that
        // only sets `active: false` (HOME is rejected, see domain service) lands
        // here as a normal `thought.updated`. Empty `changes` is the contract for
        // batched updates: the granular changes live across
        // `comment`/`chronicle`/`properties`/`links`/`attachments` blocks of the
        // same item, and the audit_log row carries the full story.
        events.push({
          type: 'thought.updated',
          data: { id: item.id, version: item.version, changes: {} },
        });
        const thought = getThoughtOrThrow(ndb, item.id);
        activity.push({ kind: 'thought', action: 'updated', thought });
      }
    }
    if (item.comment !== undefined) {
      if (item.comment.action === 'created') {
        const c = getComment(ndb, item.comment.id);
        if (c !== null) {
          events.push({ type: 'comment.created', data: { comment: c } });
          activity.push({ kind: 'comment', action: 'created', comment: c });
        }
      } else {
        // Строка комментария после записи батча существует; событие и
        // активность эмитим только по ней (иначе `kind`/`owner_id`
        // неизвестны). `kind` нужен подписчикам документа публикации.
        const c = getComment(ndb, item.comment.id);
        if (c !== null) {
          events.push({
            type: 'comment.updated',
            data: {
              id: c.id,
              owner_id: c.owner_id,
              owner_type: c.owner_type,
              kind: c.kind,
              version: item.comment.version,
              changes: { body_md: '' },
            },
          });
          activity.push({ kind: 'comment', action: 'updated', comment: c });
        }
      }
    }
    if (item.chronicle !== undefined) {
      for (const entry of item.chronicle) {
        const c = getComment(ndb, entry.id);
        if (c !== null) {
          events.push({ type: 'comment.created', data: { comment: c } });
          activity.push({ kind: 'comment', action: 'created', comment: c });
        }
      }
    }
    if (item.links !== undefined) {
      for (const link of item.links) {
        const l = getLink(ndb, link.id);
        if (l !== null) {
          events.push({ type: 'link.created', data: { link: l } });
          activity.push({ kind: 'link', action: 'created', link: l });
        }
      }
    }
    // Рёбра, созданные set-записью свойства-связи в `properties`, — публикуем
    // `link.created` так же, как для `links[]` и `etn.properties.add` (ошибка
    // 1b719d76): без этого подписчики и журнал `changes.list` не видели новых
    // рёбер.
    if (item.properties !== undefined) {
      for (const pv of Object.values(item.properties)) {
        if (pv.link_ids === undefined) continue;
        for (const linkId of pv.link_ids) {
          const l = getLink(ndb, linkId);
          if (l !== null) {
            events.push({ type: 'link.created', data: { link: l } });
            activity.push({ kind: 'link', action: 'created', link: l });
          }
        }
      }
    }
    if (item.attachments !== undefined) {
      for (const att of item.attachments) {
        const a = getAttachment(ndb, att.id);
        if (a !== null) {
          events.push({ type: 'attachment.created', data: { attachment: a } });
          activity.push({ kind: 'attachment', action: 'created', attachment: a });
        }
      }
    }
    // Рёбра, материализованные link-дефолтами типа при создании мысли, —
    // публикуем `link.created` так же, как для `links[]` и set-записи свойств
    // (ошибка 8655842b): без этого подписчики и журнал `changes.list` не видели
    // новых рёбер.
    if (item.default_link_ids !== undefined) {
      for (const linkId of item.default_link_ids) {
        const l = getLink(ndb, linkId);
        if (l !== null) {
          events.push({ type: 'link.created', data: { link: l } });
          activity.push({ kind: 'link', action: 'created', link: l });
        }
      }
    }
  }

  // Умное удаление целей свойств-связей set-записью (0.14.1, задача 58b598d5):
  // физическое удаление — `link.deleted`, пометка корзины — `link.updated`.
  // Уже помеченное ребро в список не попадает (no-op без события).
  for (const removal of written.link_removals ?? []) {
    if (removal.action === 'deleted') {
      events.push({ type: 'link.deleted', data: { id: removal.link_id } });
      activity.push({ kind: 'link', action: 'deleted', link: removal.link });
      continue;
    }
    const link = getLink(ndb, removal.link_id);
    if (link !== null) {
      events.push({
        type: 'link.updated',
        data: {
          id: link.id,
          changes: { marked_for_deletion: true },
          version: link.version,
        },
      });
      activity.push({ kind: 'link', action: 'trashed', link });
    }
  }

  return { result: written, events, activity };
}

/**
 * Исход задачи `write.thought.batch` (батчевая операция `POST /thoughts/batch`,
 * задача b9c70dd8) — зеркало {@link ThoughtsWriteOutcome}: результат записи и
 * события, собранные ВНУТРИ транзакции. Публикует их главный поток по факту
 * ответа воркера (событие уходит строго после коммита).
 */
export interface ThoughtBatchOutcome {
  result: ThoughtBatchResult;
  events: readonly AnyWriteEvent[];
}

/**
 * Композиция батчевой операции — ровно то, что делал REST-роут
 * `POST /thoughts/batch` до переноса (задача b9c70dd8). Общие групповые операции
 * (`BULK_THOUGHT_OPS`) исполняет доменный сервис {@link applyBulkThoughtOp};
 * локальные (`delete`/`purge`/`link_to_focus`/`unlink_from_focus`) собраны здесь
 * дословно из прежнего роута: ошибки отдельных id копятся в `failures`, событие
 * и строка журнала — из результата записи (требование 7f526da1).
 *
 * Порядок и состав событий/журнала сохранён, чтобы ответ и real-time-эффекты не
 * изменились; всё исполняется в одной транзакции вызывающего (`runWriteCore`).
 */
export function composeThoughtBatch(
  ndb: NetworkDb,
  payload: WriteThoughtBatchPayload,
): WriteOutcome<ThoughtBatchResult> {
  if ((BULK_THOUGHT_OPS as readonly string[]).includes(payload.op)) {
    return applyBulkThoughtOp(
      ndb,
      payload.actorUserId,
      payload.ids,
      payload.op as BulkThoughtOp,
      payload.bulk ?? {},
    );
  }

  const failures: ThoughtBatchFailure[] = [];
  const events: AnyWriteEvent[] = [];
  const activity: WriteActivityEntry[] = [];
  let affected = 0;
  const focus = payload.focus;
  for (const id of payload.ids) {
    try {
      switch (payload.op) {
        case 'delete':
        case 'purge': {
          // S13: `delete` — алиас `purge`; оба физически удаляют с одной и той же
          // блокирующей проверкой (deleteThought отказывает при ссылке из свойства).
          // actorUserId — для object-lock enforcement (задача 2031df5e).
          const existing = getThought(ndb, id);
          deleteThought(ndb, id, undefined, payload.actorUserId);
          events.push({ type: 'thought.deleted', data: { id } });
          if (existing) {
            activity.push({ kind: 'thought', action: 'deleted', thought: existing });
          }
          break;
        }
        case 'link_to_focus': {
          const [sourceId, targetId] =
            focus!.direction === 'parent'
              ? [id, focus!.focus_thought_id]
              : [focus!.focus_thought_id, id];
          const link = createLink(
            ndb,
            { source_id: sourceId, target_id: targetId, type_id: focus!.link_type_id },
            payload.actorUserId,
          );
          events.push({ type: 'link.created', data: { link } });
          activity.push({ kind: 'link', action: 'created', link });
          break;
        }
        case 'unlink_from_focus': {
          const [sourceId, targetId] =
            focus!.direction === 'parent'
              ? [id, focus!.focus_thought_id]
              : [focus!.focus_thought_id, id];
          const found = findLinksBetween(ndb, sourceId, targetId, focus!.find_link_type_id);
          if (found.length === 0) {
            throw new EtnError('NOT_FOUND', `Нет связи между ${sourceId} и ${targetId}.`);
          }
          for (const link of found) {
            deleteLink(ndb, link.id, undefined);
            events.push({ type: 'link.deleted', data: { id: link.id } });
            activity.push({ kind: 'link', action: 'deleted', link });
          }
          break;
        }
      }
      affected += 1;
    } catch (err) {
      if (err instanceof EtnError) {
        failures.push({ id, code: err.code, message: err.message });
      } else {
        failures.push({ id, code: 'INTERNAL', message: 'internal error' });
      }
    }
  }
  return { result: { affected, failures }, events, activity };
}

/** Нефатальное замечание воркера, которое логирует главный поток (наблюдаемость). */
export interface AttachmentCopyWarning {
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Исход задачи `write.thought.copy` (`POST /thoughts/copy-batch`, задача
 * b9c70dd8): результат записи, события и ПЛАН физического копирования файлов.
 * Файлы пересекают границу потока плоским списком «источник → назначение»:
 * имена копий планирует воркер (они зависят от состояния каталога-получателя), а
 * физически копирует ГЛАВНЫЙ поток после коммита — тем же порядком, что события
 * и аудит (ADR ca3a9218). `warnings` — нефатальные замечания планировщика
 * (исходный файл не найден), их тоже логирует главный поток.
 */
export interface ThoughtCopyOutcome {
  result: ThoughtCopyResult;
  events: readonly AnyWriteEvent[];
  files: readonly AttachmentFileCopy[];
  warnings: readonly AttachmentCopyWarning[];
}

/**
 * Композиция пакетного копирования — ровно то, что делал REST-роут
 * `POST /thoughts/copy-batch` до переноса (задача b9c70dd8): доменный
 * {@link copyThoughtsBatch} + событие `thought.created`/`link.created` и строка
 * журнала на каждую созданную сущность. Планировщик копирования файлов
 * (`copier`) передаётся снаружи: воркер и синхронный путь строят его по одним и
 * тем же фактам ({@link composeThoughtCopyOutcome}).
 */
export function composeThoughtCopy(
  ndb: NetworkDb,
  payload: WriteThoughtCopyPayload,
  copier: AttachmentFileCopier | null,
): WriteOutcome<ThoughtCopyResult> {
  const copied = copyThoughtsBatch(ndb, payload.input, payload.actorUserId, { fileCopier: copier });
  const events: AnyWriteEvent[] = [];
  const activity: WriteActivityEntry[] = [];
  // Real-time: `thought.created` на каждую новую мысль и `link.created` на каждую
  // новую связь (включая link-дефолты типа) — клиенты обновляются без опроса.
  for (const thought of copied.created_thoughts) {
    events.push({ type: 'thought.created', data: { thought } });
    activity.push({ kind: 'thought', action: 'created', thought });
  }
  for (const link of copied.created_links) {
    events.push({ type: 'link.created', data: { link } });
    activity.push({ kind: 'link', action: 'created', link });
  }
  return { result: copied, events, activity };
}

/**
 * Исполнить задачу `write.thought.copy` целиком на СВОЁМ соединении: построить
 * планировщик копирования по плоским фактам, провести запись через ядро обёртки
 * (`runWriteCore` — транзакция + журнал) и вернуть исход с планом файлов.
 * Одна и та же функция обслуживает воркер и синхронный путь фасада (требование
 * 3d9d017f: результат не зависит от места исполнения).
 */
export function composeThoughtCopyOutcome(
  ndb: NetworkDb,
  payload: WriteThoughtCopyPayload,
): ThoughtCopyOutcome {
  const warnings: AttachmentCopyWarning[] = [];
  const copier = makeCopyFileCopier(
    ndb,
    payload.input,
    payload.sourceAttachmentsDir ?? undefined,
    (message, details) => warnings.push({ message, details }),
  );
  const outcome = runWriteCore(
    ndb,
    { networkId: ndb.networkId, userId: payload.actorUserId, layerId: ndb.layerId },
    () => composeThoughtCopy(ndb, payload, copier),
  );
  return {
    result: outcome.result,
    events: outcome.events ?? [],
    files: copier?.pendingCopies() ?? [],
    warnings,
  };
}

/**
 * Несёт ли батч кросс-сетевые адреса значений свойств (`n:<network>#<thought>`).
 *
 * Резолв чужой сети — это открытие её БД, а значит миграции; воркеру это
 * запрещено (ADR ca3a9218, «Кросс-сетевой резолв»). Поэтому батч с адресами
 * обязан остаться в главном потоке. Проверка намеренно ШИРОКАЯ (по форме
 * строки, а не по виду свойства): значение свойства `text`, случайно похожее на
 * адрес, тоже уведёт батч в синхронный путь — это безопасная сторона ошибки,
 * результат записи от места исполнения не зависит.
 */
export function thoughtsBatchNeedsMainThread(input: McpThoughtWriteParams): boolean {
  const scalarIsAddress = (value: unknown): boolean => {
    if (typeof value === 'string') return isCrossNetworkAddress(value);
    if (Array.isArray(value)) {
      return value.some((v) => typeof v === 'string' && isCrossNetworkAddress(v));
    }
    return false;
  };
  const valuesAreAddress = (properties: unknown): boolean => {
    if (properties === null || typeof properties !== 'object') return false;
    return Object.values(properties as Record<string, unknown>).some(scalarIsAddress);
  };
  for (const item of input.thoughts) {
    if (valuesAreAddress(item.properties)) return true;
    for (const link of item.links ?? []) {
      if (valuesAreAddress(link.properties)) return true;
    }
  }
  return false;
}
