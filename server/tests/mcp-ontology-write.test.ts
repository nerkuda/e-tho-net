/**
 * `etn.ontology.write` / `etn.ontology.delete` (задача cc9ca65e, 0.7.2) —
 * управление онтологией сети из MCP одной транзакцией. Покрывает:
 *
 *   * базовый сценарий — `thought_type` + `link_type` + `property` +
 *     `type_properties` одним вызовом через локальные `ref`;
 *   * иерархию — 3 типа через `parent_ref`;
 *   * цикл в `parent_ref` → `VALIDATION_ERROR` до транзакции;
 *   * повторяющийся `ref` → `VALIDATION_ERROR`;
 *   * несуществующий `parent` → `NOT_FOUND`; `parent` по имени — тоже
 *     `NOT_FOUND`, а явный `id` нового типа не принимается (8c64fdd4);
 *   * смену `value_type` — ответ несёт `converted_values`/`dropped_values`;
 *   * идемпотентность — повторный вызов даёт `action: unchanged`;
 *   * `etn.ontology.delete` без `force` на используемом типе → отвергается
 *     со счётчиками в `details`;
 *   * `etn.ontology.delete` с `force` на используемом типе → удаляется,
 *     связанные мысли теряют `type_id`, HOME остаётся без типа;
 *   * `etn.ontology.delete` на ролевом типе (из `type_roles`) →
 *     `VALIDATION_ERROR` даже с `force`;
 *   * транзакционный откат — частичный успех невозможен;
 *   * одна строка `audit_log` на ВЕСЬ вызов write/delete.
 *
 * Bootstrap — `mcp-helpers.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createThought } from '../src/domain/thought-service.js';
import { listEffectiveTypeProperties } from '../src/domain/property-service.js';

interface OntologyWriteResult {
  thought_types: Array<{
    ref: string | null;
    id: string;
    version: number;
    action: 'created' | 'updated' | 'unchanged';
  }>;
  link_types: Array<{
    ref: string | null;
    id: string;
    version: number;
    action: 'created' | 'updated' | 'unchanged';
  }>;
  properties: Array<{
    ref: string | null;
    id: string;
    version: number;
    action: 'created' | 'updated' | 'unchanged';
    converted_values: number;
    dropped_values: number;
  }>;
  type_properties: Array<{
    owner: 'thought_type' | 'link_type';
    type_ref: string | null;
    property_ref: string | null;
    type_id: string;
    property_id: string;
    id: string;
    version: number;
    action: 'created' | 'updated' | 'unchanged';
  }>;
  layer: { id: string; title: string };
  request_id?: string;
}

interface OntologyDeleteResult {
  deleted: true;
  affected_counts: Record<string, number>;
  request_id?: string;
}

describe('etn.ontology.write / delete (0.7.2)', { skip: !nativeAvailable() }, () => {
  it('creates thought_type + link_type + property + type_properties in one batch via ref', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { ref: 'task', name: 'задача', description: 'задача проекта' },
            ],
            link_types: [
              {
                ref: 'blocks',
                name_forward: 'блокирует',
                name_reverse: 'блокируется',
              },
            ],
            properties: [
              { ref: 'status', name: 'Статус', value_type: 'text' },
            ],
            type_properties: [
              {
                owner: 'thought_type',
                type_ref: 'task',
                property_ref: 'status',
                required: true,
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<OntologyWriteResult>(result);
        assert.equal(data.thought_types.length, 1);
        assert.equal(data.thought_types[0]?.ref, 'task');
        assert.equal(data.thought_types[0]?.action, 'created');
        assert.equal(data.link_types.length, 1);
        assert.equal(data.link_types[0]?.ref, 'blocks');
        assert.equal(data.link_types[0]?.action, 'created');
        assert.equal(data.properties.length, 1);
        assert.equal(data.properties[0]?.ref, 'status');
        assert.equal(data.properties[0]?.action, 'created');
        assert.equal(data.type_properties.length, 1);
        assert.equal(data.type_properties[0]?.action, 'created');
        assert.equal(data.type_properties[0]?.type_ref, 'task');
        assert.equal(data.type_properties[0]?.property_ref, 'status');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('builds a hierarchy of 3 thought types via parent_ref in one call', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { ref: 'work', name: 'работа' },
              { ref: 'task', name: 'задача', parent_ref: 'work' },
              { ref: 'subtask', name: 'подзадача', parent_ref: 'task' },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<OntologyWriteResult>(result);
        assert.equal(data.thought_types.length, 3);
        // Каждый тип создан; parent_id будет установлен в фазе 1.5 —
        // проверим через прямой запрос в БД.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const work = data.thought_types.find((t) => t.ref === 'work')!;
        const task = data.thought_types.find((t) => t.ref === 'task')!;
        const subtask = data.thought_types.find((t) => t.ref === 'subtask')!;
        const workRow = ndb
          .prepare('SELECT id, parent_id FROM thought_types_v WHERE id = ?')
          .get(work.id) as { id: string; parent_id: string | null };
        const taskRow = ndb
          .prepare('SELECT id, parent_id FROM thought_types_v WHERE id = ?')
          .get(task.id) as { id: string; parent_id: string | null };
        const subtaskRow = ndb
          .prepare('SELECT id, parent_id FROM thought_types_v WHERE id = ?')
          .get(subtask.id) as { id: string; parent_id: string | null };
        // work — прямой потомок корня.
        assert.notEqual(workRow.parent_id, null);
        // task.parent_id === work.id, subtask.parent_id === task.id.
        assert.equal(taskRow.parent_id, work.id);
        assert.equal(subtaskRow.parent_id, task.id);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a cycle in parent_ref with VALIDATION_ERROR before any write', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { ref: 'a', name: 'A', parent_ref: 'b' },
              { ref: 'b', name: 'B', parent_ref: 'a' },
            ],
          },
        });
        assert.equal(result.isError, true, 'expected VALIDATION_ERROR');
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        assert.ok(
          text.includes('цикл') || text.includes('parent_ref') || text.includes('cycle'),
          text,
        );
        // И ничего не записалось.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const rows = ndb
          .prepare("SELECT id FROM thought_types_v WHERE name IN ('A', 'B')")
          .all();
        assert.equal(rows.length, 0, 'cycle batch must be rolled back');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('parent принимает только id, а id нового типа — только существующий (8c64fdd4)', async () => {
    // Контракт операции (гайд `etn.guide { topic: "ontology.write" }`):
    //   * `id` адресует ТОЛЬКО существующий элемент; новый создаётся по имени;
    //   * `parent` — только id существующего типа (имя не резолвится).
    // Тест фиксирует это поведение: если приём имён в `parent` когда-нибудь
    // расширят, гайд придётся править синхронно.
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // 1) Базовый тип создаётся по имени (id генерирует сервер).
        const base = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [{ name: 'TEST 0.8.4 — персона' }],
          },
        });
        assert.equal(base.isError, undefined, toolText(base));
        const baseId = toolJson<OntologyWriteResult>(base).thought_types[0]!.id;
        assert.ok(baseId.length > 0);

        // 2) `parent` по имени существующего типа — NOT_FOUND.
        const byName = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [{ name: 'TEST 0.8.4 — родитель по имени', parent: 'TEST 0.8.4 — персона' }],
          },
        });
        assert.equal(byName.isError, true, 'parent по имени должен отвергаться (NOT_FOUND)');
        const byNameText = toolText(byName);
        assert.ok(byNameText.includes('NOT_FOUND'), byNameText);
        assert.ok(byNameText.includes('parent'), `expected offending field "parent": ${byNameText}`);

        // 3) Явный id НОВОГО типа — NOT_FOUND (id только адресует существующее).
        const byId = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { id: '11111111-2222-4333-8444-555555555555', name: 'TEST 0.8.4 — тип с явным id' },
            ],
          },
        });
        assert.equal(byId.isError, true, 'id нового типа должен отвергаться (NOT_FOUND)');
        assert.ok(toolText(byId).includes('NOT_FOUND'), toolText(byId));

        // 4) Документированный путь — parent по id существующего типа.
        const byParentId = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [{ name: 'TEST 0.8.4 — ребёнок персоны', parent: baseId }],
          },
        });
        assert.equal(byParentId.isError, undefined, toolText(byParentId));
        const childId = toolJson<OntologyWriteResult>(byParentId).thought_types[0]!.id;
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const row = ndb
          .prepare('SELECT parent_id FROM thought_types_v WHERE id = ?')
          .get(childId) as { parent_id: string | null } | undefined;
        assert.equal(row?.parent_id, baseId);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects an unknown top-level key with VALIDATION_ERROR (ea4581c5)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            // Симптом ошибки ea4581c5: секция, положенная не на тот уровень
            // (правильное имя — `properties[]`), раньше молча игнорировалась.
            property: [{ name: 'P' }],
            thought_types: [{ ref: 'a', name: 'A' }],
          },
        });
        assert.equal(result.isError, true, 'expected VALIDATION_ERROR');
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        assert.ok(text.includes('property'), `expected offending field in error: ${text}`);
        assert.ok(text.includes('fields'), `expected details.fields in error: ${text}`);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a duplicate ref within thought_types', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { ref: 'dup', name: 'one' },
              { ref: 'dup', name: 'two' },
            ],
          },
        });
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        assert.ok(text.includes('duplicate'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('reports converted_values / dropped_values on value_type change', async () => {
    const ctx = await buildMcpContext();
    try {
      // 1) Создаём свойство text + тип, подключаем свойство + пишем
      //    значение "42" в свойство мысли (через прямой вызов домена).
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const t = createThoughtType(
        ndb,
        { name: 'задача', description: 'task' },
        ctx.adminId,
      );
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      let propId = '';
      try {
        const create = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            properties: [{ ref: 'p', name: 'priority', value_type: 'text' }],
            type_properties: [
              { owner: 'thought_type', type: 'задача', property_ref: 'p' },
            ],
          },
        });
        assert.equal(create.isError, undefined, toolText(create));
        const createData = toolJson<OntologyWriteResult>(create);
        propId = createData.properties[0]!.id;
        // Пишем два значения: "42" (числовое) и "abc" (нечисловое).
        const thought = createThought(
          ndb,
          { title: 'T1', type_id: t.id },
          ctx.adminId,
        );
        const thought2 = createThought(
          ndb,
          { title: 'T2', type_id: t.id },
          ctx.adminId,
        );
        void thought2;
        ndb
          .prepare(
            `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_text, value_number, value_bool, value_date, value_thought_ref, updated_at, base_version)
             VALUES (?, ?, 'thought', ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1)`,
          )
          .run(
            'pv-1',
            ndb.layerId,
            thought.id,
            propId,
            '42',
            new Date().toISOString(),
          );
        ndb
          .prepare(
            `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_text, value_number, value_bool, value_date, value_thought_ref, updated_at, base_version)
             VALUES (?, ?, 'thought', ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1)`,
          )
          .run(
            'pv-2',
            ndb.layerId,
            thought2.id,
            propId,
            'abc',
            new Date().toISOString(),
          );

        // 2) Меняем value_type: text → number.
        const update = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            properties: [{ id: propId, value_type: 'number' }],
          },
        });
        assert.equal(update.isError, undefined, toolText(update));
        const updateData = toolJson<OntologyWriteResult>(update);
        assert.equal(updateData.properties[0]?.action, 'updated');
        assert.equal(updateData.properties[0]?.converted_values, 1);
        assert.equal(updateData.properties[0]?.dropped_values, 1);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('returns unchanged on a repeat call with identical arguments', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const args = {
          network_id: ctx.networkId,
          thought_types: [{ ref: 'task', name: 'задача', description: 'таск' }],
          properties: [{ ref: 'status', name: 'Статус', value_type: 'text' as const }],
          type_properties: [
            {
              owner: 'thought_type' as const,
              type_ref: 'task',
              property_ref: 'status',
            },
          ],
        };
        const first = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: args,
        });
        assert.equal(first.isError, undefined, toolText(first));
        const firstData = toolJson<OntologyWriteResult>(first);
        const firstTaskVersion = firstData.thought_types[0]!.version;
        const firstPropVersion = firstData.properties[0]!.version;
        const firstTpVersion = firstData.type_properties[0]!.version;
        const second = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: args,
        });
        assert.equal(second.isError, undefined, toolText(second));
        const secondData = toolJson<OntologyWriteResult>(second);
        assert.equal(secondData.thought_types[0]?.action, 'unchanged');
        assert.equal(secondData.properties[0]?.action, 'unchanged');
        assert.equal(secondData.type_properties[0]?.action, 'unchanged');
        // Версии не должны были измениться.
        assert.equal(secondData.thought_types[0]?.version, firstTaskVersion);
        assert.equal(secondData.properties[0]?.version, firstPropVersion);
        assert.equal(secondData.type_properties[0]?.version, firstTpVersion);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Регрессия ошибки 7b842c40: `type_properties[].default_value` объявлен в
  // контракте, но не читался — переопределение дефолта привязки не создавалось
  // (0.8.2, ADR «дефолт свойства живёт на привязке»).
  it('пробрасывает type_properties[].default_value в override привязки (скаляр)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const args = {
          network_id: ctx.networkId,
          thought_types: [{ ref: 'task', name: 'задача-дефолт' }],
          properties: [{ ref: 'status', name: 'Статус-дефолт', value_type: 'text' as const }],
          type_properties: [
            {
              owner: 'thought_type' as const,
              type_ref: 'task',
              property_ref: 'status',
              default_value: 'черновик',
            },
          ],
        };
        const first = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: args,
        });
        assert.equal(first.isError, undefined, toolText(first));
        const firstData = toolJson<OntologyWriteResult>(first);
        assert.equal(firstData.type_properties[0]?.action, 'created');
        const typeId = firstData.thought_types[0]!.id;
        const propId = firstData.properties[0]!.id;
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const override = ndb
          .prepare(
            'SELECT default_value FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
          )
          .get('thought_type', typeId, propId) as { default_value: string } | undefined;
        assert.ok(override, 'override дефолта привязки должен быть создан');
        assert.equal(JSON.parse(override.default_value), 'черновик');
        const effective = listEffectiveTypeProperties(ndb, 'thought_type', typeId).find(
          (d) => d.property_id === propId,
        );
        assert.equal(effective?.default_value, 'черновик');
        assert.equal(effective?.overridden_here, true);

        // Идемпотентность: повторный вызов тем же батчем — `unchanged`.
        const second = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: args,
        });
        assert.equal(second.isError, undefined, toolText(second));
        assert.equal(toolJson<OntologyWriteResult>(second).type_properties[0]?.action, 'unchanged');

        // `null` снимает дефолт привязки — эффективным становится общее значение
        // стороны, а элемент отчитывается `updated` (дефолт изменился).
        const reset = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_properties: [
              {
                owner: 'thought_type',
                type: 'задача-дефолт',
                property: 'Статус-дефолт',
                default_value: null,
              },
            ],
          },
        });
        assert.equal(reset.isError, undefined, toolText(reset));
        assert.equal(toolJson<OntologyWriteResult>(reset).type_properties[0]?.action, 'updated');
        const effectiveAfterReset = listEffectiveTypeProperties(ndb, 'thought_type', typeId).find(
          (d) => d.property_id === propId,
        );
        assert.equal(effectiveAfterReset?.default_value, null);
        assert.equal(effectiveAfterReset?.overridden_here, false);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('дефолт на существующей привязке переводит элемент в updated', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const base = {
          network_id: ctx.networkId,
          thought_types: [{ ref: 'task', name: 'задача-патч' }],
          properties: [{ ref: 'status', name: 'Статус-патч', value_type: 'text' as const }],
        };
        const created = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            ...base,
            type_properties: [
              { owner: 'thought_type', type_ref: 'task', property_ref: 'status' },
            ],
          },
        });
        assert.equal(created.isError, undefined, toolText(created));
        assert.equal(toolJson<OntologyWriteResult>(created).type_properties[0]?.action, 'created');

        const patched = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            type_properties: [
              {
                owner: 'thought_type',
                type: 'задача-патч',
                property: 'Статус-патч',
                default_value: 'в работе',
              },
            ],
          },
        });
        assert.equal(patched.isError, undefined, toolText(patched));
        const patchedData = toolJson<OntologyWriteResult>(patched);
        assert.equal(patchedData.type_properties[0]?.action, 'updated');
        const typeId = patchedData.type_properties[0]!.type_id;
        const propId = patchedData.type_properties[0]!.property_id;
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const override = ndb
          .prepare(
            'SELECT default_value FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
          )
          .get('thought_type', typeId, propId) as { default_value: string } | undefined;
        assert.equal(JSON.parse(override!.default_value), 'в работе');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('дефолт свойства-связи пишется по стороне привязки (target)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const source = createThought(ndb, { title: 'Источник дефолта' }, ctx.adminId);
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [{ ref: 'task', name: 'задача-связь' }],
            properties: [
              {
                ref: 'dep',
                name: 'Зависит-дефолт',
                value_type: 'link' as const,
                name_forward: 'зависит-дефолт-от',
                name_reverse: 'от-дефолта',
              },
            ],
            type_properties: [
              {
                owner: 'thought_type' as const,
                type_ref: 'task',
                property_ref: 'dep',
                side: 'target' as const,
                default_value: [source.id],
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<OntologyWriteResult>(result);
        assert.equal(data.type_properties[0]?.action, 'created');
        const typeId = data.thought_types[0]!.id;
        const propId = data.properties[0]!.id;
        const override = ndb
          .prepare(
            'SELECT default_value FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
          )
          .get('thought_type', typeId, propId) as { default_value: string } | undefined;
        assert.ok(override, 'override target-дефолта должен быть создан');
        assert.deepEqual(JSON.parse(override.default_value), [source.id]);
        const effective = listEffectiveTypeProperties(ndb, 'thought_type', typeId).find(
          (d) => d.property_id === propId,
        );
        assert.deepEqual(effective?.default_value, [source.id]);
        assert.equal(effective?.overridden_here, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('отвергает неверную форму type_properties[].default_value', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [{ ref: 'task', name: 'задача-форма' }],
            properties: [{ ref: 'status', name: 'Статус-форма', value_type: 'text' as const }],
            type_properties: [
              {
                owner: 'thought_type',
                type_ref: 'task',
                property_ref: 'status',
                default_value: { nested: true },
              },
            ],
          },
        });
        assert.equal(result.isError, true, 'expected VALIDATION_ERROR');
        assert.ok(toolText(result).includes('VALIDATION_ERROR'), toolText(result));
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rolls back the whole batch when one element fails', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { ref: 'a', name: 'A-ok' },
              { ref: 'b', name: 'B-ok' },
            ],
            type_properties: [
              {
                owner: 'thought_type',
                type_ref: 'unknown-ref', // не объявлен в этом батче
                property: 'не-существующее-свойство-12345',
                required: true,
              },
            ],
          },
        });
        assert.equal(result.isError, true, 'expected VALIDATION_ERROR');
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        // Ничего не записалось.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const rows = ndb
          .prepare("SELECT id FROM thought_types_v WHERE name IN ('A-ok', 'B-ok')")
          .all();
        assert.equal(rows.length, 0, 'batch must be rolled back');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete without force rejects with usage counters', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const t = createThoughtType(ndb, { name: 'задача' }, ctx.adminId);
      // Создаём мысль этого типа.
      createThought(ndb, { title: 'M', type_id: t.id }, ctx.adminId);

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await callOp(
          handle.client,
          'ontology.delete',
          {
            network_id: ctx.networkId,
            kind: 'thought_type',
            id: t.id,
          },
          true,
        );
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        assert.ok(text.includes('thoughts_count') || text.includes('используется'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete with force removes the type and clears thoughts.type_id (HOME untouched)', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const t = createThoughtType(ndb, { name: 'задача' }, ctx.adminId);
      const m = createThought(ndb, { title: 'M', type_id: t.id }, ctx.adminId);
      void m;

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await callOp(
          handle.client,
          'ontology.delete',
          {
            network_id: ctx.networkId,
            kind: 'thought_type',
            id: t.id,
            force: true,
          },
          true,
        );
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<OntologyDeleteResult>(result);
        assert.equal(data.deleted, true);
        // Тип удалён, у связанной мысли type_id = NULL, HOME остаётся
        // без типа.
        const after = openNetworkDb(ctx.dataDir, ctx.networkId);
        const typeRow = after
          .prepare('SELECT id FROM thought_types_v WHERE id = ?')
          .get(t.id);
        assert.equal(typeRow, undefined, 'thought_type must be deleted');
        const thoughtRow = after
          .prepare('SELECT id, type_id FROM thoughts_v WHERE id = ?')
          .get(m.id) as { id: string; type_id: string | null } | undefined;
        assert.ok(thoughtRow !== undefined);
        assert.equal(thoughtRow!.type_id, null, 'thought.type_id must be null after force');
        const homeRow = after
          .prepare('SELECT id, type_id, is_root FROM thoughts WHERE id = ?')
          .get(ctx.homeId) as { id: string; type_id: string | null; is_root: number } | undefined;
        assert.ok(homeRow !== undefined, 'HOME must still exist');
        assert.equal(homeRow!.is_root, 1);
        assert.equal(homeRow!.type_id, null, 'HOME must remain without a type');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete on a type_roles-bound type rejects even with force', async () => {
    const ctx = await buildMcpContext();
    try {
      const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
      const t = createThoughtType(ndb, { name: 'раздел' }, ctx.adminId);
      // Ставим роль в network.type_roles.
      const existing = ctx.sys.getNetworkById(ctx.networkId)!;
      ctx.sys.updateNetwork(ctx.networkId, {
        displayName: existing.display_name,
        description: existing.description,
        when_to_use: existing.when_to_use,
        conventions: existing.conventions,
        examples: existing.examples,
        type_roles: { table_of_contents: t.id },
      });

      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await callOp(
          handle.client,
          'ontology.delete',
          {
            network_id: ctx.networkId,
            kind: 'thought_type',
            id: t.id,
            force: true,
          },
          true,
        );
        assert.equal(result.isError, true);
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        assert.ok(text.includes('table_of_contents') || text.includes('роли'), text);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('writes ONE audit row per write call and ONE per delete call', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const before = (
          ctx.rawDb
            .prepare(
              `SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?`,
            )
            .get('etn.ontology.write', ctx.networkId) as { c: number }
        ).c;
        await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [
              { ref: 't1', name: 'T1' },
              { ref: 't2', name: 'T2', parent_ref: 't1' },
            ],
            properties: [{ ref: 'p', name: 'P', value_type: 'text' }],
          },
        });
        const afterWrite = (
          ctx.rawDb
            .prepare(
              `SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?`,
            )
            .get('etn.ontology.write', ctx.networkId) as { c: number }
        ).c;
        assert.equal(afterWrite - before, 1, 'etn.ontology.write must add exactly 1 audit row');

        // Удалим leaf-тип — ещё одна запись.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const t2 = ndb
          .prepare("SELECT id FROM thought_types_v WHERE name = 'T2'")
          .get() as { id: string };
        const beforeDel = (
          ctx.rawDb
            .prepare(
              `SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?`,
            )
            .get('etn.ontology.delete', ctx.networkId) as { c: number }
        ).c;
        await callOp(
          handle.client,
          'ontology.delete',
          {
            network_id: ctx.networkId,
            kind: 'thought_type',
            id: t2.id,
          },
          true,
        );
        const afterDel = (
          ctx.rawDb
            .prepare(
              `SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?`,
            )
            .get('etn.ontology.delete', ctx.networkId) as { c: number }
        ).c;
        assert.equal(afterDel - beforeDel, 1, 'etn.ontology.delete must add exactly 1 audit row');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // 0.8.3 (задача d379e091): `etn.ontology.delete` снят в `etn.ops`. Ветки
  // `link_type` / `property` / `type_property` покрыты здесь — сторож
  // `guard-mcp-view-coverage` требует тест на каждое значение `kind`.
  it('etn.ontology.delete { kind: link_type, force } каскадит связи типа', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const written = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ ref: 't', name: 'LinkOwner' }],
              link_types: [{ ref: 'lt', name_forward: 'бьёт', name_reverse: 'бит' }],
            },
          }),
        );
        const linkTypeId = written.link_types[0]!.id;
        const a = await createThoughtViaWrite(handle.client, ctx.networkId, { title: 'A-link' });
        await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'B-link',
          link: { direction: 'parent', target_thought_id: a.id, type: 'бьёт' },
        });

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: linkTypeId, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        const data = toolJson<OntologyDeleteResult>(del);
        assert.equal(data.deleted, true);
        assert.ok((data.affected_counts.links_count ?? 0) >= 1, 'связь типа должна уйти каскадом');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete { kind: property, force } удаляет свойство и его значения', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const written = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ ref: 't', name: 'PropOwner' }],
              properties: [{ ref: 'p', name: 'приоритет', value_type: 'text' }],
              type_properties: [
                { owner: 'thought_type', type_ref: 't', property_ref: 'p' },
              ],
            },
          }),
        );
        const propertyId = written.properties[0]!.id;
        await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: ctx.networkId,
            thoughts: [
              { ref: 'x', thought: { title: 'X-prop', type: 'PropOwner' }, properties: { приоритет: 'v' } },
            ],
          },
        });

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'property', id: propertyId, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        const data = toolJson<OntologyDeleteResult>(del);
        assert.equal(data.deleted, true);
        assert.ok(
          (data.affected_counts.property_values_count ?? 0) >= 1,
          'значение свойства должно уйти каскадом',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.ontology.delete { kind: type_property } снимает привязку свойства', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const written = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ ref: 't', name: 'BindOwner' }],
              properties: [{ ref: 'p', name: 'тег', value_type: 'text' }],
              type_properties: [
                { owner: 'thought_type', type_ref: 't', property_ref: 'p' },
              ],
            },
          }),
        );
        const bindingId = written.type_properties[0]!.id;

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'type_property', id: bindingId },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        assert.equal(toolJson<OntologyDeleteResult>(del).deleted, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка f14962ca: патч существующего типа с изменившимся `parent` отвечал
  // `action: "unchanged"`, а родитель не менялся — `parent` учитывался только
  // на создании, фаза 1.5 обрабатывала лишь `parent_ref`. Явный `parent: null`
  // («под корневой тип») тоже молча терялся.
  it('applies an explicit parent on an existing thought type and link type (f14962ca)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [
                { ref: 'a', name: 'ReparentProbeA' },
                { ref: 'b', name: 'ReparentProbeB' },
              ],
              link_types: [
                { ref: 'la', name_forward: 'проба-а', name_reverse: 'проба-а-обр' },
                { ref: 'lb', name_forward: 'проба-б', name_reverse: 'проба-б-обр' },
              ],
            },
          }),
        );
        const a = created.thought_types.find((t) => t.ref === 'a')!;
        const b = created.thought_types.find((t) => t.ref === 'b')!;
        const la = created.link_types.find((t) => t.ref === 'la')!;
        const lb = created.link_types.find((t) => t.ref === 'lb')!;

        // Патч типа мысли: явный parent — id существующего типа.
        const patched = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ id: a.id, parent: b.id }],
            },
          }),
        );
        assert.equal(patched.thought_types[0]?.action, 'updated', 'parent применён, не unchanged');

        // Патч типа связи: та же семантика.
        const patchedLt = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [{ id: la.id, parent: lb.id }],
            },
          }),
        );
        assert.equal(patchedLt.link_types[0]?.action, 'updated');

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const aRow = ndb
          .prepare('SELECT parent_id FROM thought_types_v WHERE id = ?')
          .get(a.id) as { parent_id: string | null };
        assert.equal(aRow.parent_id, b.id, 'родитель типа мысли сменён');
        const laRow = ndb
          .prepare('SELECT parent_id FROM link_types_v WHERE id = ?')
          .get(la.id) as { parent_id: string | null };
        assert.equal(laRow.parent_id, lb.id, 'родитель типа связи сменён');

        // Явный `parent: null` — прикрепить под корневой тип.
        const nulled = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ id: a.id, parent: null }],
            },
          }),
        );
        assert.equal(nulled.thought_types[0]?.action, 'updated');
        const rootId = (
          ndb
            .prepare('SELECT id FROM thought_types_v WHERE is_root = 1')
            .get() as { id: string }
        ).id;
        const aAgain = ndb
          .prepare('SELECT parent_id FROM thought_types_v WHERE id = ?')
          .get(a.id) as { parent_id: string | null };
        assert.equal(aAgain.parent_id, rootId, 'parent: null возвращает тип под корень');

        // Идемпотентность: тот же parent больше ничего не меняет.
        const repeat = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ id: a.id, parent: null }],
            },
          }),
        );
        assert.equal(repeat.thought_types[0]?.action, 'unchanged');

        // Пропущенный parent (ключ не задан) родителя не трогает.
        const untouched = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ id: a.id, description: 'без смены родителя' }],
            },
          }),
        );
        assert.equal(untouched.thought_types[0]?.action, 'updated');
        const aFinal = ndb
          .prepare('SELECT parent_id FROM thought_types_v WHERE id = ?')
          .get(a.id) as { parent_id: string | null };
        assert.equal(aFinal.parent_id, rootId, 'пропущенный parent не меняет родителя');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
