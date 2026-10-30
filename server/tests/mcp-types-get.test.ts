/**
 * `etn.types.get` + расширения `etn.types.list` (задача 17ff4619, 0.15.1).
 *
 * Покрыто:
 *   * `etn.types.get` — по `id` и по `name`, оба каталога, `scope`,
 *     трансклюзии, форма записи совпадает с `etn.types.list`, `NOT_FOUND`,
 *     `VALIDATION_ERROR` с `details.candidates`, XOR `id`/`name`;
 *   * `keywords` — мини-синтаксис §6.10: AND, `*`, `-слово`, регистр; фильтр
 *     до пагинации, totals/эхо в `meta`;
 *   * `compact` — только идентификационные поля (+`usage_count` поддерева);
 *   * явная пагинация — `has_more`/`next_offset` на границе страницы, при
 *     `offset` без `limit` и при обрезке по `max_chars` (сброс записей vs
 *     только сжатие описаний);
 *   * обратная совместимость — вызов без новых параметров не несёт `meta`.
 *
 * Пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { openNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
  type ClientCallToolResult,
} from './mcp-helpers.js';

interface TypeEntry {
  id: string;
  name?: string;
  name_forward?: string;
  name_reverse?: string;
  parent_id: string | null;
  is_root: boolean;
  description?: string | null;
  comment_template_md?: string | null;
  icon?: string | null;
  properties?: Array<Record<string, unknown>>;
  views?: Array<Record<string, unknown>>;
  usage_count?: number;
}

interface ListMeta {
  truncated?: boolean;
  reason?: 'max_chars_preview' | 'max_chars_items' | null;
  thought_types_total?: number;
  link_types_total?: number;
  thought_types_returned?: number;
  link_types_returned?: number;
  limit?: number;
  offset?: number;
  keywords?: string;
  compact?: boolean;
  has_more?: boolean;
  next_offset?: number | null;
  max_chars?: number;
  original_chars?: number;
  final_chars?: number;
}

interface TypesListBody {
  thought_types?: TypeEntry[];
  link_types?: TypeEntry[];
  structural_properties_note?: string;
  meta?: ListMeta;
}

interface TypesGetBody {
  thought_types?: TypeEntry[];
  link_types?: TypeEntry[];
  structural_properties_note?: string;
}

/** `details` ошибки MCP-инструмента (`ETN error [CODE]: …\nDetails: {json}`). */
function errorDetails(result: ClientCallToolResult): Record<string, unknown> {
  const text = toolText(result);
  const marker = 'Details: ';
  const index = text.indexOf(marker);
  assert.ok(index >= 0, `в ошибке нет блока Details: ${text}`);
  return JSON.parse(text.slice(index + marker.length)) as Record<string, unknown>;
}

async function list(
  client: Parameters<typeof createThoughtViaWrite>[0],
  networkId: string,
  args: Record<string, unknown>,
): Promise<TypesListBody> {
  const result = await client.callTool({
    name: 'etn.types.list',
    arguments: { network_id: networkId, ...args },
  });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<TypesListBody>(result);
}

async function get(
  client: Parameters<typeof createThoughtViaWrite>[0],
  networkId: string,
  args: Record<string, unknown>,
): Promise<TypesGetBody> {
  const result = await client.callTool({
    name: 'etn.types.get',
    arguments: { network_id: networkId, ...args },
  });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<TypesGetBody>(result);
}

/** Вставка мысли напрямую (поддерево с типами для `usage_count`/compact). */
function insertThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  typeId: string | null,
  adminId: string,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                            version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024', ?, '2024', ?)`,
    )
    .run(id, title, title.toLowerCase(), typeId, adminId, adminId);
  return id;
}

describe('etn.types.get + list { keywords, compact, meta } (17ff4619)', {
  skip: !nativeAvailable(),
}, () => {
  it('get by id/name returns the SAME record as etn.types.list (both catalogues, transclusions expanded)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const source = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Источник описания типа',
        });
        await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          source.id,
          'Текст из типа.',
        );
        const thoughtTypeName = 'Тип с трансклюзией';
        const linkForward = 'тип-связи-прямой';
        const linkReverse = 'тип-связи-обратный';
        const wrote = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              {
                name: thoughtTypeName,
                description: `До. ![[#${source.id}]] После.`,
                comment_template_md: `Шаблон: ![[#${source.id}]]`,
              },
            ],
            link_types: [
              {
                name_forward: linkForward,
                name_reverse: linkReverse,
                description: `Связь. ![[#${source.id}]]`,
              },
            ],
          },
        });
        assert.equal(wrote.isError, undefined, toolText(wrote));

        // --- thought type: by id (name echoed in lowercase) -----------------
        const listBody = await list(handle.client, ctx.networkId, { scope: 'all' });
        const listedThought = listBody.thought_types!.find((t) => t.name === thoughtTypeName)!;
        assert.ok(listedThought, 'тип отсутствует в каталоге');

        const byId = await get(handle.client, ctx.networkId, { id: listedThought.id });
        assert.equal(byId.thought_types?.length, 1, 'ровно один тип мысли');
        assert.equal(byId.link_types?.length, 0, 'тип связи не найден по id мысли');
        // Форма записи совпадает с каталогом поле-в-поле.
        assert.deepEqual(byId.thought_types![0], listedThought);
        assert.ok(byId.structural_properties_note, 'строка о структурных свойствах');
        // Трансклюзия развёрнута, исходная ссылка не осталась.
        const description = byId.thought_types![0]!.description ?? '';
        assert.ok(description.includes('Текст из типа.'), `трансклюзия не развёрнута: ${description}`);
        assert.ok(!description.includes('![[#'), 'исходная ссылка трансклюзии осталась');
        assert.ok(
          (byId.thought_types![0]!.comment_template_md ?? '').includes('Текст из типа.'),
          'comment_template_md не развёрнут',
        );

        // --- thought type: by name, case-insensitive ------------------------
        const byName = await get(handle.client, ctx.networkId, {
          name: thoughtTypeName.toUpperCase(),
        });
        assert.equal(byName.thought_types?.length, 1);
        assert.equal(byName.thought_types![0]!.id, listedThought.id);

        // --- link type: by name_forward and name_reverse --------------------
        const listedLink = listBody.link_types!.find((t) => t.name_forward === linkForward)!;
        const linkByForward = await get(handle.client, ctx.networkId, { name: linkForward });
        assert.equal(linkByForward.link_types?.length, 1);
        assert.equal(linkByForward.link_types![0]!.id, listedLink.id);
        assert.equal(linkByForward.thought_types?.length, 0);
        assert.deepEqual(linkByForward.link_types![0], listedLink);

        const linkByReverse = await get(handle.client, ctx.networkId, {
          name: linkReverse.toUpperCase(),
        });
        assert.equal(linkByReverse.link_types![0]!.id, listedLink.id);

        // --- scope limits the catalogue -------------------------------------
        const linkOutsideScope = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId, id: listedLink.id, scope: 'thoughts' },
        });
        assert.equal(linkOutsideScope.isError, true, 'id типа связи в scope=thoughts — NOT_FOUND');
        assert.match(toolText(linkOutsideScope), /\[NOT_FOUND\]/);

        const thoughtOutsideScope = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId, name: thoughtTypeName, scope: 'links' },
        });
        assert.equal(thoughtOutsideScope.isError, true, 'имя типа мысли в scope=links — NOT_FOUND');
        assert.match(toolText(thoughtOutsideScope), /\[NOT_FOUND\]/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('scope=all: same name in both catalogues is not ambiguous — both records returned', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const thoughtType = createThoughtType(ndb, { name: 'Общее имя' }, ctx.adminId);
      const linkType = createLinkType(
        ndb,
        { name_forward: 'Общее имя', name_reverse: 'общее обратное' },
        ctx.adminId,
      );

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const body = await get(handle.client, ctx.networkId, { name: 'общее имя' });
        assert.equal(body.thought_types?.length, 1, 'совпадение в каталоге мыслей');
        assert.equal(body.thought_types![0]!.id, thoughtType.id);
        assert.equal(body.link_types?.length, 1, 'совпадение в каталоге связей');
        assert.equal(body.link_types![0]!.id, linkType.id);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ambiguous name inside one catalogue → VALIDATION_ERROR with details.candidates', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // Уникальна только ПАРА имён: forward одного может совпасть с reverse
      // другого — резолв по имени обязан сообщить кандидатов.
      const first = createLinkType(
        ndb,
        { name_forward: 'альфа', name_reverse: 'бета' },
        ctx.adminId,
      );
      const second = createLinkType(
        ndb,
        { name_forward: 'гамма', name_reverse: 'альфа' },
        ctx.adminId,
      );

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ambiguous = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId, name: 'АЛЬФА', scope: 'links' },
        });
        assert.equal(ambiguous.isError, true);
        assert.match(toolText(ambiguous), /\[VALIDATION_ERROR\]/);
        const details = errorDetails(ambiguous);
        const candidates = details.candidates as Array<Record<string, unknown>>;
        assert.equal(candidates.length, 2, 'оба типа-кандидата в details.candidates');
        assert.deepEqual(
          candidates.map((c) => c.id).sort(),
          [first.id, second.id].sort(),
        );
        for (const candidate of candidates) {
          assert.equal(typeof candidate.name_forward, 'string', 'кандидат несёт имя');
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('NOT_FOUND for unknown id/name and VALIDATION_ERROR for XOR id/name', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const unknownId = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId, id: randomUUID() },
        });
        assert.equal(unknownId.isError, true);
        assert.match(toolText(unknownId), /\[NOT_FOUND\]/);

        const unknownName = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId, name: 'такого типа нет' },
        });
        assert.equal(unknownName.isError, true);
        assert.match(toolText(unknownName), /\[NOT_FOUND\]/);

        const neither = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(neither.isError, true);
        assert.match(toolText(neither), /\[VALIDATION_ERROR\]/);
        assert.match(toolText(neither), /Укажите ровно одно/);

        const both = await handle.client.callTool({
          name: 'etn.types.get',
          arguments: { network_id: ctx.networkId, id: randomUUID(), name: 'что-то' },
        });
        assert.equal(both.isError, true);
        assert.match(toolText(both), /\[VALIDATION_ERROR\]/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('keywords: AND, *, -exclusion, case-insensitive; filter runs before pagination', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const alpha = createThoughtType(ndb, { name: 'Связь Альфа' }, ctx.adminId);
      const beta = createThoughtType(ndb, { name: 'Связь Бета' }, ctx.adminId);
      createThoughtType(ndb, { name: 'Гамма' }, ctx.adminId);
      const linkType = createLinkType(
        ndb,
        { name_forward: 'связь', name_reverse: 'связи' },
        ctx.adminId,
      );

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // `*` — подстановка; оба каталога (у связи имя в reverse тоже «связи»).
        const wildcard = await list(handle.client, ctx.networkId, { keywords: 'связ*' });
        assert.deepEqual(
          wildcard.thought_types!.map((t) => t.name).sort(),
          ['Связь Альфа', 'Связь Бета'],
        );
        assert.deepEqual(wildcard.link_types!.map((t) => t.name_forward), ['связь']);
        assert.equal(wildcard.meta?.keywords, 'связ*', 'эхо keywords');
        assert.equal(wildcard.meta?.thought_types_total, 2, 'totals по фильтру');
        assert.equal(wildcard.meta?.link_types_total, 1);
        assert.equal(wildcard.meta?.has_more, false);
        assert.equal(wildcard.meta?.next_offset, null);

        // AND: оба слова обязательны.
        const and = await list(handle.client, ctx.networkId, { keywords: 'связь альфа' });
        assert.deepEqual(and.thought_types!.map((t) => t.id), [alpha.id]);
        assert.deepEqual(and.link_types, [], 'у связи нет слова «альфа»');

        // Исключение: слова не должно быть ни в одном из имён типа.
        const excluded = await list(handle.client, ctx.networkId, {
          keywords: 'связ* -бета',
        });
        assert.deepEqual(excluded.thought_types!.map((t) => t.id), [alpha.id]);
        // У связи «связь»/«связи» слова «бета» нет — исключение её не трогает.
        assert.deepEqual(excluded.link_types!.map((t) => t.id), [linkType.id]);

        // Регистронезависимо.
        const upper = await list(handle.client, ctx.networkId, { keywords: 'СВЯЗЬ' });
        assert.deepEqual(
          upper.thought_types!.map((t) => t.id).sort(),
          [alpha.id, beta.id].sort(),
        );
        assert.deepEqual(upper.link_types!.map((t) => t.id), [linkType.id]);

        // Фильтр до пагинации: limit применяется к отфильтрованному набору.
        const paged = await list(handle.client, ctx.networkId, {
          keywords: 'связ*',
          limit: 1,
          offset: 0,
        });
        assert.equal(paged.thought_types?.length, 1);
        assert.equal(paged.meta?.thought_types_total, 2);
        assert.equal(paged.meta?.thought_types_returned, 1);
        assert.equal(paged.meta?.has_more, true);
        assert.equal(paged.meta?.next_offset, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('compact: only identification fields (usage_count only inside in_subtree_of)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const sectionType = createThoughtType(ndb, { name: 'Раздел' }, ctx.adminId);
      const noteType = createThoughtType(ndb, { name: 'Заметка' }, ctx.adminId);
      const linkType = createLinkType(
        ndb,
        { name_forward: 'содержит', name_reverse: 'входит в' },
        ctx.adminId,
      );
      // Поддерево: seed → A(Раздел) → B(Заметка) + связи внутри.
      const seedId = insertThought(ndb, 'Корень', sectionType.id, ctx.adminId);
      const aId = insertThought(ndb, 'A', sectionType.id, ctx.adminId);
      const bId = insertThought(ndb, 'B', noteType.id, ctx.adminId);
      ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', ?, ?)`,
        )
        .run(randomUUID(), seedId, aId, linkType.id, ctx.adminId, ctx.adminId);
      ndb
        .prepare(
          `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                              created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', ?, ?)`,
        )
        .run(randomUUID(), aId, bId, linkType.id, ctx.adminId, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Без поддерева: ровно id/name/parent_id/is_root.
        const plain = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          compact: true,
          limit: 1,
          offset: 0,
        });
        assert.deepEqual(
          Object.keys(plain.thought_types![0]!).sort(),
          ['id', 'is_root', 'name', 'parent_id'],
          'compact без поддерева — только идентификация',
        );
        assert.equal(plain.meta?.compact, true, 'эхо compact');

        const compactLinks = await list(handle.client, ctx.networkId, {
          scope: 'links',
          compact: true,
        });
        assert.deepEqual(
          Object.keys(compactLinks.link_types![0]!).sort(),
          ['id', 'is_root', 'name_forward', 'name_reverse', 'parent_id'],
          'compact типа связи — только идентификация',
        );

        // В поддереве появляется usage_count (единственное расширение).
        const subtree = await list(handle.client, ctx.networkId, {
          in_subtree_of: aId,
          compact: true,
        });
        assert.deepEqual(subtree.thought_types!.map((t) => t.name).sort(), ['Заметка', 'Раздел']);
        for (const entry of subtree.thought_types!) {
          assert.equal(typeof entry.usage_count, 'number', 'usage_count в поддереве');
          assert.equal('description' in entry, false);
          assert.equal('properties' in entry, false);
          assert.equal('views' in entry, false);
          assert.equal('icon' in entry, false);
        }
        assert.equal(subtree.link_types![0]!.usage_count, 1);
        // scope-эхо отражает отфильтрованный (поддерево) набор.
        assert.equal(subtree.meta?.thought_types_total, 2);
        assert.equal(subtree.meta?.link_types_total, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('pagination meta: has_more/next_offset at page boundary, out-of-range and offset without limit', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      // Плюс корневой тип «основной тип» → 4 записи каталога мыслей.
      for (const name of ['Тип-1', 'Тип-2', 'Тип-3']) {
        createThoughtType(ndb, { name }, ctx.adminId);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const first = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          limit: 2,
          offset: 0,
        });
        assert.equal(first.thought_types?.length, 2);
        assert.equal(first.meta?.thought_types_total, 4);
        assert.equal(first.meta?.thought_types_returned, 2);
        assert.equal(first.meta?.has_more, true, 'за страницей есть записи');
        assert.equal(first.meta?.next_offset, 2);
        assert.equal(first.meta?.truncated, false, 'страница — не обрезка по бюджету');

        const second = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          limit: 2,
          offset: 2,
        });
        assert.equal(second.thought_types?.length, 2);
        assert.equal(second.meta?.has_more, false, 'последняя страница');
        assert.equal(second.meta?.next_offset, null);

        const outOfRange = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          limit: 2,
          offset: 10,
        });
        assert.deepEqual(outOfRange.thought_types, []);
        assert.equal(outOfRange.meta?.has_more, false);
        assert.equal(outOfRange.meta?.next_offset, null);

        // `offset` без `limit` — хвост каталога от позиции (0.15.1).
        const tail = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          offset: 3,
        });
        assert.equal(tail.thought_types?.length, 1, 'одна запись в хвосте');
        assert.equal(tail.meta?.offset, 3);
        assert.equal(tail.meta?.has_more, false);
        assert.equal(tail.meta?.next_offset, null);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('max_chars: preview-only shrink keeps has_more=false; dropped entries move next_offset', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const long = 'x'.repeat(1500);
      for (const name of ['Альфа', 'Бета', 'Гамма']) {
        createThoughtType(ndb, { name, description: long }, ctx.adminId);
      }

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // 4000 Б: описания сжимаются до превью, но все 4 записи остаются.
        const preview = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          max_chars: 4000,
        });
        assert.equal(preview.meta?.truncated, true);
        assert.equal(preview.meta?.reason, 'max_chars_preview');
        assert.equal(preview.thought_types?.length, 4, 'записи не выброшены');
        assert.equal(preview.meta?.has_more, false, 'все записи доставлены — хвоста нет');
        assert.equal(preview.meta?.next_offset, null);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('max_chars: dropped tail is not a complete answer (has_more + next_offset)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const desc = 'y'.repeat(1500);
      for (const name of ['Тип-1', 'Тип-2', 'Тип-3', 'Тип-4', 'Тип-5']) {
        createThoughtType(ndb, { name, description: desc }, ctx.adminId);
      }
      const TOTAL = 6;

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const shrunk = await list(handle.client, ctx.networkId, {
          scope: 'thoughts',
          max_chars: 1200,
        });
        assert.equal(shrunk.meta?.truncated, true);
        assert.equal(shrunk.meta?.reason, 'max_chars_items');
        const returned = shrunk.thought_types?.length ?? 0;
        assert.ok(returned > 0 && returned < TOTAL, `хвост срезан: ${returned} из ${TOTAL}`);
        assert.equal(shrunk.meta?.thought_types_returned, returned);
        assert.equal(shrunk.meta?.has_more, true, 'обрезанный ответ не выглядит полным');
        assert.equal(shrunk.meta?.next_offset, returned, 'next_offset — на первую выброшенную запись');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('legacy call (no new params) keeps the pre-0.15.1 envelope without meta', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const legacy = await list(handle.client, ctx.networkId, {});
        assert.equal(legacy.meta, undefined, 'без новых параметров meta отсутствует');
        assert.ok((legacy.thought_types ?? []).length > 0, 'каталог мыслей на месте');
        assert.ok((legacy.link_types ?? []).length > 0, 'каталог связей на месте');
        assert.ok(
          Object.keys(legacy.thought_types![0]!).includes('properties'),
          'полная форма записи сохранена',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
