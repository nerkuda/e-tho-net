/**
 * REST: неизвестные ключи тел создания и правки отвергаются канонической 422
 * (ошибка 244859b9, требование 40efde41).
 *
 * Симптом до фикса: тела комментариев, вложений и batch-копирования
 * разбирались «по белому списку» — лишний ключ молча отбрасывался, маршрут
 * отвечал 201/200, и клиент считал поле применённым (`POST
 * /thoughts/{id}/comments {kind, body_md, zzz}` → 201; `PATCH
 * /attachments/{id} {title, zzz}` → 200; `PATCH /comments/{id} {body_md, zzz}`
 * → 200). Тела мыслей закрыл d9ba9e68 ручным вызовом в роутах; остальные
 * маршруты остались открытыми.
 *
 * Фикс — общая механика парсера REST: `assertKnownBodyFields` вызывается из
 * `parseRest` для любого тела, у которого контракт объявляет поля. Тесты
 * проверяют каждый затронутый маршрут в двух направлениях: лишний ключ → 422
 * с `details.fields` (что пришло) и `details.allowed` (что допустимо), а
 * легитимные поля по-прежнему доходят до домена (не отбрасываются вместе с
 * мусором).
 *
 * Пропускается, когда нативная сборка `better-sqlite3` недоступна.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Тело канонической ошибки REST. */
function errorBody(res: { json: () => unknown }): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return (
    res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }
  ).error;
}

async function api(
  ctx: RestTestContext,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  options: { payload?: Record<string, unknown>; version?: number } = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${path}`,
    headers: {
      ...authHeaders(ctx),
      ...(options.version === undefined ? {} : { 'if-match': String(options.version) }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await api(ctx, 'POST', '/thoughts', { payload: { title } });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Снимок мысли для тела copy-batch (минимально допустимый). */
function thoughtSnapshot(): Record<string, unknown> {
  return {
    source_id: randomUUID(),
    thought: {
      title: 'Копия',
      synonyms: [],
      type: { id: null, name: null },
      icon: null,
      icon_kind: 'emoji',
      active: true,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    },
  };
}

describe(
  'REST: неизвестные поля тел создания и правки (244859b9)',
  { skip: !nativeAvailable() },
  () => {
    it('POST /thoughts/{id}/comments: лишний ключ → 422, без него → 201', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин комментария');

        const extra = await api(ctx, 'POST', `/thoughts/${thoughtId}/comments`, {
          payload: { kind: 'permanent', body_md: 'Текст', zzz: 1 },
        });
        assert.equal(extra.statusCode, 422, extra.body);
        const error = errorBody(extra);
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.deepEqual(error.details?.['fields'], ['zzz']);
        const allowed = error.details?.['allowed'] as string[];
        for (const field of ['kind', 'body_md', 'title', 'valid_from', 'valid_to', 'use_time']) {
          assert.ok(allowed.includes(field), `details.allowed без ${field}: ${allowed.join(', ')}`);
        }

        // Легитимные поля по-прежнему принимаются и доходят до ответа.
        const ok = await api(ctx, 'POST', `/thoughts/${thoughtId}/comments`, {
          payload: {
            kind: 'chronological',
            title: 'Событие',
            body_md: 'Хронология',
            valid_from: '2026-01-01',
          },
        });
        assert.equal(ok.statusCode, 201, ok.body);
        const created = ok.json().data as { title: string; body_md: string; valid_from: string };
        assert.equal(created.title, 'Событие');
        assert.equal(created.body_md, 'Хронология');
        // `valid_from` нормализуется доменом в UTC-инстанс — проверяем день.
        assert.ok(created.valid_from.startsWith('2026-01-01'), created.valid_from);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST /networks/{id}/comments (несколько владельцев): лишний ключ → 422', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Владелец цели');
        const extra = await api(ctx, 'POST', '/comments', {
          payload: {
            kind: 'permanent',
            body_md: 'Текст',
            targets: [{ owner_type: 'thought', owner_id: thoughtId }],
            zzz: true,
          },
        });
        assert.equal(extra.statusCode, 422, extra.body);
        assert.deepEqual(errorBody(extra).details?.['fields'], ['zzz']);
        assert.ok((errorBody(extra).details?.['allowed'] as string[]).includes('targets'));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH /comments/{id}: лишний ключ → 422, без него правка применяется', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин правки комментария');
        const created = await api(ctx, 'POST', `/thoughts/${thoughtId}/comments`, {
          payload: { kind: 'chronological', title: 'Событие', body_md: 'Было' },
        });
        assert.equal(created.statusCode, 201, created.body);
        const comment = created.json().data as { id: string; version: number };

        const extra = await api(ctx, 'PATCH', `/comments/${comment.id}`, {
          payload: { body_md: 'Стало', zzz: 'нет такого поля' },
          version: comment.version,
        });
        assert.equal(extra.statusCode, 422, extra.body);
        assert.deepEqual(errorBody(extra).details?.['fields'], ['zzz']);
        assert.ok((errorBody(extra).details?.['allowed'] as string[]).includes('body_md'));

        const ok = await api(ctx, 'PATCH', `/comments/${comment.id}`, {
          payload: { title: 'Новое событие', body_md: 'Стало' },
          version: comment.version,
        });
        assert.equal(ok.statusCode, 200, ok.body);
        const updated = ok.json().data as { title: string; body_md: string; version: number };
        assert.equal(updated.title, 'Новое событие');
        assert.equal(updated.body_md, 'Стало');
        assert.equal(updated.version, comment.version + 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST /thoughts/{id}/attachments: лишний ключ → 422, без него → 201', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин вложения');

        const extra = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments`, {
          payload: { kind: 'url', url: 'https://example.com/a', zzz: 'лишнее' },
        });
        assert.equal(extra.statusCode, 422, extra.body);
        assert.deepEqual(errorBody(extra).details?.['fields'], ['zzz']);
        const allowed = errorBody(extra).details?.['allowed'] as string[];
        for (const field of [
          'kind',
          'url',
          'file_path',
          'mime_type',
          'title',
          'description',
          'position',
        ]) {
          assert.ok(allowed.includes(field), `details.allowed без ${field}: ${allowed.join(', ')}`);
        }

        const ok = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments`, {
          payload: {
            kind: 'url',
            url: 'https://example.com/a',
            title: 'Ссылка',
            description: 'Описание',
            position: 2,
          },
        });
        assert.equal(ok.statusCode, 201, ok.body);
        const attachment = ok.json().data as {
          id: string;
          title: string | null;
          description: string | null;
          position: number;
        };
        assert.equal(attachment.title, 'Ссылка');
        assert.equal(attachment.description, 'Описание');
        assert.equal(attachment.position, 2);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH /attachments/{id}: лишний ключ → 422, без него правка применяется', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин правки вложения');
        const created = await api(ctx, 'POST', `/thoughts/${thoughtId}/attachments`, {
          payload: { kind: 'url', url: 'https://example.com/b', title: 'Было' },
        });
        assert.equal(created.statusCode, 201, created.body);
        const attachment = created.json().data as { id: string };

        const extra = await api(ctx, 'PATCH', `/attachments/${attachment.id}`, {
          payload: { title: 'Стало', zzz: 1 },
        });
        assert.equal(extra.statusCode, 422, extra.body);
        assert.deepEqual(errorBody(extra).details?.['fields'], ['zzz']);
        const allowedFields = errorBody(extra).details?.['allowed'] as string[];
        assert.deepEqual(
          allowedFields.filter((field) => ['title', 'description', 'icon'].includes(field)),
          ['title', 'description', 'icon'],
          `в details.allowed нет правки метаданных: ${allowedFields.join(', ')}`,
        );

        const ok = await api(ctx, 'PATCH', `/attachments/${attachment.id}`, {
          payload: { title: 'Стало', description: 'Новое описание' },
        });
        assert.equal(ok.statusCode, 200, ok.body);
        const updated = ok.json().data as { title: string | null; description: string | null };
        assert.equal(updated.title, 'Стало');
        assert.equal(updated.description, 'Новое описание');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST /thoughts/copy-batch: лишний ключ → 422, без него → 200', async () => {
      const ctx = await buildRestContext();
      try {
        const parentId = await createThought(ctx, 'Цель вставки');
        const copy = await api(ctx, 'POST', '/thoughts/copy-batch', {
          payload: {
            source_network_id: ctx.networkId,
            parent_thought_id: parentId,
            thoughts: [thoughtSnapshot()],
            links: [],
          },
        });
        assert.equal(copy.statusCode, 200, copy.body);

        const extra = await api(ctx, 'POST', '/thoughts/copy-batch', {
          payload: {
            source_network_id: ctx.networkId,
            parent_thought_id: parentId,
            thoughts: [thoughtSnapshot()],
            links: [],
            zzz: 'лишнее',
          },
        });
        assert.equal(extra.statusCode, 422, extra.body);
        assert.deepEqual(errorBody(extra).details?.['fields'], ['zzz']);
        const allowed = errorBody(extra).details?.['allowed'] as string[];
        for (const field of ['source_network_id', 'parent_thought_id', 'thoughts', 'links']) {
          assert.ok(allowed.includes(field), `details.allowed без ${field}: ${allowed.join(', ')}`);
        }
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
