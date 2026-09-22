/**
 * Групповые операции над мыслями — единая доменная реализация
 * (ADR 8c93f03a, ADR 162d8e7a, требование 7f526da1, задача fffe76f2 —
 * веха 7 версии 0.8.2).
 *
 * `POST /thoughts/batch` (docs/03-server-api.md §6.6) и
 * `etn.thoughts.bulk_update` (docs/05-mcp-server.md) были двумя независимыми
 * реализациями одних и тех же операций; MCP-ветка `unlink_parents`/
 * `unlink_children` собирала для журнала фальшивый DTO с `type_id: null`
 * (ошибка e8959ae7), а `set_only_parents` вовсе не журналировала удаления.
 * Теперь изменение, real-time-эффекты и журнал активности формируются здесь
 * — из результата записи, а не из аргументов вызова; обе точки входа —
 * фасады, которые только разбирают вход и исполняют {@link applyBulkThoughtOp}
 * через обёртку записи {@link runWrite} (веха 9: сам сервис ничего не
 * публикует и не журналирует — он возвращает {@link WriteOutcome}).
 *
 * Семантика канонична REST-спецификации §6.6: удаление связей учитывает
 * все видимые связи пары (любого типа, включая неактивные).
 *
 * Валидация входов (непустые `ids`, наличие `args.type_id` у `set_type`,
 * резолв имён типов) остаётся в фасадах — это веха 8.
 */

import { EtnError, type Link, type ThoughtBatchFailure } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import type { AnyWriteEvent, WriteActivityEntry, WriteOutcome } from './write-wrapper.js';
import { createLink, deleteLink, findLinksBetween, incomingLinksOf } from './link-service.js';
import { updateThought } from './thought-service.js';

/** Операции, общие для REST-батча и MCP-тула (подмножество `ThoughtBatchOp`). */
export const BULK_THOUGHT_OPS = [
  'set_type',
  'clear_type',
  'set_active',
  'set_inactive',
  'trash',
  'link_parents',
  'link_children',
  'set_only_parents',
  'unlink_parents',
  'unlink_children',
] as const;

/** Одна из общих групповых операций. */
export type BulkThoughtOp = (typeof BULK_THOUGHT_OPS)[number];

/** Нормализованные аргументы групповой операции (резолв имён — в фасадах). */
export interface BulkThoughtArgs {
  type_id?: string | null;
  parent_ids?: string[];
  child_ids?: string[];
  link_type_id?: string | null;
}

/** Итог групповой операции: счётчики + исход записи для обёртки. */
export type BulkThoughtWrite = WriteOutcome<{
  affected: number;
  failures: ThoughtBatchFailure[];
}>;

/** Изменения мысли в групповых операциях. */
type BulkThoughtChanges = {
  type_id?: string | null;
  active?: boolean;
  marked_for_deletion?: boolean;
};

/**
 * Применить одну групповую операцию ко всем `ids`.
 *
 * Ошибки отдельных мыслей собираются в `failures` (остальные обрабатываются,
 * 03-server-api.md §6.6): каждая запись открывает собственную транзакцию —
 * вложенную в savepoint обёрточной транзакции {@link runWrite}, поэтому
 * неудача отдельного id не откатывает остальные, а необработанный сбой
 * откатывает батч целиком.
 *
 * События и журнал активности собираются из результата записи (обновлённый
 * DTO мысли, реальный снимок созданной/удалённой связи) и исполняются
 * обёрткой после коммита — см. требования 7f526da1 и 3269a025.
 */
export function applyBulkThoughtOp(
  ndb: NetworkDb,
  userId: string,
  ids: readonly string[],
  op: BulkThoughtOp,
  args: BulkThoughtArgs,
): BulkThoughtWrite {
  const events: AnyWriteEvent[] = [];
  const activity: WriteActivityEntry[] = [];
  const failures: ThoughtBatchFailure[] = [];
  let affected = 0;

  /** Обновить мысль, занести эффект и строку журнала из результата. */
  const updateAndRecord = (
    id: string,
    changes: BulkThoughtChanges,
    action: 'updated' | 'trashed',
  ): void => {
    const updated = updateThought(ndb, id, changes, undefined, userId);
    events.push({ type: 'thought.updated', data: { id, changes, version: updated.version } });
    activity.push({ kind: 'thought', action, thought: updated });
  };

  /** Создать связь пары, занести эффект и строку журнала из результата. */
  const linkAndRecord = (sourceId: string, targetId: string): void => {
    if (sourceId === targetId) return; // self-loop — молча пропускается (§6.6)
    if (findLinksBetween(ndb, sourceId, targetId).length > 0) return; // идемпотентность по парам
    const link = createLink(
      ndb,
      { source_id: sourceId, target_id: targetId, type_id: args.link_type_id ?? null },
      userId,
    );
    events.push({ type: 'link.created', data: { link } });
    activity.push({ kind: 'link', action: 'created', link });
  };

  /** Удалить связь, занести эффект и строку журнала с её реальным снимком. */
  const deleteAndRecord = (link: Link): void => {
    deleteLink(ndb, link.id, undefined);
    events.push({ type: 'link.deleted', data: { id: link.id } });
    // `link` прочитан из представления ДО удаления и несёт настоящий
    // `type_id` — журнал отражает то, что записано (требование 7f526da1,
    // ошибка e8959ae7).
    activity.push({ kind: 'link', action: 'deleted', link });
  };

  for (const id of ids) {
    try {
      switch (op) {
        case 'set_type':
          updateAndRecord(id, { type_id: args.type_id ?? null }, 'updated');
          break;
        case 'clear_type':
          updateAndRecord(id, { type_id: null }, 'updated');
          break;
        case 'set_active':
          updateAndRecord(id, { active: true }, 'updated');
          break;
        case 'set_inactive':
          updateAndRecord(id, { active: false }, 'updated');
          break;
        case 'trash':
          updateAndRecord(id, { marked_for_deletion: true }, 'trashed');
          break;
        case 'link_parents':
          for (const parentId of args.parent_ids ?? []) {
            linkAndRecord(parentId, id);
          }
          break;
        case 'link_children':
          for (const childId of args.child_ids ?? []) {
            linkAndRecord(id, childId);
          }
          break;
        case 'set_only_parents': {
          const keepers = new Set(args.parent_ids ?? []);
          // Удалить все входящие связи, кроме связей с якорями (§6.6: любого
          // типа, включая неактивные — `incomingLinksOf` без фильтра active).
          for (const link of incomingLinksOf(ndb, id)) {
            if (keepers.has(link.source_id)) continue;
            deleteAndRecord(link);
          }
          // Досоздать недостающие связи с якорями.
          for (const parentId of args.parent_ids ?? []) {
            linkAndRecord(parentId, id);
          }
          break;
        }
        case 'unlink_parents':
          for (const parentId of args.parent_ids ?? []) {
            for (const link of findLinksBetween(ndb, parentId, id)) {
              deleteAndRecord(link);
            }
          }
          break;
        case 'unlink_children':
          for (const childId of args.child_ids ?? []) {
            for (const link of findLinksBetween(ndb, id, childId)) {
              deleteAndRecord(link);
            }
          }
          break;
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
