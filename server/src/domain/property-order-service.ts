/**
 * Запись пер-мысленного порядка внетиповых свойств (0.14.1, задача 3948af62;
 * контракт `PUT /thoughts/{id}/properties/order` 27ed2b39; ADR 75a79109).
 *
 * Операция — ОДИН полный набор: таблица `thought_property_order` приводится к
 * переданному массиву (отсутствующие строки удаляются), позиции нормализуются
 * в `0..n-1`, запись идёт одной транзакцией в текущем слое. Поэлементных
 * операций позиции нет — так проще слияние и бюджет записи.
 *
 * `side` — адрес строки, а не второе хранилище направления (ADR 75a79109 п. 4):
 * сторона свойства-связи ВСЕГДА выводится из живых рёбер у владельца. Если у
 * владельца живы обе стороны одного типа связи, `side` на входе обязателен;
 * при одной стороне он необязателен, а переданный сверяется с выведенным.
 * Сторона, входящая в эффективный набор типа владельца (включая зеркала
 * `allowed_target_type_ids`), не упорядочивается — `422`.
 */

import {
  EtnError,
  type LinkPropertySide,
  type LinkPropertyDirection,
  type NetworkProperty,
  type ThoughtPropertyOrderInput as SharedPropertyOrderInput,
  type ThoughtPropertiesReorderedItem as SharedPropertyOrderItem,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { deleteRowLayered, materializeShadow } from '../db/layer-write.js';
import { thoughtPropertyOrderId } from '../db/property-order-id.js';
import { thoughtPropertyOrderKey } from './property-order.js';
import {
  attachedPropertyIds,
  getNetworkProperty,
  linkPropertyLinkTypeId,
  isStructuralLinkProperty,
  listThoughtLinkProperties,
} from './property-service.js';

/**
 * Один элемент входа операции (позиция ещё не нормализована). Форма — общий
 * контракт `@etn/shared` (PUT …/properties/order, 27ed2b39).
 */
export type ThoughtPropertyOrderInput = SharedPropertyOrderInput;

/**
 * Нормализованная строка порядка: сторона вычислена сервером. Форма — общий
 * контракт `@etn/shared` (payload события d819137a), чтобы клиент и сервер
 * читали один тип (стандарт 01268f2d, задача 2e87285b).
 */
export type ThoughtPropertyOrderItem = SharedPropertyOrderItem;

/** Направление стороны у владельца: источник → `out`, цель → `in`. */
function directionOfSide(side: LinkPropertySide): LinkPropertyDirection {
  return side === 'source' ? 'out' : 'in';
}

/** Живые стороны одного типа связи у мысли (владелец-источник / цель). */
function liveLinkSides(
  ndb: NetworkDb,
  thoughtId: string,
  linkTypeId: string,
): { source: boolean; target: boolean } {
  const row = ndb
    .prepare(
      `SELECT
         EXISTS(
           SELECT 1 FROM links_v
            WHERE source_id = ? AND type_id = ? AND active = 1 AND marked_for_deletion = 0
         ) AS source_live,
         EXISTS(
           SELECT 1 FROM links_v
            WHERE target_id = ? AND type_id = ? AND active = 1 AND marked_for_deletion = 0
         ) AS target_live`,
    )
    .get(thoughtId, linkTypeId, thoughtId, linkTypeId) as
    | { source_live: number; target_live: number }
    | undefined;
  return { source: row?.source_live === 1, target: row?.target_live === 1 };
}

/**
 * Пары `(тип связи, направление)`, покрытые эффективным набором типа
 * владельца: явные привязки и зеркальные свойства (dde92461). Такая сторона —
 * типовая, её позиция задаётся привязкой, а не пер-мысленным порядком.
 */
function typedLinkPairs(ndb: NetworkDb, thoughtId: string): Set<string> {
  const out = new Set<string>();
  for (const lp of listThoughtLinkProperties(ndb, thoughtId)) {
    if (lp.outside_type === true) continue;
    out.add(`${lp.link_type_id ?? ''}|${lp.direction}`);
  }
  return out;
}

/** Валидация и вывод стороны одного свойства-связи. */
function resolveLinkSide(
  ndb: NetworkDb,
  thoughtId: string,
  prop: NetworkProperty,
  linkTypeId: string,
  typed: Set<string>,
  requested: LinkPropertySide | undefined,
): LinkPropertySide {
  const live = liveLinkSides(ndb, thoughtId, linkTypeId);
  const isTyped = (side: LinkPropertySide): boolean =>
    typed.has(`${linkTypeId}|${directionOfSide(side)}`);

  if (requested !== undefined) {
    if (isTyped(requested)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `сторона «${requested}» свойства «${prop.name}» входит в эффективный набор типа мысли — её порядок задаёт привязка типа`,
        { field: 'side', property_id: prop.id, side: requested },
      );
    }
    if (!live[requested]) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `у свойства «${prop.name}» нет живых рёбер стороны «${requested}» — пустой внетиповой строки не существует`,
        { field: 'side', property_id: prop.id, side: requested },
      );
    }
    return requested;
  }

  if (live.source && live.target) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `у мысли живы обе стороны свойства «${prop.name}» — укажите side`,
      { field: 'side', property_id: prop.id, allowed: ['source', 'target'] },
    );
  }
  if (!live.source && !live.target) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `у свойства «${prop.name}» нет живых рёбер — пустой внетиповой строки не существует`,
      { property_id: prop.id },
    );
  }
  const only: LinkPropertySide = live.source ? 'source' : 'target';
  if (isTyped(only)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `сторона «${only}» свойства «${prop.name}» входит в эффективный набор типа мысли — её порядок задаёт привязка типа`,
      { field: 'side', property_id: prop.id, side: only },
    );
  }
  return only;
}

/**
 * Привести видимые строки порядка к полному набору `items` (нормализованному).
 * Возвращает нормализованный набор в порядке позиций.
 */
export function setThoughtPropertyOrder(
  ndb: NetworkDb,
  thoughtId: string,
  items: readonly ThoughtPropertyOrderInput[],
): ThoughtPropertyOrderItem[] {
  return ndb.transaction(() => {
    const thought = ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ?').get(thoughtId);
    if (thought === undefined) {
      throw new EtnError('NOT_FOUND', `thought ${thoughtId} not found`, {
        entity: 'thought',
        id: thoughtId,
      });
    }

    const attached = attachedPropertyIds(ndb, 'thought', thoughtId);
    const typed = typedLinkPairs(ndb, thoughtId);
    const resolved: ThoughtPropertyOrderItem[] = [];
    const seen = new Map<string, number>();

    items.forEach((item, index) => {
      if (!Number.isFinite(item.position) || item.position < 0) {
        throw new EtnError('VALIDATION_ERROR', 'position должен быть неотрицательным числом', {
          field: `items[${index}].position`,
          position: item.position,
        });
      }
      const prop = getNetworkProperty(ndb, item.property_id);
      if (prop === null) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `свойства ${item.property_id} нет в справочнике сети`,
          { field: `items[${index}].property_id`, property_id: item.property_id },
        );
      }

      let side: LinkPropertySide | null = null;
      if (prop.value_type === 'link') {
        const linkTypeId = linkPropertyLinkTypeId(prop.config);
        if (linkTypeId === null || isStructuralLinkProperty(prop.config)) {
          // Структурные «Родители»/«Потомки» привязаны к корневому типу —
          // порядок им задаёт привязка, пер-мысленных строк у них нет.
          throw new EtnError(
            'VALIDATION_ERROR',
            `свойство «${prop.name}» — структурное и не упорядочивается пер-мысленно`,
            { field: `items[${index}].property_id`, property_id: prop.id },
          );
        }
        side = resolveLinkSide(ndb, thoughtId, prop, linkTypeId, typed, item.side);
      } else if (item.side !== undefined) {
        throw new EtnError('VALIDATION_ERROR', 'side задаётся только для свойств-связей', {
          field: `items[${index}].side`,
          property_id: prop.id,
        });
      } else {
        if (attached.has(prop.id)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `свойство «${prop.name}» привязано к типу мысли — его порядок задаёт привязка типа`,
            { field: `items[${index}].property_id`, property_id: prop.id },
          );
        }
        const value = ndb
          .prepare(
            `SELECT 1 FROM property_values_v
              WHERE owner_type = 'thought' AND owner_id = ? AND property_id = ?`,
          )
          .get(thoughtId, prop.id);
        if (value === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `у мысли нет значения свойства «${prop.name}» — упорядочивать нечего`,
            { field: `items[${index}].property_id`, property_id: prop.id },
          );
        }
      }

      const key = thoughtPropertyOrderKey(prop.id, side);
      const duplicate = seen.get(key);
      if (duplicate !== undefined) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `дубль строки порядка: свойство «${prop.name}»${side === null ? '' : `, сторона «${side}»`}`,
          {
            field: `items[${index}].property_id`,
            property_id: prop.id,
            duplicate_of: duplicate,
          },
        );
      }
      seen.set(key, index);
      resolved.push({ property_id: prop.id, side, position: item.position });
    });

    // Нормализация: сортировка по position (устойчивая — при равенстве
    // сохраняется порядок элементов входа) и перенумерация 0..n-1.
    const normalized = resolved
      .map((item, index) => ({ item, index }))
      .sort((a, b) => a.item.position - b.item.position || a.index - b.index)
      .map(({ item }, position) => ({ ...item, position }));

    const now = new Date().toISOString();
    const desired = new Map(normalized.map((item) => [thoughtPropertyOrderKey(item.property_id, item.side), item]));

    // 1. Полный набор: видимые строки, которых нет во входе, удаляются.
    const visible = ndb
      .prepare(
        `SELECT id, property_id, side
           FROM thought_property_order_v
          WHERE thought_id = ?`,
      )
      .all(thoughtId) as Array<{ id: string; property_id: string; side: string | null }>;
    const visibleByKey = new Map<string, string>();
    for (const row of visible) {
      const key = thoughtPropertyOrderKey(
        row.property_id,
        (row.side as LinkPropertySide | null) ?? null,
      );
      visibleByKey.set(key, row.id);
      if (!desired.has(key)) deleteRowLayered(ndb, 'thought_property_order', row.id);
    }

    // 2. Запись/перестановка. Правка строки предка сначала материализует тень —
    // в слое она наследует id основы (детерминированный id и так совпадает).
    for (const item of normalized) {
      const key = thoughtPropertyOrderKey(item.property_id, item.side);
      const existingId = visibleByKey.get(key);
      if (existingId !== undefined) {
        materializeShadow(ndb, 'thought_property_order', existingId);
        ndb
          .prepare(
            `UPDATE thought_property_order
                SET deleted = 0, position = ?, updated_at = ?
              WHERE id = ? AND layer_id = ?`,
          )
          .run(item.position, now, existingId, ndb.layerId);
        continue;
      }
      // Собственная строка слоя могла остаться надгробием (полный набор её
      // удалил, теперь тот же ключ вернулся): оживляем её, не создавая вторую.
      // Чтение физическое осознанно — `*_v` прячет надгробие, а нам нужна
      // именно своя строка слоя, включая скрытую.
      const own = ndb
        .prepare(
          `SELECT id FROM thought_property_order -- layers:physical-read
            WHERE thought_id = ? AND property_id = ?
              AND COALESCE(side, '') = COALESCE(?, '') AND layer_id = ?`,
        )
        .get(thoughtId, item.property_id, item.side, ndb.layerId) as { id: string } | undefined;
      if (own !== undefined) {
        ndb
          .prepare(
            `UPDATE thought_property_order
                SET deleted = 0, position = ?, updated_at = ?
              WHERE id = ? AND layer_id = ?`,
          )
          .run(item.position, now, own.id, ndb.layerId);
        continue;
      }
      ndb
        .prepare(
          `INSERT INTO thought_property_order
             (id, layer_id, deleted, base_version, thought_id, property_id, side, position, updated_at)
           VALUES (?, ?, 0, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          thoughtPropertyOrderId(thoughtId, item.property_id, item.side),
          ndb.layerId,
          thoughtId,
          item.property_id,
          item.side,
          item.position,
          now,
        );
    }

    return normalized;
  });
}
