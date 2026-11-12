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
 *   * одна строка `audit_log` на ВЕСЬ вызов write/delete;
 *   * `affected_counts.links_becoming_structural` (ошибка 3537f1c2): точное
 *     число живых рёбер, теряющих `type_id`, фильтры REST, паритет с
 *     `DELETE /properties/:id`, 0 и отсутствие рёбер, рабочий слой, откат;
 *   * `kind: "property"` для свойства-связи (ошибка 937b4d81): удаляется пара
 *     «свойство + link_type» одним путём с REST, рёбра теряют `type_id`,
 *     число — в ответе и `audit.details`, скаляр не затронут, откат.
 *
 * Bootstrap — `mcp-helpers.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import type { RealtimeEvent } from '@etn/shared';

import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';
import { openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createLink, updateLink } from '../src/domain/link-service.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createThought } from '../src/domain/thought-service.js';
import {
  createTypeProperty,
  ensureLinkPropertyForLinkType,
  listEffectiveTypeProperties,
} from '../src/domain/property-service.js';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';

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
    /** Парное свойство-связь типа (0.15.4, ошибка 117a999a). */
    property_id: string | null;
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

/**
 * Фикстура для `links_becoming_structural` (ошибка 3537f1c2): тип связи с
 * парным свойством-связью и рёбра заданного состояния — живые, в корзине,
 * неактивные. Рёбра строятся доменными сервисами: MCP-вызов нужен только на
 * сам `ontology.delete`, состояния рёбер задаются `updateLink`.
 */
function seedLinkTypeWithEdges(
  ndb: NetworkDb,
  actorUserId: string,
  options: { tag: string; live?: number; trashed?: number; inactive?: number },
): { linkTypeId: string; propertyId: string; linkIds: string[] } {
  const linkType = createLinkType(
    ndb,
    { name_forward: `связь-${options.tag}`, name_reverse: `связь-${options.tag}-обр` },
    actorUserId,
  );
  const pair = ensureLinkPropertyForLinkType(ndb, linkType.id, actorUserId);
  const anchor = createThought(ndb, { title: `якорь-${options.tag}` }, actorUserId);
  const linkIds: string[] = [];
  const add = (state: 'live' | 'trashed' | 'inactive'): void => {
    const other = createThought(
      ndb,
      { title: `цель-${options.tag}-${linkIds.length}` },
      actorUserId,
    );
    const link = createLink(
      ndb,
      { source_id: anchor.id, target_id: other.id, type_id: linkType.id },
      actorUserId,
    );
    if (state === 'trashed') {
      updateLink(ndb, link.id, { marked_for_deletion: true }, undefined, actorUserId);
    }
    if (state === 'inactive') {
      updateLink(ndb, link.id, { active: false }, undefined, actorUserId);
    }
    linkIds.push(link.id);
  };
  for (let i = 0; i < (options.live ?? 0); i += 1) add('live');
  for (let i = 0; i < (options.trashed ?? 0); i += 1) add('trashed');
  for (let i = 0; i < (options.inactive ?? 0); i += 1) add('inactive');
  return { linkTypeId: linkType.id, propertyId: pair.property.id, linkIds };
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

  // Ошибка 98ab2c3e: фаза 1.5 для link_types адресовала тип через `item.id`,
  // а у только что СОЗДАННОГО типа он ещё null — `parent_ref` молча терялся,
  // тип оставался под корнем. Теперь id берётся из результата записи, как в
  // фазе thought_types.
  it('builds a hierarchy of 3 link types via parent_ref in one call (98ab2c3e)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            link_types: [
              { ref: 'lwork', name_forward: 'иерарх-работа', name_reverse: 'иерарх-работа-обр' },
              {
                ref: 'ltask',
                name_forward: 'иерарх-задача',
                name_reverse: 'иерарх-задача-обр',
                parent_ref: 'lwork',
              },
              {
                ref: 'lsub',
                name_forward: 'иерарх-подзадача',
                name_reverse: 'иерарх-подзадача-обр',
                parent_ref: 'ltask',
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<OntologyWriteResult>(result);
        assert.equal(data.link_types.length, 3);
        for (const t of data.link_types) assert.equal(t.action, 'created');
        const lwork = data.link_types.find((t) => t.ref === 'lwork')!;
        const ltask = data.link_types.find((t) => t.ref === 'ltask')!;
        const lsub = data.link_types.find((t) => t.ref === 'lsub')!;
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const parentOf = (id: string): string | null =>
          (
            ndb.prepare('SELECT parent_id FROM link_types_v WHERE id = ?').get(id) as {
              parent_id: string | null;
            }
          ).parent_id;
        // lwork — прямой потомок корня.
        assert.notEqual(parentOf(lwork.id), null);
        assert.equal(parentOf(ltask.id), lwork.id, 'ltask подвешен под lwork');
        assert.equal(parentOf(lsub.id), ltask.id, 'lsub подвешен под ltask');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('resolves parent_ref of a new link type to an existing one by name and by id (98ab2c3e)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const seed = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                {
                  ref: 'root',
                  name_forward: 'существующий-родитель',
                  name_reverse: 'существующий-родитель-обр',
                },
              ],
            },
          }),
        );
        const existingId = seed.link_types[0]!.id;

        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            link_types: [
              // Батч-псевдоним, совпадающий по паре имён с существующим типом:
              // его id резолвится из БД ещё в resolve-фазе.
              {
                ref: 'byName',
                name_forward: 'существующий-родитель',
                name_reverse: 'существующий-родитель-обр',
              },
              {
                ref: 'childByName',
                name_forward: 'новичок-по-имени',
                name_reverse: 'новичок-по-имени-обр',
                parent_ref: 'byName',
              },
              // Батч-псевдоним с явным id существующего типа.
              { ref: 'byId', id: existingId },
              {
                ref: 'childById',
                name_forward: 'новичок-по-id',
                name_reverse: 'новичок-по-id-обр',
                parent_ref: 'byId',
              },
            ],
          },
        });
        assert.equal(result.isError, undefined, toolText(result));
        const data = toolJson<OntologyWriteResult>(result);
        const childByName = data.link_types.find((t) => t.ref === 'childByName')!;
        const childById = data.link_types.find((t) => t.ref === 'childById')!;
        assert.equal(childByName.action, 'created');
        assert.equal(childById.action, 'created');
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const parentOf = (id: string): string | null =>
          (
            ndb.prepare('SELECT parent_id FROM link_types_v WHERE id = ?').get(id) as {
              parent_id: string | null;
            }
          ).parent_id;
        assert.equal(parentOf(childByName.id), existingId, 'родитель по имени существующего типа');
        assert.equal(parentOf(childById.id), existingId, 'родитель по id существующего типа');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('rejects a link type parent_ref not declared in the batch (98ab2c3e)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const result = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            link_types: [
              {
                ref: 'orphan',
                name_forward: 'нерезолв-ребёнок',
                name_reverse: 'нерезолв-ребёнок-обр',
                parent_ref: 'nope',
              },
            ],
          },
        });
        assert.equal(result.isError, true, 'ожидается VALIDATION_ERROR, а не молчаливый игнор');
        const text = toolText(result);
        assert.ok(text.includes('VALIDATION_ERROR'), text);
        assert.ok(text.includes('nope'), `ожидалось упоминание ref: ${text}`);
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const rows = ndb
          .prepare("SELECT id FROM link_types_v WHERE name_forward = 'нерезолв-ребёнок'")
          .all();
        assert.equal(rows.length, 0, 'батч с нерезолвленным parent_ref откатывается');
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
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const pairLeft = (
          ndb
            .prepare(
              `SELECT COUNT(*) AS c FROM properties
                WHERE deleted = 0 AND json_extract(config, '$.link_type_id') = ?`,
            )
            .get(linkTypeId) as { c: number }
        ).c;
        assert.equal(pairLeft, 0, 'парное свойство удалено вместе с типом (117a999a)');
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

  // Ошибка 1eb2a430 (замечания проверки f14962ca): MCP `ontology.write`
  // расходился с REST в трактовке `parent`:
  //   (а) явный `parent` у КОРНЕВОГО типа молча игнорировался (`unchanged`),
  //       тогда как REST PATCH корня → `VALIDATION_ERROR`;
  //   (б) `parent: ""` отвергался схемой `min(1)`, тогда как REST приводит
  //       `parent_id: ""` к null → под корень.
  // Контракты сведены к паритету: (а) → VALIDATION_ERROR, (б) → под корень.
  it('root type rejects explicit parent; parent:"" is treated as null (1eb2a430)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const rootTtId = (
          ndb.prepare('SELECT id FROM thought_types_v WHERE is_root = 1').get() as { id: string }
        ).id;
        const rootLtId = (
          ndb.prepare('SELECT id FROM link_types_v WHERE is_root = 1').get() as { id: string }
        ).id;

        // (а) явный parent у корневого ТИПА МЫСЛИ → VALIDATION_ERROR.
        const ttRootParent = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            thought_types: [{ id: rootTtId, parent: rootTtId }],
          },
        });
        assert.equal(ttRootParent.isError, true, 'явный parent у корня должен отвергаться');
        assert.ok(
          toolText(ttRootParent).includes('the root type has no parent'),
          `expected root-parent error: ${toolText(ttRootParent)}`,
        );

        // (а) то же для корневого ТИПА СВЯЗИ.
        const ltRootParent = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            link_types: [{ id: rootLtId, parent: null }],
          },
        });
        assert.equal(ltRootParent.isError, true, 'parent у корня типа связи должен отвергаться');
        assert.ok(toolText(ltRootParent).includes('the root type has no parent'));

        // Родитель корня не изменился и не получил version-инкремента.
        const rootRow = ndb
          .prepare('SELECT parent_id FROM thought_types_v WHERE id = ?')
          .get(rootTtId) as { parent_id: string | null };
        assert.equal(rootRow.parent_id, null, 'parent_id корня остался null');

        // (б) `parent: ""` на СОЗДАНИИ → под корень (не VALIDATION_ERROR).
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [
                { ref: 'p', name: 'ReparentEmptyParent' },
                { ref: 'c', name: 'ReparentEmptyChild', parent_ref: 'p' },
              ],
              link_types: [
                { ref: 'lp', name_forward: 'пустой-родитель', name_reverse: 'пустой-родитель-обр' },
                { ref: 'lc', name_forward: 'пустой-ребёнок', name_reverse: 'пустой-ребёнок-обр' },
              ],
            },
          }),
        );
        const p = created.thought_types.find((t) => t.ref === 'p')!;
        const c = created.thought_types.find((t) => t.ref === 'c')!;
        const lp = created.link_types.find((t) => t.ref === 'lp')!;
        const lc = created.link_types.find((t) => t.ref === 'lc')!;
        assert.equal(
          (ndb.prepare('SELECT parent_id FROM thought_types_v WHERE id = ?').get(c.id) as {
            parent_id: string | null;
          }).parent_id,
          p.id,
          'перед патчем ребёнок подвешен под p',
        );
        // Тип связи подвесим под `lp` явным parent-id, чтобы затем снять его
        // пустой строкой. (`parent_ref` при СОЗДАНИИ link_type тоже работает —
        // см. регресс 98ab2c3e ниже; здесь выбран явный id, чтобы отдельно
        // проверить именно снятие родителя пустой строкой.)
        toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [{ id: lc.id, parent: lp.id }],
            },
          }),
        );
        assert.equal(
          (ndb.prepare('SELECT parent_id FROM link_types_v WHERE id = ?').get(lc.id) as {
            parent_id: string | null;
          }).parent_id,
          lp.id,
          'перед патчем тип связи подвешен под lp',
        );

        // (б) `parent: ""` на ПАТЧЕ существующего типа — под корень, как REST.
        const emptied = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ id: c.id, parent: '' }],
              link_types: [{ id: lc.id, parent: '' }],
            },
          }),
        );
        assert.equal(emptied.thought_types[0]?.action, 'updated', 'parent:"" применён, не отвергнут');
        assert.equal(emptied.link_types[0]?.action, 'updated', 'parent:"" применён у типа связи');
        assert.equal(
          (ndb.prepare('SELECT parent_id FROM thought_types_v WHERE id = ?').get(c.id) as {
            parent_id: string | null;
          }).parent_id,
          rootTtId,
          'parent:"" прикрепил тип мысли под корень',
        );
        assert.equal(
          (ndb.prepare('SELECT parent_id FROM link_types_v WHERE id = ?').get(lc.id) as {
            parent_id: string | null;
          }).parent_id,
          rootLtId,
          'parent:"" прикрепил тип связи под корень',
        );

        // (б) пустая строка и `null` равнозначны: повтор ничего не меняет.
        const repeat = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ id: c.id, parent: null }],
            },
          }),
        );
        assert.equal(repeat.thought_types[0]?.action, 'unchanged');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // Ошибка 16766f82: патч существующего свойства-связи с явным
  // `parent_link_type_id` отвечал `action: "unchanged"` и родителя связанного
  // link_type не менял — у `NetworkPropertyUpdateInput` не было поля, а
  // `updateNetworkProperty` не умел менять родителя уже созданного link_type
  // (тот же класс, что `parent` у типа до f14962ca).
  it('applies an explicit parent_link_type_id on an existing link property (16766f82)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'p', name_forward: 'проба-родитель', name_reverse: 'проба-родитель-обр' },
              ],
              properties: [
                {
                  ref: 'prop',
                  name: 'ZzLinkProp',
                  value_type: 'link',
                  name_forward: 'проба-свойство',
                  name_reverse: 'проба-свойство-обр',
                },
              ],
            },
          }),
        );
        const ltParent = created.link_types.find((t) => t.ref === 'p')!;
        const prop = created.properties.find((p) => p.ref === 'prop')!;

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const linkTypeIdOf = (propertyId: string): string => {
          const row = ndb
            .prepare('SELECT config FROM properties WHERE id = ?')
            .get(propertyId) as { config: string | null };
          return (JSON.parse(row.config ?? '{}') as { link_type_id: string }).link_type_id;
        };
        const parentOf = (linkTypeId: string): string | null =>
          (
            ndb
              .prepare('SELECT parent_id FROM link_types_v WHERE id = ?')
              .get(linkTypeId) as { parent_id: string | null }
          ).parent_id;
        const propLinkTypeId = linkTypeIdOf(prop.id);

        // Явный parent_link_type_id — id существующего типа связи.
        const patched = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [{ id: prop.id, parent_link_type_id: ltParent.id }],
            },
          }),
        );
        assert.equal(patched.properties[0]?.action, 'updated', 'родитель применён, не unchanged');
        assert.equal(parentOf(propLinkTypeId), ltParent.id, 'родитель link_type сменён');

        // Повтор того же значения — unchanged (идемпотентность).
        const repeat = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [{ id: prop.id, parent_link_type_id: ltParent.id }],
            },
          }),
        );
        assert.equal(repeat.properties[0]?.action, 'unchanged', 'повтор не поднимает version');

        // Явный `parent_link_type_id: null` — под корневой тип связи.
        const nulled = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [{ id: prop.id, parent_link_type_id: null }],
            },
          }),
        );
        assert.equal(nulled.properties[0]?.action, 'updated');
        const rootLinkTypeId = (
          ndb.prepare('SELECT id FROM link_types_v WHERE is_root = 1').get() as { id: string }
        ).id;
        assert.equal(parentOf(propLinkTypeId), rootLinkTypeId, 'null — под корневой тип связи');

        // Пропущенный ключ родителя не трогает: патч по другому полю.
        const otherPatched = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [{ id: prop.id, description: 'родитель не тронут' }],
            },
          }),
        );
        assert.equal(otherPatched.properties[0]?.action, 'updated');
        assert.equal(
          parentOf(propLinkTypeId),
          rootLinkTypeId,
          'пропущенный ключ родителя не меняет родителя',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
  // -------------------------------------------------------------------------
  // 0.15.4 (ошибка 117a999a): тип связи из `link_types[]` живёт в паре со
  // своим свойством-связью — без пары GUI не даёт править тип.
  // -------------------------------------------------------------------------

  it('link_types[] автосоздаёт парное свойство-связь и возвращает property_id (117a999a)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'a', name_forward: 'пара-а', name_reverse: 'пара-а-обр' },
                { ref: 'b', name_forward: 'пара-б', name_reverse: 'пара-б-обр' },
              ],
            },
          }),
        );
        assert.equal(created.link_types.length, 2);
        const propertyIds = created.link_types.map((t) => t.property_id);
        assert.ok(
          propertyIds.every((id) => typeof id === 'string' && id !== ''),
          'каждый созданный тип возвращает property_id',
        );
        assert.equal(new Set(propertyIds).size, 2, 'N типов — N разных пар');

        interface PairRow {
          id: string;
          name: string;
          description: string | null;
          config: string;
        }
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const pairsOf = (linkTypeId: string): PairRow[] =>
          ndb
            .prepare(
              `SELECT id, name, description, config FROM properties_v
                WHERE value_type = 'link'
                  AND json_extract(config, '$.link_type_id') = ?`,
            )
            .all(linkTypeId) as PairRow[];

        for (const [index, item] of created.link_types.entries()) {
          const rows = pairsOf(item.id);
          assert.equal(rows.length, 1, 'ровно одна пара на тип');
          assert.equal(rows[0]!.id, item.property_id);
          assert.equal(rows[0]!.name, index === 0 ? 'пара-а' : 'пара-б', 'имя = name_forward');
          assert.equal(rows[0]!.description, null, 'неявное свойство без описания');
          assert.deepEqual(JSON.parse(rows[0]!.config), { link_type_id: item.id });
        }

        // Идемпотентность: повтор по id не создаёт вторую пару.
        const repeat = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                {
                  id: created.link_types[0]!.id,
                  name_forward: 'пара-а',
                  name_reverse: 'пара-а-обр',
                },
              ],
            },
          }),
        );
        assert.equal(repeat.link_types[0]?.action, 'unchanged');
        assert.equal(repeat.link_types[0]?.property_id, created.link_types[0]!.property_id);
        assert.equal(pairsOf(created.link_types[0]!.id).length, 1, 'повтор не плодит пару');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('конфликт имени пары — DUPLICATE с откатом батча, надгробие тоже конфликт (117a999a)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const pre = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [{ ref: 'p', name: 'занято-пара', value_type: 'text' }],
            },
          }),
        );
        const conflictId = pre.properties[0]!.id;
        const attempt = () =>
          handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'lt', name_forward: 'занято-пара', name_reverse: 'занято-пара-обр' },
              ],
            },
          });

        const first = await attempt();
        assert.equal(first.isError, true, 'конфликт имени должен отвергаться');
        const firstText = toolText(first);
        assert.ok(firstText.includes('DUPLICATE'), firstText);
        assert.ok(firstText.includes('link_types[0]'), `details.field: ${firstText}`);
        assert.ok(firstText.includes(conflictId), `details.conflict_property_id: ${firstText}`);

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const liveTypes = (): number =>
          (
            ndb
              .prepare("SELECT COUNT(*) AS c FROM link_types_v WHERE name_forward = 'занято-пара'")
              .get() as { c: number }
          ).c;
        assert.equal(liveTypes(), 0, 'батч откатился, тип не создан');

        // Надгробие свойства того же имени в слое — тоже конфликт: оно даст
        // нарушение UNIQUE(name_key, layer_id) при вставке пары. В базовом
        // слое delete физический (deleteRowLayered), поэтому надгробие
        // ставим сырой строкой — так же, как его оставил бы рабочий слой.
        const tombstoneId = randomUUID();
        const nowIso = new Date().toISOString();
        ndb
          .prepare(
            `INSERT INTO properties (id, layer_id, deleted, base_version, name, name_key,
                                      value_type, config, description, created_at, updated_at,
                                      created_by, updated_by, created_at_ms, updated_at_ms)
             VALUES (?, ?, 1, 0, 'занято-труп', type_name_key('занято-труп'),
                     'text', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
          )
          .run(tombstoneId, ndb.layerId, nowIso, nowIso, ctx.adminId, ctx.adminId, Date.now(), Date.now());

        const second = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            link_types: [
              { ref: 'lt2', name_forward: 'занято-труп', name_reverse: 'занято-труп-обр' },
            ],
          },
        });
        assert.equal(second.isError, true, 'надгробие того же имени — конфликт');
        const secondText = toolText(second);
        assert.ok(secondText.includes('DUPLICATE'), secondText);
        assert.ok(secondText.includes(tombstoneId), `details.conflict_property_id: ${secondText}`);
        assert.equal(liveTypes(), 0, 'откат и во втором случае');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('переименование типа через link_types[] синхронизирует пару, коллизия — DUPLICATE (117a999a)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'lt', name_forward: 'имя-старое', name_reverse: 'имя-старое-обр' },
              ],
            },
          }),
        );
        const linkTypeId = created.link_types[0]!.id;
        const propertyId = created.link_types[0]!.property_id!;

        // Ошибка 117a999a: переименование типа переносит имя пары — это
        // отдельная сущность реестра, подписчики `property-registry.*`
        // должны получить событие (и только при фактической смене имени).
        const registryUpdates: Array<{ id: string; name: string | undefined }> = [];
        const unsubscribe = ctx.pubsub.subscribe(
          ctx.networkId,
          (event: RealtimeEvent<'property-registry.updated'>) => {
            registryUpdates.push({ id: event.data.id, name: event.data.changes.name });
          },
          { type: 'property-registry.updated' },
        );

        const renamed = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [{ id: linkTypeId, name_forward: 'имя-новое' }],
            },
          }),
        );
        assert.equal(renamed.link_types[0]?.action, 'updated');
        assert.equal(renamed.link_types[0]?.property_id, propertyId, 'пара та же');
        assert.deepEqual(
          registryUpdates,
          [{ id: propertyId, name: 'имя-новое' }],
          'событие реестра несёт id пары и новое имя',
        );

        // Правка типа, где имя пары не меняется (то же имя + описание),
        // событий реестра не порождает — только фактическое переименование.
        const sameNameUpdate = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { id: linkTypeId, name_forward: 'имя-новое', description: 'правка без переименования' },
              ],
            },
          }),
        );
        assert.equal(sameNameUpdate.link_types[0]?.action, 'updated');
        assert.equal(registryUpdates.length, 1, 'то же имя — не переименование');
        // Идемпотентная перезапись того же имени тоже молчит.
        const sameName = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [{ id: linkTypeId, name_forward: 'имя-новое' }],
            },
          }),
        );
        assert.equal(sameName.link_types[0]?.action, 'unchanged');
        unsubscribe();
        assert.equal(registryUpdates.length, 1, 'без смены имени событий реестра нет');

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const storedName = (): { name: string; name_key: string } =>
          ndb.prepare('SELECT name, name_key FROM properties_v WHERE id = ?').get(propertyId) as {
            name: string;
            name_key: string;
          };
        assert.equal(storedName().name, 'имя-новое', 'имя пары следует за типом (38eaa15c)');
        assert.equal(storedName().name_key, 'имя-новое');

        // Коллизия нового имени — DUPLICATE, имя пары не меняется (откат).
        const clashProp = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [{ ref: 'p', name: 'занято-имя', value_type: 'text' }],
            },
          }),
        );
        const clash = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            link_types: [{ id: linkTypeId, name_forward: 'занято-имя' }],
          },
        });
        assert.equal(clash.isError, true, 'коллизия имени — DUPLICATE');
        const clashText = toolText(clash);
        assert.ok(clashText.includes('DUPLICATE'), clashText);
        assert.ok(clashText.includes(clashProp.properties[0]!.id), clashText);
        assert.equal(storedName().name, 'имя-новое', 'откат не тронул имя пары');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ontology.delete { kind: link_type } удаляет пару, но отказывает при её привязках (117a999a)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const written = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'busy', name_forward: 'связ-занят', name_reverse: 'связ-занят-обр' },
                { ref: 'free', name_forward: 'связ-свободен', name_reverse: 'связ-свободен-обр' },
              ],
            },
          }),
        );
        const busy = written.link_types.find((t) => t.ref === 'busy')!;
        const free = written.link_types.find((t) => t.ref === 'free')!;
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);

        // Привязка пары к типу мысли — «чужая» для типа связи: удалять нельзя.
        const holder = createThoughtType(ndb, { name: 'Держатель-пары' }, ctx.adminId);
        createTypeProperty(
          ndb,
          'thought_type',
          holder.id,
          {
            key: 'связ-занят',
            value_type: 'link',
            config: { link_type_id: busy.id },
            side: 'source',
          },
          ctx.adminId,
        );

        const refused = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: busy.id, force: true },
          true,
        );
        assert.equal(refused.isError, true, 'привязки пары блокируют удаление типа');
        const refusedText = toolText(refused);
        assert.ok(refusedText.includes('VALIDATION_ERROR'), refusedText);
        assert.ok(refusedText.includes(busy.property_id!), `details.property_id: ${refusedText}`);
        // Ошибка 117a999a: у link-свойства значения живут рёбрами, а не в
        // `property_values`, поэтому счётчик значений только вводит в
        // заблуждение (всегда 0) — в деталях отказа его быть не должно.
        assert.ok(refusedText.includes('type_properties_count'), refusedText);
        assert.ok(!refusedText.includes('property_values_count'), refusedText);

        // Свободная пара уходит вместе с типом (атомарно).
        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: free.id, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        assert.equal(toolJson<OntologyDeleteResult>(del).deleted, true);

        const livePairs = (linkTypeId: string): number =>
          (
            ndb
              .prepare(
                `SELECT COUNT(*) AS c FROM properties
                  WHERE deleted = 0 AND json_extract(config, '$.link_type_id') = ?`,
              )
              .get(linkTypeId) as { c: number }
          ).c;
        assert.equal(livePairs(free.id), 0, 'пара удалена вместе с типом');
        assert.equal(livePairs(busy.id), 1, 'пара занятого типа осталась');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Ошибка 3537f1c2: `affected_counts.links_becoming_structural` для
  // `kind: "link_type"`. Рёбра не удаляются — они теряют `type_id`; число
  // живых таких рёбер совпадает с REST `DELETE /properties/:id` (требование
  // 09f692ff), а `links_count` считает шире (корзина + неактивные).
  // -------------------------------------------------------------------------

  it('ontology.delete { kind: link_type } отдаёт links_becoming_structural = N с фильтрами REST (3537f1c2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        // 1 живое + 1 в корзине + 1 неактивное: REST-число = 1, links_count = 3.
        const fixture = seedLinkTypeWithEdges(ndb, ctx.adminId, {
          tag: 'структ',
          live: 1,
          trashed: 1,
          inactive: 1,
        });

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: fixture.linkTypeId, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        const counts = toolJson<OntologyDeleteResult>(del).affected_counts;
        assert.ok(
          Object.prototype.hasOwnProperty.call(counts, 'links_becoming_structural'),
          `поле обязано присутствовать (не null и не отсутствовать): ${JSON.stringify(counts)}`,
        );
        assert.equal(typeof counts.links_becoming_structural, 'number', 'поле — число, не null');
        assert.equal(
          counts.links_becoming_structural,
          1,
          `только живое ребро стало структурным: ${JSON.stringify(counts)}`,
        );
        // Тест-детектор DoD: поле не подменено переиспользованием links_count.
        assert.equal(
          counts.links_count,
          3,
          `links_count считает все рёбра типа, включая корзину и неактивные: ${JSON.stringify(counts)}`,
        );

        // Рёбра не удалены — у живого ребра обнулён `type_id`.
        const survived = ndb
          .prepare('SELECT type_id, updated_by FROM links WHERE id = ?')
          .get(fixture.linkIds[0]!) as
          | { type_id: string | null; updated_by: string }
          | undefined;
        assert.ok(survived !== undefined, 'ребро не должно исчезнуть');
        assert.equal(survived.type_id, null, 'ребро стало структурным, а не удалённым');
        // DoD 6: в базовом слое обнуление пишется на действующего пользователя.
        assert.equal(survived.updated_by, ctx.adminId, 'атрибуция обнуления — действующий агент');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ontology.delete { kind: link_type } отдаёт 0 без рёбер и когда все рёбра в корзине/неактивны (3537f1c2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const empties = seedLinkTypeWithEdges(ndb, ctx.adminId, { tag: 'пусто' });
        const tombstoned = seedLinkTypeWithEdges(ndb, ctx.adminId, {
          tag: 'только-корзина',
          trashed: 1,
          inactive: 1,
        });

        const delEmpty = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: empties.linkTypeId, force: true },
          true,
        );
        assert.equal(delEmpty.isError, undefined, toolText(delEmpty));
        const emptyCounts = toolJson<OntologyDeleteResult>(delEmpty).affected_counts;
        assert.equal(
          emptyCounts.links_becoming_structural,
          0,
          `тип без рёбер обязан отдать 0, а не отсутствие поля: ${JSON.stringify(emptyCounts)}`,
        );
        assert.equal(emptyCounts.links_count, 0);

        const delTomb = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: tombstoned.linkTypeId, force: true },
          true,
        );
        assert.equal(delTomb.isError, undefined, toolText(delTomb));
        const tombCounts = toolJson<OntologyDeleteResult>(delTomb).affected_counts;
        assert.equal(
          tombCounts.links_becoming_structural,
          0,
          `неактивные и помеченные на удаление рёбра в счётчик не входят: ${JSON.stringify(tombCounts)}`,
        );
        assert.equal(
          tombCounts.links_count,
          2,
          `links_count при этом видит оба ребра: ${JSON.stringify(tombCounts)}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('links_becoming_structural MCP совпадает с REST на эквивалентных фикстурах (3537f1c2)', async () => {
    const restCtx = await buildRestContext();
    let mcpCtx: McpTestContext | undefined;
    let handle: McpClientHandle | undefined;
    try {
      const ndb = restCtx.ndb;
      // Две фикстуры одной формы: одну пару удаляем REST-путём, другую — MCP
      // (одну и ту же пару дважды удалить нельзя).
      const restFixture = seedLinkTypeWithEdges(ndb, restCtx.adminId, {
        tag: 'паритет-rest',
        live: 1,
        trashed: 1,
        inactive: 1,
      });
      const mcpFixture = seedLinkTypeWithEdges(ndb, restCtx.adminId, {
        tag: 'паритет-mcp',
        live: 1,
        trashed: 1,
        inactive: 1,
      });

      const restDel = await restCtx.app.inject({
        method: 'DELETE',
        url: `/api/v1/networks/${restCtx.networkId}/properties/${restFixture.propertyId}`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restDel.statusCode, 200, restDel.body?.toString());
      const restCount = (restDel.json().data as { links_becoming_structural: number | null })
        .links_becoming_structural;
      assert.equal(restCount, 1, 'REST-число на этой фикстуре');

      mcpCtx = await buildMcpContext({
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      });
      handle = await connectMcpClient(mcpCtx, restCtx.adminKey);
      const mcpDel = await callOp(
        handle.client,
        'ontology.delete',
        {
          network_id: restCtx.networkId,
          kind: 'link_type',
          id: mcpFixture.linkTypeId,
          force: true,
        },
        true,
      );
      assert.equal(mcpDel.isError, undefined, toolText(mcpDel));
      const mcpCounts = toolJson<OntologyDeleteResult>(mcpDel).affected_counts;
      assert.equal(
        mcpCounts.links_becoming_structural,
        restCount,
        `MCP и REST обязаны давать одно число на одинаковой фикстуре: ${JSON.stringify(mcpCounts)} vs ${restCount}`,
      );
      assert.equal(mcpCounts.links_count, 3, 'широкий счётчик при этом прежний');
    } finally {
      if (handle !== undefined) await handle.close();
      if (mcpCtx !== undefined) await closeMcpContext(mcpCtx);
      await closeRestContext(restCtx);
    }
  });

  it('ontology.delete { kind: link_type } откатывается на реальном триггере — тип, пара и рёбра живы (3537f1c2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const parent = seedLinkTypeWithEdges(ndb, ctx.adminId, { tag: 'с-деткой', live: 1 });
        // Реальный триггер отказа внутри `deleteLinkType`: дочерний тип
        // (`link-type-service.ts` «the type has child types»). DUPLICATE по
        // `property_values` для пары недостижим — значений у link-свойства нет.
        createLinkType(
          ndb,
          {
            name_forward: 'связь-детка',
            name_reverse: 'связь-детка-обр',
            parent_id: parent.linkTypeId,
          },
          ctx.adminId,
        );

        const refused = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: parent.linkTypeId, force: true },
          true,
        );
        assert.equal(refused.isError, true, 'тип с дочерними типами обязан быть отвергнут');
        assert.ok(toolText(refused).includes('child types'), toolText(refused));

        // Транзакция целиком: ни тип, ни пара, ни ребро не изменились.
        const typeAlive = ndb
          .prepare('SELECT id FROM link_types_v WHERE id = ?')
          .get(parent.linkTypeId);
        assert.ok(typeAlive !== undefined, 'тип жив после отказа');
        const pairAlive = ndb
          .prepare('SELECT id FROM properties_v WHERE id = ?')
          .get(parent.propertyId);
        assert.ok(pairAlive !== undefined, 'парное свойство живо после отказа');
        const linkRow = ndb
          .prepare('SELECT type_id FROM links_v WHERE id = ?')
          .get(parent.linkIds[0]!) as { type_id: string | null } | undefined;
        assert.ok(linkRow !== undefined, 'ребро живо после отказа');
        assert.equal(linkRow.type_id, parent.linkTypeId, 'ребро сохранило тип');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('в рабочем слое links_becoming_structural считается по видимым рёбрам (3537f1c2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        // База: 1 живое ребро + 1 в корзине.
        const fixture = seedLinkTypeWithEdges(ndb, ctx.adminId, {
          tag: 'слой',
          live: 1,
          trashed: 1,
        });
        const layer = toolJson<{ id: string }>(
          await callOp(handle.client, 'layers.create', {
            network_id: ctx.networkId,
            title: 'Слой структурных рёбер',
          }),
        );
        await handle.client.callTool({
          name: 'etn.layers.select',
          arguments: { network_id: ctx.networkId, layer_id: layer.id },
        });

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: fixture.linkTypeId, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        const counts = toolJson<OntologyDeleteResult>(del).affected_counts;
        assert.equal(
          counts.links_becoming_structural,
          1,
          `в слое число отражает видимые живые рёбра: ${JSON.stringify(counts)}`,
        );
        assert.equal(counts.links_count, 2, 'широкий счётчик в слое видит оба ребра');

        // Удаление в слое не тронуло основу: тип и рёбра на месте.
        const baseType = ndb
          .prepare('SELECT id FROM link_types WHERE id = ?')
          .get(fixture.linkTypeId);
        assert.ok(baseType !== undefined, 'в основе тип остался');
        const baseLink = ndb
          .prepare('SELECT type_id FROM links_v WHERE id = ?')
          .get(fixture.linkIds[0]!) as { type_id: string | null } | undefined;
        assert.equal(baseLink?.type_id, fixture.linkTypeId, 'в основе ребро сохранило тип');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ontology.delete { kind: link_type } пишет ОДНУ строку аудита с числом в details (3537f1c2)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const fixture = seedLinkTypeWithEdges(ndb, ctx.adminId, {
          tag: 'аудит',
          live: 1,
          trashed: 1,
        });
        const countAudit = (): number =>
          (
            ctx.rawDb
              .prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?')
              .get('etn.ontology.delete', ctx.networkId) as { c: number }
          ).c;
        const before = countAudit();

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'link_type', id: fixture.linkTypeId, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        assert.equal(countAudit() - before, 1, 'ровно одна строка аудита на вызов');

        const row = ctx.rawDb
          .prepare(
            `SELECT details FROM audit_log
              WHERE action = ? AND network_id = ?
              ORDER BY rowid DESC LIMIT 1`,
          )
          .get('etn.ontology.delete', ctx.networkId) as { details: string | null } | undefined;
        assert.ok(row?.details !== null && row?.details !== undefined, 'details записаны');
        const details = JSON.parse(row.details) as {
          affected_counts: Record<string, number>;
        };
        assert.equal(
          details.affected_counts.links_becoming_structural,
          1,
          `число обязано попасть в audit.details: ${row.details}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Ошибка 937b4d81: `kind: "property"` для свойства-связи обязан идти тем же
  // путём, что REST `DELETE /properties/:id` — удалять пару «свойство +
  // link_type» в одной транзакции (требование 09f692ff). Рёбра не удаляются,
  // а теряют `type_id`; число живых рёбер — в ответе и `audit.details`.
  // -------------------------------------------------------------------------

  it('ontology.delete { kind: property } удаляет пару «свойство-связь + link_type», рёбра теряют type_id (937b4d81)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const fixture = seedLinkTypeWithEdges(ndb, ctx.adminId, {
          tag: 'пара-свойство',
          live: 1,
          trashed: 1,
          inactive: 1,
        });

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'property', id: fixture.propertyId },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        const counts = toolJson<OntologyDeleteResult>(del).affected_counts;
        assert.equal(
          counts.links_becoming_structural,
          1,
          `только живое ребро в счётчике (фильтры REST): ${JSON.stringify(counts)}`,
        );

        // Пара ушла целиком: и строка реестра, и парный тип связи.
        assert.equal(
          ndb.prepare('SELECT id FROM properties_v WHERE id = ?').get(fixture.propertyId),
          undefined,
          'свойство-связь удалено',
        );
        assert.equal(
          ndb.prepare('SELECT id FROM link_types_v WHERE id = ?').get(fixture.linkTypeId),
          undefined,
          'парный тип связи удалён вместе со свойством',
        );
        // Рёбра живы и стали структурными; в базовом слое обнуление пишется
        // на действующего пользователя.
        for (const linkId of fixture.linkIds) {
          const row = ndb
            .prepare('SELECT type_id, updated_by FROM links WHERE id = ?')
            .get(linkId) as { type_id: string | null; updated_by: string };
          assert.equal(row.type_id, null, `ребро ${linkId} стало структурным, а не удалённым`);
          assert.equal(row.updated_by, ctx.adminId, 'атрибуция обнуления — действующий агент');
        }
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ontology.delete { kind: property } на скалярном свойстве не добавляет links_becoming_structural (937b4d81)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const written = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              thought_types: [{ ref: 't', name: 'ScalarOwner' }],
              properties: [{ ref: 'p', name: 'вес', value_type: 'number' }],
              type_properties: [{ owner: 'thought_type', type_ref: 't', property_ref: 'p' }],
            },
          }),
        );
        const propertyId = written.properties[0]!.id;

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'property', id: propertyId, force: true },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        const counts = toolJson<OntologyDeleteResult>(del).affected_counts;
        assert.equal(
          Object.prototype.hasOwnProperty.call(counts, 'links_becoming_structural'),
          false,
          `скалярное свойство не отдаёт счётчик рёбер: ${JSON.stringify(counts)}`,
        );
        assert.equal(counts.property_values_count ?? 0, 0);
        assert.equal(counts.type_properties_count, 1, 'привязка ушла каскадом, как раньше');

        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        assert.equal(
          ndb.prepare('SELECT id FROM properties_v WHERE id = ?').get(propertyId),
          undefined,
          'скалярное свойство удалено',
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('kind: property — links_becoming_structural совпадает с REST на эквивалентных фикстурах (937b4d81)', async () => {
    const restCtx = await buildRestContext();
    let mcpCtx: McpTestContext | undefined;
    let handle: McpClientHandle | undefined;
    try {
      const ndb = restCtx.ndb;
      // Две фикстуры одной формы: одну пару удаляем REST-путём, другую — MCP.
      const restFixture = seedLinkTypeWithEdges(ndb, restCtx.adminId, {
        tag: 'свойство-rest',
        live: 1,
        trashed: 1,
        inactive: 1,
      });
      const mcpFixture = seedLinkTypeWithEdges(ndb, restCtx.adminId, {
        tag: 'свойство-mcp',
        live: 1,
        trashed: 1,
        inactive: 1,
      });

      const restDel = await restCtx.app.inject({
        method: 'DELETE',
        url: `/api/v1/networks/${restCtx.networkId}/properties/${restFixture.propertyId}`,
        headers: authHeaders(restCtx),
      });
      assert.equal(restDel.statusCode, 200, restDel.body?.toString());
      const restCount = (restDel.json().data as { links_becoming_structural: number | null })
        .links_becoming_structural;
      assert.equal(restCount, 1, 'REST-число на этой фикстуре');

      mcpCtx = await buildMcpContext({
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      });
      handle = await connectMcpClient(mcpCtx, restCtx.adminKey);
      const mcpDel = await callOp(
        handle.client,
        'ontology.delete',
        { network_id: restCtx.networkId, kind: 'property', id: mcpFixture.propertyId },
        true,
      );
      assert.equal(mcpDel.isError, undefined, toolText(mcpDel));
      assert.equal(
        toolJson<OntologyDeleteResult>(mcpDel).affected_counts.links_becoming_structural,
        restCount,
        'MCP и REST обязаны давать одно число на одинаковой фикстуре',
      );
      assert.equal(
        ndb.prepare('SELECT id FROM link_types_v WHERE id = ?').get(mcpFixture.linkTypeId),
        undefined,
        'MCP удаляет парный тип связи, как REST',
      );
    } finally {
      if (handle !== undefined) await handle.close();
      if (mcpCtx !== undefined) await closeMcpContext(mcpCtx);
      await closeRestContext(restCtx);
    }
  });

  it('ontology.delete { kind: property } откатывается на реальном триггере — свойство, тип и рёбра живы (937b4d81)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const fixture = seedLinkTypeWithEdges(ndb, ctx.adminId, { tag: 'пара-детка', live: 1 });
        // Реальный триггер отказа внутри `deleteLinkType`: дочерний тип.
        createLinkType(
          ndb,
          {
            name_forward: 'связь-детка-пара',
            name_reverse: 'связь-детка-пара-обр',
            parent_id: fixture.linkTypeId,
          },
          ctx.adminId,
        );

        const refused = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'property', id: fixture.propertyId, force: true },
          true,
        );
        assert.equal(refused.isError, true, 'тип с дочерними типами обязан быть отвергнут');
        assert.ok(toolText(refused).includes('child types'), toolText(refused));

        assert.ok(
          ndb.prepare('SELECT id FROM properties_v WHERE id = ?').get(fixture.propertyId) !==
            undefined,
          'свойство живо после отказа',
        );
        assert.ok(
          ndb.prepare('SELECT id FROM link_types_v WHERE id = ?').get(fixture.linkTypeId) !==
            undefined,
          'тип связи жив после отказа',
        );
        const linkRow = ndb
          .prepare('SELECT type_id FROM links_v WHERE id = ?')
          .get(fixture.linkIds[0]!) as { type_id: string | null } | undefined;
        assert.ok(linkRow !== undefined, 'ребро живо после отказа');
        assert.equal(linkRow.type_id, fixture.linkTypeId, 'ребро сохранило тип');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ontology.delete { kind: property } пишет ОДНУ строку аудита с числом в details (937b4d81)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const fixture = seedLinkTypeWithEdges(ndb, ctx.adminId, {
          tag: 'пара-аудит',
          live: 1,
          trashed: 1,
        });
        const countAudit = (): number =>
          (
            ctx.rawDb
              .prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND network_id = ?')
              .get('etn.ontology.delete', ctx.networkId) as { c: number }
          ).c;
        const before = countAudit();

        const del = await callOp(
          handle.client,
          'ontology.delete',
          { network_id: ctx.networkId, kind: 'property', id: fixture.propertyId },
          true,
        );
        assert.equal(del.isError, undefined, toolText(del));
        assert.equal(countAudit() - before, 1, 'ровно одна строка аудита на вызов');

        const row = ctx.rawDb
          .prepare(
            `SELECT details FROM audit_log
              WHERE action = ? AND network_id = ?
              ORDER BY rowid DESC LIMIT 1`,
          )
          .get('etn.ontology.delete', ctx.networkId) as { details: string | null } | undefined;
        assert.ok(row?.details !== null && row?.details !== undefined, 'details записаны');
        const details = JSON.parse(row.details) as {
          affected_counts: Record<string, number>;
        };
        assert.equal(
          details.affected_counts.links_becoming_structural,
          1,
          `число обязано попасть в audit.details: ${row.details}`,
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('properties[] не создаёт второе свойство-связь, но чинит голый тип (117a999a)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'lt', name_forward: 'уже-пара', name_reverse: 'уже-пара-обр' },
              ],
            },
          }),
        );
        const linkTypeId = created.link_types[0]!.id;
        const pairId = created.link_types[0]!.property_id!;

        const dup = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              {
                ref: 'dup',
                name: 'Дубль-пары',
                value_type: 'link',
                config: { link_type_id: linkTypeId },
              },
            ],
          },
        });
        assert.equal(dup.isError, true, 'второе свойство на тот же тип запрещено');
        const dupText = toolText(dup);
        assert.ok(dupText.includes('DUPLICATE'), dupText);
        assert.ok(dupText.includes(pairId), `details.conflict_property_id: ${dupText}`);

        // Общий `createLinkType` пару НЕ создаёт (иначе ломается properties[]-
        // путь), а `properties[]` легально достраивает её голому типу.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const bare = createLinkType(
          ndb,
          { name_forward: 'голый-тип', name_reverse: 'голый-тип-обр' },
          ctx.adminId,
        );
        const pairsOf = (id: string): number =>
          (
            ndb
              .prepare(
                `SELECT COUNT(*) AS c FROM properties
                  WHERE deleted = 0 AND json_extract(config, '$.link_type_id') = ?`,
              )
              .get(id) as { c: number }
          ).c;
        assert.equal(pairsOf(bare.id), 0, 'createLinkType пару не создаёт');

        const repaired = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              properties: [
                {
                  ref: 'fix',
                  name: 'Голое-свойство',
                  value_type: 'link',
                  config: { link_type_id: bare.id },
                },
              ],
            },
          }),
        );
        assert.equal(repaired.properties[0]?.action, 'created');
        assert.equal(pairsOf(bare.id), 1, 'голый тип вылечен');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('properties[] с direction:"in" не создаёт вторую пару — срабатывает guard, не коллизия имени (117a999a)', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        // Имена сторон РАЗНЫЕ: имя второй пары (name_reverse) свободно, поэтому
        // единственная причина отказа — guard «у типа уже есть свойство-связь»
        // в createNetworkProperty, а не конфликт имён.
        const created = toolJson<OntologyWriteResult>(
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [
                { ref: 'lt', name_forward: 'гард-вперёд', name_reverse: 'гард-назад' },
              ],
            },
          }),
        );
        const linkTypeId = created.link_types[0]!.id;
        const pairId = created.link_types[0]!.property_id!;

        const attempt = await handle.client.callTool({
          name: 'etn.ontology.write',
          arguments: {
            network_id: ctx.networkId,
            properties: [
              {
                ref: 'dup',
                name: 'гард-назад',
                value_type: 'link',
                config: { link_type_id: linkTypeId, direction: 'in' },
              },
            ],
          },
        });
        assert.equal(attempt.isError, true, 'вторая пара через properties[] запрещена');
        const text = toolText(attempt);
        assert.ok(text.includes('DUPLICATE'), text);
        assert.ok(text.includes(pairId), `details.conflict_property_id: ${text}`);

        // Инвариант: живая пара по link_type_id ровно одна, свойства со стороной
        // name_reverse не появилось.
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const pairs = (
          ndb
            .prepare(
              `SELECT COUNT(*) AS c FROM properties_v
                WHERE value_type = 'link'
                  AND (json_extract(config, '$.structural') IS NULL
                       OR json_extract(config, '$.structural') = 0)
                  AND json_extract(config, '$.link_type_id') = ?`,
            )
            .get(linkTypeId) as { c: number }
        ).c;
        assert.equal(pairs, 1, 'у типа ровно одна живая пара');
        const reverse = ndb
          .prepare("SELECT id FROM properties_v WHERE name_key = type_name_key('гард-назад')")
          .get();
        assert.equal(reverse, undefined, 'свойство со стороной name_reverse не создано');
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

});
