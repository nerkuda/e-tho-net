/**
 * REST-операции владельцев вложений, правка заголовка и ответ usage
 * (0.12.1, задача 478f8c1f; операции 6ba247cc, 4924d61e, f3203ce4).
 *
 * Покрытие DoD:
 *   * `POST /attachments/{id}/owners` — успех, идемпотентность (`skipped`),
 *     404 (нет вложения), 422 (несуществующий владелец);
 *   * `DELETE /attachments/{id}/owners` — успех, 409 на свою иконку,
 *     404 (нет владения), owner-cleanup вложения последним владельцем;
 *   * `PATCH /attachments/{id}` — переименование (title) без смены владельца;
 *   * `GET /attachments/{id}/usage` — владельцы + использования (иконки/обложки);
 *   * `DELETE /attachments/{id}` — убран из публичного API (404).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OPS_ACTION_NAMES } from '../src/mcp/tools/ops-catalog.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable as mcpNativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

interface InjectOptions {
  payload?: Record<string, unknown>;
}

/** Inject a REST call under the context's network and admin authorization. */
async function api(
  ctx: RestTestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: InjectOptions = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${path}`,
    headers: authHeaders(ctx),
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
  });
}

async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await api(ctx, 'POST', '/thoughts', { payload: { title } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Крошечный PNG (1×1) — картинка-вложение (иконка/обложка требуют image/*). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function createImageAttachment(
  ctx: RestTestContext,
  thoughtId: string,
  title: string,
): Promise<string> {
  const res = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments/file`, {
    payload: { mime_type: 'image/png', data_base64: PNG_BASE64, title },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

describe('REST: операции владельцев вложений (478f8c1f)', { skip: !nativeAvailable() }, () => {
  it('owners: добавление идемпотентно, снятие защищено иконкой, owner-cleanup', async () => {
    const ctx = await buildRestContext();
    try {
      const a = await createThought(ctx, 'Владелец A');
      const b = await createThought(ctx, 'Владелец B');
      const att = await createImageAttachment(ctx, a, 'Картинка');

      // Добавление владельца B.
      const add = await api(ctx, 'POST', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_ids: [b] },
      });
      assert.equal(add.statusCode, 200, add.body);
      const addData = add.json().data as {
        added: Array<{ owner_id: string; title: string | null }>;
        skipped: unknown[];
      };
      assert.deepEqual(addData.skipped, []);
      assert.deepEqual(
        addData.added.map((o) => o.owner_id),
        [b],
      );
      assert.equal(addData.added[0]!.title, 'Владелец B');

      // Повтор — идемпотентно (skipped).
      const again = await api(ctx, 'POST', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_ids: [b] },
      });
      assert.equal(again.statusCode, 200, again.body);
      assert.deepEqual((again.json().data as { added: unknown[] }).added, []);
      assert.equal((again.json().data as { skipped: unknown[] }).skipped.length, 1);

      // Вложение видно у обоих владельцев.
      for (const owner of [a, b]) {
        const list = await api(ctx, 'GET', `/thoughts/${owner}/attachments`);
        assert.equal((list.json().data as unknown[]).length, 1);
      }

      // 404 — нет вложения.
      const missingAtt = await api(
        ctx,
        'POST',
        '/attachments/00000000-0000-0000-0000-000000000000/owners',
        { payload: { owner_type: 'thought', owner_ids: [b] } },
      );
      assert.equal(missingAtt.statusCode, 404, missingAtt.body);

      // 422 — несуществующий владелец.
      const missingOwner = await api(ctx, 'POST', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_ids: ['00000000-0000-0000-0000-000000000000'] },
      });
      assert.equal(missingOwner.statusCode, 422, missingOwner.body);

      // A использует вложение как иконку → снятие запрещено (409).
      const icon = await api(ctx, 'PATCH', `/thoughts/${a}`, {
        payload: { icon_attachment_id: att },
      });
      assert.equal(icon.statusCode, 200, icon.body);
      const forbidden = await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: a },
      });
      assert.equal(forbidden.statusCode, 409, forbidden.body);
      assert.equal(
        (forbidden.json().error as { details?: { code?: string } }).details?.code,
        'ATTACHMENT_OWNER_IS_ICON',
      );

      // Снятие владельца B проходит (A ещё владеет — вложение живо).
      const delB = await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: b },
      });
      assert.equal(delB.statusCode, 200, delB.body);
      assert.deepEqual(delB.json().data, { removed: true, attachment_deleted: false });

      // Повторное снятие — 404 (нет владения).
      const delBAgain = await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: b },
      });
      assert.equal(delBAgain.statusCode, 404, delBAgain.body);

      // Очищаем иконку и снимаем последнее владение A — вложение удаляется.
      const clearIcon = await api(ctx, 'PATCH', `/thoughts/${a}`, {
        payload: { icon_attachment_id: null },
      });
      assert.equal(clearIcon.statusCode, 200, clearIcon.body);
      const delA = await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: a },
      });
      assert.equal(delA.statusCode, 200, delA.body);
      assert.deepEqual(delA.json().data, { removed: true, attachment_deleted: true });
      const gone = await api(ctx, 'GET', `/attachments/${att}`);
      assert.equal(gone.statusCode, 404, gone.body);

      // Публичного DELETE вложения нет.
      const oldDelete = await api(ctx, 'DELETE', `/attachments/${att}`);
      assert.equal(oldDelete.statusCode, 404, oldDelete.body);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('PATCH меняет заголовок, владелец не меняется', async () => {
    const ctx = await buildRestContext();
    try {
      const a = await createThought(ctx, 'Хозяин');
      const att = await createImageAttachment(ctx, a, 'Старое имя');

      const patched = await api(ctx, 'PATCH', `/attachments/${att}`, {
        payload: { title: 'Новое имя', description: 'Описание' },
      });
      assert.equal(patched.statusCode, 200, patched.body);
      const data = patched.json().data as {
        title: string | null;
        description: string | null;
        owner_id: string;
      };
      assert.equal(data.title, 'Новое имя');
      assert.equal(data.description, 'Описание');
      assert.equal(data.owner_id, a, 'владелец не изменился');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('usage отдаёт владельцев и использования (иконка мысли, обложка публикации)', async () => {
    const ctx = await buildRestContext();
    try {
      const owner = await createThought(ctx, 'Владелец картинки');
      const att = await createImageAttachment(ctx, owner, 'Картинка');

      // Использование как иконка мысли.
      const icon = await api(ctx, 'PATCH', `/thoughts/${owner}`, {
        payload: { icon_attachment_id: att },
      });
      assert.equal(icon.statusCode, 200, icon.body);

      const usage = await api(ctx, 'GET', `/attachments/${att}/usage`);
      assert.equal(usage.statusCode, 200, usage.body);
      const usageData = usage.json().data as {
        owners: Array<{ owner_type: string; owner_id: string }>;
        usages: Array<{ usage: string; owner_type: string; owner_id: string }>;
      };
      assert.deepEqual(
        usageData.owners.map((o) => o.owner_id).sort(),
        [owner],
      );
      const iconUsage = usageData.usages.find((u) => u.usage === 'icon');
      assert.ok(iconUsage, 'иконка попала в usages');
      assert.equal(iconUsage!.owner_id, owner);
      assert.equal(iconUsage!.owner_type, 'thought');

      // Использование как обложка публикации.
      const pub = await api(ctx, 'POST', '/publications', { payload: { title: 'Документ' } });
      assert.equal(pub.statusCode, 201, pub.body);
      const pubId = (pub.json().data as { id: string }).id;
      const pubAtt = await api(ctx, 'POST', `/publications/${pubId}/attachments/file`, {
        payload: { mime_type: 'image/png', data_base64: PNG_BASE64, title: 'Обложка' },
      });
      assert.equal(pubAtt.statusCode, 201, pubAtt.body);
      const coverId = (pubAtt.json().data as { id: string }).id;
      const cover = await api(ctx, 'PATCH', `/publications/${pubId}`, {
        payload: { cover_attachment_id: coverId },
      });
      assert.equal(cover.statusCode, 200, cover.body);

      const usage2 = await api(ctx, 'GET', `/attachments/${coverId}/usage`);
      const usages2 = (usage2.json().data as { usages: Array<{ usage: string }> }).usages;
      assert.ok(
        usages2.some((u) => u.usage === 'cover'),
        'обложка попала в usages',
      );
    } finally {
      await closeRestContext(ctx);
    }
  });
});

describe('каталог etn.ops: attachments.delete снят (478f8c1f)', () => {
  it('removeOwner присутствует, delete — нет', () => {
    assert.ok(OPS_ACTION_NAMES.includes('attachments.removeOwner'));
    assert.ok(!OPS_ACTION_NAMES.includes('attachments.delete'));
  });
});

describe('MCP: attachments.removeOwner и usage (478f8c1f)', { skip: !mcpNativeAvailable() }, () => {
  it('removeOwner деструктивно (confirm обязателен), usage отдаёт usages', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<{ id: string }>(
          await callOp(handle.client, 'attachments.add', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ctx.homeId,
            kind: 'url',
            url: 'https://example.test/mcp-owners',
            title: 'MCP-вложение',
          }),
        );

        // usage: владелец + (пустой) список использований.
        const usage = toolJson<{ owners: unknown[]; usages: unknown[] }>(
          await callOp(handle.client, 'attachments.usage', {
            network_id: ctx.networkId,
            attachment_id: created.id,
          }),
        );
        assert.equal(usage.owners.length, 1);
        assert.ok(Array.isArray(usage.usages), 'usage отдаёт usages');

        // Без confirm — отказ деструктивного действия.
        const refused = await callOp(handle.client, 'attachments.removeOwner', {
          network_id: ctx.networkId,
          attachment_id: created.id,
          owner_type: 'thought',
          owner_id: ctx.homeId,
        });
        assert.equal(refused.isError, true);
        assert.match(toolText(refused), /confirm/);

        // С confirm — владение снято, вложение удалено (последний владелец).
        const removed = toolJson<{ removed: boolean; attachment_deleted: boolean }>(
          await callOp(
            handle.client,
            'attachments.removeOwner',
            {
              network_id: ctx.networkId,
              attachment_id: created.id,
              owner_type: 'thought',
              owner_id: ctx.homeId,
            },
            true,
          ),
        );
        assert.equal(removed.removed, true);
        assert.equal(removed.attachment_deleted, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
