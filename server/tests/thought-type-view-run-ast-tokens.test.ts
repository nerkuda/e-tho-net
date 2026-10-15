/**
 * Матрица токенов в ИСПОЛНЕНИИ отбора типа, AST-форма
 * (ошибка 23c7d3e9 п. C3 «токен $thought не разрешился»).
 *
 * **Симптом.** Отбор типа с условием «Мысль в иерархии $thought» на карте давал
 * «Отбор вернул пустой результат: токен «$thought» не разрешился». Причина:
 * AST-определение раскрывал сам движок отбора по `tokenContext`, а контекста
 * МЫСЛИ в сетевом запросе нет — токены `$thought`/`$thought.*`/`$thought.[…]`
 * в AST-отборах типа не разрешались вовсе (плоская `definition v1` подставляла
 * их своим резолвером). Теперь токены контекста мысли раскрывает сервис
 * `runViewForThought` (у него мысль есть), глобальные — по-прежнему движок.
 *
 * **Требование к поведению (DoD).** Каждый вид токена либо РАЗРЕШАЕТСЯ, либо
 * даёт ШТАТНУЮ диагностику (`meta.unresolved` с причиной) — необъяснимого
 * «пустого результата» быть не должно. Поэтому тест — матрица по видам токенов
 * и по проверкам сохранения/исполнения:
 *   * календарные (`$today`, `$weekStart/$weekEnd`, `$monthStart/$monthEnd`,
 *     `$yearStart/$yearEnd`) и арифметика `±N d/w/mo/y`;
 *   * `$user`;
 *   * поля мысли (`$thought`, `$thought.id/.title/.type/.active/.synonyms/
 *     .author/.editor/.created/.updated`) и арифметика по датам;
 *   * свойства `$thought.[<свойство>]` (text и date + арифметика);
 *   * токены времени в календарном профиле (`$now`, `$hourStart`, `±Nmi`) —
 *     штатная диагностика `time_context_required`;
 *   * неизвестный токен/свойство — отказ на СОХРАНЕНИИ (422, а не тихий пустой
 *     результат при исполнении).
 * Плюс два сценарных теста на подстановку: «Мысль в иерархии $thought» отдаёт
 * поддерево контекстной мысли, а `$thought.[Свойство]`/`$thought.type` берут
 * значения у неё же.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как у соседних
 * интеграционных тестов.
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

/** Минимум DTO отбора, нужный тесту. */
interface ViewDto {
  id: string;
  name: string;
}

/** Дочерняя мысль заданного родителя (HOME — для мыслей верхнего уровня). */
async function createChildOf(
  ctx: RestTestContext,
  title: string,
  parentId: string,
  synonyms: readonly string[] = [],
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: {
      title,
      ...(synonyms.length > 0 ? { synonyms: [...synonyms] } : {}),
      create_link: { direction: 'parent', target_thought_id: parentId },
    },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Тип мысли; возвращает id. */
async function createThoughtType(ctx: RestTestContext, name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload: { name },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Реестровое свойство заданной природы, подключённое к типу мысли. */
async function attachProperty(
  ctx: RestTestContext,
  typeId: string,
  valueType: 'text' | 'date',
): Promise<{ id: string; name: string }> {
  const name = `tok-${valueType}-${randomUUID().slice(0, 8)}`;
  const regRes = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: authHeaders(ctx),
    payload: { name, value_type: valueType },
  });
  assert.equal(regRes.statusCode, 201, regRes.body?.toString());
  const propertyId = (regRes.json().data as { id: string }).id;
  const attachRes = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/properties`,
    headers: authHeaders(ctx),
    payload: { property_id: propertyId, required: false },
  });
  assert.equal(attachRes.statusCode, 201, attachRes.body?.toString());
  return { id: propertyId, name };
}

/** Тип мысли у мысли (PATCH). */
async function setType(ctx: RestTestContext, thoughtId: string, typeId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
    headers: authHeaders(ctx),
    payload: { type_id: typeId },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

/** Значение свойства мысли (PUT). */
async function setProperty(
  ctx: RestTestContext,
  thoughtId: string,
  propName: string,
  value: string,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${propName}`,
    headers: authHeaders(ctx),
    payload: { value },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

/** AST-отбор типа с ОДНИМ условием: создание (ответ как есть). */
async function createAstView(
  ctx: RestTestContext,
  typeId: string,
  entity: Record<string, unknown>,
  operator: string,
  value: unknown,
): Promise<{ statusCode: number; view?: ViewDto; body?: string }> {
  const definition = JSON.stringify({ version: 1, filter: { entity, operator, value } });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
    headers: authHeaders(ctx),
    payload: { name: `tok-${randomUUID().slice(0, 8)}`, definition, is_default: false },
  });
  if (res.statusCode !== 201) return { statusCode: res.statusCode, body: res.body?.toString() };
  return { statusCode: 201, view: res.json().data as ViewDto };
}

/** Исполнить отбор относительно мысли-контекста. */
async function runView(
  ctx: RestTestContext,
  thoughtId: string,
  viewName: string,
): Promise<{ ids: string[]; total: number; unresolved: Array<{ token: string; reason: string }> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url:
      `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}` +
      `/views/${encodeURIComponent(viewName)}/run`,
    headers: authHeaders(ctx),
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  const body = res.json() as {
    data: Array<{ id: string }>;
    meta: { total: number; unresolved?: Array<{ token: string; reason: string }> };
  };
  return {
    ids: body.data.map((row) => row.id),
    total: body.meta.total,
    unresolved: body.meta.unresolved ?? [],
  };
}

/** Реестр тип+свойства+контекстная мысль для матрицы токенов. */
interface TokenFixture {
  typeId: string;
  /** Контекстная мысль (от неё исполняется отбор). */
  context: string;
  /** text-свойство, подключённое к типу (id в реестре + имя для токена). */
  tag: { id: string; name: string };
  /** date-свойство, подключённое к типу. */
  due: { id: string; name: string };
}

/** Тип + text/date свойства + контекстная мысль с заполненными значениями. */
async function buildTokenFixture(ctx: RestTestContext): Promise<TokenFixture> {
  const typeId = await createThoughtType(ctx, `tk-${randomUUID().slice(0, 8)}`);
  const tag = await attachProperty(ctx, typeId, 'text');
  const due = await attachProperty(ctx, typeId, 'date');
  const context = await createChildOf(ctx, `Контекст ${randomUUID().slice(0, 6)}`, ctx.homeId, [
    'синоним-контекста',
    'второй-синоним',
  ]);
  await setType(ctx, context, typeId);
  await setProperty(ctx, context, tag.name, 'ctx-tag');
  await setProperty(ctx, context, due.name, '2026-01-15');
  return { typeId, context, tag, due };
}

describe(
  'run AST-отбора типа: матрица токенов (ошибка 23c7d3e9 п. C3)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('каждый вид токена разрешается или даёт штатную диагностику', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        // Пары «операнд + оператор» подобраны по природе токена: дата, дата с
        // арифметикой, пользователь, тип, булев предикат, ссылка на мысль,
        // текст и список (синонимы), свойства мысли.
        const matrix: Array<{
          token: string;
          entity: Record<string, unknown>;
          operator: string;
          /** `true` — значение-СПИСОК (наборные операторы), иначе одиночный токен. */
          list?: boolean;
          /** `'resolved'` — обязан разрешиться; иначе — ожидаемая причина. */
          expect: string;
        }> = [
          { token: '$today', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$today+7d', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$today-1mo', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$today+1y', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$weekStart', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$weekEnd', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$monthStart', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$monthEnd', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$yearStart', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$yearEnd', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$user', entity: { kind: 'author' }, operator: 'eq', expect: 'resolved' },
          // Поля мысли.
          { token: '$thought', entity: { kind: 'id' }, operator: 'eq', expect: 'resolved' },
          { token: '$thought', entity: { kind: 'id' }, operator: 'in_hierarchy', list: true, expect: 'resolved' },
          { token: '$thought.id', entity: { kind: 'id' }, operator: 'eq', expect: 'resolved' },
          {
            token: '$thought.title',
            entity: { kind: 'property', property_id: fx.tag.id },
            operator: 'contains',
            expect: 'resolved',
          },
          {
            token: '$thought.synonyms',
            entity: { kind: 'property', property_id: fx.tag.id },
            operator: 'in',
            list: true,
            expect: 'resolved',
          },
          { token: '$thought.type', entity: { kind: 'type' }, operator: 'eq', expect: 'resolved' },
          { token: '$thought.active', entity: { kind: 'active' }, operator: 'eq', expect: 'resolved' },
          { token: '$thought.author', entity: { kind: 'author' }, operator: 'eq', expect: 'resolved' },
          { token: '$thought.editor', entity: { kind: 'editor' }, operator: 'eq', expect: 'resolved' },
          { token: '$thought.created', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$thought.updated', entity: { kind: 'updated_at' }, operator: 'gte', expect: 'resolved' },
          { token: '$thought.created+7d', entity: { kind: 'created_at' }, operator: 'gte', expect: 'resolved' },
          // Свойства мысли: значение подставляется из контекстной мысли.
          {
            token: `$thought.[${fx.tag.name}]`,
            entity: { kind: 'property', property_id: fx.tag.id },
            operator: 'contains',
            expect: 'resolved',
          },
          {
            token: `$thought.[${fx.due.name}]`,
            entity: { kind: 'created_at' },
            operator: 'gte',
            expect: 'resolved',
          },
          {
            token: `$thought.[${fx.due.name}]+7d`,
            entity: { kind: 'created_at' },
            operator: 'gte',
            expect: 'resolved',
          },
          // Токены времени в календарном профиле отбора мыслей — штатная
          // диагностика, а не «пустой результат».
          { token: '$now', entity: { kind: 'created_at' }, operator: 'gte', expect: 'time_context_required' },
          { token: '$hourStart', entity: { kind: 'created_at' }, operator: 'gte', expect: 'time_context_required' },
          { token: '$today+1mi', entity: { kind: 'created_at' }, operator: 'gte', expect: 'time_context_required' },
        ];

        for (const item of matrix) {
          const value = item.list === true ? [{ token: item.token }] : { token: item.token };
          const created = await createAstView(ctx, fx.typeId, item.entity, item.operator, value);
          assert.equal(
            created.statusCode,
            201,
            `отбор с токеном ${item.token} не сохранён: ${created.body ?? ''}`,
          );
          const ran = await runView(ctx, fx.context, created.view!.name);
          if (item.expect === 'resolved') {
            assert.deepEqual(
              ran.unresolved,
              [],
              `токен ${item.token} обязан разрешиться (контекст мысли у отбора типа есть)`,
            );
          } else {
            assert.equal(ran.unresolved.length, 1, `токен ${item.token}: ожидалась одна диагностика`);
            assert.equal(ran.unresolved[0]!.token, item.token, `диагностика адресует токен ${item.token}`);
            assert.equal(ran.unresolved[0]!.reason, item.expect, `причина диагностики ${item.token}`);
          }
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('пустое значение токена: у скалярной операции — пустое значение (A6), у наборной — объяснённый отказ', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        // Контекст БЕЗ значений свойств и синонимов.
        const bare = await createChildOf(ctx, `bare-${randomUUID().slice(0, 6)}`, ctx.homeId);
        await setType(ctx, bare, fx.typeId);

        // Скалярная операция: пустое значение свойства — это ПУСТОЕ значение
        // (семантика A6), а не неразрешимый токен: отбор исполняется.
        const scalar = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'property', property_id: fx.tag.id },
          'contains',
          { token: `$thought.[${fx.tag.name}]` },
        );
        assert.equal(scalar.statusCode, 201, scalar.body ?? '');
        const ranScalar = await runView(ctx, bare, scalar.view!.name);
        assert.deepEqual(ranScalar.unresolved, [], 'пустое значение — не неразрешимый токен');

        // Наборная операция: пустое МНОЖЕСТВО в AST выразить нечем — движок
        // отвергает пустой список значений отдельным сообщением (штатная
        // диагностика с причиной, а не «токен не разрешился» и не пустой
        // результат без объяснения).
        const list = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'property', property_id: fx.tag.id },
          'in',
          [{ token: '$thought.synonyms' }],
        );
        assert.equal(list.statusCode, 201, list.body ?? '');
        const res = await ctx.app.inject({
          method: 'POST',
          url:
            `/api/v1/networks/${ctx.networkId}/thoughts/${bare}` +
            `/views/${encodeURIComponent(list.view!.name)}/run`,
          headers: authHeaders(ctx),
          payload: {},
        });
        assert.equal(res.statusCode, 422, 'движок объясняет пустое значение наборной операции');
        assert.match(res.body?.toString() ?? '', /Массив значений операции in/);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('«Мысль в иерархии $thought» отдаёт поддерево контекстной мысли (сценарий п. C3)', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        // Поддерево контекста: A и B — его дети, C — внук; D — чужая ветвь.
        const a = await createChildOf(ctx, `A-${randomUUID().slice(0, 6)}`, fx.context);
        const b = await createChildOf(ctx, `B-${randomUUID().slice(0, 6)}`, fx.context);
        const c = await createChildOf(ctx, `C-${randomUUID().slice(0, 6)}`, a);
        const d = await createChildOf(ctx, `D-${randomUUID().slice(0, 6)}`, ctx.homeId);

        const created = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'id' },
          'in_hierarchy',
          [{ token: '$thought' }],
        );
        assert.equal(created.statusCode, 201, created.body ?? '');
        const ran = await runView(ctx, fx.context, created.view!.name);
        assert.deepEqual(ran.unresolved, [], 'токен $thought разрешился — диагностики нет');
        const ids = new Set(ran.ids);
        assert.ok(ids.has(a) && ids.has(b), 'дети контекстной мысли в выборке');
        assert.ok(ids.has(c), 'внук контекстной мысли в выборке (глубина поддерева)');
        assert.ok(!ids.has(d), 'чужая ветвь не попала в выборку');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('$thought.[Свойство] и $thought.type берут значения у контекстной мысли', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        // Две мысли того же типа с тем же значением свойства, что у контекста,
        // и одна с другим — совпасть обязаны только первые.
        const same = await createChildOf(ctx, `same-${randomUUID().slice(0, 6)}`, ctx.homeId);
        await setType(ctx, same, fx.typeId);
        await setProperty(ctx, same, fx.tag.name, 'ctx-tag');
        const other = await createChildOf(ctx, `other-${randomUUID().slice(0, 6)}`, ctx.homeId);
        await setType(ctx, other, fx.typeId);
        await setProperty(ctx, other, fx.tag.name, 'иное');

        const byProp = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'property', property_id: fx.tag.id },
          'eq',
          { token: `$thought.[${fx.tag.name}]` },
        );
        assert.equal(byProp.statusCode, 201, byProp.body ?? '');
        const ranProp = await runView(ctx, fx.context, byProp.view!.name);
        assert.deepEqual(ranProp.unresolved, [], 'токен свойства разрешился');
        assert.ok(ranProp.ids.includes(same), 'мысль с тем же значением свойства попала в выборку');
        assert.ok(!ranProp.ids.includes(other), 'мысль с другим значением — нет');

        const byType = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'type' },
          'eq',
          { token: '$thought.type' },
        );
        assert.equal(byType.statusCode, 201, byType.body ?? '');
        const ranType = await runView(ctx, fx.context, byType.view!.name);
        assert.deepEqual(ranType.unresolved, [], 'токен типа разрешился');
        assert.ok(ranType.ids.includes(same), 'мысль контекстного типа попала в выборку');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('неизвестный токен и неизвестное свойство — отказ на СОХРАНЕНИИ (422)', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        const badToken = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'created_at' },
          'gte',
          { token: '$thought.bogus' },
        );
        assert.equal(badToken.statusCode, 422, 'неизвестное поле мысли отвергается при сохранении');
        const badProperty = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'created_at' },
          'gte',
          { token: '$thought.[нет-такого-свойства]' },
        );
        assert.equal(badProperty.statusCode, 422, 'неизвестное свойство отвергается при сохранении');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

/**
 * Ad-hoc AST-маршрут `POST /networks/{nid}/thoughts/{thoughtId}/views/run`
 * (задача 0e7e89f5) — REST-паритет с MCP `etn.views.run { ast }`: то же тело
 * отбора исполняется ОТНОСИТЕЛЬНО контекстной мысли, контекст исключается из
 * страницы, `$thought*` резолвится, красная диагностика запрещает прогон, а
 * `ast.sort` несовместим с телом `sort`/`order`.
 */
describe(
  'ad-hoc AST-маршрут относительно мысли (0e7e89f5)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /** Прогнать новый ad-hoc маршрут с произвольным телом. */
    async function runAdHoc(
      ctx: RestTestContext,
      thoughtId: string,
      payload: Record<string, unknown>,
    ): Promise<{ statusCode: number; json: () => Record<string, unknown>; body?: string }> {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views/run`,
        headers: authHeaders(ctx),
        payload,
      });
      return { statusCode: res.statusCode, json: () => res.json() as Record<string, unknown>, body: res.body?.toString() };
    }

    it('$thought.type резолвится, контекстная мысль исключена, meta.ast; тело строгое', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        // Две мысли того же типа, что и контекст.
        const same = await createChildOf(ctx, `same-${randomUUID().slice(0, 6)}`, ctx.homeId);
        await setType(ctx, same, fx.typeId);
        const other = await createChildOf(ctx, `other-${randomUUID().slice(0, 6)}`, ctx.homeId);
        await setType(ctx, other, fx.typeId);

        const ast = {
          version: 1,
          filter: { entity: { kind: 'type' }, operator: 'eq', value: { token: '$thought.type' } },
        };
        const res = await runAdHoc(ctx, fx.context, { ast });
        assert.equal(res.statusCode, 200, res.body ?? '');
        const body = res.json() as {
          data: Array<{ id: string }>;
          meta: { total: number; ast?: boolean; unresolved?: unknown[] };
        };
        const ids = body.data.map((r) => r.id);
        assert.equal(body.meta.ast, true, 'REST ad-hoc помечен meta.ast');
        assert.equal(body.meta.unresolved, undefined, '$thought.type разрешён');
        assert.ok(ids.includes(same) && ids.includes(other), 'мысли того же типа в выборке');
        assert.ok(!ids.includes(fx.context), 'контекстная мысль исключена из страницы');
        assert.equal(body.meta.total, 2, 'total — COUNT совпадений без контекстной мысли');

        // Строгая схема тела: неизвестное поле — 422 (а не молчаливое срезание).
        const extra = await runAdHoc(ctx, fx.context, { ast, bogus: 1 });
        assert.equal(extra.statusCode, 422, 'неизвестное поле ad-hoc тела отвергается');

        // Старый `:view`-маршрут теперь тоже строгий: `ast` в нём — 422, а не
        // молчаливое исполнение сохранённого отбора (ошибочно присланное тело
        // прежде срезалось zod-ом).
        const savedView = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'type' },
          'eq',
          { token: '$thought.type' },
        );
        assert.equal(savedView.statusCode, 201, savedView.body ?? '');
        const oldWithAst = await ctx.app.inject({
          method: 'POST',
          url:
            `/api/v1/networks/${ctx.networkId}/thoughts/${fx.context}` +
            `/views/${encodeURIComponent(savedView.view!.name)}/run`,
          headers: authHeaders(ctx),
          payload: { ast },
        });
        assert.equal(oldWithAst.statusCode, 422, 'ast в старом маршруте отвергается строгой схемой');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('ast.sort и sort в теле одновременно — VALIDATION_ERROR (конвенция cb78315b)', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        const conflicting = await runAdHoc(ctx, fx.context, {
          ast: {
            version: 1,
            sort: [{ key: 'title', order: 'asc' }],
            filter: { entity: { kind: 'type' }, operator: 'eq', value: { token: '$thought.type' } },
          },
          sort: 'created',
        });
        assert.equal(conflicting.statusCode, 422, 'два источника сортировки — 422');
        assert.match(conflicting.body ?? '', /оставьте один источник/);

        // Без ast.sort тело `sort`/`order` работает как плоская сортировка.
        const ok = await runAdHoc(ctx, fx.context, {
          ast: {
            version: 1,
            filter: { entity: { kind: 'type' }, operator: 'eq', value: { token: '$thought.type' } },
          },
          sort: 'created',
          order: 'desc',
        });
        assert.equal(ok.statusCode, 200, ok.body ?? '');
        const okBody = ok.json() as { meta: { sort: string; order: string } };
        assert.equal(okBody.meta.sort, 'created');
        assert.equal(okBody.meta.order, 'desc');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('красная диагностика (удалённая сущность) запрещает ad-hoc прогон — как у сохранённого отбора', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        const ast = {
          version: 1,
          filter: {
            entity: { kind: 'property', property_id: randomUUID() },
            operator: 'contains',
            value: 'x',
          },
        };
        const adHoc = await runAdHoc(ctx, fx.context, { ast });
        assert.equal(adHoc.statusCode, 422, 'удалённое свойство — красная диагностика, прогон запрещён');
        assert.match(adHoc.body ?? '', /filter_entity_deleted/);

        // Паритет с сохранённым отбором: та же красная диагностика в `:view/run`.
        const saved = await createAstView(
          ctx,
          fx.typeId,
          { kind: 'property', property_id: randomUUID() },
          'contains',
          'x',
        );
        assert.equal(saved.statusCode, 422, 'красная диагностика срабатывает и на сохранении AST-отбора');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('unresolved-конверт несёт те же поля страницы, что и успешный ответ (паритет с MCP)', async () => {
      const ctx = await buildRestContext();
      try {
        const fx = await buildTokenFixture(ctx);
        // `$now` в календарном профиле отбора мыслей — штатная неразрешимость
        // (диагностика движка, не отказ маршрута).
        const res = await runAdHoc(ctx, fx.context, {
          ast: {
            version: 1,
            filter: { entity: { kind: 'created_at' }, operator: 'gte', value: { token: '$now' } },
          },
        });
        assert.equal(res.statusCode, 200, res.body ?? '');
        const body = res.json() as { data: unknown[]; meta: Record<string, unknown> };
        assert.deepEqual(body.data, [], 'страница пуста');
        const unresolved = body.meta.unresolved as Array<{ token: string }> | undefined;
        assert.ok(
          Array.isArray(unresolved) && unresolved.length > 0,
          'неразрешимый токен обязан попасть в meta.unresolved',
        );
        assert.equal(body.meta.ast, true, 'unresolved-конверт помечен meta.ast');
        assert.equal(typeof body.meta.has_more, 'boolean', 'unresolved-конверт несёт has_more');
        assert.ok('next_cursor' in body.meta, 'unresolved-конверт несёт next_cursor');
        assert.ok('sort' in body.meta && 'order' in body.meta, 'unresolved-конверт несёт sort/order');
        assert.ok('directions' in body.meta, 'unresolved-конверт несёт directions');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
