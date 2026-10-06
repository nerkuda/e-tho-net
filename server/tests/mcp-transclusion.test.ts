/**
 * ТП2 «Трансклюзии комментариев», задача `bcfc7eb7` — MCP-развёртка трансклюзий
 * в `body_md` с маркерами границ (ADR `85a7a01e`, требование R8).
 *
 * Проверяет сквозной путь через производственный MCP-сервер (`mcp-helpers.ts`):
 *   * `etn.comments.get` (по `thought_id` и `comment_id`) отдаёт `body_md`,
 *     в котором `![[#<id>]]` развёрнуты текстом источника и обёрнуты маркерами
 *     begin/end;
 *   * адресация раздела `![[#<id>#Раздел]]` разворачивает только раздел с
 *     подразделами (маркер несёт `section="…"`);
 *   * отсутствующий источник — маркер `missing`; цикл — маркер `skip
 *     reason=cycle`;
 *   * вложенность разворачивается рекурсивно (B → A);
 *   * `etn.thoughts.get` (`meta.permanent`), `etn.thoughts.resolve`
 *     (`comment_preview`) и `etn.thoughts.subgraph` (`comments`) отдают
 *     развёрнутый текст;
 *   * доменные читатели БЕЗ инжектированного развёртывателя (REST-путь)
 *     возвращают исходный `![[#…]]` — в базе и REST текст не меняется.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openNetworkDb } from '../src/db/network-db.js';
import {
  getPermanentFull,
  getPermanentPreview,
} from '../src/domain/comment-service.js';
import {
  createBodyExpander,
  createTransclusionResolver,
} from '../src/domain/transclusion-service.js';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  addChronicleViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
  upsertPermanentViaWrite,
} from './mcp-helpers.js';

const A = '11111111-1111-4111-8111-111111111111';
const MISSING = '44444444-4444-4444-8444-444444444444';

/** Одна мысль с постоянным комментарием; возвращает её id. */
async function makeThoughtWithComment(
  client: Parameters<typeof upsertPermanentViaWrite>[0],
  networkId: string,
  title: string,
  bodyMd: string,
): Promise<string> {
  const created = await createThoughtViaWrite(client, networkId, { title });
  await upsertPermanentViaWrite(client, networkId, created.id, bodyMd);
  return created.id;
}

interface PermanentRow {
  id: string;
  body_md: string;
  body_html?: string;
}

interface CommentsGetByThought {
  thought_id: string;
  permanent: PermanentRow | null;
}

describe('MCP-развёртка трансклюзий (bcfc7eb7, ADR 85a7a01e)', { skip: !nativeAvailable() }, () => {
  it('etn.comments.get разворачивает ![[#id]] с маркерами begin/end по thought_id и comment_id', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник',
          '## Раздел\nТекст раздела с **жирным**.\n## Хвост\nТекст хвоста.',
        );
        const boxId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Контейнер',
          `Начало.\n\n![[#${sourceId}]]\n\nКонец.`,
        );

        const byThought = toolJson<CommentsGetByThought>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: boxId },
          }),
        );
        const body = byThought.permanent?.body_md ?? '';
        const begin = `<!-- etn:transclusion begin source=${sourceId} depth=1 -->`;
        const end = `<!-- etn:transclusion end source=${sourceId} depth=1 -->`;
        assert.ok(body.includes(begin), `begin-маркер отсутствует: ${body}`);
        assert.ok(body.includes(end), `end-маркер отсутствует: ${body}`);
        assert.ok(body.includes('Текст раздела с **жирным**.'), 'текст источника не развёрнут');
        assert.ok(!body.includes('![[#'), 'исходная ссылка осталась в выдаче');
        assert.ok(body.includes('Начало.') && body.includes('Конец.'), 'окружающий текст потерян');

        // Тот же результат по comment_id.
        const byComment = toolJson<PermanentRow>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: byThought.permanent!.id },
          }),
        );
        assert.equal(byComment.body_md, body);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.comments.get и etn.chronicle.query отдают body_html, согласованный с развёрнутым body_md (ошибка a6da3d37)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник HTML',
          'Текст источника с **жирным**.',
        );
        const boxId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Контейнер HTML',
          `Начало.\n\n![[#${sourceId}]]\n\nКонец.`,
        );
        // Хронологическая запись с трансклюзией — для etn.chronicle.query.
        await addChronicleViaWrite(
          handle.client,
          ctx.networkId,
          boxId,
          `Дневниковая заметка. ![[#${sourceId}]]`,
          '2026-10-06',
        );

        // comments.get: body_md развёрнут, body_html — из развёрнутого текста.
        const byThought = toolJson<CommentsGetByThought>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: boxId },
          }),
        );
        const md = byThought.permanent?.body_md ?? '';
        const html = byThought.permanent?.body_html ?? '';
        assert.ok(md.includes('Текст источника'), 'body_md не развёрнут');
        assert.ok(!html.includes('![[#'), `body_html содержит литерал ссылки: ${html}`);
        assert.ok(html.includes('Текст источника'), `body_html не развёрнут: ${html}`);
        assert.ok(
          !html.includes('etn:transclusion'),
          `маркеры границ не должны попадать в HTML: ${html}`,
        );
        // Разметка источника отрендерена (markdown, а не литерал).
        assert.ok(html.includes('<strong>жирным</strong>'), `источник не отрендерен: ${html}`);

        // chronicle.query: body_html строки тоже собран из развёрнутого текста.
        const chron = toolJson<{ rows: Array<{ body_md?: string; body_html: string }> }>(
          await handle.client.callTool({
            name: 'etn.chronicle.query',
            arguments: { network_id: ctx.networkId, thought_ids: [boxId], limit: 50 },
          }),
        );
        const row = chron.rows.find((r) => r.body_html.includes('Дневниковая заметка'));
        assert.ok(row !== undefined, 'строка хроники не найдена');
        assert.ok(
          !row.body_html.includes('![[#'),
          `chronicle body_html содержит литерал ссылки: ${row.body_html}`,
        );
        assert.ok(
          row.body_html.includes('Текст источника'),
          `chronicle body_html не развёрнут: ${row.body_html}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('адресация раздела ![[#id#Раздел]] разворачивает раздел с подразделами', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник',
          '## Раздел\nТело раздела.\n### Подраздел\nТело подраздела.\n## Хвост\nТело хвоста.',
        );
        const boxId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Контейнер',
          `![[#${sourceId}#Раздел]]`,
        );
        const data = toolJson<CommentsGetByThought>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: boxId },
          }),
        );
        const body = data.permanent?.body_md ?? '';
        assert.ok(
          body.includes(`section="Раздел"`),
          `маркер не несёт section: ${body}`,
        );
        assert.ok(body.includes('Тело раздела.') && body.includes('Тело подраздела.'));
        assert.ok(!body.includes('Тело хвоста.'), 'раздел захватил следующий заголовок');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('отсутствующий источник — missing, цикл — skip reason=cycle', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const missingBox = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Нет источника',
          `![[#${MISSING}]]`,
        );
        const missing = toolJson<CommentsGetByThought>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: missingBox },
          }),
        );
        assert.ok(
          (missing.permanent?.body_md ?? '').includes(
            // Уточнение 0.12.1 (задача a2b68d72, ADR 85a7a01e): missing-маркер
            // несёт обязательный `reason=<source|section>` последним атрибутом.
            `<!-- etn:transclusion missing source=${MISSING} reason=source -->`,
          ),
          'missing-маркер не найден',
        );

        const cycleA = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Цикл A',
        });
        const cycleB = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Цикл B',
        });
        await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          cycleA.id,
          `![[#${cycleB.id}]]`,
        );
        await upsertPermanentViaWrite(
          handle.client,
          ctx.networkId,
          cycleB.id,
          `![[#${cycleA.id}]]`,
        );
        const cycle = toolJson<CommentsGetByThought>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: cycleA.id },
          }),
        );
        const cycleBody = cycle.permanent?.body_md ?? '';
        assert.ok(cycleBody.includes('reason=cycle'), `нет skip-маркера цикла: ${cycleBody}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('вложенность разворачивается рекурсивно (N → B → A)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник',
          'Глубокий текст.',
        );
        const boxId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Контейнер',
          `![[#${sourceId}]]`,
        );
        const outerId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Внешний',
          `![[#${boxId}]]`,
        );
        const data = toolJson<CommentsGetByThought>(
          await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, thought_id: outerId },
          }),
        );
        const body = data.permanent?.body_md ?? '';
        assert.ok(body.includes('Глубокий текст.'), 'вложенный источник не развёрнут');
        assert.ok(
          body.includes(`<!-- etn:transclusion begin source=${boxId} depth=1 -->`),
          'маркер внешнего уровня отсутствует',
        );
        assert.ok(
          body.includes(`<!-- etn:transclusion begin source=${sourceId} depth=2 -->`),
          'маркер вложенного уровня отсутствует',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.thoughts.get / resolve / subgraph отдают развёрнутый текст', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник',
          'Текст источника.',
        );
        const boxId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Контейнер',
          `![[#${sourceId}]]`,
        );

        const got = toolJson<{ meta: { permanent: PermanentRow } }>(
          await handle.client.callTool({
            name: 'etn.thoughts.get',
            arguments: { network_id: ctx.networkId, thought_id: boxId },
          }),
        );
        assert.ok(
          got.meta.permanent.body_md.includes('Текст источника.'),
          'etn.thoughts.get: трансклюзия не развёрнута',
        );

        const resolved = toolJson<{ items: Array<{ comment_preview: PermanentRow | null }> }>(
          await handle.client.callTool({
            name: 'etn.thoughts.resolve',
            arguments: { network_id: ctx.networkId, thought_ids: [boxId] },
          }),
        );
        assert.ok(
          (resolved.items[0]?.comment_preview?.body_md ?? '').includes('Текст источника.'),
          'etn.thoughts.resolve: трансклюзия не развёрнута',
        );

        const subgraph = toolJson<{
          comments: Array<{ thought_id: string; permanent: PermanentRow | null }>;
        }>(
          await handle.client.callTool({
            name: 'etn.thoughts.subgraph',
            arguments: { network_id: ctx.networkId, seed_ids: [boxId], radius: 0, include_comments: true },
          }),
        );
        const node = subgraph.comments.find((c) => c.thought_id === boxId);
        assert.ok(
          (node?.permanent?.body_md ?? '').includes('Текст источника.'),
          'etn.thoughts.subgraph: трансклюзия не развёрнута',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('доменные читатели без развёртывателя (REST-путь) сохраняют исходную ссылку', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник',
          'Текст источника.',
        );
        const boxId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Контейнер',
          `![[#${sourceId}]]`,
        );
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);

        // Без transform — исходный текст (REST/клиентские виджеты правят ссылку).
        const raw = getPermanentFull(ndb, 'thought', boxId);
        assert.ok(raw?.body_md.includes(`![[#${sourceId}]]`), 'REST-путь получил развёртку');

        // С transform — развёрнутый текст.
        const expanded = getPermanentFull(ndb, 'thought', boxId, createBodyExpander(ndb));
        assert.ok(expanded?.body_md.includes('Текст источника.'), 'развёртка не сработала');

        // Превью-форма: transform применяется до обрезки, метаданные согласованы.
        const preview = getPermanentPreview(
          ndb,
          'thought',
          boxId,
          undefined,
          createBodyExpander(ndb),
        );
        assert.ok(preview !== null);
        assert.equal(preview.body_md.length, preview.chars_returned);
        assert.equal(preview.chars_total, expanded!.body_md.length);

        // Резолвер отдаёт «не найден» для отсутствующего источника.
        const resolve = createTransclusionResolver(ndb);
        assert.deepEqual(resolve(A), { found: false, body_md: '' });
        assert.equal(resolve(sourceId).found, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.types.list разворачивает description и comment_template_md типов (R8, scope описаний типов)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const sourceId = await makeThoughtWithComment(
          handle.client,
          ctx.networkId,
          'Источник типа',
          'Текст из типа.',
        );
        const typeName = 'Тип с трансклюзией';
        const linkNameForward = 'тип-связи-прямой';
        const linkNameReverse = 'тип-связи-обратный';
        const wrote = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              {
                name: typeName,
                description: `До. ![[#${sourceId}]] После.`,
                comment_template_md: `Шаблон: ![[#${sourceId}]]`,
              },
            ],
            link_types: [
              {
                name_forward: linkNameForward,
                name_reverse: linkNameReverse,
                description: `Связь. ![[#${sourceId}]]`,
              },
            ],
          },
        });
        assert.equal(wrote.isError, undefined, toolText(wrote));

        const list = toolJson<{
          thought_types: Array<{
            id: string;
            name: string;
            description: string | null;
            comment_template_md: string | null;
          }>;
          link_types: Array<{ id: string; name_forward: string; description: string | null }>;
        }>(
          await handle.client.callTool({
            name: 'etn.types.list',
            arguments: { network_id: ctx.networkId, scope: 'all' },
          }),
        );

        const thoughtType = list.thought_types.find((t) => t.name === typeName);
        assert.ok(thoughtType !== undefined, 'новый тип мысли отсутствует в каталоге');
        assert.ok(
          (thoughtType.description ?? '').includes('<!-- etn:transclusion begin'),
          `description типа не развёрнут: ${thoughtType.description}`,
        );
        assert.ok(
          (thoughtType.description ?? '').includes('Текст из типа.'),
          'текст источника не развёрнут в description',
        );
        assert.ok(
          !(thoughtType.description ?? '').includes('![[#'),
          'исходная ссылка осталась в description',
        );
        assert.ok(
          (thoughtType.comment_template_md ?? '').includes('Текст из типа.') &&
            (thoughtType.comment_template_md ?? '').includes('<!-- etn:transclusion begin'),
          `comment_template_md типа не развёрнут: ${thoughtType.comment_template_md}`,
        );

        const linkType = list.link_types.find((t) => t.name_forward === linkNameForward);
        assert.ok(linkType !== undefined, 'новый тип связи отсутствует в каталоге');
        assert.ok(
          (linkType.description ?? '').includes('Текст из типа.') &&
            (linkType.description ?? '').includes('<!-- etn:transclusion begin'),
          `description типа связи не развёрнут: ${linkType.description}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
