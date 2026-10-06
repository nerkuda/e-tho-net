/**
 * Вид иконки `icon_kind='icon'` — имя каталога Lucide и его серверная
 * валидация (ADR 2b655b29, требование ead91183, задача 610a440e).
 *
 * Проверяется: значение `icon` добавлено в `ICON_KINDS`; REST-контракты
 * создания/правки/чтения мысли и типа мысли принимают вид `icon` с известным
 * именем; неизвестное имя отвергается `VALIDATION_ERROR` (REST и MCP
 * `etn.ontology.write`); виды `emoji`/`image` работают как прежде — правило
 * срабатывает только при `icon_kind='icon'`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ICON_KINDS, ICON_LIBRARY_NAMES, isIconLibraryName } from '@etn/shared';

import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolText,
} from './mcp-helpers.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';

const LIBRARY_ICON_MESSAGE = 'icon должен быть именем иконки из каталога Lucide (kebab-case).';

/** Известное имя каталога (используется в положительных сценариях). */
const KNOWN_ICON = 'book-open';
/** Заведомо отсутствующее в каталоге имя. */
const UNKNOWN_ICON = 'definitely-not-a-lucide-icon';

interface RestError {
  error: { code: string; message: string };
}

async function createThought(ctx: RestTestContext, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload,
  });
}

describe('каталог имён иконок в @etn/shared (610a440e)', () => {
  it('ICON_KINDS содержит вид icon', () => {
    assert.ok((ICON_KINDS as readonly string[]).includes('icon'));
  });

  it('isIconLibraryName принимает известное kebab-имя и отвергает неизвестное', () => {
    assert.ok(ICON_LIBRARY_NAMES.length > 100, 'каталог Lucide непустой');
    assert.ok(isIconLibraryName('search'));
    assert.ok(isIconLibraryName(KNOWN_ICON));
    assert.equal(isIconLibraryName(UNKNOWN_ICON), false);
    assert.equal(isIconLibraryName(''), false);
    assert.equal(isIconLibraryName('Search'), false, 'имена — строго kebab-case');
  });
});

describe(
  'REST: вид иконки icon в контрактах мысли (610a440e)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('создание с известным именем проходит, чтение возвращает вид icon', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createThought(ctx, {
          title: 'Мысль с библиотечной иконкой',
          icon: KNOWN_ICON,
          icon_kind: 'icon',
        });
        assert.equal(created.statusCode, 201, created.body);
        const id = (created.json().data as { id: string }).id;

        const get = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(get.statusCode, 200);
        const data = get.json().data as { icon: string | null; icon_kind: string };
        assert.equal(data.icon_kind, 'icon');
        assert.equal(data.icon, KNOWN_ICON);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('создание с неизвестным именем — VALIDATION_ERROR', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await createThought(ctx, {
          title: 'Мысль с плохой иконкой',
          icon: UNKNOWN_ICON,
          icon_kind: 'icon',
        });
        assert.equal(res.statusCode, 422, res.body);
        const body = res.json() as RestError;
        assert.equal(body.error.code, 'VALIDATION_ERROR');
        assert.equal(body.error.message, LIBRARY_ICON_MESSAGE);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('правка вида icon: неизвестное имя отвергается, известное проходит', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createThought(ctx, { title: 'Правка иконки' });
        assert.equal(created.statusCode, 201);
        const id = (created.json().data as { id: string }).id;

        const bad = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { icon: UNKNOWN_ICON, icon_kind: 'icon' },
        });
        assert.equal(bad.statusCode, 422, bad.body);
        assert.equal((bad.json() as RestError).error.message, LIBRARY_ICON_MESSAGE);

        const good = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { icon: KNOWN_ICON, icon_kind: 'icon' },
        });
        assert.equal(good.statusCode, 200, good.body);
        const data = good.json().data as { icon: string | null; icon_kind: string };
        assert.equal(data.icon_kind, 'icon');
        assert.equal(data.icon, KNOWN_ICON);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('обратная совместимость: emoji и image работают, правило не срабатывает', async () => {
      const ctx = await buildRestContext();
      try {
        const emoji = await createThought(ctx, {
          title: 'Эмодзи',
          icon: '🙂',
          icon_kind: 'emoji',
        });
        assert.equal(emoji.statusCode, 201, emoji.body);

        // Строка, не входящая в каталог, при виде emoji допустима (правило
        // вида icon к emoji не применяется).
        const emojiOdd = await createThought(ctx, {
          title: 'Эмодзи-слот с произвольной строкой',
          icon: UNKNOWN_ICON,
          icon_kind: 'emoji',
        });
        assert.equal(emojiOdd.statusCode, 201, emojiOdd.body);

        const image = await createThought(ctx, {
          title: 'Картинка',
          icon: 'https://example.com/icon.png',
          icon_kind: 'image',
        });
        assert.equal(image.statusCode, 201, image.body);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

describe(
  'REST: вид иконки icon в контрактах типа мысли (610a440e)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('известное имя проходит, неизвестное — VALIDATION_ERROR (создание и правка)', async () => {
      const ctx = await buildRestContext();
      try {
        const bad = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types`,
          headers: authHeaders(ctx),
          payload: { name: 'Тип с плохой иконкой', icon: UNKNOWN_ICON, icon_kind: 'icon' },
        });
        assert.equal(bad.statusCode, 422, bad.body);
        assert.equal((bad.json() as RestError).error.message, LIBRARY_ICON_MESSAGE);

        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types`,
          headers: authHeaders(ctx),
          payload: { name: 'Тип с иконкой', icon: KNOWN_ICON, icon_kind: 'icon' },
        });
        assert.equal(created.statusCode, 201, created.body);
        const id = (created.json().data as { id: string }).id;

        const patchBad = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${id}`,
          headers: authHeaders(ctx),
          payload: { icon: UNKNOWN_ICON, icon_kind: 'icon' },
        });
        assert.equal(patchBad.statusCode, 422, patchBad.body);
        assert.equal((patchBad.json() as RestError).error.message, LIBRARY_ICON_MESSAGE);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

describe(
  'MCP: вид иконки icon в etn.ontology.write (610a440e)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('неизвестное имя отвергается, известное проходит', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const bad = await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [
                { ref: 'bad', name: 'Тип с плохой иконкой', icon: UNKNOWN_ICON, icon_kind: 'icon' },
              ],
            },
          });
          assert.equal(bad.isError, true, toolText(bad));
          assert.match(toolText(bad), /VALIDATION_ERROR/);
          assert.match(toolText(bad), /Lucide/);

          const good = await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [
                { ref: 'good', name: 'Тип с иконкой', icon: KNOWN_ICON, icon_kind: 'icon' },
              ],
            },
          });
          assert.equal(good.isError, undefined, toolText(good));
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
