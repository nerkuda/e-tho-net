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
 *     - `link_type` → рёбра типа **не удаляются**: у них обнуляется `type_id`,
 *       и они становятся структурными («Родители/Потомки»); удаляются
 *       привязки и парное свойство-связь. Число живых рёбер, потерявших тип,
 *       считается до удаления и отдаётся в
 *       `affected_counts.links_becoming_structural`;
 *     - `property` → удалить `property_values` и `type_properties` этого
 *       свойства; для свойства-связи — тем же путём, что REST
 *       `DELETE /properties/:id`: удаляется и парный тип связи, рёбра теряют
 *       `type_id` (число живых — `affected_counts.links_becoming_structural`,
 *       ошибка 937b4d81). В рабочем слое (ошибка 81184542) основа физически не
 *       трогается: видимые привязки и значения (при `force`) получают
 *       надгробия, строка реестра скрывается слоевым удалением;
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
import { deleteRowLayered, isBaseContext } from '../db/layer-write.js';
import { getRootTypeId } from './type-hierarchy.js';
import {
  countLinksBecomingStructural,
  deleteNetworkProperty,
  deleteTypeProperty,
  getLinkPropertyByLinkTypeId,
  getNetworkProperty,
} from './property-service.js';
import { deleteThoughtTypeWithViews } from './thought-type-delete-service.js';
import { deleteLinkType } from './link-type-service.js';
import { deleteThoughtTypeView } from './thought-type-views-service.js';

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
  /** Для `link_type` — число живых рёбер, теряющих `type_id` (ошибка
   *  3537f1c2): считается до удаления с фильтрами REST и отдаётся всегда,
   *  включая 0. Для `property` — то же число, если это свойство-связь:
   *  вместе с ним удаляется и парный тип связи (ошибка 937b4d81). */
  links_becoming_structural?: number;
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
        `The type is used by the network in the "${role}" role; remove the role via PATCH /networks/{id} first.`,
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
        `${params.kind} ${params.id} is in use; pass force=true for a cascade.`,
        buildUsageDetails(params.kind, params.id, usage),
      );
    }
  }

  ndb.transaction(() => {
    switch (params.kind) {
      case 'thought_type': {
        // Единая точка удаления типа (0.14.1, ошибка 1242f78d): каскад
        // отборов и снапшоты ДО удаления — общая с REST DELETE. Прежде каскад
        // жил только здесь и выполнялся ПОСЛЕ удаления типа, поэтому
        // `listThoughtTypeViewsByType` возвращал пусто, а события каскада не
        // эмитились. Отборы не переживают удаление владеющего типа даже без
        // `force` (тип-то уже удалён/скрыт в слое).
        const deleted = deleteThoughtTypeWithViews(ndb, params.id, undefined, {
          force,
          actorUserId,
        });
        usage.type_views_count = deleted.views.length;
        break;
      }
      case 'link_type': {
        // 0.8.1 / ошибка 117a999a: тип связи живёт в паре со своим
        // свойством-связью. Удаляем пару вместе с типом, но только если
        // свойство свободно: привязки к типам (кроме привязок самого типа,
        // которые снимает deleteLinkType) — отказ с подсказкой. Счётчика
        // `property_values` у пары нет: значения link-свойства живут
        // рёбрами, а не в таблице значений (их судьбу решает deleteLinkType).
        // Живые рёбра типа — существующая семантика deleteLinkType:
        // без `force` отказ, с `force` обнуление `type_id`.
        //
        // Ошибка 3537f1c2: рёбра не удаляются — они теряют `type_id` и
        // становятся структурными. Число таких рёбер считаем ДО удаления
        // (после `deleteLinkType` в `links_v` их уже не найти) и тем же
        // хелпером, что REST `DELETE /properties/:id`: фильтры REST — только
        // живые рёбра. Значение отдаём всегда, включая 0; `links_count` из
        // `collectUsage` считает шире (корзина и неактивные) и его не
        // подменяет.
        usage.links_becoming_structural = countLinksBecomingStructural(ndb, params.id);
        const pair = getLinkPropertyByLinkTypeId(ndb, params.id);
        if (pair !== null) {
          const foreignBindings = (
            ndb
              .prepare(
                `SELECT COUNT(*) AS c FROM type_properties_v
                  WHERE property_id = ?
                    AND NOT (owner_type = 'link_type' AND owner_id = ?)`,
              )
              .get(pair.id, params.id) as { c: number }
          ).c;
          if (foreignBindings > 0) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'the link type has a paired link property bound to types; unbind it or delete the property first',
              {
                entity: 'link_type',
                id: params.id,
                property_id: pair.id,
                type_properties_count: foreignBindings,
              },
            );
          }
        }
        deleteLinkType(ndb, params.id, undefined, { force, actorUserId });
        // Пара удаляется после типа: deleteNetworkProperty не найдёт тип и не
        // станет повторно каскадить рёбра, а сам снесёт строку реестра слоевым
        // удалением. Порядок сохраняет атомарность (одна транзакция).
        if (pair !== null) deleteNetworkProperty(ndb, pair.id);
        break;
      }
      case 'property': {
        const current = getNetworkProperty(ndb, params.id);
        if (isBaseContext(ndb)) {
          // Основа: широкая физическая чистка по `property_id` (снимает и
          // слойные строки — сирот не остаётся), затем строка реестра.
          // MCP-семантика `force`.
          if (force) {
            ndb
              // layers:physical-write — базовая ветка слоёного удаления
              .prepare("DELETE FROM property_values WHERE property_id = ?")
              .run(params.id);
          }
          // layers:physical-write — базовая ветка слоёного удаления
          ndb.prepare("DELETE FROM type_properties WHERE property_id = ?").run(params.id);
        } else {
          // Рабочий слой (ошибка 81184542): только надгробия по ВИДИМЫМ
          // строкам — физическая чистка выметала базовые привязки и значения
          // основы, а строка реестра искалась по `layer_id` и не находилась
          // (тихий no-op при `deleted: true`). 13-layers.md §5.2.
          const bindingIds = (
            ndb.prepare('SELECT id FROM type_properties_v WHERE property_id = ?').all(params.id) as {
              id: string;
            }[]
          ).map((row) => row.id);
          for (const bindingId of bindingIds) {
            deleteTypeProperty(ndb, bindingId, actorUserId);
          }
          if (force) {
            const valueIds = (
              ndb
                .prepare('SELECT id FROM property_values_v WHERE property_id = ?')
                .all(params.id) as { id: string }[]
            ).map((row) => row.id);
            for (const valueId of valueIds) {
              deleteRowLayered(ndb, 'property_values', valueId);
            }
          }
        }
        // Ошибка 937b4d81: свойство-связь и его тип связи — один жизненный
        // цикл (требование 09f692ff). Для свойства-связи идём тем же путём,
        // что REST `DELETE /properties/:id`: `deleteNetworkProperty` удаляет
        // и парный `link_type`, рёбра теряют `type_id` и становятся
        // структурными, а число живых таких рёбер возвращается в
        // `links_becoming_structural`. Каскад выше обязателен: занятое
        // свойство `deleteNetworkProperty` отвергает (`DUPLICATE`).
        // В основе каскад физический, в рабочем слое — надгробия: оба вида
        // значения (скаляр и связь) идут одним путём слоевой семантики.
        if (current !== null) {
          if (current.value_type === 'link') {
            const removed = deleteNetworkProperty(ndb, params.id, { actorUserId });
            if (removed.links_becoming_structural !== null) {
              usage.links_becoming_structural = removed.links_becoming_structural;
            }
          } else {
            deleteRowLayered(ndb, 'properties', params.id);
          }
        }
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
        // layers:physical-write — защитный инвариант HOME: собственная строка основы
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
