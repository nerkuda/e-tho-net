/**
 * 0.7.2 — `etn.instructions` (задача ba024a45, ADR 717f04df, спека 14b0cc4f).
 *
 * Витрина инструкций сети: три режима (по `instruction_id` / по `keywords`
 * / все) и четыре кейса:
 *   * сеть без роли `instructions` → `{ has_instructions: false, instructions: [] }`;
 *   * сеть с ролью и активными инструкциями → превью + список;
 *   * неактуальные (active = 0) или помеченные на удаление мысли скрыты;
 *   * по `instruction_id` — полный текст постоянного комментария без обрезки.
 *
 * Bootstrap — `mcp-helpers.ts` (тот же, что в `mcp-comments-edit.test.ts`):
 * in-memory `_system.db` + сеть с `data.db` через `NetworkService`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { openNetworkDb } from '../src/db/network-db.js';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
} from './mcp-helpers.js';

interface InstructionSummary {
  id: string;
  title: string;
  synonyms: string[];
  preview: { id: string; body_md: string; truncated: boolean; chars_total?: number };
  type_id: string | null;
}

interface InstructionsList {
  network_id: string;
  has_instructions: boolean;
  instructions: InstructionSummary[];
  meta: { total: number; matched?: number };
}

interface InstructionFull {
  network_id: string;
  has_instructions: boolean;
  instruction_id: string;
  title: string;
  type_id: string | null;
  body_md: string | null;
}

interface InstructionsEmpty {
  network_id: string;
  has_instructions: false;
  instructions: [];
}

/** Insert a thought directly via the network DB. */
function makeThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  opts: { typeId: string | null; active?: number; trashed?: number; id?: string },
  userId: string,
): string {
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, ?, 0, 0,
               ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      opts.typeId,
      opts.active ?? 1,
      opts.trashed ?? 0,
      now,
      now,
      userId,
      userId,
      Date.now(),
      Date.now(),
    );
  return id;
}

/** Insert a thought-type directly. */
function makeThoughtType(
  ndb: ReturnType<typeof openNetworkDb>,
  name: string,
  userId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, is_root, version,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(id, name, name.toLowerCase(), now, now, userId, userId);
  return id;
}

/** Set the network's `type_roles` via the system DB. */
function setTypeRoles(
  ctx: Awaited<ReturnType<typeof buildMcpContext>>,
  roles: Record<string, string | null>,
): void {
  ctx.sys.updateNetwork(ctx.networkId, {
    displayName: ctx.sys.getNetworkById(ctx.networkId)!.display_name,
    description: null,
    when_to_use: null,
    conventions: null,
    examples: null,
    type_roles: roles,
  });
}

/** Insert a link type directly (для типизированного ребра). */
function makeLinkType(
  ndb: ReturnType<typeof openNetworkDb>,
  nameForward: string,
  nameReverse: string,
  userId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_reverse, description, color, style,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, NULL, NULL, 'solid', 1, ?, ?, ?)`,
    )
    .run(id, nameForward, nameReverse, now, now, userId);
  return id;
}

/** Insert a directed link directly; `typeId: null` — нетипизированная (структурная) связь. */
function linkThoughts(
  ndb: ReturnType<typeof openNetworkDb>,
  sourceId: string,
  targetId: string,
  typeId: string | null,
  userId: string,
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          color, style, width, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, NULL, NULL, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), sourceId, targetId, typeId, now, now, userId, userId);
}

describe('etn.instructions (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('has_instructions=false when the network has no `instructions` role', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsEmpty>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_instructions, false);
        assert.deepEqual(data.instructions, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('lists every active instruction with preview when the role is set', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const otherTypeId = makeThoughtType(ndb, 'Заметка', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const alpha = makeThought(ndb, 'Alpha', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, alpha, 'Первая инструкция.');
        const beta = makeThought(ndb, 'Beta', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, beta, 'Вторая инструкция.');
        makeThought(ndb, 'Noise', { typeId: otherTypeId }, ctx.adminId);

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_instructions, true);
        assert.equal(data.instructions.length, 2);
        assert.deepEqual(
          data.instructions.map((i) => i.title).sort(),
          ['Alpha', 'Beta'],
        );
        for (const item of data.instructions) {
          assert.ok(typeof item.preview.id === 'string');
          assert.ok(item.preview.body_md.length > 0);
        }
        assert.equal(data.meta.total, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 50098756: выдача обязана отдавать комментарий ИМЕННО запрошенной
  // мысли — один и тот же `preview.id` не может принадлежать двум инструкциям.
  // Регресс: сверяем `preview.id`/тело каждой карточки с реальным владельцем
  // постоянного комментария по базе (`etn.comments.get` по `thought_id`) и FULL
  // режим — с телом запрошенной мысли.
  it('preview/body каждой инструкции принадлежат её собственной мысли (50098756)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const alpha = makeThought(ndb, 'Alpha', { typeId: instructionsTypeId }, ctx.adminId);
        const beta = makeThought(ndb, 'Beta', { typeId: instructionsTypeId }, ctx.adminId);
        const alphaBody = 'ALPHA: тело первой инструкции. '.repeat(40);
        const betaBody = 'BETA: тело второй инструкции. '.repeat(40);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, alpha, alphaBody);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, beta, betaBody);
        setTypeRoles(ctx, { instructions: instructionsTypeId });

        // Реальные владельцы постоянных комментариев — по данным базы.
        const owner = async (thoughtId: string): Promise<string> => {
          const res = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: thoughtId },
          });
          const data = toolJson<{ permanent: { id: string } | null }>(res);
          assert.ok(data.permanent !== null, 'у инструкции обязан быть постоянный комментарий');
          return data.permanent.id;
        };
        const alphaCommentId = await owner(alpha);
        const betaCommentId = await owner(beta);
        assert.notEqual(alphaCommentId, betaCommentId, 'разные мысли — разные комментарии');

        const res = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(res.isError, undefined, toolText(res));
        const data = toolJson<InstructionsList>(res);
        const byId = new Map(data.instructions.map((i) => [i.id, i]));
        const alphaItem = byId.get(alpha);
        const betaItem = byId.get(beta);
        assert.ok(alphaItem !== undefined && betaItem !== undefined);
        // Карточка Alpha несёт комментарий Alpha, карточка Beta — комментарий Beta.
        assert.equal(alphaItem.preview.id, alphaCommentId);
        assert.equal(betaItem.preview.id, betaCommentId);
        assert.ok(alphaItem.preview.body_md.startsWith('ALPHA:'));
        assert.ok(betaItem.preview.body_md.startsWith('BETA:'));

        // FULL-режим отдаёт тело ровно запрошенной мысли.
        const full = toolJson<InstructionFull>(
          await handle.client.callTool({
            name: 'etn.instructions',
            arguments: { network_id: ctx.networkId, instruction_id: beta },
          }),
        );
        assert.equal(full.instruction_id, beta);
        assert.equal(full.body_md, betaBody);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 8ca8f4cc: `instruction_id` принимает короткий (hex-префиксный) id —
  // как `etn.thoughts.get`. Однозначный префикс резолвится; неоднозначный и
  // ненайденный дают внятную ошибку (ложный ответ недопустим).
  it('короткий id инструкции резолвится; неоднозначный/ненайденный — ошибка (8ca8f4cc)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Две мысли с общим 8-символьным префиксом `cafe000` — для
        // детерминированной неоднозначности; третьей общей префикс не нужен.
        const alpha = makeThought(
          ndb,
          'Alpha',
          { typeId: instructionsTypeId, id: 'cafe0001-0000-4000-8000-000000000001' },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, alpha, 'Тело Альфы.');
        makeThought(
          ndb,
          'Alpha-2',
          { typeId: instructionsTypeId, id: 'cafe0002-0000-4000-8000-000000000002' },
          ctx.adminId,
        );
        setTypeRoles(ctx, { instructions: instructionsTypeId });

        // Однозначный префикс — полный текст нужной инструкции.
        const shortRes = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_id: 'cafe0001' },
        });
        assert.equal(shortRes.isError, undefined, toolText(shortRes));
        const short = toolJson<InstructionFull>(shortRes);
        assert.equal(short.instruction_id, alpha);
        assert.equal(short.body_md, 'Тело Альфы.');

        // Короткий id в режиме «указанные» тоже резолвится.
        const idsRes = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_ids: ['cafe0001'] },
        });
        assert.equal(idsRes.isError, undefined, toolText(idsRes));
        const ids = toolJson<InstructionsList & { missing: string[] }>(idsRes);
        assert.deepEqual(ids.instructions.map((i) => i.id), [alpha]);
        assert.deepEqual(ids.missing, []);

        // Неоднозначный префикс — VALIDATION_ERROR со списком кандидатов.
        const amb = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_id: 'cafe000' },
        });
        assert.equal(amb.isError, true, toolText(amb));
        assert.match(toolText(amb), /VALIDATION_ERROR/);
        assert.match(toolText(amb), /неоднозначен/);

        // Ненайденный префикс — NOT_FOUND (без ложного ответа).
        const gone = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_id: 'deadbeef' },
        });
        assert.equal(gone.isError, true, toolText(gone));
        assert.match(toolText(gone), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('hides inactive and trashed instructions', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const active = makeThought(
          ndb,
          'Active',
          { typeId: instructionsTypeId, active: 1 },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, active, 'видимая');
        const inactive = makeThought(
          ndb,
          'Inactive',
          { typeId: instructionsTypeId, active: 0 },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, inactive, 'скрытая');
        const trashed = makeThought(
          ndb,
          'Trashed',
          { typeId: instructionsTypeId, trashed: 1 },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, trashed, 'удалено');

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.deepEqual(
          data.instructions.map((i) => i.title),
          ['Active'],
        );
        assert.equal(data.meta.total, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('by_id returns the FULL permanent comment without truncation', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const longBody = 'x'.repeat(8000);
        const thoughtId = makeThought(
          ndb,
          'Long',
          { typeId: instructionsTypeId },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, thoughtId, longBody);

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_id: thoughtId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionFull>(result);
        assert.equal(data.network_id, ctx.networkId);
        assert.equal(data.has_instructions, true);
        assert.equal(data.instruction_id, thoughtId);
        assert.equal(data.title, 'Long');
        // FULL text — no truncation.
        assert.equal(data.body_md?.length, 8000);
        assert.equal(data.body_md, longBody);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('by_id rejects unknown / unrelated instructions with NOT_FOUND', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      setTypeRoles(ctx, { instructions: instructionsTypeId });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: {
            network_id: ctx.networkId,
            instruction_id: '00000000-0000-4000-8000-0000000000aa',
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /NOT_FOUND/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 18d7774a: union-схема заменена одним объектом со взаимоисключением
  // через `.refine()` — режимы обязаны остаться взаимоисключимыми.
  it('rejects instruction_id and keywords passed together', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      setTypeRoles(ctx, { instructions: instructionsTypeId });
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const err = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: {
            network_id: ctx.networkId,
            instruction_id: '00000000-0000-4000-8000-0000000000aa',
            keywords: 'up',
          },
        });
        assert.equal(err.isError, true);
        assert.match(toolText(err), /взаимоисключимы/);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('by keywords filters by title + synonyms (mini-syntax)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const a = makeThought(ndb, 'Setup', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, a, '...');
        const b = makeThought(ndb, 'Cleanup', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, b, '...');
        const c = makeThought(ndb, 'Build', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, c, '...');

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        // One word matches both Setup and Cleanup (the common fragment `up`).
        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, keywords: 'up' },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.deepEqual(
          data.instructions.map((i) => i.title).sort(),
          ['Cleanup', 'Setup'],
        );
        // Total matches what the keyword filter found.
        assert.equal(data.meta.total, 2);
        assert.equal(data.meta.matched, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка fa7df2c3: корневая = нет входящих НЕТИПИЗИРОВАННЫХ рёбер от
  // инструкций. Типизированная связь («см. также») иерархии не образует и не
  // должна прятать корневую инструкцию; структурное ребро — прячет.
  it('структурное ребро прячет корневую, типизированное «см. также» — нет', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const seeAlsoTypeId = makeLinkType(ndb, 'см. также', 'см. также', ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const parent = makeThought(ndb, 'Parent', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, parent, 'Корневая.');
        const structural = makeThought(
          ndb,
          'StructuralChild',
          { typeId: instructionsTypeId },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, structural, 'Подчинённая.');
        const typed = makeThought(
          ndb,
          'TypedLinked',
          { typeId: instructionsTypeId },
          ctx.adminId,
        );
        await upsertPermanentViaWrite(handle.client, ctx.networkId, typed, 'Связана «см. также».');

        // Структурное ребро Parent → StructuralChild (нетипизированное).
        linkThoughts(ndb, parent, structural, null, ctx.adminId);
        // Типизированное ребро Parent → TypedLinked («см. также»).
        linkThoughts(ndb, parent, typed, seeAlsoTypeId, ctx.adminId);

        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const result = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<InstructionsList>(result);
        assert.deepEqual(
          data.instructions.map((i) => i.title).sort(),
          ['Parent', 'TypedLinked'],
        );
        assert.ok(
          !data.instructions.some((i) => i.id === structural),
          'структурное ребро обязано прятать подчинённую инструкцию',
        );
        assert.ok(
          data.instructions.some((i) => i.id === typed),
          'типизированное ребро «см. также» не должно прятать корневую инструкцию',
        );
        assert.equal(data.meta.total, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Задача 649c55e2: режим перечня `scope` — roots (по умолчанию) / all.
  it('scope=all отдаёт подчинённые инструкции, по умолчанию — только корневые', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const root = makeThought(ndb, 'Root', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, root, 'Корневая.');
        const nested = makeThought(ndb, 'Nested', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, nested, 'Подчинённая.');
        linkThoughts(ndb, root, nested, null, ctx.adminId);
        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const rootsRes = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId },
        });
        assert.equal(rootsRes.isError, undefined, toolText(rootsRes));
        const roots = toolJson<InstructionsList>(rootsRes);
        assert.deepEqual(roots.instructions.map((i) => i.title), ['Root']);
        assert.equal(roots.meta.total, 1);

        const allRes = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, scope: 'all' },
        });
        assert.equal(allRes.isError, undefined, toolText(allRes));
        const all = toolJson<InstructionsList>(allRes);
        assert.deepEqual(
          all.instructions.map((i) => i.title).sort(),
          ['Nested', 'Root'],
        );
        assert.equal(all.meta.total, 2);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Задача 649c55e2: режим «указанные» — карточки перечня в порядке запроса.
  it('instruction_ids — карточки в порядке запроса, ненайденные в missing', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const instructionsTypeId = makeThoughtType(ndb, 'Инструкция', ctx.adminId);
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const alpha = makeThought(ndb, 'Alpha', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, alpha, 'Альфа.');
        const beta = makeThought(ndb, 'Beta', { typeId: instructionsTypeId }, ctx.adminId);
        await upsertPermanentViaWrite(handle.client, ctx.networkId, beta, 'Бета.');
        setTypeRoles(ctx, { instructions: instructionsTypeId });

        const ghost = '00000000-0000-4000-8000-0000000000aa';
        const res = await handle.client.callTool({
          name: 'etn.instructions',
          arguments: { network_id: ctx.networkId, instruction_ids: [beta, alpha, ghost] },
        });
        assert.equal(res.isError, undefined, toolText(res));
        const data = toolJson<InstructionsList & { missing: string[] }>(res);
        assert.deepEqual(
          data.instructions.map((i) => i.id),
          [beta, alpha],
          'карточки — в порядке запроса',
        );
        assert.deepEqual(data.missing, [ghost]);
        assert.equal(data.meta.total, 2);
        for (const item of data.instructions) {
          assert.ok(typeof item.preview.id === 'string');
          assert.ok(item.preview.body_md.length > 0);
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Схема остаётся ОДНИМ объектом (ошибка 18d7774a); взаимоисключения режимов —
  // через `.refine()`. Задача 649c55e2.
  it('взаимоисключения режимов: scope и instruction_ids', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ghost = '00000000-0000-4000-8000-0000000000aa';
        const cases: Array<Record<string, unknown>> = [
          { scope: 'all', keywords: 'x' },
          { scope: 'all', instruction_id: ghost },
          { instruction_ids: [ghost], keywords: 'x' },
          { instruction_ids: [ghost], instruction_id: ghost },
          { instruction_ids: [ghost], scope: 'all' },
          { instruction_ids: [ghost], limit: 10 },
        ];
        for (const extra of cases) {
          const res = await handle.client.callTool({
            name: 'etn.instructions',
            arguments: { network_id: ctx.networkId, ...extra },
          });
          assert.equal(
            res.isError,
            true,
            `ожидалось отвержение аргументов ${JSON.stringify(extra)}`,
          );
          assert.match(toolText(res), /взаимоисключимы|применим/, toolText(res));
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
