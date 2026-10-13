/**
 * Задача d5e8ddc1 (требование b91336e7, ADR 7581ac14): приём AST-условия
 * мыслевых настроек в REST-точке поиска `GET /search`.
 *
 * Проверяем через реальный сервер (`app.inject`):
 *   * `ast` принимается в query-параметре как JSON-объект и исполняется
 *     единым движком (актуальность/корзина из AST, не плоские дефолты);
 *   * `ast` XOR плоские мыслевые параметры → 422 `VALIDATION_ERROR` (схема);
 *   * условие вне профиля `thoughts` → 422 `VALIDATION_ERROR` с диагностикой
 *     (`details.violations`) — сценарий 55f31eee;
 *   * веерный режим `network_ids` несёт `ast` (иначе настройки терялись бы).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION, type FilterAst } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Вставить мысль напрямую в БД сети теста. */
function seedThought(
  ctx: RestTestContext,
  title: string,
  opts: { active?: number } = {},
): string {
  const id = randomUUID();
  ctx.ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, ?, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), opts.active ?? 1);
  return id;
}

/** `ast`-условие «только неактуальные / только активные». */
function activeAst(active: boolean): FilterAst {
  return {
    version: FILTER_AST_VERSION,
    filter: { entity: { kind: 'active' }, operator: 'eq', value: active },
  };
}

async function search(
  ctx: RestTestContext,
  query: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const url = `/api/v1/networks/${ctx.networkId}/search?${new URLSearchParams(query).toString()}`;
  const res = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx) });
  return { status: res.statusCode, body: res.json() };
}

describe('REST /search + ast (задача d5e8ddc1)', { skip: !nativeAvailable() }, () => {
  it('ast в query-параметре исполняется; плоские дефолты актуальности не применяются', async () => {
    const ctx = await buildRestContext();
    try {
      seedThought(ctx, 'Ast active secret', { active: 1 });
      const inactive = seedThought(ctx, 'Ast inactive secret', { active: 0 });

      // Без ast: неактивная мысль скрыта дефолтом.
      const plain = await search(ctx, { q: 'secret', scope: 'names' });
      assert.equal(plain.status, 200);
      const plainNames = (plain.body as { data: { by_names: unknown[] } }).data.by_names;
      assert.equal(plainNames.length, 1);

      // С ast «только неактуальные»: единый движок чтит AST, а не дефолт.
      const viaAst = await search(ctx, {
        q: 'secret',
        scope: 'names',
        ast: JSON.stringify(activeAst(false)),
      });
      assert.equal(viaAst.status, 200, JSON.stringify(viaAst.body));
      const astNames = (
        viaAst.body as { data: { by_names: Array<{ thought_id: string }> } }
      ).data.by_names;
      assert.deepEqual(astNames.map((h) => h.thought_id), [inactive]);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('ast XOR плоские мыслевые параметры → 422 VALIDATION_ERROR', async () => {
    const ctx = await buildRestContext();
    try {
      const conflict = await search(ctx, {
        q: 'secret',
        ast: JSON.stringify(activeAst(true)),
        show_inactive: 'true',
      });
      assert.equal(conflict.status, 422, JSON.stringify(conflict.body));
      assert.equal(
        (conflict.body as { error: { code: string } }).error.code,
        'VALIDATION_ERROR',
      );
      // Корпусные параметры (author/editor) с ast совместимы.
      const ok = await search(ctx, {
        q: 'secret',
        ast: JSON.stringify(activeAst(true)),
        author_id: 'u',
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('условие вне профиля `thoughts` → 422 с diagnostics (сценарий 55f31eee)', async () => {
    const ctx = await buildRestContext();
    try {
      const bad: FilterAst = {
        version: FILTER_AST_VERSION,
        filter: { entity: { kind: 'record_title' }, operator: 'eq', value: 'x' },
      };
      const res = await search(ctx, { q: 'secret', ast: JSON.stringify(bad) });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      const error = (res.body as { error: { code: string; details?: { violations?: unknown[] } } })
        .error;
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(error.details?.violations), 'details.violations присутствует');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('веерный режим network_ids передаёт ast в каждую сеть', async () => {
    const ctx = await buildRestContext();
    try {
      seedThought(ctx, 'Fanout active secret', { active: 1 });
      const inactive = seedThought(ctx, 'Fanout inactive secret', { active: 0 });

      // Веер (сеть одна, но идёт веерная ветка): AST «только неактуальные».
      const res = await search(ctx, {
        q: 'secret',
        scope: 'names',
        network_ids: ctx.networkId,
        ast: JSON.stringify(activeAst(false)),
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = res.body as {
        data: { by_names: Array<{ thought_id: string; network_id?: string }> };
      };
      assert.deepEqual(
        data.data.by_names.map((h) => h.thought_id),
        [inactive],
        'веер применил ast (иначе настройки отбора потерялись бы)',
      );
      assert.equal(data.data.by_names[0]!.network_id, ctx.networkId);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('legacy scope=thoughts: неразрешимый токен не дублируется в unresolved (задача 1169ae37)', async () => {
    const ctx = await buildRestContext();
    try {
      seedThought(ctx, 'Legacy scope secret');

      // Legacy `scope=thoughts` — ДВА прогона одного AST (`names` + `texts`):
      // без схлопывания диагностика приходила из обоих ответов и дублировалась
      // (живой прогон давал `length: 2`).
      const res = await search(ctx, {
        q: 'secret',
        scope: 'thoughts',
        ast: JSON.stringify({
          version: FILTER_AST_VERSION,
          filter: {
            entity: { kind: 'active' },
            operator: 'eq',
            value: { token: '$nonexistent' },
          },
        }),
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = (
        res.body as {
          data: {
            by_names: unknown[];
            by_texts: unknown[];
            unresolved?: Array<{ token: string; reason: string }>;
          };
        }
      ).data;
      assert.equal(data.by_names.length, 0, 'неразрешимый токен — пустая выдача');
      assert.equal(data.by_texts.length, 0);
      assert.equal(data.unresolved?.length, 1, 'одна проблема — одна запись диагностики');
      assert.equal(data.unresolved?.[0]?.token, '$nonexistent');
    } finally {
      await closeRestContext(ctx);
    }
  });
});
