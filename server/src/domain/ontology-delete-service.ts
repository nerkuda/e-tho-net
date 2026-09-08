/**
 * Single-entity delete service for `etn.ontology.delete` (задача cc9ca65e,
 * версия 0.7.2, docs/05-mcp-server.md §4.2b).
 *
 * Удаляет одну сущность онтологии с учётом правил:
 *
 *   * Без `force` — отвергается, если элемент используется; в `details`
 *     возвращаются счётчики (`thoughts_count` / `links_count` /
 *     `type_properties_count`).
 *   * С `force` — каскад:
 *     - `thought_type` → обнулить `type_id` у связанных мыслей, удалить
 *       `type_properties` этого типа;
 *     - `link_type` → удалить связи этого типа (со свойствами и
 *       комментариями), удалить `type_properties`;
 *     - `property` → удалить `property_values` и `type_properties` этого
 *       свойства;
 *     - `type_property` → удалить строку привязки.
 *   * Элемент, занятый в `type_roles` сети → `VALIDATION_ERROR` даже с
 *     `force`. Сначала снять роль через `etn.networks.write`.
 *
 * Дополнительная защита: HOME-мысль не имеет типа (её `type_id` всегда
 * NULL), поэтому `thought_type` delete не задевает её по построению. После
 * каскада повторно проверяем, что `type_id` HOME остался NULL.
 */

import {
  EtnError,
  type OntologyDeleteAffectedCounts,
  type OntologyDeleteKind,
  type OntologyDeleteParams,
  type OntologyDeleteResult,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getRootTypeId } from './type-hierarchy.js';
import { deleteTypeProperty } from './property-service.js';
import { deleteThoughtType } from './thought-type-service.js';
import { deleteLinkType } from './link-type-service.js';
import { deleteThoughtTypeView, listThoughtTypeViewsByType } from './thought-type-views-service.js';

export {
  EtnError,
  type OntologyDeleteAffectedCounts,
  type OntologyDeleteKind,
  type OntologyDeleteParams,
  type OntologyDeleteResult,
};

/** Type guard по `kind`. */
function isKind(value: unknown): value is OntologyDeleteKind {
  return (
    value === 'thought_type' ||
    value === 'link_type' ||
    value === 'property' ||
    value === 'type_property' ||
    value === 'type_view'
  );
}

/**
 * Счётчики использования для конкретной сущности — собираются ДО удаления
 * и возвращаются как `details` в `VALIDATION_ERROR` (без `force`).
 */
interface OntologyDeleteUsage {
  thoughts_count?: number;
  links_count?: number;
  type_properties_count?: number;
  property_values_count?: number;
  /** Для `thought_type` — число отборов типа (задача c1fa71d4, 0.7.3). */
  type_views_count?: number;
}

function buildUsageDetails(
  kind: OntologyDeleteKind,
  id: string,
  counts: OntologyDeleteUsage,
): Record<string, unknown> {
  const details: Record<string, unknown> = { entity: kind, id };
  for (const [k, v] of Object.entries(counts)) {
    if (v !== undefined) details[k] = v;
  }
  return details;
}

/**
 * Удалить одну сущность онтологии. Семантика соответствует REST-роутам:
 *   * DELETE /thought-types/:id (`thought-type-service.deleteThoughtType`)
 *   * DELETE /link-types/:id (`link-type-service.deleteLinkType`)
 *   * DELETE /properties/:id — каскад + привязки
 *   * DELETE …/types/:id/properties/:propertyId — отдельная привязка
 *
 * Дополнительно перед удалением проверяется занятость в `type_roles`
 * сети (если передан `networkRoles` — словарь `role → type_id`).
 */
export function deleteOntologyEntity(
  ndb: NetworkDb,
  params: OntologyDeleteParams,
  actorUserId: string,
  networkRoles: Record<string, string | null> = {},
): OntologyDeleteResult {
  if (!isKind(params.kind)) {
    throw new EtnError('VALIDATION_ERROR', `invalid kind: ${String(params.kind)}`, {
      field: 'kind',
      allowed: ['thought_type', 'link_type', 'property', 'type_property'] as const,
    });
  }
  const force = params.force === true;
  const usage = collectUsage(ndb, params.kind, params.id);

  // Защита ролевых типов — даже с force.
  if (params.kind === 'thought_type' || params.kind === 'link_type') {
    const role = (Object.entries(networkRoles) as Array<[string, string | null]>).find(
      ([, value]) => value === params.id,
    )?.[0];
    if (role !== undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `Тип используется сетью в роли «${role}»; сначала снимите роль через PATCH /networks/{id}.`,
        { entity: params.kind, id: params.id, role },
      );
    }
  }
  // Защита `type_view` (задача c1fa71d4): отбор не может быть занят в роли
  // сети (роли — это типы), отдельная проверка не нужна.
  void networkRoles;

  // Без force — отвергаем на любом использовании. `type_view` не имеет
  // использований (нет мыслей/связей/привязок, ссылающихся на отбор), так
  // что для него ветка force-блока тривиальна.
  if (!force) {
    const hasUsage =
      (usage.thoughts_count ?? 0) > 0 ||
      (usage.links_count ?? 0) > 0 ||
      (usage.type_properties_count ?? 0) > 0 ||
      (usage.property_values_count ?? 0) > 0;
    if (hasUsage) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `${params.kind} ${params.id} используется; передайте force=true для каскада.`,
        buildUsageDetails(params.kind, params.id, usage),
      );
    }
  }

  ndb.transaction(() => {
    switch (params.kind) {
      case 'thought_type': {
        deleteThoughtType(ndb, params.id, undefined, { force, actorUserId });
        // Каскад отборов типа (задача c1fa71d4). Делается всегда — отборы
        // не переживают удаление владеющего типа даже без `force` (тип-то
        // уже удалён/скрыт в слое), а в базе каскад обязателен.
        const viewIds = listThoughtTypeViewsByType(ndb, params.id).map((v) => v.id);
        for (const viewId of viewIds) {
          deleteThoughtTypeView(ndb, viewId);
        }
        usage.type_views_count = viewIds.length;
        break;
      }
      case 'link_type':
        deleteLinkType(ndb, params.id, undefined, { force, actorUserId });
        break;
      case 'property': {
        // Каскад property_values + type_properties.
        if (force) {
          ndb
            .prepare("DELETE FROM property_values WHERE property_id = ?")
            .run(params.id);
        }
        ndb.prepare("DELETE FROM type_properties WHERE property_id = ?").run(params.id);
        ndb.prepare("DELETE FROM properties WHERE id = ? AND layer_id = ?").run(
          params.id,
          ndb.layerId,
        );
        break;
      }
      case 'type_property': {
        deleteTypeProperty(ndb, params.id, actorUserId);
        break;
      }
      case 'type_view': {
        // `deleteThoughtTypeView` уже идемпотентен: возвращает `false`,
        // если строки нет. NOT_FOUND на стороне репозитория не бросаем —
        // здесь мы НЕ делаем pre-check через `getViewOrThrow`, чтобы
        // повторный delete не падал.
        deleteThoughtTypeView(ndb, params.id);
        break;
      }
    }
  });

  // Защита HOME: после каскада проверим, что у HOME-мысли `type_id`
  // остался NULL (теоретически и так, потому что HOME не имеет типа, но
  // дополнительная проверка — гарантия для спеки).
  if (params.kind === 'thought_type' && force) {
    const rootId = getRootTypeId(ndb, 'thought_types');
    if (rootId !== null) {
      const homeRow = ndb
        // layers:physical-read — нам нужен именно базовый HOME (один на сеть),
        // независимо от послойных теней.
        .prepare("SELECT id, type_id FROM thoughts WHERE is_root = 1 LIMIT 1") // layers:physical-read
        .get() as { id: string; type_id: string | null } | undefined;
      if (homeRow !== undefined && homeRow.type_id !== null && homeRow.type_id !== rootId) {
        // Должно быть невозможно (HOME имеет только `is_root = 1`, но
        // защита от regression).
        ndb
          .prepare('UPDATE thoughts SET type_id = NULL WHERE id = ?')
          .run(homeRow.id);
      }
    }
  }

  return {
    deleted: true,
    affected_counts: usage,
  };
}

/** Собрать счётчики использования для данного вида сущности. */
function collectUsage(
  ndb: NetworkDb,
  kind: OntologyDeleteKind,
  id: string,
): OntologyDeleteUsage {
  switch (kind) {
    case 'thought_type': {
      const thoughts = (
        ndb.prepare('SELECT COUNT(*) AS c FROM thoughts_v WHERE type_id = ?').get(id) as {
          c: number;
        }
      ).c;
      const typeViews = (
        ndb.prepare('SELECT COUNT(*) AS c FROM thought_type_views_v WHERE thought_type_id = ?').get(id) as {
          c: number;
        }
      ).c;
      return {
        thoughts_count: thoughts,
        type_properties_count: countTypeProperties(ndb, 'thought_type', id),
        type_views_count: typeViews,
      };
    }
    case 'link_type': {
      const links = (
        ndb.prepare('SELECT COUNT(*) AS c FROM links_v WHERE type_id = ?').get(id) as {
          c: number;
        }
      ).c;
      return { links_count: links, type_properties_count: countTypeProperties(ndb, 'link_type', id) };
    }
    case 'property': {
      const valuesCount = (
        ndb.prepare('SELECT COUNT(*) AS c FROM property_values_v WHERE property_id = ?').get(id) as {
          c: number;
        }
      ).c;
      const tpCount = (
        ndb.prepare('SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ?').get(id) as {
          c: number;
        }
      ).c;
      return { property_values_count: valuesCount, type_properties_count: tpCount };
    }
    case 'type_property': {
      return {};
    }
    case 'type_view': {
      // `type_view` сам по себе не имеет использований: нет мыслей, ссылок
      // или свойств, привязанных к отбору. Удаление идёмпотентно.
      return {};
    }
  }
}

function countTypeProperties(
  ndb: NetworkDb,
  ownerType: 'thought_type' | 'link_type',
  ownerId: string,
): number {
  return (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM type_properties_v WHERE owner_type = ? AND owner_id = ?')
      .get(ownerType, ownerId) as { c: number }
  ).c;
}
