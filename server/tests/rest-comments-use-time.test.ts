/**
 * Регресс REST-правки хроно-комментария: флаг «учитывать время» (`use_time`)
 * доезжает до домена (0.10.1, итерация приёмки №11, ошибка f45fac74).
 *
 * Дефект: контракт `RestCommentUpdate` объявлял `use_time` в zod-схеме, но не
 * в REST-карте, а `parseRest` читает только REST-карту — `PATCH /comments/{id}`
 * молча терял флаг (экран «Дневник» включал время, но оно не сохранялось).
 * Здесь проверяется СКВОЗНОЙ путь REST: создание (уже работало — не сломать),
 * снятие и включение флага правкой.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authHeaders, buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';

interface CommentDto {
  id: string;
  version: number;
  use_time: boolean;
  valid_from: string;
  valid_to: string | null;
}

describe(
  'REST: правка хроно-комментария доводит use_time (f45fac74)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('создание чтит use_time; PATCH снимает и включает флаг', async () => {
      const ctx = await buildRestContext();
      try {
        // Создание — уже работало (`commentFieldsRest` содержит use_time).
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'chronological',
            body_md: 'тест флага времени',
            valid_from: '2026-09-27T07:00:00.000Z',
            valid_to: '2026-09-27T07:00:00.000Z',
            use_time: true,
          },
        });
        assert.equal(created.statusCode, 201, created.body);
        const first = created.json().data as CommentDto;
        assert.equal(first.use_time, true, 'создание сохраняет use_time=true');

        // PATCH use_time=false — снять флаг.
        const off = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${first.id}`,
          headers: { ...authHeaders(ctx), 'if-match': String(first.version) },
          payload: { use_time: false },
        });
        assert.equal(off.statusCode, 200, off.body);
        const offData = off.json().data as CommentDto;
        assert.equal(offData.use_time, false, 'PATCH применяет use_time=false');

        // PATCH use_time=true — включить флаг (без фикса здесь оставалось false).
        const on = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${first.id}`,
          headers: { ...authHeaders(ctx), 'if-match': String(offData.version) },
          payload: { use_time: true },
        });
        assert.equal(on.statusCode, 200, on.body);
        const onData = on.json().data as CommentDto;
        assert.equal(onData.use_time, true, 'PATCH применяет use_time=true');
        assert.equal(onData.valid_from, first.valid_from, 'правка флага не трогает даты');

        // Перечитывание (GET) подтверждает сохранение в хранилище.
        const read = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/comments/${first.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(read.statusCode, 200, read.body);
        assert.equal((read.json().data as CommentDto).use_time, true, 'флаг сохранён в базе');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
