/**
 * Вложения публикаций: привязка, REST и MCP (0.11.1, задача 46cf4bcb;
 * ADR 73cfcf64 «обложка — строка-вложение с общим файлом»; требование
 * 71c2d194 «владелец-вложение публикация»).
 *
 * Покрытие DoD:
 *   * REST: список/добавление (url и файл)/отвязка вложений публикации —
 *     паритет с мыслями; использование вложения (владельцы общего носителя);
 *   * карточка публикации отдаёт полные метаданные (автор/дата создания,
 *     последний редактор/дата изменения, дата сборки);
 *   * обложка корректно ссылается на строку-вложение этой публикации и
 *     отвергает чужую;
 *   * MCP-паритет: `attachments.add` с owner_type=publication и
 *     `attachments.usage`.
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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

const skip = !nativeAvailable();

/** Крошечный PNG (1×1) для загрузки файла-вложения. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

/** Создать мысль через REST и вернуть её id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await api(ctx, 'POST', '/thoughts', { payload: { title } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Создать публикацию через REST и вернуть её карточку. */
async function createPublication(
  ctx: RestTestContext,
  title: string,
): Promise<Record<string, unknown> & { id: string }> {
  const res = await api(ctx, 'POST', '/publications', { payload: { title } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().data as Record<string, unknown> & { id: string };
}

describe('вложения публикаций: REST (46cf4bcb)', { skip }, () => {
  it('привязка url → список → использование → обложка → отвязка', async () => {
    const ctx = await buildRestContext();
    try {
      const pub = await createPublication(ctx, 'Документ с вложениями');
      // Полные метаданные карточки (п.3 задачи): автор/дата создания,
      // последний редактор/дата изменения, дата сборки.
      assert.equal(pub.created_by, ctx.adminId);
      assert.ok(pub.created_at, 'created_at заполнен');
      assert.equal(pub.updated_by, ctx.adminId);
      assert.ok(pub.updated_at, 'updated_at заполнен');
      assert.equal(pub.assembly_date, null);
      assert.equal(pub.cover_kind, 'none');

      // Добавление вложения-URL к публикации.
      const created = await api(ctx, 'POST', `/publications/${pub.id}/attachments`, {
        payload: { kind: 'url', url: 'https://example.com/pic.png', title: 'Картинка' },
      });
      assert.equal(created.statusCode, 201, created.body);
      const attachment = created.json().data as {
        id: string;
        owner_type: string;
        owner_id: string;
      };
      assert.equal(attachment.owner_type, 'publication');
      assert.equal(attachment.owner_id, pub.id);

      // Список вложений публикации.
      const list = await api(ctx, 'GET', `/publications/${pub.id}/attachments`);
      assert.equal(list.statusCode, 200, list.body);
      assert.equal((list.json().data as unknown[]).length, 1);

      // Использование: пока один владелец — сама публикация.
      const usage = await api(ctx, 'GET', `/attachments/${attachment.id}/usage`);
      assert.equal(usage.statusCode, 200, usage.body);
      assert.deepEqual((usage.json().data as { owners: unknown[] }).owners, [
        { owner_type: 'publication', owner_id: pub.id, title: 'Документ с вложениями' },
      ]);

      // Обложка из строки-вложения этой публикации — допустима.
      const cover = await api(ctx, 'PATCH', `/publications/${pub.id}`, {
        payload: { cover_attachment_id: attachment.id },
      });
      assert.equal(cover.statusCode, 200, cover.body);
      assert.equal((cover.json().data as { cover_kind: string }).cover_kind, 'attachment');

      // Та же картинка на мысль — использование агрегирует оба владельца.
      const thought = await createThought(ctx, 'Владелец картинки');
      const copied = await api(ctx, 'POST', `/attachments/${attachment.id}/copy`, {
        payload: { target_owner_type: 'thought', target_owner_ids: [thought] },
      });
      assert.equal(copied.statusCode, 200, copied.body);

      const usage2 = await api(ctx, 'GET', `/attachments/${attachment.id}/usage`);
      const owners2 = (usage2.json().data as { owners: Array<{ owner_type: string; title: string | null }> })
        .owners;
      assert.equal(owners2.length, 2, 'владельцы общего носителя: мысль и публикация');
      assert.deepEqual(
        owners2.map((o) => o.owner_type),
        ['thought', 'publication'],
      );
      assert.equal(owners2[0]!.title, 'Владелец картинки');

      // Отвязка строки публикации.
      const del = await api(ctx, 'DELETE', `/attachments/${attachment.id}`);
      assert.equal(del.statusCode, 204, del.body);
      const list2 = await api(ctx, 'GET', `/publications/${pub.id}/attachments`);
      assert.equal((list2.json().data as unknown[]).length, 0);

      // У скопированной строки носитель тот же, но владелец теперь один.
      const copiedId = (copied.json().data as { created: Array<{ id: string }> }).created[0]!.id;
      const usage3 = await api(ctx, 'GET', `/attachments/${copiedId}/usage`);
      assert.deepEqual(
        (usage3.json().data as { owners: Array<{ owner_type: string }> }).owners.map(
          (o) => o.owner_type,
        ),
        ['thought'],
      );
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('загрузка файла публикации и запрет чужой строки в обложке', async () => {
    const ctx = await buildRestContext();
    try {
      const pub = await createPublication(ctx, 'Документ с файлом');
      const upload = await api(ctx, 'POST', `/publications/${pub.id}/attachments/file`, {
        payload: { mime_type: 'image/png', data_base64: PNG_BASE64, title: 'Иконка' },
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const fileAtt = upload.json().data as { id: string; kind: string; owner_type: string };
      assert.equal(fileAtt.kind, 'file');
      assert.equal(fileAtt.owner_type, 'publication');

      // Строка-вложение ЧУЖОЙ публикации в обложке — 422.
      const other = await createPublication(ctx, 'Другая публикация');
      const bad = await api(ctx, 'PATCH', `/publications/${other.id}`, {
        payload: { cover_attachment_id: fileAtt.id },
      });
      assert.equal(bad.statusCode, 422, bad.body);
      assert.equal(
        (bad.json().error as { details?: { code?: string } }).details?.code,
        'cover_attachment_invalid',
      );
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('вложение к несуществующей публикации и usage несуществующего вложения → 404', async () => {
    const ctx = await buildRestContext();
    try {
      const missing = '00000000-0000-4000-8000-0000000000ff';
      const create = await api(ctx, 'POST', `/publications/${missing}/attachments`, {
        payload: { kind: 'url', url: 'https://example.com/x.png' },
      });
      assert.equal(create.statusCode, 404, create.body);
      const usage = await api(ctx, 'GET', `/attachments/${missing}/usage`);
      assert.equal(usage.statusCode, 404, usage.body);
    } finally {
      await closeRestContext(ctx);
    }
  });

  // Блокер приёмки 46cf4bcb: usage файлового вложения всегда отдавал owners:[]
  // (обе ветки WHERE были ложны для kind=file); общий корень — тот же
  // перепутанный паттерн в copyAttachment создавал дубль строки вместо skipped.
  it('usage для kind=file и идемпотентность copy (file и url)', async () => {
    const ctx = await buildRestContext();
    try {
      const pub = await createPublication(ctx, 'Файловый документ');
      const upload = await api(ctx, 'POST', `/publications/${pub.id}/attachments/file`, {
        payload: { mime_type: 'image/png', data_base64: PNG_BASE64, title: 'Файл' },
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const fileAtt = upload.json().data as { id: string; kind: string };

      // usage по файловой строке: ровно один владелец — публикация.
      const usage1 = await api(ctx, 'GET', `/attachments/${fileAtt.id}/usage`);
      assert.equal(usage1.statusCode, 200, usage1.body);
      assert.deepEqual(
        (usage1.json().data as { owners: Array<{ owner_type: string }> }).owners.map(
          (o) => o.owner_type,
        ),
        ['publication'],
        'usage файлового вложения обязан находить владельца (блокер)',
      );

      // Копия файла на мысль — создаётся; повтор — skipped, без дубля строки
      // (общий корень с блокером: старый паттерн создавал дубль).
      const thought = await createThought(ctx, 'Хозяин файла');
      const copy1 = await api(ctx, 'POST', `/attachments/${fileAtt.id}/copy`, {
        payload: { target_owner_type: 'thought', target_owner_ids: [thought] },
      });
      assert.equal(copy1.statusCode, 200, copy1.body);
      const copy1data = copy1.json().data as { created: unknown[]; skipped: string[] };
      assert.equal(copy1data.created.length, 1);
      assert.deepEqual(copy1data.skipped, []);

      const copy2 = await api(ctx, 'POST', `/attachments/${fileAtt.id}/copy`, {
        payload: { target_owner_type: 'thought', target_owner_ids: [thought] },
      });
      assert.equal(copy2.statusCode, 200, copy2.body);
      const copy2data = copy2.json().data as { created: unknown[]; skipped: string[] };
      assert.equal(copy2data.created.length, 0, 'повторное копирование файла не создаёт дубль');
      assert.deepEqual(copy2data.skipped, [thought]);

      // Копия на СВОЕГО же владельца (публикацию) тоже skipped — дубль не растёт.
      const copySameOwner = await api(ctx, 'POST', `/attachments/${fileAtt.id}/copy`, {
        payload: { target_owner_type: 'publication', target_owner_ids: [pub.id] },
      });
      assert.equal(
        (copySameOwner.json().data as { created: unknown[] }).created.length,
        0,
        'копия файла на уже владеющего — skipped',
      );
      const list = await api(ctx, 'GET', `/publications/${pub.id}/attachments`);
      assert.equal((list.json().data as unknown[]).length, 1, 'дубль строки не создан');

      // Агрегированное использование файла: мысль и публикация.
      const usage2 = await api(ctx, 'GET', `/attachments/${fileAtt.id}/usage`);
      const owners2 = (usage2.json().data as { owners: Array<{ owner_type: string; title: string | null }> })
        .owners;
      assert.deepEqual(
        owners2.map((o) => o.owner_type),
        ['thought', 'publication'],
      );
      assert.equal(owners2[0]!.title, 'Хозяин файла');

      // URL-вложение: идемпотентность копии тоже обязана работать.
      const urlAtt = (
        await api(ctx, 'POST', `/publications/${pub.id}/attachments`, {
          payload: { kind: 'url', url: 'https://example.com/idem.png' },
        })
      ).json().data as { id: string };
      const urlCopy1 = await api(ctx, 'POST', `/attachments/${urlAtt.id}/copy`, {
        payload: { target_owner_type: 'thought', target_owner_ids: [thought] },
      });
      assert.equal(
        (urlCopy1.json().data as { created: unknown[] }).created.length,
        1,
        'первая копия url создаётся',
      );
      const urlCopy2 = await api(ctx, 'POST', `/attachments/${urlAtt.id}/copy`, {
        payload: { target_owner_type: 'thought', target_owner_ids: [thought] },
      });
      assert.equal(
        (urlCopy2.json().data as { created: unknown[] }).created.length,
        0,
        'повторная копия url — skipped',
      );
    } finally {
      await closeRestContext(ctx);
    }
  });
});

describe('вложения публикаций: MCP-паритет (46cf4bcb)', { skip: !mcpNativeAvailable() }, () => {
  it('attachments.add с owner_type=publication и attachments.usage', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<{ id: string }>(
          await handle.client.callTool({
            name: 'etn.publications.create',
            arguments: { network_id: ctx.networkId, title: 'MCP-документ' },
          }),
        );
        const pubId = created.id;

        const added = await callOp(handle.client, 'attachments.add', {
          network_id: ctx.networkId,
          owner_type: 'publication',
          owner_id: pubId,
          kind: 'url',
          url: 'https://example.com/mcp.png',
          title: 'MCP-картинка',
        });
        assert.equal(added.isError, undefined, toolText(added));
        const addedJson = toolJson<{ id: string }>(added);

        const usage = await callOp(handle.client, 'attachments.usage', {
          network_id: ctx.networkId,
          attachment_id: addedJson.id,
        });
        assert.equal(usage.isError, undefined, toolText(usage));
        const usageJson = toolJson<{
          attachment_id: string;
          owners: Array<{ owner_type: string; owner_id: string; title: string | null }>;
        }>(usage);
        assert.equal(usageJson.attachment_id, addedJson.id);
        assert.deepEqual(usageJson.owners, [
          { owner_type: 'publication', owner_id: pubId, title: 'MCP-документ' },
        ]);

        // kind=file (блокер приёмки): usage по файловой строке обязан найти
        // владельца, а не вернуть пустой список.
        const fileAdded = toolJson<{ id: string }>(
          await callOp(handle.client, 'attachments.add', {
            network_id: ctx.networkId,
            owner_type: 'publication',
            owner_id: pubId,
            kind: 'file',
            mime_type: 'image/png',
            data_base64: PNG_BASE64,
            title: 'MCP-файл',
          }),
        );
        const fileUsage = toolJson<{
          owners: Array<{ owner_type: string; owner_id: string; title: string | null }>;
        }>(
          await callOp(handle.client, 'attachments.usage', {
            network_id: ctx.networkId,
            attachment_id: fileAdded.id,
          }),
        );
        assert.deepEqual(
          fileUsage.owners,
          [{ owner_type: 'publication', owner_id: pubId, title: 'MCP-документ' }],
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
