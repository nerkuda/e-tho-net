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
import type { AstTokenContext, ThoughtQueryRequest } from './query-service.js';
import { BASE_LAYER_ID } from '@etn/shared';
import type { CrossNetworkSearchResponse, CrossNetworkTokenIssue, DuplicateHit, FilterProfileId, NetworksCatalog, NetworkRef, SearchResponse, ThoughtQueryResponse } from '@etn/shared';

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
 *  возвращается `truncated: true`. Неразрешимые токены AST агрегируются по
 *  сетям (у каждой сети свой контекст — первый день недели).
 *
 *  Записи `unresolved` здесь НЕ схлопываются: одна и та же проблема из разных
 *  сетей — разные диагностики (у сети свой контекст), их различает `network_id`.
 *  Дедупликация нужна только внутри одной сети (legacy `scope=thoughts` — два
 *  прогона одного AST, `routes/search.ts`, задача 1169ae37). */
function mergeSearchResponses(
  responses: Array<{ networkId: string; response: SearchResponse }>,
  cap: number,
): { response: CrossNetworkSearchResponse; truncated: boolean } {
  const budget = makeBudget(cap);
  const by_names: SearchResponse['by_names'] = [];
  const by_texts: SearchResponse['by_texts'] = [];
  const by_links: SearchResponse['by_links'] = [];
  const by_chrono: SearchResponse['by_chrono'] = [];
  const total = { names: 0, texts: 0, links: 0, chronology: 0 };
  const unresolved: CrossNetworkTokenIssue[] = [];
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
    if (response.unresolved !== undefined) {
      for (const issue of response.unresolved) {
        unresolved.push({ network_id: networkId, token: issue.token, reason: issue.reason });
      }
    }
  }
  return {
    response: {
      by_names,
      by_texts,
      by_links,
      by_chrono,
      meta: { total_in_group: total },
      ...(unresolved.length > 0 ? { unresolved } : {}),
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
  /**
   * AST-условие мыслевых настроек отбора (профиль `thoughts`, задача
   * d5e8ddc1, требование b91336e7): веерный режим обязан передавать `ast`,
   * иначе настройки отбора терялись бы на каждой сети.
   */
  ast?: import('@etn/shared').FilterAst;
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
  /**
   * Мысль-фокус карты — контекст токенов `$thought*` в `ast` (задача
   * 4b1cc3d4): один id по всем сетям веера, домен разрешает его в каждой
   * сети (мысль ищется в БД этой сети).
   */
  focus_thought_id?: string;
  limit: number;
  offset: number;
  /** Значение `show_inactive` по умолчанию (из пользовательских настроек). */
  showInactiveDefault: boolean;
  /**
   * Контекст разрешения токенов AST по сети (задача 56a143ff): первый день
   * недели у каждой сети свой, поэтому фабрика берёт `networkId`. Отсутствие —
   * исполнение без разрешения календарных токенов.
   */
  tokenContextFor?: (networkId: string) => AstTokenContext;
  /** Потолок суммарной выдачи; по умолчанию {@link CROSS_NETWORK_MAX_HITS}. */
  maxHits?: number;
}

/** Запустить веером {@link search} по всем сетям и слить выдачу. */
export function fanOutSearch(
  access: CrossNetworkAccess,
  args: CrossNetworkSearchArgs,
): { response: CrossNetworkSearchResponse; networks: NetworksCatalog } {
  const ids = normalizeNetworkIds(args.networkIds);
  const accessible = access.networks.filter((n) => ids.includes(n.id));
  const cap = args.maxHits ?? CROSS_NETWORK_MAX_HITS;
  const responses: Array<{ networkId: string; response: SearchResponse }> = [];
  for (const net of accessible) {
    const ndb = openNetworkDbForCrossNetwork(access.dataDir, access.userId, access.clientId, net.id, access.logger);
    const response = search(ndb, {
      q: args.q,
      ast: args.ast,
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
      focus_thought_id: args.focus_thought_id,
      // Берём per-сеть лимит = лимит * |networks|, чтобы после слияния
      // верхушка веера была представлена полностью. Объём удерживает общий
      // потолок `cap` (задача 29bc5673): per-сеть лимит НЕ занижаем до `cap`,
      // иначе обрезка становится неотличима от «ровно в потолок».
      limit: args.limit * Math.max(accessible.length, 1),
      offset: 0,
    }, args.showInactiveDefault, args.tokenContextFor?.(net.id));
    responses.push({ networkId: net.id, response });
  }
  // Сначала сливаем (по сетям уже урезанные по per-сеть-лимиту выборки) с
  // общим бюджетом, затем применяем limit/offset к объединённой выдаче.
  const { response: merged, truncated } = mergeSearchResponses(responses, cap);
  const paginated: CrossNetworkSearchResponse = {
    by_names: merged.by_names.slice(args.offset, args.offset + args.limit),
    by_texts: merged.by_texts.slice(args.offset, args.offset + args.limit),
    by_links: merged.by_links.slice(args.offset, args.offset + args.limit),
    by_chrono: merged.by_chrono.slice(args.offset, args.offset + args.limit),
    meta: merged.meta,
    truncated,
    reason: truncated ? 'cross_network_max_hits' : null,
    // Диагностика неразрешимых токенов агрегирована по сетям — отдаём как есть.
    ...(merged.unresolved !== undefined ? { unresolved: merged.unresolved } : {}),
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
  /** Контекст разрешения токенов AST по сети (обязательный пункт задачи
   *  c13762b1): первый день недели у каждой сети свой, поэтому фабрика берёт
   *  networkId. Отсутствие — исполнение без разрешения календарных токенов. */
  tokenContextFor?: (networkId: string) => AstTokenContext;
  /** Профиль точки применения отбора (требование 0095daad, ADR 0c02ab4f).
   *  По умолчанию `thoughts`; задаётся фасадом точки. */
  profile?: FilterProfileId;
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
  // Неразрешимые токены AST, агрегированные по сетям (требование b7fdab20):
  // у каждой сети свой контекст разрешения (первый день недели, реестр) — в
  // веерном ответе носитель «какая сеть» обязателен.
  const unresolved: import('@etn/shared').CrossNetworkTokenIssue[] = [];
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
      { maxLimit: 200, emptyFilterMode: 'all', profile: args.profile ?? 'thoughts', ...(args.tokenContextFor !== undefined ? { tokenContext: args.tokenContextFor(net.id) } : {}) },
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
    if (result.unresolved !== undefined) {
      for (const issue of result.unresolved) {
        unresolved.push({ network_id: net.id, token: issue.token, reason: issue.reason });
      }
    }
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
      // Отдаём только при непустом наборе — как у одиночной выборки,
      // чтобы «всё разрешилось» не шумело в ответе.
      ...(unresolved.length > 0 ? { unresolved } : {}),
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
