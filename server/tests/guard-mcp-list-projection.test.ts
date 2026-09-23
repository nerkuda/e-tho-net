/**
 * Сторож формы записей списочных ответов MCP (задача 6ee904ad, требование
 * «Компактная проекция ответов view compact и full», блок «Актуализация 0.8.3»).
 *
 * Правило. Записи всех списочных ответов формируются единым сериализатором
 * `server/src/mcp/projection.ts`. В компактном списке не остаётся:
 *   * визуальных полей (`fg_color`, `bg_color`, `font_*`, `icon_kind`,
 *     `icon_attachment_id`);
 *   * сервисных полей (`version`, `created_by`, `updated_by`,
 *     `marked_for_deletion_at`, `marked_for_deletion_by`, `manual_position`);
 *   * пустых контейнеров (`views`, `synonyms`, `link_types`, `chronological`);
 *   * дублей тела постоянного комментария (текст едет один раз).
 *
 * Как проверяется. Сторож поднимает реальную MCP-сессию (`buildMcpContext` +
 * `connectMcpClient`), засевает граф с заполненными визуальными/сервисными
 * полями и вызывает каждый списочный инструмент, после чего сканирует именно
 * массивы записей ответа. Инструмент, который соберёт запись в обход
 * сериализатора, уронит сторож при обычном `npm test`.
 *
 * Наборы ключей импортируются из самого сериализатора — расширение проекции
 * расширяет и сторож, отдельного списка держать не нужно.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { openNetworkDb } from '../src/db/network-db.js';
import {
  COMPACT_EMPTY_CONTAINER_KEYS,
  COMPACT_SERVICE_FIELD_KEYS,
  COMPACT_VISUAL_FIELD_KEYS,
  isEmptyContainer,
} from '../src/mcp/projection.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
  type ClientCallToolResult,
  type McpTestContext,
} from './mcp-helpers.js';

/** Обязательные к отсутствию поля записи списка. */
const FORBIDDEN_FIELD_KEYS = [...COMPACT_VISUAL_FIELD_KEYS, ...COMPACT_SERVICE_FIELD_KEYS];

/**
 * Проверить форму одной записи: нет запрещённых полей и нет пустых контейнеров.
 */
function assertRowShape(row: unknown, label: string): void {
  assert.ok(row !== null && typeof row === 'object', `${label}: запись должна быть объектом`);
  const record = row as Record<string, unknown>;
  for (const key of FORBIDDEN_FIELD_KEYS) {
    assert.equal(key in record, false, `${label}: запись списка не должна нести «${key}»`);
  }
  for (const key of COMPACT_EMPTY_CONTAINER_KEYS) {
    if (key in record) {
      assert.equal(
        isEmptyContainer(key, record[key]),
        false,
        `${label}: пустой контейнер «${key}» не должен сериализоваться`,
      );
    }
  }
}

/** Проверить форму массива записей. */
function assertRowsShape(rows: unknown, label: string): void {
  assert.ok(Array.isArray(rows), `${label}: ожидался массив записей`);
  rows.forEach((row, index) => assertRowShape(row, `${label}[${index}]`));
}

/** Проверить форму словаря-справочника записей. */
function assertCatalogShape(catalog: unknown, label: string): void {
  if (catalog === undefined) return;
  assert.ok(catalog !== null && typeof catalog === 'object', `${label}: ожидался справочник`);
  for (const [key, row] of Object.entries(catalog as Record<string, unknown>)) {
    assertRowShape(row, `${label}.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Фикстура: типы, мысли с богатыми визуальными/сервисными полями, роли
// ---------------------------------------------------------------------------

interface Fixture {
  richId: string;
  grandId: string;
  sectionId: string;
  instructionId: string;
  searchId: string;
  trashedId: string;
  versionTypeId: string;
  sectionTypeId: string;
}

/** Прямая SQL-вставка типа мысли (MCP-инструмента создания типа нет). */
function insertThoughtType(
  ndb: ReturnType<typeof openNetworkDb>,
  name: string,
  userId: string,
  opts: { isRoot?: boolean; parentId?: string | null } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, is_root, parent_id, version,
                                  description, icon, icon_kind, fg_color, bg_color, font_bold,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, '🧩', 'emoji', '#010203', '#040506', 1, ?, ?, ?, ?)`,
    )
    .run(id, name, name.toLowerCase(), opts.isRoot ? 1 : 0, opts.parentId ?? null,
      'тип для сторожа проекции', now, now, userId, userId);
  return id;
}

/**
 * Прямая SQL-вставка мысли со всеми визуальными/сервисными полями: `icon_kind`,
 * `fg_color`/`bg_color`, ручные флаги шрифта, `version`, авторство, отметки
 * удаления. Через MCP такие поля не выставить — они и есть цель сторожа.
 */
function insertRichThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  opts: { typeId: string | null; userId: string; trashed?: boolean; markedAt?: string | null },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, marked_for_deletion_at, marked_for_deletion_by,
                             fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
                             font_manual, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, '🎨', 'emoji', ?, 1, 0, 0,
               ?, ?, ?,
               '#112233', '#445566', 1, 0, 1, 0,
               5, 7, ?, ?,
               ?, ?, ?, ?)`,
    )
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      opts.typeId,
      null, // icon_attachment_id — поле присутствует в сырой строке как `null`
      opts.trashed ? 1 : 0,
      opts.markedAt ?? null,
      opts.markedAt === undefined || opts.markedAt === null ? null : opts.userId,
      now,
      now,
      opts.userId,
      opts.userId,
      Date.now(),
      Date.now(),
    );
  return id;
}

/** Прямая вставка типизированного ребра. */
function insertLink(
  ndb: ReturnType<typeof openNetworkDb>,
  sourceId: string,
  targetId: string,
  typeId: string | null,
  opts: { userId: string; trashed?: boolean } = { userId: '' },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          color, style, width, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, '#00ff00', 'dotted', 5, 3, ?, ?, ?, ?)`,
    )
    .run(id, sourceId, targetId, typeId, opts.trashed ? 1 : 0, now, now, opts.userId, opts.userId);
  return id;
}

/** Заполнить сеть сторожа. */
function seedFixture(ctx: McpTestContext): Fixture {
  const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
  const userId = ctx.adminId;
  const versionTypeId = insertThoughtType(ndb, 'версия', userId);
  const sectionTypeId = insertThoughtType(ndb, 'раздел', userId);
  const instructionTypeId = insertThoughtType(ndb, 'инструкция', userId);

  // Отбор у типа «версия» — чтобы `etn.views.run` вернул непустую страницу.
  ndb
    .prepare(
      `INSERT INTO thought_type_views (id, layer_id, thought_type_id, name, name_key, description,
                                       definition, position, is_default, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, 'Работы версии', 'работы версии', NULL, ?, 0, 0, 1, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      ndb.layerId,
      versionTypeId,
      JSON.stringify({ filters: [], sort: 'alpha', order: 'asc' }),
      new Date().toISOString(),
      new Date().toISOString(),
      userId,
    );

  const richId = insertRichThought(ndb, 'Богатая мысль', { typeId: versionTypeId, userId });
  const grandId = insertRichThought(ndb, 'Внук богатой', { typeId: null, userId });
  insertLink(ndb, richId, grandId, null, { userId });
  // Ребро вверх к HOME — чтобы соседи/подграф видели богатую мысль как ребёнка.
  insertLink(ndb, ctx.homeId, richId, null, { userId });

  const sectionId = insertRichThought(ndb, 'Раздел структуры', { typeId: sectionTypeId, userId });
  insertLink(ndb, ctx.homeId, sectionId, null, { userId });
  const instructionId = insertRichThought(ndb, 'Инструкция сети', {
    typeId: instructionTypeId,
    userId,
  });
  insertLink(ndb, ctx.homeId, instructionId, null, { userId });

  const trashedId = insertRichThought(ndb, 'Корзинная мысль', {
    typeId: null,
    userId,
    trashed: true,
    markedAt: new Date().toISOString(),
  });
  const trashedLinkId = insertLink(ndb, ctx.homeId, trashedId, null, { userId, trashed: true });
  void trashedLinkId;

  // Роли сети: структура (оглавление) и витрина инструкций.
  const current = ctx.sys.getNetworkById(ctx.networkId)!;
  ctx.sys.updateNetwork(ctx.networkId, {
    displayName: current.display_name,
    description: current.description,
    when_to_use: current.when_to_use,
    conventions: current.conventions,
    examples: current.examples,
    type_roles: { table_of_contents: sectionTypeId, instructions: instructionTypeId },
  });

  return {
    richId,
    grandId,
    sectionId,
    instructionId,
    searchId: '',
    trashedId,
    versionTypeId,
    sectionTypeId,
  };
}

/** Вызвать инструмент и вернуть JSON, проверив отсутствие ошибки. */
async function call(
  client: Awaited<ReturnType<typeof connectMcpClient>>['client'],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result: ClientCallToolResult = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, `${name}: ${toolText(result)}`);
  return toolJson(result);
}

// ---------------------------------------------------------------------------

describe('guard: форма записей списочных ответов MCP (задача 6ee904ad)', { skip: !nativeAvailable() }, () => {
  it('все списочные инструменты отдают записи без визуальных/сервисных полей и пустых контейнеров', async () => {
    const ctx = await buildMcpContext();
    try {
      const fixture = seedFixture(ctx);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const client = handle.client;

        // --- search ---------------------------------------------------------
        const searchId = (
          await createThoughtViaWrite(client, ctx.networkId, {
            title: 'Сторожевая мысль поиска',
            comment: { body_md: 'тело комментария для полнотекстового поиска' },
          })
        ).id;
        const search = (await call(client, 'etn.thoughts.search', {
          network_id: ctx.networkId,
          query: 'Сторожевая',
        })) as Record<string, unknown>;
        assertRowsShape(search.by_names, 'search.by_names');
        assertRowsShape(search.by_texts, 'search.by_texts');
        assertRowsShape(search.by_links, 'search.by_links');
        assertRowsShape(search.by_chrono, 'search.by_chrono');
        void searchId;

        // --- views.run ------------------------------------------------------
        const views = (await call(client, 'etn.views.run', {
          network_id: ctx.networkId,
          thought_id: fixture.richId,
          view_name: 'Работы версии',
        })) as Record<string, unknown>;
        assertRowsShape(views.data, 'views.run.data');

        // --- resolve --------------------------------------------------------
        const resolve = (await call(client, 'etn.thoughts.resolve', {
          network_id: ctx.networkId,
          thought_ids: [fixture.richId, fixture.sectionId],
        })) as { items: Array<Record<string, unknown>> };
        assertRowsShape(resolve.items, 'resolve.items');
        for (const card of resolve.items) {
          // Дубль тела постоянного комментария запрещён: текст — только в
          // `comment_preview`, `meta.permanent` обнулён (ошибка 29def270).
          const meta = card.meta as { permanent?: unknown } | undefined;
          assert.equal(meta?.permanent ?? null, null, 'resolve: meta.permanent не должен дублировать текст');
        }

        // --- neighbors (depth 1, both) --------------------------------------
        const neighbors = (await call(client, 'etn.thoughts.neighbors', {
          network_id: ctx.networkId,
          thought_id: fixture.richId,
          dir: 'both',
        })) as Record<string, unknown>;
        assertRowsShape(neighbors.neighbors, 'neighbors.neighbors');
        assertCatalogShape(neighbors.thought_types, 'neighbors.thought_types');
        assertCatalogShape(neighbors.link_types, 'neighbors.link_types');
        // depth>1 — ThoughtRef[].
        const deep = (await call(client, 'etn.thoughts.neighbors', {
          network_id: ctx.networkId,
          thought_id: fixture.richId,
          dir: 'children',
          depth: 2,
        })) as Record<string, unknown>;
        assertRowsShape(deep.thoughts, 'neighbors(depth=2).thoughts');

        // --- subgraph -------------------------------------------------------
        const subgraph = (await call(client, 'etn.thoughts.subgraph', {
          network_id: ctx.networkId,
          seed_ids: [fixture.richId],
          radius: 2,
        })) as Record<string, unknown>;
        assertRowsShape(subgraph.nodes, 'subgraph.nodes');
        assertRowsShape(subgraph.edges, 'subgraph.edges');
        assertCatalogShape(subgraph.thought_types, 'subgraph.thought_types');
        assertCatalogShape(subgraph.link_types, 'subgraph.link_types');

        // --- instructions ---------------------------------------------------
        const instructions = (await call(client, 'etn.instructions', {
          network_id: ctx.networkId,
        })) as { instructions: Array<Record<string, unknown>> };
        assertRowsShape(instructions.instructions, 'instructions.instructions');
        // У инструкции нет синонимов — пустое поле не сериализуется.
        for (const item of instructions.instructions) {
          assert.equal('synonyms' in item, false, 'instructions: пустой synonyms не сериализуется');
        }

        // --- networks.structure ---------------------------------------------
        const structure = (await call(client, 'etn.networks.structure', {
          network_id: ctx.networkId,
        })) as Record<string, unknown>;
        assertRowsShape(structure.sections, 'structure.sections');
        assertRowShape(structure.node_section_type, 'structure.node_section_type');
        assertCatalogShape(structure.thought_types, 'structure.thought_types');

        // --- types.list -----------------------------------------------------
        const types = (await call(client, 'etn.types.list', {
          network_id: ctx.networkId,
        })) as Record<string, unknown>;
        assertRowsShape(types.thought_types, 'types.list.thought_types');
        assertRowsShape(types.link_types, 'types.list.link_types');

        // --- find_duplicates / path / trash.list / usage (тот же класс списков) --
        const duplicates = (await call(client, 'etn.thoughts.find_duplicates', {
          network_id: ctx.networkId,
          title: 'Богатая мысль',
        })) as unknown;
        assertRowsShape(duplicates, 'find_duplicates[]');

        const path = (await call(client, 'etn.thoughts.path', {
          network_id: ctx.networkId,
          from_id: ctx.homeId,
          to_id: fixture.richId,
        })) as Record<string, unknown>;
        assertRowsShape(path.thoughts, 'path.thoughts');

        const trash = (await call(client, 'etn.trash.list', {
          network_id: ctx.networkId,
        })) as Record<string, unknown>;
        assertRowsShape(trash.thoughts, 'trash.thoughts');
        assertRowsShape(trash.links, 'trash.links');

        const usage = (await call(client, 'etn.thoughts.usage', {
          network_id: ctx.networkId,
          thought_id: fixture.grandId,
        })) as { groups: Array<{ thoughts: unknown[] }> };
        for (const group of usage.groups) {
          assertRowsShape(group.thoughts, 'usage.groups[].thoughts');
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

/** Размер JSON-ответа в байтах UTF-8. */
function responseBytes(result: ClientCallToolResult): number {
  return Buffer.byteLength(toolText(result), 'utf8');
}

/**
 * Бюджеты объёма типовых ответов на фикстуре сторожа (байты UTF-8).
 * Фактические значения, измеренные на фикстуре (2026-09-23, ветка 0.8.3):
 *
 *   search=526, views.run=918, resolve=3271, neighbors=1140,
 *   subgraph=5221, instructions=334, networks.structure=1704, types.list=3856
 *
 * Пороги — «факт × ~1,4», чтобы правка с ожидаемым ростом данных не краснила
 * зря, а утечка визуальных/сервисных полей или возврат пустых контейнеров
 * (рост на десятки процентов) роняла сторож. Ориентир критериев приёмки
 * тех.проекта — типичный обзорный вызов ≤ 10 КБ; все бюджеты ниже.
 */
const RESPONSE_BUDGET_BYTES = {
  search: 800,
  viewsRun: 1400,
  resolve: 5000,
  neighbors: 1700,
  subgraph: 7500,
  instructions: 600,
  structure: 2600,
  typesList: 5500,
} as const;

describe('guard: бюджеты объёма типовых ответов MCP (задача 6ee904ad)', { skip: !nativeAvailable() }, () => {
  it('типичные списочные ответы укладываются в числовые пороги', async () => {
    const ctx = await buildMcpContext();
    try {
      const fixture = seedFixture(ctx);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const client = handle.client;
        await createThoughtViaWrite(client, ctx.networkId, {
          title: 'Обзорная мысль',
          comment: { body_md: 'тело комментария для обзора' },
        });

        const cases: Array<{ name: string; budget: number; call: () => Promise<ClientCallToolResult> }> = [
          {
            name: 'search',
            budget: RESPONSE_BUDGET_BYTES.search,
            call: () =>
              client.callTool({
                name: 'etn.thoughts.search',
                arguments: { network_id: ctx.networkId, query: 'Обзорная' },
              }),
          },
          {
            name: 'views.run',
            budget: RESPONSE_BUDGET_BYTES.viewsRun,
            call: () =>
              client.callTool({
                name: 'etn.views.run',
                arguments: { network_id: ctx.networkId, thought_id: fixture.richId, view_name: 'Работы версии' },
              }),
          },
          {
            name: 'resolve',
            budget: RESPONSE_BUDGET_BYTES.resolve,
            call: () =>
              client.callTool({
                name: 'etn.thoughts.resolve',
                arguments: { network_id: ctx.networkId, thought_ids: [fixture.richId, fixture.sectionId] },
              }),
          },
          {
            name: 'neighbors',
            budget: RESPONSE_BUDGET_BYTES.neighbors,
            call: () =>
              client.callTool({
                name: 'etn.thoughts.neighbors',
                arguments: { network_id: ctx.networkId, thought_id: fixture.richId, dir: 'both' },
              }),
          },
          {
            name: 'subgraph',
            budget: RESPONSE_BUDGET_BYTES.subgraph,
            call: () =>
              client.callTool({
                name: 'etn.thoughts.subgraph',
                arguments: { network_id: ctx.networkId, seed_ids: [fixture.richId], radius: 2 },
              }),
          },
          {
            name: 'instructions',
            budget: RESPONSE_BUDGET_BYTES.instructions,
            call: () =>
              client.callTool({ name: 'etn.instructions', arguments: { network_id: ctx.networkId } }),
          },
          {
            name: 'networks.structure',
            budget: RESPONSE_BUDGET_BYTES.structure,
            call: () =>
              client.callTool({
                name: 'etn.networks.structure',
                arguments: { network_id: ctx.networkId },
              }),
          },
          {
            name: 'types.list',
            budget: RESPONSE_BUDGET_BYTES.typesList,
            call: () =>
              client.callTool({ name: 'etn.types.list', arguments: { network_id: ctx.networkId } }),
          },
        ];

        const measured: string[] = [];
        for (const testCase of cases) {
          const result = await testCase.call();
          assert.equal(result.isError, undefined, `${testCase.name}: ${toolText(result)}`);
          const bytes = responseBytes(result);
          measured.push(`${testCase.name}=${bytes}`);
          assert.ok(
            bytes <= testCase.budget,
            `${testCase.name}: ответ ${bytes} Б превышает бюджет ${testCase.budget} Б`,
          );
        }
        // Фактические значения фиксируются в выводе теста — при регрессии
        // объёма видно, насколько и куда он уехал.
        console.log(`[budgets] фактические размеры: ${measured.join(', ')}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('компактная проекция строго меньше полной на той же карточке', async () => {
    const ctx = await buildMcpContext();
    try {
      const fixture = seedFixture(ctx);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const compact = responseBytes(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: { network_id: ctx.networkId, thought_ids: [fixture.richId] },
          }),
        );
        const full = responseBytes(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: { network_id: ctx.networkId, thought_ids: [fixture.richId], view: 'full' },
          }),
        );
        console.log(`[budgets] resolve.card compact=${compact}, full=${full}`);
        assert.ok(
          compact < full,
          `compact-проекция resolve (${compact} Б) должна быть меньше full (${full} Б)`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});

  it('точечный thoughts.get сохраняет полную проекцию (сервисные поля на месте)', async () => {
    const ctx = await buildMcpContext();
    try {
      const fixture = seedFixture(ctx);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const card = (await call(handle.client, 'etn.thoughts.get', {
          network_id: ctx.networkId,
          thought_id: fixture.richId,
        })) as Record<string, unknown>;
        // Контрольная точка границы: get НЕ использует списочный сериализатор —
        // сервисные поля (ревизия, авторство) остаются полными.
        assert.equal(card.version, 7);
        assert.equal(card.created_by, ctx.adminId);
        assert.equal(card.synonyms !== undefined, true, 'get: synonyms сохраняется даже пустым');
        // Признаки защиты/HOME снимаются и в компактной проекции get.
        assert.equal(card.is_protected, undefined);
        assert.equal(card.is_root, undefined);
        // Визуальные поля снимаются и в компактной проекции get.
        for (const key of COMPACT_VISUAL_FIELD_KEYS) {
          assert.equal(key in card, false, `get: визуальное поле «${key}» должно быть снято`);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
