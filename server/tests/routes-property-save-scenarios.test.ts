/**
 * Сценарии сохранения свойств (ошибка 0033ea14, DoD 4/5): CRUD свойств всех
 * видов значений через REST ровно теми телами, которые собирает клиент, и
 * внятные детали валидации ограничений свойств-связей.
 *
 * Красно-зелёная основа — первая проверка: тело подключения свойства
 * (`mode: 'attach'` из `AttachPropertyInput` в `@etn/shared`) долгое время
 * отвергалось строгой проверкой неизвестных полей (`422 Unknown fields:
 * mode`), из-за чего «Типы источника/назначений» не сохранялись, а диалог
 * показывал только «проверьте введённые данные». Тест с этим телом должен
 * краснеть на коде до исправления и зеленеть после.
 *
 * Остальные проверки фиксируют требуемое поведение целиком: скалярные виды
 * (текст с предопределёнными значениями, число, дата, флаг, ссылка),
 * свойство-связь (обе стороны, ограничения типов, пустые списки,
 * несуществующий id типа) — создание, изменение, удаление.
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

/** Ответ REST-вызова: статус и разобранное тело. */
interface JsonResponse {
  statusCode: number;
  body: string;
  json: () => { data?: unknown; error?: { code: string; details?: Record<string, unknown> } };
}

/** Короткая обёртка над `app.inject` с разбором JSON. */
async function call(
  ctx: RestTestContext,
  headers: Record<string, string>,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<JsonResponse> {
  const res = await ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${url}`,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  return res as unknown as JsonResponse;
}

/** Тип мысли сети; возвращает его id. */
async function makeThoughtType(
  ctx: RestTestContext,
  headers: Record<string, string>,
  name: string,
): Promise<string> {
  const res = await call(ctx, headers, 'POST', '/thought-types', { name });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Свойство реестра; возвращает ответ целиком (нужны и id, и config). */
async function makeProperty(
  ctx: RestTestContext,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<{ id: string; config: Record<string, unknown> | null }> {
  const res = await call(ctx, headers, 'POST', '/properties', payload);
  assert.equal(res.statusCode, 201, res.body);
  return res.json().data as { id: string; config: Record<string, unknown> | null };
}

describe(
  '/properties: сохранение ограничений и CRUD свойств (ошибка 0033ea14)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('подключение свойства-связи телом клиента с mode: attach сохраняется (красно-зелёный)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const source = await makeThoughtType(ctx, h, 'Раздел книги');
        const target = await makeThoughtType(ctx, h, 'Глава книги');
        const prop = await makeProperty(ctx, h, {
          name: 'Входит в главу',
          value_type: 'link',
          name_forward: 'Входит в главу',
          name_reverse: 'Глава',
          config: { direction: 'out' },
        });

        // Ровно тело `AttachPropertyInput` из @etn/shared: `mode` на проводе.
        const attach = await call(ctx, h, 'POST', `/thought-types/${source}/properties`, {
          mode: 'attach',
          property_id: prop.id,
          required: true,
          side: 'source',
        });
        assert.equal(attach.statusCode, 201, attach.body);
        const binding = attach.json().data as { side: string | null; required: boolean };
        assert.equal(binding.side, 'source');
        assert.equal(binding.required, true);

        // Ограничение «Типы назначений» — та же привязка, вторая сторона.
        const mirror = await call(ctx, h, 'POST', `/thought-types/${target}/properties`, {
          mode: 'attach',
          property_id: prop.id,
          required: false,
          side: 'target',
        });
        assert.equal(mirror.statusCode, 201, mirror.body);

        // Переоткрытие диалога = повторное чтение определений типа.
        const reopened = await call(ctx, h, 'GET', `/thought-types/${source}/properties`);
        assert.equal(reopened.statusCode, 200);
        const defs = reopened.json().data as Array<{ property_id: string; side: string | null }>;
        assert.deepEqual(
          defs.filter((d) => d.property_id === prop.id).map((d) => d.side),
          ['source'],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('mode сверяется с формой тела: attach без property_id и create с property_id — 422 с полем mode', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const owner = await makeThoughtType(ctx, h, 'Владелец');
        const prop = await makeProperty(ctx, h, { name: 'тег', value_type: 'text' });

        const attachWithoutId = await call(ctx, h, 'POST', `/thought-types/${owner}/properties`, {
          mode: 'attach',
          required: false,
        });
        assert.equal(attachWithoutId.statusCode, 422, attachWithoutId.body);
        assert.equal(attachWithoutId.json().error?.code, 'VALIDATION_ERROR');
        assert.equal(attachWithoutId.json().error?.details?.field, 'mode');

        const createWithId = await call(ctx, h, 'POST', `/thought-types/${owner}/properties`, {
          mode: 'create',
          property_id: prop.id,
        });
        assert.equal(createWithId.statusCode, 422, createWithId.body);
        assert.equal(createWithId.json().error?.details?.field, 'mode');

        // Неизвестное значение самого селектора — тоже внятная 422.
        const badMode = await call(ctx, h, 'POST', `/thought-types/${owner}/properties`, {
          mode: 'connect',
          property_id: prop.id,
        });
        assert.equal(badMode.statusCode, 422, badMode.body);
        assert.equal(badMode.json().error?.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('CRUD скалярных видов: создание, правка имени/описания/конфига, удаление', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const cases: Array<{
          name: string;
          value_type: string;
          config: Record<string, unknown> | null;
          update: Record<string, unknown>;
          expectedConfig: Record<string, unknown> | null;
        }> = [
          {
            name: 'статус',
            value_type: 'text',
            config: { options: ['черновик', 'готово'], multiple: false },
            update: {
              description: 'состояние работы',
              config: { options: ['черновик', 'готово', 'снято'], default_value: 'черновик' },
            },
            expectedConfig: {
              options: ['черновик', 'готово', 'снято'],
              default_value: 'черновик',
            },
          },
          {
            name: 'вес',
            value_type: 'number',
            config: null,
            update: { config: { default_value: 12.5 } },
            expectedConfig: { default_value: 12.5 },
          },
          {
            name: 'дата',
            value_type: 'date',
            config: null,
            update: { config: { default_value: '2026-11-23' } },
            expectedConfig: { default_value: '2026-11-23' },
          },
          {
            name: 'признак',
            value_type: 'bool',
            config: null,
            update: { config: { default_value: true } },
            expectedConfig: { default_value: true },
          },
          {
            name: 'адрес',
            value_type: 'url',
            config: { multiple: true },
            update: { config: { multiple: true, default_value: ['https://example.org/a'] } },
            expectedConfig: { multiple: true, default_value: ['https://example.org/a'] },
          },
        ];

        for (const testCase of cases) {
          const created = await makeProperty(ctx, h, {
            name: testCase.name,
            value_type: testCase.value_type,
            ...(testCase.config === null ? {} : { config: testCase.config }),
          });

          const renamed = `${testCase.name}-2`;
          const patch = await call(ctx, h, 'PATCH', `/properties/${created.id}`, {
            name: renamed,
            ...testCase.update,
          });
          assert.equal(patch.statusCode, 200, `${testCase.value_type}: ${patch.body}`);
          const updated = patch.json().data as {
            name: string;
            value_type: string;
            config: Record<string, unknown> | null;
            description: string | null;
          };
          assert.equal(updated.name, renamed);
          assert.equal(updated.value_type, testCase.value_type);
          assert.deepEqual(updated.config, testCase.expectedConfig);

          const read = await call(ctx, h, 'GET', `/properties/${created.id}`);
          assert.equal(read.statusCode, 200);
          assert.equal((read.json().data as { name: string }).name, renamed);

          const removed = await call(ctx, h, 'DELETE', `/properties/${created.id}`);
          assert.equal(removed.statusCode, 200, removed.body);
          const gone = await call(ctx, h, 'GET', `/properties/${created.id}`);
          assert.equal(gone.statusCode, 404);
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('свойство-связь: обе стороны, ограничения типов, пустые списки и несуществующий тип', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const sourceType = await makeThoughtType(ctx, h, 'Раздел книги');
        const targetType = await makeThoughtType(ctx, h, 'Глава книги');
        const otherType = await makeThoughtType(ctx, h, 'Сноска');

        const prop = await makeProperty(ctx, h, {
          name: 'Состав главы',
          value_type: 'link',
          name_forward: 'Состав главы',
          name_reverse: 'Входит в',
          config: { direction: 'out' },
        });

        const sourceBinding = await call(
          ctx,
          h,
          'POST',
          `/thought-types/${sourceType}/properties`,
          { mode: 'attach', property_id: prop.id, required: false, side: 'source' },
        );
        assert.equal(sourceBinding.statusCode, 201, sourceBinding.body);
        const sourceBindingId = (sourceBinding.json().data as { id: string }).id;

        const targetBinding = await call(
          ctx,
          h,
          'POST',
          `/thought-types/${targetType}/properties`,
          { mode: 'attach', property_id: prop.id, required: false, side: 'target' },
        );
        assert.equal(targetBinding.statusCode, 201, targetBinding.body);
        const targetBindingId = (targetBinding.json().data as { id: string }).id;

        // Ограничение назначений у источника: конкретный тип + пустой список-сброс.
        const limited = await call(
          ctx,
          h,
          'PATCH',
          `/thought-types/${sourceType}/properties/${sourceBindingId}`,
          { allowed_target_type_ids: [targetType] },
        );
        assert.equal(limited.statusCode, 200, limited.body);
        assert.deepEqual(
          (limited.json().data as { config: { allowed_target_type_ids?: string[] } }).config
            .allowed_target_type_ids,
          [targetType],
        );

        // Ограничение источников у назначения (зеркальный ключ).
        const restrictedSources = await call(
          ctx,
          h,
          'PATCH',
          `/thought-types/${targetType}/properties/${targetBindingId}`,
          { allowed_source_type_ids: [sourceType, otherType] },
        );
        assert.equal(restrictedSources.statusCode, 200, restrictedSources.body);
        assert.deepEqual(
          (
            restrictedSources.json().data as {
              config: { allowed_source_type_ids?: string[] };
            }
          ).config.allowed_source_type_ids,
          [sourceType, otherType],
        );

        // Пустой список = «без ограничения», а не ошибка.
        const cleared = await call(
          ctx,
          h,
          'PATCH',
          `/thought-types/${sourceType}/properties/${sourceBindingId}`,
          { allowed_target_type_ids: [] },
        );
        assert.equal(cleared.statusCode, 200, cleared.body);

        // Несуществующий тип — 422 с полем и id (детали для диалога).
        const bogusId = '11111111-1111-4111-8111-111111111111';
        const bogus = await call(
          ctx,
          h,
          'PATCH',
          `/thought-types/${sourceType}/properties/${sourceBindingId}`,
          { allowed_target_type_ids: [bogusId] },
        );
        assert.equal(bogus.statusCode, 422, bogus.body);
        assert.equal(bogus.json().error?.code, 'VALIDATION_ERROR');
        assert.equal(bogus.json().error?.details?.field, 'config.allowed_target_type_ids');
        assert.equal(bogus.json().error?.details?.id, bogusId);

        // Имена сторон правятся в реестре и видны после перечитывания.
        const renamed = await call(ctx, h, 'PATCH', `/properties/${prop.id}`, {
          name_forward: 'Состав главы',
          name_reverse: 'Глава',
        });
        assert.equal(renamed.statusCode, 200, renamed.body);

        // Дефолты сторон: `config.default_value` — набор целей источника,
        // `config.default_value_target` — набор источников назначения.
        const targetThought = await call(ctx, h, 'POST', '/thoughts', {
          title: 'Глава 1',
          type_id: targetType,
        });
        assert.equal(targetThought.statusCode, 201, targetThought.body);
        const targetThoughtId = (targetThought.json().data as { id: string }).id;
        const sourceThought = await call(ctx, h, 'POST', '/thoughts', {
          title: 'Раздел 1',
          type_id: sourceType,
        });
        assert.equal(sourceThought.statusCode, 201, sourceThought.body);
        const sourceThoughtId = (sourceThought.json().data as { id: string }).id;

        const withDefaults = await call(ctx, h, 'PATCH', `/properties/${prop.id}`, {
          config: {
            direction: 'out',
            link_type_id: prop.config?.link_type_id,
            allowed_target_type_ids: [targetType],
            allowed_source_type_ids: [sourceType, otherType],
            default_value: [targetThoughtId],
            default_value_target: [sourceThoughtId],
          },
        });
        assert.equal(withDefaults.statusCode, 200, withDefaults.body);
        const defaultsConfig = (withDefaults.json().data as { config: Record<string, unknown> })
          .config;
        assert.deepEqual(defaultsConfig.default_value, [targetThoughtId]);
        assert.deepEqual(defaultsConfig.default_value_target, [sourceThoughtId]);

        // Удаление свойства-связи снимает привязки и тип связи.
        const removeBindingSource = await call(
          ctx,
          h,
          'DELETE',
          `/thought-types/${sourceType}/properties/${sourceBindingId}`,
        );
        assert.equal(removeBindingSource.statusCode, 204, removeBindingSource.body);
        const removeBindingTarget = await call(
          ctx,
          h,
          'DELETE',
          `/thought-types/${targetType}/properties/${targetBindingId}`,
        );
        assert.equal(removeBindingTarget.statusCode, 204, removeBindingTarget.body);

        const removed = await call(ctx, h, 'DELETE', `/properties/${prop.id}`);
        assert.equal(removed.statusCode, 200, removed.body);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('ограничения существующего свойства-связи сохраняются через PATCH реестра', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeA = await makeThoughtType(ctx, h, 'Раздел книги');
        const typeB = await makeThoughtType(ctx, h, 'Глава книги');
        const prop = await makeProperty(ctx, h, {
          name: 'Состав главы',
          value_type: 'link',
          name_forward: 'Состав главы',
          name_reverse: 'Входит в',
          config: { direction: 'out' },
        });

        // Тело как у клиента: полный config с ограничениями и оформлением.
        const patch = await call(ctx, h, 'PATCH', `/properties/${prop.id}`, {
          name: 'Состав главы',
          name_forward: 'Состав главы',
          name_reverse: 'Входит в',
          config: {
            direction: 'out',
            link_type_id: prop.config?.link_type_id,
            allowed_target_type_ids: [typeB],
            allowed_source_type_ids: [typeA],
          },
        });
        assert.equal(patch.statusCode, 200, patch.body);
        const config = (patch.json().data as { config: Record<string, unknown> }).config;
        assert.deepEqual(config.allowed_target_type_ids, [typeB]);
        assert.deepEqual(config.allowed_source_type_ids, [typeA]);

        // Пустые списки снимают ограничения, не ломая сохранение.
        const cleared = await call(ctx, h, 'PATCH', `/properties/${prop.id}`, {
          config: {
            direction: 'out',
            link_type_id: config.link_type_id,
            allowed_target_type_ids: [],
          },
        });
        assert.equal(cleared.statusCode, 200, cleared.body);
        assert.deepEqual(
          (cleared.json().data as { config: Record<string, unknown> }).config
            .allowed_target_type_ids,
          [],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
