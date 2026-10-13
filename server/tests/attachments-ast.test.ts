/**
 * Отбор вложений на общий AST (задача 5a007bed; требование f67c85c1 «Вложения:
 * операнды профиля», 0095daad «Профили контекста точек применения»; ADR
 * 0c02ab4f).
 *
 * Покрытие DoD:
 *   * операнды профиля «вложения» (имя, тип, MIME, владельцы, размер) работают
 *     через единый AST-исполнитель;
 *   * сценарий «Вложения в (выборке: изображение И размер > 1МБ)»;
 *   * пограничный «вложение без владельцев» (`owner.is_empty`);
 *   * видимость профиля (операнд/оператор вне профиля → VALIDATION_ERROR);
 *   * `ast` XOR плоские фильтры (`parseAttachmentSearchQuery`);
 *   * идентичность прежнему плоскому поиску (независимая сыро-SQL реализация);
 *   * REST `GET /attachments?ast=…` и MCP `etn.ops attachments.search` — паритет.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  EtnError,
  FILTER_AST_VERSION,
  buildLikePattern,
  type FilterAst,
  type FilterAstNode,
} from '@etn/shared';

import {
  createAttachmentResult,
  parseAttachmentSearchQuery,
  searchAttachments,
  searchAttachmentsByAst,
} from '../src/domain/attachment-service.js';
import {
  apiCreateThought,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable as mcpNativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** Обернуть фильтр-узел в тело отбора AST. */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Лист отбора: операнд (`{entity:{kind}}`) + оператор + (опц.) значение. */
function leaf(partial: { entity: Record<string, unknown> }, operator: string, value?: unknown): FilterAstNode {
  const out: Record<string, unknown> = { entity: partial.entity, operator };
  if (value !== undefined) out['value'] = value;
  return out as unknown as FilterAstNode;
}

/** Структурная связь «родитель → ребёнок» через свойство «Потомки». */
async function setChildren(
  ctx: RestTestContext,
  parentId: string,
  childIds: string[],
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${parentId}/properties/${encodeURIComponent('Потомки')}`,
    headers: { authorization: `Bearer ${ctx.adminKey}` },
    payload: { value: childIds },
  });
  assert.equal(res.statusCode, 200, res.body);
}

const MPI = 1024 * 1024;

describe('отбор вложений на общий AST (задача 5a007bed)', { skip: !nativeAvailable() }, () => {
  let ctx: RestTestContext;
  let thoughtA: string;
  let thoughtB: string;
  let thoughtC: string;
  const ids: Record<string, string> = {};

  before(async () => {
    ctx = await buildRestContext();
    const a = await apiCreateThought(ctx, { title: 'Мысль А' });
    thoughtA = a.data.id as string;
    const b = await apiCreateThought(ctx, { title: 'Мысль Б' });
    thoughtB = b.data.id as string;
    // Мысль В — структурный потомок А (для «владельцы в иерархии»).
    const c = await apiCreateThought(ctx, { title: 'Мысль В' });
    thoughtC = c.data.id as string;
    await setChildren(ctx, thoughtA, [thoughtC]);

    const mk = (
      ownerId: string,
      input: Parameters<typeof createAttachmentResult>[3],
    ): string =>
      createAttachmentResult(ctx.ndb, 'thought', ownerId, input, ctx.adminId).attachment.id;

    ids['imgA'] = mk(thoughtA, {
      kind: 'url',
      url: 'https://example.test/img-a.png',
      title: 'Схема дома',
      mime_type: 'image/png',
      file_size: 2 * MPI,
    });
    ids['txtA'] = mk(thoughtA, {
      kind: 'url',
      url: 'https://example.test/notes.txt',
      title: 'Заметки',
      mime_type: 'text/plain',
      file_size: 512,
    });
    ids['imgB'] = mk(thoughtB, {
      kind: 'url',
      url: 'https://example.test/img-b.jpg',
      title: 'Фото',
      mime_type: 'image/jpeg',
      file_size: 3 * MPI,
    });
    ids['pdfC'] = mk(thoughtC, {
      kind: 'url',
      url: 'https://example.test/doc-c.pdf',
      title: 'Документ',
      mime_type: 'application/pdf',
      file_size: 4 * MPI,
    });
    ids['orphan'] = mk(thoughtA, {
      kind: 'url',
      url: 'https://example.test/orphan.png',
      title: 'Сирота',
      mime_type: 'image/png',
      file_size: 5 * MPI,
    });
    // «Вложение без владельцев»: снимаем живые владения НАПРЯМУЮ — owner-cleanup
    // через API удалил бы саму строку, и случай был бы недостижим.
    ctx.ndb
      .prepare('DELETE FROM attachment_owners WHERE attachment_id = ?')
      .run(ids['orphan']);
  });

  after(async () => {
    await closeRestContext(ctx);
  });

  const idsOf = (a: FilterAst): string[] =>
    searchAttachmentsByAst(ctx.ndb, a)
      .items.map((i) => i.id)
      .sort();
  const sorted = (...list: string[]): string[] => [...list].sort();

  it('профиль: операнд/оператор вне профиля «вложения» отвергается', () => {
    // «Есть слова» (keywords) — операнд мыслей, в профиле вложений невидим.
    assert.throws(
      () => idsOf(ast(leaf({ entity: { kind: 'keywords' } }, 'matches', 'ex'))),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
    // «Размер» с оператором, которого нет в наборе (`contains`).
    assert.throws(
      () => idsOf(ast(leaf({ entity: { kind: 'size' } }, 'contains', 10))),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('сценарий: изображение И размер > 1МБ В выборке мыслей', () => {
    // «В (выборке: изображение И размер > 1МБ)»: владелец ∈ подвыборке мыслей,
    // MIME содержит image, размер больше 1 МиБ.
    const filter: FilterAstNode = {
      op: 'and',
      children: [
        leaf(
          { entity: { kind: 'owner' } },
          'in',
          {
            query: leaf({ entity: { kind: 'id' } }, 'in', [thoughtA]),
            operator: 'in',
          },
        ),
        leaf({ entity: { kind: 'mime_type' } }, 'contains', 'image'),
        leaf({ entity: { kind: 'size' } }, 'gt', MPI),
      ],
    };
    assert.deepEqual(idsOf(ast(filter)), [ids['imgA']!]);
  });

  it('имя/тип/MIME/размер — операнды профиля', () => {
    // Имя: равно / содержит / в списке / «есть слова».
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'name' } }, 'eq', 'Схема дома'))), [ids['imgA']!]);
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'name' } }, 'contains', 'замет'))), [ids['txtA']!]);
    assert.deepEqual(
      idsOf(ast(leaf({ entity: { kind: 'name' } }, 'in', ['Фото', 'Сирота']))),
      sorted(ids['imgB']!, ids['orphan']!),
    );
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'name' } }, 'matches', 'сирота'))), [ids['orphan']!]);
    // Тип: file/url (все пять — url).
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'kind' } }, 'in', ['file']))), []);
    assert.equal(idsOf(ast(leaf({ entity: { kind: 'kind' } }, 'in', ['url']))).length, 5);
    // MIME: содержит / в списке.
    assert.deepEqual(
      idsOf(ast(leaf({ entity: { kind: 'mime_type' } }, 'in', ['image/png']))),
      sorted(ids['imgA']!, ids['orphan']!),
    );
    // Размер: между / сравнение / заполнено.
    assert.deepEqual(
      idsOf(ast(leaf({ entity: { kind: 'size' } }, 'between', [MPI, 2 * MPI]))),
      [ids['imgA']!],
    );
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'size' } }, 'lt', 1000))), [ids['txtA']!]);
    assert.equal(idsOf(ast(leaf({ entity: { kind: 'size' } }, 'not_empty'))).length, 5);
  });

  it('пограничный: «вложение без владельцев» (owner.is_empty)', () => {
    // Вложение без живых владений видно только по «не заполнено».
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'is_empty'))), [ids['orphan']!]);
    assert.deepEqual(
      idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'not_empty'))),
      sorted(ids['imgA']!, ids['txtA']!, ids['imgB']!, ids['pdfC']!),
    );
  });

  it('владельцы: список типов, подвыборка мыслей, количество, иерархия', () => {
    const sub = (thoughtIds: string[], operator: 'in' | 'not_in' | 'all_in') =>
      leaf(
        { entity: { kind: 'owner' } },
        operator === 'all_in' ? 'all_of' : operator,
        {
          query: leaf({ entity: { kind: 'id' } }, 'in', thoughtIds),
          operator,
        },
      );
    // «В списке» по ТИПУ владельца.
    assert.equal(idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'in', ['thought']))).length, 4);
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'in', ['publication']))), []);
    // Подвыборка мыслей-владельцев: вложение без владельцев НЕ удовлетворяет.
    assert.deepEqual(
      idsOf(ast(sub([thoughtA], 'in'))),
      sorted(ids['imgA']!, ids['txtA']!),
    );
    // «Не в выборке» — тоже требует хотя бы одного владельца.
    assert.deepEqual(
      idsOf(ast(sub([thoughtA], 'not_in'))),
      sorted(ids['imgB']!, ids['pdfC']!),
    );
    // «Все владельцы ∈ подвыборке»: только у А (её потомок В — уже вне выборки).
    assert.deepEqual(
      idsOf(ast(sub([thoughtA], 'all_in'))),
      sorted(ids['imgA']!, ids['txtA']!),
    );
    // …и оба владельца А/Б: документ В не входит.
    assert.deepEqual(
      idsOf(ast(sub([thoughtA, thoughtB], 'all_in'))),
      sorted(ids['imgA']!, ids['txtA']!, ids['imgB']!),
    );
    // Пустая подвыборка — «нет совпадений».
    assert.deepEqual(
      idsOf(ast(sub(['00000000-0000-4000-8000-000000000000'], 'all_in'))),
      [],
    );
    // Количество владельцев.
    assert.equal(idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'eq', 1))).length, 4);
    assert.deepEqual(idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'gt', 1))), []);
    // «В иерархии» от мысли-корня: поддерево А включает её потомка В.
    assert.deepEqual(
      idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'in_hierarchy', [thoughtA]))),
      sorted(ids['imgA']!, ids['txtA']!, ids['pdfC']!),
    );
    assert.deepEqual(
      idsOf(ast(leaf({ entity: { kind: 'owner' } }, 'not_in_hierarchy', [thoughtA]))),
      [ids['imgB']!],
    );
  });

  it('XOR: `ast` несовместим с плоскими фильтрами', () => {
    const a = ast(leaf({ entity: { kind: 'kind' } }, 'in', ['url']));
    assert.throws(
      () => parseAttachmentSearchQuery({ ast: a, q: 'ex' }, 'req'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => parseAttachmentSearchQuery({ ast: a, kind: 'url' }, 'req'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
    // Только `ast` (или только плоские) — ок.
    assert.ok(parseAttachmentSearchQuery({ ast: a }, 'req').ast !== undefined);
    assert.equal(parseAttachmentSearchQuery({ q: 'ex' }, 'req').ast, undefined);
  });

  it('идентичность прежнему плоскому поиску (независимая сыро-SQL реализация)', () => {
    const legacy = (
      q: string,
      kind?: 'url' | 'file',
      exclude?: { type: string; id: string },
    ): string[] => {
      const where: string[] = [];
      const params: unknown[] = [];
      const concat =
        "LOWER(COALESCE(title, '') || '\n' || COALESCE(description, '') || '\n' || COALESCE(url, '') || '\n' || COALESCE(file_path, ''))";
      for (const word of q.split(/\s+/).filter((w) => w !== '' && !w.startsWith('-'))) {
        where.push(`${concat} LIKE ? ESCAPE '\\'`);
        params.push(buildLikePattern(word).toLowerCase());
      }
      if (where.length === 0) return [];
      if (kind !== undefined) {
        where.push('kind = ?');
        params.push(kind);
      }
      if (exclude !== undefined) {
        where.push(
          'NOT EXISTS (SELECT 1 FROM attachment_owners_v o WHERE o.attachment_id = attachments_v.id AND o.owner_type = ? AND o.owner_id = ?)',
        );
        params.push(exclude.type, exclude.id);
      }
      const rows = ctx.ndb
        .prepare(
          `SELECT id FROM attachments_v WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
        )
        .all(...params) as Array<{ id: string }>;
      return rows.map((r) => r.id).sort();
    };

    const cases: Array<{ q: string; kind?: 'url' | 'file'; exclude?: { type: string; id: string } }> = [
      { q: 'example' },
      { q: 'img' },
      { q: 'example', kind: 'url' },
      { q: 'example', kind: 'file' },
      { q: 'example', exclude: { type: 'thought', id: thoughtA } },
      { q: '' },
    ];
    for (const c of cases) {
      const flat = searchAttachments(ctx.ndb, {
        q: c.q,
        ...(c.kind !== undefined ? { kind: c.kind } : {}),
        ...(c.exclude !== undefined
          ? { exclude_owner_type: 'thought', exclude_owner_id: c.exclude.id }
          : {}),
      })
        .items.map((i) => i.id)
        .sort();
      assert.deepEqual(flat, legacy(c.q, c.kind, c.exclude), `flat ${JSON.stringify(c)}`);
    }
  });

  it('REST `GET /attachments?ast=…` и MCP `etn.ops attachments.search` — паритет', async () => {
    const a = ast(
      leaf({ entity: { kind: 'mime_type' } }, 'contains', 'image'),
    );
    const query = `?ast=${encodeURIComponent(JSON.stringify(a))}`;
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/attachments${query}`,
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    const scoped = res.json() as { data: Array<{ id: string }>; meta: { total: number } };
    assert.deepEqual(
      scoped.data.map((i) => i.id).sort(),
      sorted(ids['imgA']!, ids['imgB']!, ids['orphan']!),
    );

    // XOR: `ast` + плоский `q` → 422; битый JSON → 422.
    const conflict = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/attachments?q=img&${query.slice(1)}`,
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    assert.equal(conflict.statusCode, 422, 'ast + q → 422');
    const bad = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/attachments?ast=%7Bnot-json`,
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    assert.equal(bad.statusCode, 422);

    // Плоский поиск по-прежнему работает (200, без ast).
    const flat = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/attachments?q=img`,
      headers: { authorization: `Bearer ${ctx.adminKey}` },
    });
    assert.equal(flat.statusCode, 200);

    // MCP через `etn.ops`: то же ast-тело даёт тот же набор (паритет транспортов).
    if (mcpNativeAvailable()) {
      const mcp = await buildMcpContext({
        dataDir: ctx.dataDir,
        networkId: ctx.networkId,
        systemDb: ctx.sys,
      });
      const handle = await connectMcpClient(mcp, ctx.adminKey);
      try {
        const mcpRes = await handle.client.callTool({
          name: 'etn.ops',
          arguments: {
            action: 'attachments.search',
            params: { network_id: ctx.networkId, ast: a },
          },
        });
        assert.equal(mcpRes.isError, undefined, toolText(mcpRes));
        const payload = toolJson<Array<{ id: string }>>(mcpRes);
        assert.deepEqual(
          payload.map((i) => i.id).sort(),
          scoped.data.map((i) => i.id).sort(),
          'REST и MCP с одним ast дают один набор',
        );
      } finally {
        await handle.close();
        await closeMcpContext(mcp, {
          dataDir: ctx.dataDir,
          networkId: ctx.networkId,
          systemDb: ctx.sys,
        });
      }
    }
  });
});
