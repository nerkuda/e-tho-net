/**
 * Cross-network (fan-out) обёртки для поиска, выборки и проверки дублей
 * (задача eb1a3f43, требование c98d5d19 «Веерный режим поиска и выборки:
 * network_ids»).
 *
 * Семантика — веер по сетям с последующим слиянием:
 *   1. На каждую запрошенную сеть открывается её `data.db` в её текущем
 *      сессионном слое (через {@link openNetworkDbForCrossNetwork}).
 *   2. Вызывается та же доменная функция, что и для одиночной сети.
 *   3. Хиты получают `network_id`, собираются справочник сетей
 *      (`id` + `display_name`).
 *   4. Сети, к которым у вызывающего ключа нет доступа (member/admin),
 *      молча исключаются (требование: «в выдачу попадают только сети, где
 *      пользователь ключа — участник; недоступные исключаются молча»).
 *
 * Объём результата умножается на количество сетей, поэтому потолок по
 * сетям — 16 (требование: «разумный потолок»). `limit`/`offset` применяются
 * уже к объединённой выдаче, что даёт честный пейджинг по вееру.
 *
 * Общего кросс-сетевого индекса не появляется — граница MVP сохранена:
 * каждая сеть опрашивается по своему индексу (см. комментарий в карточке
 * задачи eb1a3f43).
 */

import type { NetworkDb } from '../db/network-db.js';
import type { Logger } from 'pino';
import { openNetworkDb } from '../db/network-db.js';
import { resolveSessionLayer } from './layer-service.js';
import { findDuplicates, search } from './search-service.js';
import { queryThoughts, type ThoughtQueryRequest } from './query-service.js';
import { BASE_LAYER_ID } from '@etn/shared';
import type { DuplicateHit, NetworksCatalog, NetworkRef, SearchResponse, ThoughtQueryResponse } from '@etn/shared';

/** Максимум сетей в одном веерном вызове. Запросы сверх лимита — ошибка
 *  (агенту нужен явный сигнал, а не молчаливая обрезка). */
export const CROSS_NETWORK_MAX = 16;

/** Открыть `data.db` сети в её текущем сессионном слое для cross-network
 *  запроса. Слой выбирается так же, как в {@link openMemberNetwork} MCP. */
function openNetworkDbForCrossNetwork(
  dataDir: string,
  userId: string,
  clientId: string,
  networkId: string,
  logger: Logger,
): NetworkDb {
  // Base-слой + resolveSessionLayer — повторяет логику `openMemberNetwork` из
  // `server/src/mcp/context.ts`, но без зависимости от MCP-рантайма.
  const base = openNetworkDb(dataDir, networkId, logger, BASE_LAYER_ID);
  const layer = resolveSessionLayer(base, userId, clientId);
  return openNetworkDb(dataDir, networkId, logger, layer.id);
}

/** Сеть, в которой вызывающему разрешено искать. */
export interface AccessibleNetwork {
  id: string;
  display_name: string;
}

/**
 * Аргумент {@link fanOutSearch}/{@link fanOutQuery}/{@link fanOutFindDuplicates}:
 * список сетей с правом доступа. Фильтрация по правам делается вызывающим —
 * обычно через `systemDb.getMemberRole` + `etn.networks.list`.
 */
export interface CrossNetworkAccess {
  networks: AccessibleNetwork[];
  /** Те же id, что и в `networks`, в порядке обхода — нужно для FAN-OUT
   *  цикла без реконструкции списка. */
  accessibleIds: string[];
  dataDir: string;
  userId: string;
  clientId: string;
  logger: Logger;
}

/** Проверить и дедуплицировать список сетей (≤ {@link CROSS_NETWORK_MAX}). */
function normalizeNetworkIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > CROSS_NETWORK_MAX) {
    throw new Error(
      `Слишком много сетей в network_ids: ${unique.length} (макс. ${CROSS_NETWORK_MAX}).`,
    );
  }
  return unique;
}

/** Слить N SearchResponse в один с проставленным `network_id` на каждом хите. */
function mergeSearchResponses(
  responses: Array<{ networkId: string; response: SearchResponse }>,
): SearchResponse {
  const by_names: SearchResponse['by_names'] = [];
  const by_texts: SearchResponse['by_texts'] = [];
  const by_links: SearchResponse['by_links'] = [];
  const by_chrono: SearchResponse['by_chrono'] = [];
  const total = { names: 0, texts: 0, links: 0, chronology: 0 };
  for (const { networkId, response } of responses) {
    for (const hit of response.by_names) by_names.push({ ...hit, network_id: networkId });
    for (const hit of response.by_texts) by_texts.push({ ...hit, network_id: networkId });
    for (const hit of response.by_links) by_links.push({ ...hit, network_id: networkId });
    for (const hit of response.by_chrono) by_chrono.push({ ...hit, network_id: networkId });
    total.names += response.meta.total_in_group.names;
    total.texts += response.meta.total_in_group.texts;
    total.links += response.meta.total_in_group.links;
    total.chronology += response.meta.total_in_group.chronology;
  }
  return {
    by_names,
    by_texts,
    by_links,
    by_chrono,
    meta: { total_in_group: total },
  };
}

/** Параметры веерного поиска. */
export interface CrossNetworkSearchArgs {
  /** Список сетей для веера (после проверки доступа). */
  networkIds: string[];
  /** Те же аргументы, что и для {@link search} одиночной сети. */
  q: string;
  scope?: SearchResponse['by_names'][number] extends never ? never
    : import('@etn/shared').SearchScope;
  in?: 'subtree';
  from_thought_id?: string;
  type_id?: string[];
  type?: string;
  link_type_id?: string[];
  show_inactive?: boolean;
  trashed?: boolean;
  author_id?: string;
  editor_id?: string;
  limit: number;
  offset: number;
  /** Значение `show_inactive` по умолчанию (из пользовательских настроек). */
  showInactiveDefault: boolean;
}

/** Запустить веером {@link search} по всем сетям и слить выдачу. */
export function fanOutSearch(
  access: CrossNetworkAccess,
  args: CrossNetworkSearchArgs,
): { response: SearchResponse; networks: NetworksCatalog } {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const responses: Array<{ networkId: string; response: SearchResponse }> = [];
  for (const net of accessible) {
    const ndb = openNetworkDbForCrossNetwork(access.dataDir, access.userId, access.clientId, net.id, access.logger);
    const response = search(ndb, {
      q: args.q,
      scope: args.scope,
      in: args.in,
      from_thought_id: args.from_thought_id,
      type_id: args.type_id,
      type: args.type,
      link_type_id: args.link_type_id,
      show_inactive: args.show_inactive,
      trashed: args.trashed,
      author_id: args.author_id,
      editor_id: args.editor_id,
      // Берём per-сеть лимит = лимит * |networks|, чтобы после слияния
      // верхушка веера была представлена полностью. Можно жёстче
      // (limit на сеть), но это даёт агенту меньше контроля.
      limit: args.limit * Math.max(accessible.length, 1),
      offset: 0,
    }, args.showInactiveDefault);
    responses.push({ networkId: net.id, response });
  }
  // Сначала сливаем (по сетям уже урезанные по per-сеть-лимиту выборки), затем
  // применяем limit/offset к объединённой выдаче.
  const merged = mergeSearchResponses(responses);
  const paginated: SearchResponse = {
    by_names: merged.by_names.slice(args.offset, args.offset + args.limit),
    by_texts: merged.by_texts.slice(args.offset, args.offset + args.limit),
    by_links: merged.by_links.slice(args.offset, args.offset + args.limit),
    by_chrono: merged.by_chrono.slice(args.offset, args.offset + args.limit),
    meta: merged.meta,
  };
  return {
    response: paginated,
    networks: accessible.map((n) => ({ id: n.id, display_name: n.display_name })),
  };
}

/** Параметры веерной структурной выборки. */
export interface CrossNetworkQueryArgs {
  networkIds: string[];
  /** Доменный (уже резолвнутый) ThoughtQueryRequest — фасад несёт
   *  ответственность за форму (REST: `structureRequestToQuery`, MCP:
   *  `mcpRequestToQuery`). */
  query: ThoughtQueryRequest;
  limit: number;
  offset: number;
}

/** Запустить веером {@link queryThoughts} по всем сетям. */
export function fanOutQuery(
  access: CrossNetworkAccess,
  args: CrossNetworkQueryArgs,
): { response: ThoughtQueryResponse; networks: NetworksCatalog } {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const hits: import('@etn/shared').ThoughtQueryHit[] = [];
  let total = 0;
  let truncated = false;
  let reason: 'max_nodes' | null = null;
  for (const net of accessible) {
    const ndb = openNetworkDbForCrossNetwork(access.dataDir, access.userId, access.clientId, net.id, access.logger);
    const result = queryThoughts(
      ndb,
      access.userId,
      // per-сеть лимит — тот же приём, что в fanOutSearch.
      { ...args.query, limit: args.limit * Math.max(accessible.length, 1), offset: 0 },
      { maxLimit: 200, emptyFilterMode: 'all' },
    );
    for (const item of result.items) {
      hits.push({
        id: item.id,
        network_id: net.id,
        title: item.title,
        type_id: item.type_id,
        active: item.active,
        depth: result.depths === null ? null : (result.depths.get(item.id) ?? null),
      });
    }
    total += result.total;
    if (result.truncated) {
      truncated = true;
      reason = result.reason;
    }
  }
  // Сортировка + limit/offset на объединённой выдаче.
  const sort = args.query.sort ?? 'alpha';
  const order = args.query.order ?? 'asc';
  const cmp = (a: import('@etn/shared').ThoughtQueryHit, b: import('@etn/shared').ThoughtQueryHit): number => {
    let primary = 0;
    if (sort === 'alpha' || sort === undefined) primary = a.title.localeCompare(b.title);
    else primary = a.id.localeCompare(b.id);
    return order === 'asc' ? primary : -primary;
  };
  hits.sort(cmp);
  const page = hits.slice(args.offset, args.offset + args.limit);
  return {
    response: {
      total,
      hits: page,
      truncated,
      reason,
    },
    networks: accessible.map((n) => ({ id: n.id, display_name: n.display_name })),
  };
}

/** Параметры веерного поиска дублей. */
export interface CrossNetworkFindDuplicatesArgs {
  networkIds: string[];
  title: string;
  synonyms?: string[];
  typeIds?: string[];
}

/** Запустить веером {@link findDuplicates}. */
export function fanOutFindDuplicates(
  access: CrossNetworkAccess,
  args: CrossNetworkFindDuplicatesArgs,
): { hits: DuplicateHit[]; networks: NetworksCatalog } {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const byId = new Map<string, DuplicateHit>();
  // Объединяем по `(network_id, thought_id)` — одинаковые id в разных сетях
  // (теоретически возможно при кросс-DB ссылках) трактуются как разные хиты.
  const keyOf = (networkId: string, thoughtId: string): string => `${networkId}:${thoughtId}`;
  for (const net of accessible) {
    const ndb = openNetworkDbForCrossNetwork(access.dataDir, access.userId, access.clientId, net.id, access.logger);
    const local = findDuplicates(ndb, args.title, args.synonyms ?? [], args.typeIds ?? []);
    for (const hit of local) {
      const key = keyOf(net.id, hit.id);
      const existing = byId.get(key);
      if (existing === undefined) {
        byId.set(key, { ...hit, network_id: net.id });
      }
    }
  }
  return {
    hits: [...byId.values()],
    networks: accessible.map((n) => ({ id: n.id, display_name: n.display_name })),
  };
}

/** Удобный тип: «справочник сетей из systemDb» — соответствует полям
 *  `NetworkRef` плюс реальный id. */
export type NetworkListRef = NetworkRef;
