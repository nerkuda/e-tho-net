/**
 * Эффективный порядок внетиповых свойств мысли (0.14.1, задача 3948af62;
 * контракт 27ed2b39, сущность e41cea2e).
 *
 * Чтение складывает два источника:
 *
 *   * явные позиции — строки `thought_property_order_v` (ветвимая таблица,
 *     читается только через представление слоя);
 *   * хвост — «порядок появления» свойства у мысли: `property_values.created_at`
 *     для скаляров и `MIN(links.created_at)` живых рёбер для свойств-связей.
 *
 * Порядок применяется ТОЛЬКО к внетиповым записям: типовые свойства идут в
 * порядке своей привязки (`type_properties.position`), как и раньше. Порядок
 * внутри группы «Свойства вне типа» — явные позиции по возрастанию, затем
 * хвост по времени появления; связка тай-брейков делает результат
 * детерминированным (одинаковые `created_at`/позиции не «прыгают» между
 * запросами).
 *
 * Модуль намеренно не импортирует `property-service`: его вызывает сам
 * `property-service` на путях чтения, а обратная зависимость дала бы цикл.
 */

import type { LinkPropertySide } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Одна видимая строка порядка (`thought_property_order_v`). */
export interface ThoughtPropertyOrderEntry {
  property_id: string;
  side: LinkPropertySide | null;
  position: number;
}

/** Натуральный ключ строки порядка; `side` скаляра — `''`. */
export function thoughtPropertyOrderKey(
  propertyId: string,
  side: LinkPropertySide | null,
): string {
  return `${propertyId}|${side ?? ''}`;
}

/** Видимые строки порядка мысли в текущем слое. */
export function loadThoughtPropertyOrder(
  ndb: NetworkDb,
  thoughtId: string,
): ThoughtPropertyOrderEntry[] {
  const rows = ndb
    .prepare(
      `SELECT property_id, side, position
         FROM thought_property_order_v
        WHERE thought_id = ?`,
    )
    .all(thoughtId) as Array<{
    property_id: string;
    side: string | null;
    position: number;
  }>;
  return rows
    .map((row) => ({
      property_id: row.property_id,
      side: (row.side as LinkPropertySide | null) ?? null,
      position: row.position,
    }))
    .sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      const ka = thoughtPropertyOrderKey(a.property_id, a.side);
      const kb = thoughtPropertyOrderKey(b.property_id, b.side);
      return ka === kb ? 0 : ka < kb ? -1 : 1;
    });
}

/** Минимальный набор полей записи свойства, нужный сортировке. */
export interface OrderableProperty {
  property_id: string;
  value_type: string;
  outside_type: boolean;
  side?: LinkPropertySide | null;
  link_type_id?: string | null;
  direction?: 'out' | 'in';
}

/** Пара «тип связи + направление» — ключ проекции свойства-связи. */
function linkPair(linkTypeId: string | null | undefined, direction: string | undefined): string {
  return `${linkTypeId ?? ''}|${direction ?? ''}`;
}

/** Время появления скалярного значения у мысли: `property_id → created_at`. */
function scalarAppearanceTimes(ndb: NetworkDb, thoughtId: string): Map<string, string> {
  const rows = ndb
    .prepare(
      `SELECT property_id, created_at
         FROM property_values_v
        WHERE owner_type = 'thought' AND owner_id = ?`,
    )
    .all(thoughtId) as Array<{ property_id: string; created_at: string }>;
  const out = new Map<string, string>();
  for (const row of rows) out.set(row.property_id, row.created_at ?? '');
  return out;
}

/**
 * Время первого живого ребра по паре «тип связи + направление»:
 * `MIN(links.created_at)` отдельно для исходящих и входящих рёбер.
 */
function linkAppearanceTimes(ndb: NetworkDb, thoughtId: string): Map<string, string> {
  const out = new Map<string, string>();
  const absorb = (rows: Array<{ type_id: string | null; created_at: string | null }>, dir: 'out' | 'in'): void => {
    for (const row of rows) {
      const key = linkPair(row.type_id, dir);
      if (!out.has(key)) out.set(key, row.created_at ?? '');
    }
  };
  absorb(
    ndb
      .prepare(
        `SELECT type_id, MIN(created_at) AS created_at
           FROM links_v
          WHERE source_id = ? AND active = 1 AND marked_for_deletion = 0
          GROUP BY type_id`,
      )
      .all(thoughtId) as Array<{ type_id: string | null; created_at: string | null }>,
    'out',
  );
  absorb(
    ndb
      .prepare(
        `SELECT type_id, MIN(created_at) AS created_at
           FROM links_v
          WHERE target_id = ? AND active = 1 AND marked_for_deletion = 0
          GROUP BY type_id`,
      )
      .all(thoughtId) as Array<{ type_id: string | null; created_at: string | null }>,
    'in',
  );
  return out;
}

/**
 * Карта «тип связи + направление» → свойство реестра для строк порядка.
 *
 * Нужна как запасной ключ сопоставления: у внетиповой проекции свойства-связи
 * в `GET …/properties` сегодня пустой `property_id` (ошибка 45248206, отдельная
 * работа), но строка порядка адресует свойство реестра. Пока id не резолвится,
 * сопоставляем по паре (тип связи + направление); если на пару приходится
 * несколько свойств, запасной ключ не используется (порядок по id).
 */
function orderPairPositions(
  ndb: NetworkDb,
  entries: readonly ThoughtPropertyOrderEntry[],
): Map<string, number> {
  const ids = [...new Set(entries.map((e) => e.property_id))];
  if (ids.length === 0) return new Map();
  const rows = ndb
    .prepare(
      `SELECT id, config FROM properties_v WHERE id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as Array<{ id: string; config: string | null }>;
  const linkTypeByProperty = new Map<string, string | null>();
  for (const row of rows) {
    if (row.config === null) continue;
    try {
      const cfg = JSON.parse(row.config) as { link_type_id?: unknown; structural?: unknown };
      if (cfg.structural === true) continue;
      if (typeof cfg.link_type_id === 'string' && cfg.link_type_id !== '') {
        linkTypeByProperty.set(row.id, cfg.link_type_id);
      }
    } catch {
      // Битый config реестра — не повод падать на чтении свойств: строка
      // порядка просто останется доступной только по property_id.
    }
  }
  // Пара может обслуживать несколько свойств: тогда запасной ключ неоднозначен.
  const byPair = new Map<string, { position: number; propertyId: string }>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    if (entry.side === null) continue;
    const linkTypeId = linkTypeByProperty.get(entry.property_id);
    if (linkTypeId === undefined) continue;
    const pair = linkPair(linkTypeId, entry.side === 'source' ? 'out' : 'in');
    const existing = byPair.get(pair);
    if (existing !== undefined && existing.propertyId !== entry.property_id) {
      ambiguous.add(pair);
      continue;
    }
    byPair.set(pair, { position: entry.position, propertyId: entry.property_id });
  }
  const out = new Map<string, number>();
  for (const [pair, value] of byPair) {
    if (!ambiguous.has(pair)) out.set(pair, value.position);
  }
  return out;
}

/**
 * Переставить внетиповые записи `entries` в эффективном порядке. Типовые
 * записи остаются на своих местах: меняется только относительный порядок
 * внетиповых (клиент фильтрует группу «Свойства вне типа», сохраняя порядок
 * ответа). Возвращает тот же массив (мутация на месте) — удобно для обоих
 * путей чтения.
 */
export function reorderOutsideTypeProperties<T extends OrderableProperty>(
  ndb: NetworkDb,
  thoughtId: string,
  entries: T[],
): T[] {
  const outsideIdx: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]!.outside_type === true) outsideIdx.push(i);
  }
  if (outsideIdx.length < 2) return entries;

  const rows = loadThoughtPropertyOrder(ndb, thoughtId);
  const positionsByKey = new Map<string, number>();
  for (const row of rows) {
    positionsByKey.set(thoughtPropertyOrderKey(row.property_id, row.side), row.position);
  }
  const positionsByPair = orderPairPositions(ndb, rows);
  const scalarTimes = scalarAppearanceTimes(ndb, thoughtId);
  const linkTimes = linkAppearanceTimes(ndb, thoughtId);

  const positionOf = (entry: T): number | null => {
    if (entry.property_id !== '') {
      const direct = positionsByKey.get(
        thoughtPropertyOrderKey(entry.property_id, entry.side ?? null),
      );
      if (direct !== undefined) return direct;
    }
    if (entry.value_type === 'link') {
      const pairPos = positionsByPair.get(linkPair(entry.link_type_id, entry.direction));
      if (pairPos !== undefined) return pairPos;
    }
    return null;
  };
  const timeOf = (entry: T): string => {
    if (entry.value_type === 'link') {
      return linkTimes.get(linkPair(entry.link_type_id, entry.direction)) ?? '';
    }
    return scalarTimes.get(entry.property_id) ?? '';
  };
  const tieKey = (entry: T): string =>
    `${entry.property_id}|${entry.side ?? ''}|${entry.link_type_id ?? ''}|${entry.direction ?? ''}`;

  const ordered = outsideIdx
    .map((index) => entries[index]!)
    .sort((a, b) => {
      const pa = positionOf(a);
      const pb = positionOf(b);
      if (pa !== pb) {
        // Явные позиции — раньше дефолтного хвоста.
        return (pa ?? Number.POSITIVE_INFINITY) - (pb ?? Number.POSITIVE_INFINITY);
      }
      const ta = timeOf(a);
      const tb = timeOf(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      const ka = tieKey(a);
      const kb = tieKey(b);
      return ka === kb ? 0 : ka < kb ? -1 : 1;
    });

  for (let i = 0; i < outsideIdx.length; i += 1) {
    entries[outsideIdx[i]!] = ordered[i]!;
  }
  return entries;
}
