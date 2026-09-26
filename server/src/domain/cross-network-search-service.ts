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
 * сетям — 16 (требование: «разумный потолок»), а суммарная выдача
 * ограничена {@link CROSS_NETWORK_MAX_HITS} с диагностикой
 * `truncated`/`reason` (задача 29bc5673). `limit`/`offset` применяются уже к
 * объединённой (и обрезанной) выдаче, что даёт честный пейджинг по вееру.
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
import { queryThoughtsAsync } from './heavy-read.js';
import type { ThoughtQueryRequest } from './query-service.js';
import { BASE_LAYER_ID } from '@etn/shared';
import type { DuplicateHit, NetworksCatalog, NetworkRef, SearchResponse, ThoughtQueryResponse } from '@etn/shared';

/** Максимум сетей в одном веерном вызове. Запросы сверх лимита — ошибка
 *  (агенту нужен явный сигнал, а не молчаливая обрезка). */
export const CROSS_NETWORK_MAX = 16;

/**
 * Потолок суммарной веерной выдачи: максимум объединённых хитов по всем сетям
 * (задача 29bc5673). Раньше per-сеть лимит `limit * |networks|` умножался на
 * число сетей, и объём ответа рос неограниченно. Сети обходятся в порядке
 * `network_ids`, вклад сверх потолка отбрасывается, и ответ несёт `truncated`
 * + `reason: 'cross_network_max_hits'` — обрезка предсказуема.
 *
 * Значение — верхняя граница объединённой выдачи одного веерного вызова;
 * `limit`/`offset` применяются к ней уже после обрезки (честный пейджинг по
 * обрезанному множеству). Для тестов и внутренних вызовов порог можно
 * переопределить аргументом `maxHits`.
 */
export const CROSS_NETWORK_MAX_HITS = 1000;

/**
 * Общий бюджет хитов на веерный вызов (задача 29bc5673): `remaining`
 * уменьшается по мере наполнения групп в порядке сетей и групп; `truncated`
 * становится true, если что-то не поместилось. `cap <= 0` — без потолка.
 */
interface HitBudget {
  remaining: number;
  truncated: boolean;
}

function makeBudget(cap: number): HitBudget {
  return { remaining: cap > 0 ? cap : Number.POSITIVE_INFINITY, truncated: false };
}

/** Взять из `items` столько, сколько осталось в бюджете; остаток — обрезка. */
function acceptWithBudget<T>(budget: HitBudget, items: readonly T[]): T[] {
  if (items.length <= budget.remaining) {
    budget.remaining -= items.length;
    return [...items];
  }
  const taken = items.slice(0, Math.max(0, budget.remaining));
  budget.remaining -= taken.length;
  budget.truncated = true;
  return taken;
}

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

/** Слить N SearchResponse в один с проставленным `network_id` на каждом хите.
 *  Суммарный бюджет `cap` расходуется в порядке сетей и групп; при обрезке
 *  возвращается `truncated: true`. */
function mergeSearchResponses(
  responses: Array<{ networkId: string; response: SearchResponse }>,
  cap: number,
): { response: SearchResponse; truncated: boolean } {
  const budget = makeBudget(cap);
  const by_names: SearchResponse['by_names'] = [];
  const by_texts: SearchResponse['by_texts'] = [];
  const by_links: SearchResponse['by_links'] = [];
  const by_chrono: SearchResponse['by_chrono'] = [];
  const total = { names: 0, texts: 0, links: 0, chronology: 0 };
  for (const { networkId, response } of responses) {
    for (const hit of acceptWithBudget(budget, response.by_names)) {
      by_names.push({ ...hit, network_id: networkId });
    }
    for (const hit of acceptWithBudget(budget, response.by_texts)) {
      by_texts.push({ ...hit, network_id: networkId });
    }
    for (const hit of acceptWithBudget(budget, response.by_links)) {
      by_links.push({ ...hit, network_id: networkId });
    }
    for (const hit of acceptWithBudget(budget, response.by_chrono)) {
      by_chrono.push({ ...hit, network_id: networkId });
    }
    total.names += response.meta.total_in_group.names;
    total.texts += response.meta.total_in_group.texts;
    total.links += response.meta.total_in_group.links;
    total.chronology += response.meta.total_in_group.chronology;
  }
  return {
    response: {
      by_names,
      by_texts,
      by_links,
      by_chrono,
      meta: { total_in_group: total },
    },
    truncated: budget.truncated,
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
  /** Потолок суммарной выдачи; по умолчанию {@link CROSS_NETWORK_MAX_HITS}. */
  maxHits?: number;
}

/** Запустить веером {@link search} по всем сетям и слить выдачу. */
export function fanOutSearch(
  access: CrossNetworkAccess,
  args: CrossNetworkSearchArgs,
): { response: SearchResponse; networks: NetworksCatalog } {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const cap = args.maxHits ?? CROSS_NETWORK_MAX_HITS;
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
      // верхушка веера была представлена полностью. Объём удерживает общий
      // потолок `cap` (задача 29bc5673): per-сеть лимит НЕ занижаем до `cap`,
      // иначе обрезка становится неотличима от «ровно в потолок».
      limit: args.limit * Math.max(accessible.length, 1),
      offset: 0,
    }, args.showInactiveDefault);
    responses.push({ networkId: net.id, response });
  }
  // Сначала сливаем (по сетям уже урезанные по per-сеть-лимиту выборки) с
  // общим бюджетом, затем применяем limit/offset к объединённой выдаче.
  const { response: merged, truncated } = mergeSearchResponses(responses, cap);
  const paginated: SearchResponse = {
    by_names: merged.by_names.slice(args.offset, args.offset + args.limit),
    by_texts: merged.by_texts.slice(args.offset, args.offset + args.limit),
    by_links: merged.by_links.slice(args.offset, args.offset + args.limit),
    by_chrono: merged.by_chrono.slice(args.offset, args.offset + args.limit),
    meta: merged.meta,
    truncated,
    reason: truncated ? 'cross_network_max_hits' : null,
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
  /** Потолок суммарной выдачи; по умолчанию {@link CROSS_NETWORK_MAX_HITS}. */
  maxHits?: number;
}

/** Запустить веером {@link queryThoughtsAsync} по всем сетям. */
export async function fanOutQuery(
  access: CrossNetworkAccess,
  args: CrossNetworkQueryArgs,
): Promise<{ response: ThoughtQueryResponse; networks: NetworksCatalog }> {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const cap = args.maxHits ?? CROSS_NETWORK_MAX_HITS;
  const budget = makeBudget(cap);
  const hits: import('@etn/shared').ThoughtQueryHit[] = [];
  let total = 0;
  let truncated = false;
  let reason: 'max_nodes' | 'cross_network_max_hits' | null = null;
  for (const net of accessible) {
    const ndb = openNetworkDbForCrossNetwork(access.dataDir, access.userId, access.clientId, net.id, access.logger);
    const result = await queryThoughtsAsync(
      ndb,
      access.userId,
      // per-сеть лимит — тот же приём, что в fanOutSearch: не занижаем до
      // `cap`, чтобы обрезку можно было отличить от «ровно в потолок».
      // `count: true` — вееру нужен полный счёт по каждой сети для `total`
      // объединённой выдачи (требование 5adebf61: COUNT только по явному флагу).
      {
        ...args.query,
        count: true,
        cursor: undefined,
        limit: args.limit * Math.max(accessible.length, 1),
        offset: 0,
      },
      { maxLimit: 200, emptyFilterMode: 'all' },
    );
    for (const item of acceptWithBudget(budget, result.items)) {
      hits.push({
        id: item.id,
        network_id: net.id,
        title: item.title,
        type_id: item.type_id,
        active: item.active,
        depth: result.depths === null ? null : (result.depths.get(item.id) ?? null),
      });
    }
    total += result.total ?? 0;
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
  // Потолок веера перекрывает per-сетевой `max_nodes` как более общую причину.
  if (budget.truncated) {
    truncated = true;
    reason = 'cross_network_max_hits';
  }
  return {
    response: {
      total,
      hits: page,
      // Кросс-сетевая выдача собирается в памяти и пагинируется slice'ом по
      // объединённому списку — keyset-курсор к ней неприменим (требование
      // 3f2fdc41 адресует однoсетевые выборки).
      has_more: args.offset + page.length < hits.length,
      next_cursor: null,
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
  /** Потолок суммарной выдачи; по умолчанию {@link CROSS_NETWORK_MAX_HITS}. */
  maxHits?: number;
}

/** Запустить веером {@link findDuplicates}. */
export function fanOutFindDuplicates(
  access: CrossNetworkAccess,
  args: CrossNetworkFindDuplicatesArgs,
): {
  hits: DuplicateHit[];
  networks: NetworksCatalog;
  truncated: boolean;
  reason: 'cross_network_max_hits' | null;
} {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const cap = args.maxHits ?? CROSS_NETWORK_MAX_HITS;
  const budget = makeBudget(cap);
  const byId = new Map<string, DuplicateHit>();
  // Объединяем по `(network_id, thought_id)` — одинаковые id в разных сетях
  // (теоретически возможно при кросс-DB ссылках) трактуются как разные хиты.
  const keyOf = (networkId: string, thoughtId: string): string => `${networkId}:${thoughtId}`;
  for (const net of accessible) {
    const ndb = openNetworkDbForCrossNetwork(access.dataDir, access.userId, access.clientId, net.id, access.logger);
    const local = findDuplicates(ndb, args.title, args.synonyms ?? [], args.typeIds ?? []);
    for (const hit of acceptWithBudget(budget, local)) {
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
    truncated: budget.truncated,
    reason: budget.truncated ? 'cross_network_max_hits' : null,
  };
}

/** Удобный тип: «справочник сетей из systemDb» — соответствует полям
 *  `NetworkRef` плюс реальный id. */
export type NetworkListRef = NetworkRef;
