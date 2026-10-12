/**
 * views.ts — MCP-инструменты области «registerViewsRunTool».
 * Вынесено из `tools.ts` (ADR 8c93f03a, веха 7 версии 0.8.2) без изменения
 * поведения: фасады разбиты на модули по областям, логика — в домене.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpRuntime } from '../context.js';
import { EtnError, MCP_TOOL_ANNOTATIONS } from '@etn/shared';
import { getThoughtOrThrow } from '../../domain/thought-service.js';
import { ViewsRun } from '../../contracts.js';
import { recordReads } from '../../domain/read-metrics-service.js';
import { thoughtTypeCatalog } from '../catalogs.js';
import { projectThoughtRows } from '../../domain/response-projection.js';
import { getEffectiveViewsForThought, runViewForThought } from '../../domain/thought-type-views-service.js';
import { queryThoughtsAsync } from '../../domain/heavy-read.js';
import { mcpRequestToQuery } from '../../domain/query-service.js';
import { parseFilterAst } from '../../domain/filter-ast.js';
import { openMemberNetwork, runTool } from '../context.js';
import { mcpTokenContext } from './token-context.js';

export function registerViewsRunTool(mcp: McpServer, rt: McpRuntime): void {
  // =========================================================================
  // `etn.views.run` (задача c1fa71d4, 0.7.3, операция cb8d8e43) — исполнение
  // именованного отбора типа относительно конкретной мысли.
  //
  // Агент узнаёт о доступных отборах через `meta.views` в `etn.thoughts.get`
  // и каталог типов в `etn.types.list`; здесь дёргает отбор по `view_name`
  // (нормализованное имя отбора) или по его `id`. Тонкая обёртка над
  // `runViewForThought` (домен, задача 20b2fca0): резолв отбора по
  // эффективному набору мысли, подстановка токенов `$thought.*`/`$today`/…,
  // `queryThoughts` с фильтром. Read-only: бюджет записи не тратит,
  // `audit_log` не пишет.
  // =========================================================================
  mcp.registerTool(
    'etn.views.run',
    {
      title: 'Исполнить отбор типа относительно мысли',
      description:
        'Run a thought-type view for one thought. `view_name` — имя отбора из `meta.views` ' +
        'карточки мысли (нормализованное сравнение, регистр не важен) или его `id`; либо ' +
        'готовое `ast`-тело (грамматика — `etn.guide { topic: "thoughts.query" }`) — ровно одно ' +
        'из двух. Read-only: бюджет записи не тратит, `audit_log` не пишет. ' +
        'Возвращает страницу мыслей + `meta.view` (отбор, который был исполнен; при `ast` — ' +
        '`meta.ast: true`) и `meta.unresolved` (не пусто, если встретился неразрешимый на ' +
        'момент исполнения токен — тогда `data` пустая). Удалённая сущность условия — ' +
        '`VALIDATION_ERROR` (`details.diagnostics`), отвязанное свойство — `meta.warnings`.',
      inputSchema: ViewsRun.schema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.views.run'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = getThoughtOrThrow(ndb, args.thought_id);
        // AST-тело (задача cb78315b, требование a50c7872): готовая форма вместо
        // сохранённого отбора. Разбор формы — доменный (неизвестные поля →
        // VALIDATION_ERROR); исполняет тот же движок, что `etn.thoughts.query`.
        if (args.ast !== undefined) {
          const ast = parseFilterAst(args.ast);
          const req = mcpRequestToQuery(
            {
              ast,
              ...(args.order !== undefined ? { order: args.order } : {}),
              // Тот же дефолт лимита, что у пути сохранённого отбора (100) —
              // иначе два пути etn.views.run отвечали бы разными страницами.
              limit: args.limit ?? 100,
              ...(args.offset !== undefined ? { offset: args.offset } : {}),
            },
            { maxNodes: rt.limits.maxNodesPerSubgraph },
          );
          const result = await queryThoughtsAsync(ndb, rt.deps.auth.userId, req, {
            maxLimit: 200,
            emptyFilterMode: 'all',
            // Обязательный пункт задачи cb78315b: контекст разрешения токенов.
            tokenContext: mcpTokenContext(rt, args.network_id),
            // Профиль точки применения (требование 0095daad, ADR 0c02ab4f).
            profile: 'thoughts',
          });
          recordReads(ndb, result.items.map((i) => i.id), { now: new Date().toISOString() });
          const pageItems = projectThoughtRows(result.items);
          return {
            thought: { id: thought.id, title: thought.title },
            data: pageItems,
            thought_types: thoughtTypeCatalog(ndb, pageItems.map((it) => it.type_id)),
            meta: {
              total: result.total,
              limit: req.limit,
              offset: req.offset,
              sort: req.sort,
              order: req.order,
              ast: true,
              has_more: result.has_more,
              next_cursor: result.next_cursor,
              ...(result.unresolved !== undefined && result.unresolved.length > 0
                ? {
                    unresolved: result.unresolved.map((u) => ({
                      token: u.token,
                      reason: u.reason,
                    })),
                  }
                : {}),
            },
          };
        }
        // Резолв отбора по эффективному набору мысли. Схема гарантирует ровно
        // одно из `view_name`/`ast`, поэтому здесь `view_name` задан.
        const viewName = args.view_name as string;
        const effective = getEffectiveViewsForThought(ndb, thought);
        // Сравнение по `name_key` (trim+lowercase) — соответствует правилу
        // сравнения дублей в `findThoughtTypeViewByTypeAndNameKey`. Если
        // в `view_name` пришёл uuid отбора (id), тоже сматчим — иначе
        // агенту пришлось бы всегда передавать имя.
        const trimmed = viewName.trim();
        const lower = trimmed.toLowerCase();
        const matched =
          effective.find((v) => v.name_key === lower) ??
          effective.find((v) => v.id === trimmed) ??
          null;
        if (matched === null) {
          // Доступно ошибочное состояние, при котором `view_name` похоже на
          // имя, но не входит в эффективный набор. Чтобы помочь агенту,
          // возвращаем 404 c `details.available_views` — список имён
          // эффективного набора. Не молча пустой массив.
          throw new EtnError(
            'NOT_FOUND',
            `Отбор «${viewName}» не найден в эффективном наборе мысли ${args.thought_id}.`,
            {
              entity: 'thought_type_view',
              view_name: viewName,
              thought_id: args.thought_id,
              available_views: effective.map((v) => ({
                id: v.id,
                name: v.name,
                name_key: v.name_key,
                is_default: v.is_default,
              })),
            },
          );
        }
        // `runViewForThought` (домен) уже подставляет токены и фильтрует
        // саму мысль из результата. Здесь — тонкая обёртка: пользовательский
        // `limit`/`offset`/`order` пробрасывается в SQL-движок; сортировка
        // исполняется движком по сохранённому в отборе `sort`/`order`
        // (контракт как у REST — задача c5265deb, ошибка 4dd14aa3).
        const base = await runViewForThought(
          ndb,
          matched,
          args.thought_id,
          rt.deps.auth.userId,
          undefined,
          {
            ...(args.order !== undefined ? { order: args.order } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.offset !== undefined ? { offset: args.offset } : {}),
            // Обязательный пункт задачи cb78315b: контекст разрешения токенов
            // (нужен для отборов, хранящих определение в форме AST).
            tokenContext: mcpTokenContext(rt, args.network_id),
          },
        );
        // Страница уже отсортирована и спагинирована SQL-движком — никакой
        // JS-пересортировки по названию (задача c5265deb).
        //
        // MCP-проекция списка — единый сериализатор (projection.ts): у записей
        // снимаются визуальные и сервисные поля, пустые контейнеры не пишутся,
        // `icon` остаётся. `etn.views.run` параметра `view` не имеет — как и
        // `etn.thoughts.query`, списочный ответ всегда компактный.
        const pageItems = projectThoughtRows(base.items);
        const limit = args.limit ?? 100;
        const offset = args.offset ?? 0;
        // Reference table: типы мыслей, реально использованные в items.
        const thoughtTypes = thoughtTypeCatalog(
          ndb,
          pageItems.map((it) => it.type_id),
        );
        // O10: посещение контекстной мысли считается за чтение.
        recordReads(ndb, [args.thought_id], { now: new Date().toISOString() });
        return {
          thought: { id: thought.id, title: thought.title },
          view: {
            id: matched.id,
            name: matched.name,
            name_key: matched.name_key,
            description: matched.description,
            defined_on: matched.defined_on,
            inherited: matched.inherited,
          },
          data: pageItems,
          thought_types: thoughtTypes,
          meta: {
            total: base.total,
            limit,
            offset,
            sort: base.sort,
            order: base.order,
            ...(base.unresolved.length > 0
              ? {
                  unresolved: base.unresolved.map((u) => ({
                    token: u.token,
                    reason: u.reason,
                  })),
                }
              : {}),
            // Жёлтая диагностика (требование 325efc13): свойство отвязано от
            // типа — отбор исполнен, предупреждение видно агенту.
            ...(base.warnings !== undefined && base.warnings.length > 0
              ? { warnings: base.warnings }
              : {}),
          },
        };
      }),
  );

  // etn.changes.list — O9 read tool. Delta feed over the real-time event_log
  // (04-realtime.md §3, §6) for long-lived agents that maintain their own
  // cache. Same retention window as the WebSocket gateway (24h / 10 000 rows,
  // `REALTIME_DEFAULTS.EVENT_LOG_*`) — when the agent's `since_seq` falls
  // outside the retained buffer, the response carries `truncated: true` so
  // the caller knows to do a full resync instead of resuming. No `data.db`
  // access: the event log lives in `_system.db` (see migration
  // `009_event_log.sql`), so we reuse the membership-only check pattern from
  // `etn.networks.structure`.
}
