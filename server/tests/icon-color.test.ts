/**
 * Цвет символа иконки `icon_color` — хранение на мысли и типе мысли и серверная
 * валидация значения (0.12.1, задача 4105bd6a; наследование — требование
 * 0da6f02a).
 *
 * Проверяется: REST-контракты создания/правки/чтения мысли и типа мысли
 * принимают HEX-цвет (`#rrggbb`) и отдают его при чтении (переживает запись в
 * БД); `null` сбрасывает цвет; не-HEX значение отвергается `VALIDATION_ERROR`
 * (REST — на обоих контрактах).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';

const ICON_COLOR_MESSAGE = 'icon_color должен быть HEX-цветом вида #rrggbb.';
const COLOR = '#ff8800';

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

async function getThought(ctx: RestTestContext, id: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
  });
}

async function createType(ctx: RestTestContext, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload,
  });
}

describe(
  'REST: цвет символа иконки мысли (4105bd6a)',
  () => {
    it('создание с HEX-цветом проходит, чтение возвращает цвет', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createThought(ctx, {
          title: 'Мысль с цветной иконкой',
          icon: 'book-open',
          icon_kind: 'icon',
          icon_color: COLOR,
        });
        assert.equal(created.statusCode, 201, created.body);
        const id = (created.json().data as { id: string }).id;

        const get = await getThought(ctx, id);
        assert.equal(get.statusCode, 200);
        const data = get.json().data as { icon_color?: string | null };
        assert.equal(data.icon_color, COLOR);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('правка: цвет задаётся и сбрасывается в null', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await createThought(ctx, { title: 'Правка цвета' });
        assert.equal(created.statusCode, 201);
        const id = (created.json().data as { id: string }).id;

        const set = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { icon_color: COLOR },
        });
        assert.equal(set.statusCode, 200, set.body);
        assert.equal((set.json().data as { icon_color?: string | null }).icon_color, COLOR);

        const clear = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
          headers: { ...authHeaders(ctx), 'if-match': '2' },
          payload: { icon_color: null },
        });
        assert.equal(clear.statusCode, 200, clear.body);
        assert.equal((clear.json().data as { icon_color?: string | null }).icon_color, null);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('не-HEX значение отвергается VALIDATION_ERROR на создании и правке', async () => {
      const ctx = await buildRestContext();
      try {
        const badCreate = await createThought(ctx, {
          title: 'Плохой цвет',
          icon_color: 'red',
        });
        assert.equal(badCreate.statusCode, 422, badCreate.body);
        assert.equal((badCreate.json() as RestError).error.message, ICON_COLOR_MESSAGE);

        const created = await createThought(ctx, { title: 'Правка плохого цвета' });
        const id = (created.json().data as { id: string }).id;
        const badPatch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { icon_color: '#xyzxyz' },
        });
        assert.equal(badPatch.statusCode, 422, badPatch.body);
        assert.equal((badPatch.json() as RestError).error.message, ICON_COLOR_MESSAGE);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

describe('REST: цвет символа иконки типа мысли (4105bd6a)', () => {
  it('создание с HEX-цветом проходит, чтение типа возвращает цвет', async () => {
    const ctx = await buildRestContext();
    try {
      const created = await createType(ctx, {
        name: 'Тип с цветной иконкой',
        icon: 'book-open',
        icon_kind: 'icon',
        icon_color: COLOR,
      });
      assert.equal(created.statusCode, 201, created.body);
      const id = (created.json().data as { id: string }).id;

      const get = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/thought-types/${id}`,
        headers: authHeaders(ctx),
      });
      assert.equal(get.statusCode, 200, get.body);
      const found = get.json().data as { icon_color?: string | null };
      assert.equal(found.icon_color, COLOR);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('не-HEX значение отвергается VALIDATION_ERROR', async () => {
    const ctx = await buildRestContext();
    try {
      const bad = await createType(ctx, { name: 'Тип плохой цвет', icon_color: '#12345' });
      assert.equal(bad.statusCode, 422, bad.body);
      assert.equal((bad.json() as RestError).error.message, ICON_COLOR_MESSAGE);
    } finally {
      await closeRestContext(ctx);
    }
  });
});
