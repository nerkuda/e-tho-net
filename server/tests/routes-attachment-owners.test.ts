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

import type { AnyRealtimeEvent } from '@etn/shared';

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
  callWrite,
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

/** DTO-проекция агрегатов владения (сущность 109be255). */
interface AttachmentDto {
  id: string;
  owner_count?: number;
  owned_by_current?: boolean;
  owners?: Array<{ owner_type: string; owner_id: string }>;
}

describe('REST: DTO-агрегаты владений (109be255, замечание проверки 478f8c1f)', { skip: !nativeAvailable() }, () => {
  it('owners/owner_count/owned_by_current в list/get/search', async () => {
    const ctx = await buildRestContext();
    try {
      const a = await createThought(ctx, 'Владелец A');
      const b = await createThought(ctx, 'Владелец B');
      const att = await createImageAttachment(ctx, a, 'shared-image');

      // Список объекта: один владелец, признак «принадлежит объекту» = true.
      const listA = await api(ctx, 'GET', `/thoughts/${a}/attachments`);
      const rowA = (listA.json().data as AttachmentDto[])[0]!;
      assert.equal(rowA.owner_count, 1, 'owner_count списка объекта');
      assert.equal(rowA.owned_by_current, true, 'список объекта — owned_by_current');
      assert.deepEqual(rowA.owners?.map((o) => o.owner_id), [a]);

      // Одиночное чтение несёт те же агрегаты.
      const get = await api(ctx, 'GET', `/attachments/${att}`);
      const dto = get.json().data as AttachmentDto;
      assert.equal(dto.owner_count, 1);
      assert.equal(dto.owners?.length, 1);

      // Второй владелец видит агрегат из двух.
      const add = await api(ctx, 'POST', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_ids: [b] },
      });
      assert.equal(add.statusCode, 200, add.body);
      const listB = await api(ctx, 'GET', `/thoughts/${b}/attachments`);
      const rowB = (listB.json().data as AttachmentDto[])[0]!;
      assert.equal(rowB.owner_count, 2, 'общий агрегат у второго владельца');
      assert.equal(rowB.owned_by_current, true);
      assert.deepEqual(
        rowB.owners?.map((o) => o.owner_id).sort(),
        [a, b].sort(),
      );

      // Поиск без exclude: агрегат есть, признак контекста отсутствует.
      const search = await api(ctx, 'GET', '/attachments?q=shared');
      const items = search.json().data as AttachmentDto[];
      assert.equal(items.length, 1);
      assert.equal(items[0]!.owner_count, 2, 'поиск несёт owner_count');
      assert.equal(
        Object.prototype.hasOwnProperty.call(items[0]!, 'owned_by_current'),
        false,
        'без exclude_owner_* признак не выставляется',
      );

      // Поиск с exclude по СТОРОННЕМУ объекту (не владельцу) — вложение
      // остаётся в выдаче, owned_by_current = false.
      const z = await createThought(ctx, 'Сторонний Z');
      const searchEx = await api(
        ctx,
        'GET',
        `/attachments?q=shared&exclude_owner_type=thought&exclude_owner_id=${z}`,
      );
      const exItems = searchEx.json().data as AttachmentDto[];
      assert.equal(exItems.length, 1);
      assert.equal(exItems[0]!.owned_by_current, false, 'exclude → owned_by_current=false');

      // А exclude по настоящему владельцу A прячет вложение (оно уже у него).
      const searchHidden = await api(
        ctx,
        'GET',
        `/attachments?q=shared&exclude_owner_type=thought&exclude_owner_id=${a}`,
      );
      assert.equal((searchHidden.json().data as AttachmentDto[]).length, 0);
    } finally {
      await closeRestContext(ctx);
    }
  });
});

describe('REST: realtime-события владений (109be255, f77382ba)', { skip: !nativeAvailable() }, () => {
  it('add/copy/дедуп эмитят owner.added, снятие — owner.removed (+deleted)', async () => {
    const ctx = await buildRestContext();
    const seen: AnyRealtimeEvent[] = [];
    const unsubscribe = ctx.app.pubsub.subscribe(ctx.networkId, (e) =>
      seen.push(e as unknown as AnyRealtimeEvent),
    );
    const attEvents = (): AnyRealtimeEvent[] =>
      seen.filter((e) => e.type.startsWith('attachment.'));
    try {
      const a = await createThought(ctx, 'A');
      const b = await createThought(ctx, 'B');
      const c = await createThought(ctx, 'C');
      const d = await createThought(ctx, 'D');
      const att = await createImageAttachment(ctx, a, 'Файл');
      assert.deepEqual(
        attEvents().map((e) => e.type),
        ['attachment.created'],
        'первичное создание — attachment.created',
      );

      // Добавление владельца B — attachment.owner.added.
      seen.length = 0;
      await api(ctx, 'POST', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_ids: [b] },
      });
      assert.deepEqual(
        attEvents().map((e) => e.type),
        ['attachment.owner.added'],
      );
      assert.deepEqual(attEvents()[0]!.data, {
        attachment_id: att,
        owner_type: 'thought',
        owner_id: b,
      });

      // Копирование владельцам C — тоже attachment.owner.added.
      seen.length = 0;
      await api(ctx, 'POST', `/attachments/${att}/copy`, {
        payload: { target_owner_type: 'thought', target_owner_ids: [c] },
      });
      assert.deepEqual(
        attEvents().map((e) => e.type),
        ['attachment.owner.added'],
      );
      assert.equal((attEvents()[0]!.data as { owner_id: string }).owner_id, c);

      // Дедуп: повторная загрузка тех же байт к D переиспользует вложение и
      // эмитит владение, а не ложное создание.
      seen.length = 0;
      const dup = await api(ctx, 'POST', `/thoughts/${d}/attachments/file`, {
        payload: { mime_type: 'image/png', data_base64: PNG_BASE64, title: 'Дубль' },
      });
      assert.equal(dup.statusCode, 201, dup.body);
      assert.equal((dup.json().meta as { reused?: boolean }).reused, true, 'дедуп по хэшу');
      assert.deepEqual(
        attEvents().map((e) => e.type),
        ['attachment.owner.added'],
        'дедуп — владение, не создание',
      );
      assert.deepEqual(attEvents()[0]!.data, {
        attachment_id: att,
        owner_type: 'thought',
        owner_id: d,
      });

      // Снятие владельца B — attachment.owner.removed.
      seen.length = 0;
      await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: b },
      });
      assert.deepEqual(
        attEvents().map((e) => e.type),
        ['attachment.owner.removed'],
      );
      assert.deepEqual(attEvents()[0]!.data, {
        attachment_id: att,
        owner_type: 'thought',
        owner_id: b,
      });

      // Снятие последнего живого владельца — removed + deleted.
      await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: a },
      });
      await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: c },
      });
      seen.length = 0;
      await api(ctx, 'DELETE', `/attachments/${att}/owners`, {
        payload: { owner_type: 'thought', owner_id: d },
      });
      assert.deepEqual(
        attEvents().map((e) => e.type),
        ['attachment.owner.removed', 'attachment.deleted'],
        'последний владелец: removed + deleted',
      );
    } finally {
      unsubscribe();
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

describe('MCP: события владений вложения (f77382ba)', { skip: !mcpNativeAvailable() }, () => {
  it('дедуп add — owner.added (повтор тому же владельцу молчит); removeOwner — owner.removed (+deleted)', async () => {
    const ctx = await buildMcpContext();
    const seen: AnyRealtimeEvent[] = [];
    const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (e) =>
      seen.push(e as unknown as AnyRealtimeEvent),
    );
    const attEvents = (): AnyRealtimeEvent[] =>
      seen.filter((e) => e.type.startsWith('attachment.'));
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Вторая мысль-владелец через батч (MCP-путь создания мысли).
        const written = await callWrite(handle.client, ctx.networkId, [
          { ref: 'mcp-owner', thought: { title: 'MCP-владелец' } },
        ]);
        const ownerId = written.items[0]!.id;

        // Первая загрузка файла к HOME — attachment.created.
        const first = toolJson<{ id: string }>(
          await callOp(handle.client, 'attachments.add', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ctx.homeId,
            kind: 'file',
            mime_type: 'image/png',
            data_base64: PNG_BASE64,
            title: 'shared-via-mcp',
          }),
        );
        assert.deepEqual(
          attEvents().map((e) => e.type),
          ['attachment.created'],
        );

        // Те же байты ко второму владельцу — дедуп: owner.added, та же строка.
        seen.length = 0;
        const second = toolJson<{ id: string }>(
          await callOp(handle.client, 'attachments.add', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: ownerId,
            kind: 'file',
            mime_type: 'image/png',
            data_base64: PNG_BASE64,
            title: 'shared-via-mcp',
          }),
        );
        assert.equal(second.id, first.id, 'дедуп: та же строка вложения');
        assert.deepEqual(
          attEvents().map((e) => e.type),
          ['attachment.owner.added'],
        );
        assert.deepEqual(attEvents()[0]!.data, {
          attachment_id: first.id,
          owner_type: 'thought',
          owner_id: ownerId,
        });

        // Повтор тому же владельцу — нового владения нет, событий нет.
        seen.length = 0;
        await callOp(handle.client, 'attachments.add', {
          network_id: ctx.networkId,
          owner_type: 'thought',
          owner_id: ownerId,
          kind: 'file',
          mime_type: 'image/png',
          data_base64: PNG_BASE64,
          title: 'shared-via-mcp',
        });
        assert.deepEqual(
          attEvents().map((e) => e.type),
          [],
          'повтор тому же владельцу — без событий',
        );

        // Снятие второго владельца — owner.removed (вложение живо у HOME).
        seen.length = 0;
        await callOp(
          handle.client,
          'attachments.removeOwner',
          {
            network_id: ctx.networkId,
            attachment_id: first.id,
            owner_type: 'thought',
            owner_id: ownerId,
          },
          true,
        );
        assert.deepEqual(
          attEvents().map((e) => e.type),
          ['attachment.owner.removed'],
        );
        assert.deepEqual(attEvents()[0]!.data, {
          attachment_id: first.id,
          owner_type: 'thought',
          owner_id: ownerId,
        });

        // Последний владелец — owner.removed + attachment.deleted.
        seen.length = 0;
        await callOp(
          handle.client,
          'attachments.removeOwner',
          {
            network_id: ctx.networkId,
            attachment_id: first.id,
            owner_type: 'thought',
            owner_id: ctx.homeId,
          },
          true,
        );
        assert.deepEqual(
          attEvents().map((e) => e.type),
          ['attachment.owner.removed', 'attachment.deleted'],
        );
      } finally {
        await handle.close();
      }
    } finally {
      unsubscribe();
      await closeMcpContext(ctx);
    }
  });
});
