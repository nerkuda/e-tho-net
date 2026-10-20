/**
 * 0.14.1, тех.проект bd349082 / задача Z1 (92903c26): свобода записи значений
 * свойств у владельцев-мыслей и параметр `side` для свойств-связей.
 *
 * Покрывает DoD задачи:
 *   * создание/правка/удаление внетипового скаляра через REST и MCP — у мысли
 *     с типом и без типа;
 *   * несуществующее имя свойства → `422 VALIDATION_ERROR` (REST и MCP);
 *   * внетиповое свойство-связь создаёт ребро через REST PUT и MCP
 *     `etn.properties.add`/`etn.thoughts.write`;
 *   * `side`: симметричное имя — обе стороны живы → `side` обязателен, одна
 *     живая/ни одной — необязателен; создание отсутствующей стороны без сверки;
 *     сверка с фактическим направлением при удалении (422 при расхождении);
 *   * set-запись работает по живым рёбрам (корзинная цель не восстанавливается).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createNetworkProperty,
  createTypeProperty,
  getLinkPropertyValues,
  listEffectiveTypeProperties,
} from '../src/domain/property-service.js';
import { createLinkType, updateLinkType } from '../src/domain/link-type-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { openNetworkDb } from '../src/db/network-db.js';

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
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  toolJson,
  toolText,
} from './mcp-helpers.js';

const USER = 'user-1';

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** POST /properties — строка справочника. */
async function createProperty(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ id: string; name: string; config: Record<string, unknown> | null }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().data as { id: string; name: string; config: Record<string, unknown> | null };
}

/** POST /thoughts — мысль (опционально с типом), привязанная к HOME. */
async function createThought(
  ctx: RestTestContext,
  title: string,
  typeId?: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: {
      title,
      ...(typeId === undefined ? {} : { type_id: typeId }),
      create_link: { direction: 'parent', target_thought_id: ctx.homeId },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

async function putProperty(
  ctx: RestTestContext,
  thoughtId: string,
  key: string,
  value: unknown,
  side?: 'source' | 'target',
) {
  return ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${encodeURIComponent(key)}`,
    headers: authHeaders(ctx),
    payload: { value, ...(side === undefined ? {} : { side }) },
  });
}

async function deleteProperty(
  ctx: RestTestContext,
  thoughtId: string,
  key: string,
  side?: 'source' | 'target',
) {
  return ctx.app.inject({
    method: 'DELETE',
    url:
      `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${encodeURIComponent(key)}` +
      (side === undefined ? '' : `?side=${side}`),
    headers: authHeaders(ctx),
  });
}

async function listProperties(
  ctx: RestTestContext,
  thoughtId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().data as Array<Record<string, unknown>>;
}

describe(
  '0.14.1 — свобода записи значений свойств и side (REST)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('внетиповой скаляр: создание, правка, удаление у мысли с типом и без; 422 для несуществующего', async () => {
      const ctx = await buildRestContext();
      try {
        const prop = await createProperty(ctx, { name: 'период проживания', value_type: 'text' });
        const typeId = createThoughtType(ctx.ndb, { name: 'Квартира-freedom' }, USER).id;
        const typed = await createThought(ctx, 'Квартира', typeId);
        const untyped = await createThought(ctx, 'Конспект');

        for (const thoughtId of [typed, untyped]) {
          // Создание значения вне типа.
          const created = await putProperty(ctx, thoughtId, 'период проживания', '2010–2019');
          assert.equal(created.statusCode, 200, created.body);
          assert.equal((created.json().data as { outside_type: boolean }).outside_type, true);

          const listed = await listProperties(ctx, thoughtId);
          const value = listed.find((v) => v.property_id === prop.id);
          assert.ok(value !== undefined, 'значение видно в чтении');
          assert.equal(value.value, '2010–2019');
          assert.equal(value.outside_type, true);

          // Правка внетипового значения.
          const edited = await putProperty(ctx, thoughtId, 'период проживания', '2010–2024');
          assert.equal(edited.statusCode, 200, edited.body);
          assert.equal(
            (await listProperties(ctx, thoughtId)).find((v) => v.property_id === prop.id)?.value,
            '2010–2024',
          );

          // Удаление любого значения, включая вне типа.
          const removed = await deleteProperty(ctx, thoughtId, 'период проживания');
          assert.equal(removed.statusCode, 204);
          assert.equal(
            (await listProperties(ctx, thoughtId)).find((v) => v.property_id === prop.id),
            undefined,
          );
        }

        // Несуществующее имя — единственный 422 записи.
        const missingPut = await putProperty(ctx, typed, 'нет такого свойства', 'x');
        assert.equal(missingPut.statusCode, 422, missingPut.body);
        assert.equal((missingPut.json() as { error: { code: string } }).error.code, 'VALIDATION_ERROR');
        const missingDelete = await deleteProperty(ctx, typed, 'нет такого свойства');
        assert.equal(missingDelete.statusCode, 422, missingDelete.body);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('внетиповое свойство-связь создаёт ребро через REST PUT', async () => {
      const ctx = await buildRestContext();
      try {
        const prop = createNetworkProperty(
          ctx.ndb,
          {
            name: 'читал в',
            value_type: 'link',
            name_forward: 'читал в',
            name_reverse: 'читальный зал',
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        const owner = await createThought(ctx, 'Конспект-связь');
        const hall = await createThought(ctx, 'Зал №3');

        const put = await putProperty(ctx, owner, 'читал в', hall);
        assert.equal(put.statusCode, 200, put.body);
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').map(
            (v) => v.target_id,
          ),
          [hall],
          'ребро владелец → цель создано',
        );

        const listed = await listProperties(ctx, owner);
        // Проекция ребра вне типа: реестровое свойство не привязано к типу,
        // поэтому строка идёт по паре (тип связи + направление) — имя из типа
        // связи, property_id у внетиповой проекции пуст
        // (см. `listThoughtLinkProperties`, шаг 3).
        const linkRow = listed.find(
          (v) => v.property_name === 'читал в' && v.value_type === 'link',
        );
        assert.ok(linkRow !== undefined, 'свойство-связь видно в чтении');
        assert.equal(linkRow.outside_type, true);
        assert.equal(linkRow.count, 1);

        const removed = await deleteProperty(ctx, owner, 'читал в');
        assert.equal(removed.statusCode, 204);
        assert.equal(getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').length, 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('side адресует сторону симметричного свойства-связи; сверка при удалении', async () => {
      const ctx = await buildRestContext();
      try {
        const prop = createNetworkProperty(
          ctx.ndb,
          {
            name: 'см. также',
            value_type: 'link',
            name_forward: 'см. также',
            name_reverse: 'см. также',
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        const owner = await createThought(ctx, 'Тема');
        const first = await createThought(ctx, 'Смежная тема 1');
        const second = await createThought(ctx, 'Смежная тема 2');

        // Ни одной живой стороны: без side работает config.direction (out).
        const defaultSide = await putProperty(ctx, owner, 'см. также', first);
        assert.equal(defaultSide.statusCode, 200, defaultSide.body);
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').map((v) => v.target_id),
          [first],
        );

        // Одна живая сторона: без side направление выводится из неё (out).
        const inferred = await putProperty(ctx, owner, 'см. также', first);
        assert.equal(inferred.statusCode, 200, inferred.body);

        // Создание ОТСУТСТВУЮЩЕЙ стороны — side=target, без сверки.
        const targetSide = await putProperty(ctx, owner, 'см. также', second, 'target');
        assert.equal(targetSide.statusCode, 200, targetSide.body);
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'in').map((v) => v.target_id),
          [second],
        );

        // Обе стороны живы — без side имя неоднозначно, 422.
        const ambiguous = await putProperty(ctx, owner, 'см. также', first);
        assert.equal(ambiguous.statusCode, 422, ambiguous.body);
        assert.equal(
          (ambiguous.json() as { error: { code: string; details?: { field?: string } } }).error.details
            ?.field,
          'side',
        );

        // Удаление по каждой стороне отдельно: снимается только она.
        const deleteTarget = await deleteProperty(ctx, owner, 'см. также', 'target');
        assert.equal(deleteTarget.statusCode, 204);
        assert.equal(getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'in').length, 0);
        assert.equal(getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').length, 1);

        // Сверка при удалении: указанная сторона пуста, а рёбра есть на
        // противоположной — 422 (а не молчаливый no-op).
        const mismatch = await deleteProperty(ctx, owner, 'см. также', 'target');
        assert.equal(mismatch.statusCode, 422, mismatch.body);

        const deleteSource = await deleteProperty(ctx, owner, 'см. также', 'source');
        assert.equal(deleteSource.statusCode, 204);
        assert.equal(getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').length, 0);

        // Несимметричное имя + side другой стороны — противоречие адресов, 422.
        createNetworkProperty(
          ctx.ndb,
          {
            name: 'ссылается на',
            value_type: 'link',
            name_forward: 'ссылается на',
            name_reverse: 'сослано из',
          },
          USER,
        );
        const contradiction = await putProperty(ctx, owner, 'ссылается на', first, 'target');
        assert.equal(contradiction.statusCode, 422, contradiction.body);

        // Типовая привязка со стороной target: живая сторона одна (по
        // привязке), обеих сторон нет — без side пишется сторона привязки (in).
        const symType = createThoughtType(ctx.ndb, { name: 'Тема-тип' }, USER);
        const boundProp = createNetworkProperty(
          ctx.ndb,
          {
            name: 'связано с',
            value_type: 'link',
            name_forward: 'связано с',
            name_reverse: 'связано с',
          },
          USER,
        );
        createTypeProperty(
          ctx.ndb,
          'thought_type',
          symType.id,
          { key: 'связано с', value_type: 'link', side: 'target' },
          USER,
        );
        const typedOwner = await createThought(ctx, 'Типизированная тема', symType.id);
        const typedPeer = await createThought(ctx, 'Тема-сосед');
        const byBinding = await putProperty(ctx, typedOwner, 'связано с', typedPeer);
        assert.equal(byBinding.statusCode, 200, byBinding.body);
        const boundLinkTypeId = boundProp.config?.link_type_id as string;
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', typedOwner, boundLinkTypeId, 'in').map(
            (v) => v.target_id,
          ),
          [typedPeer],
          'без side создаётся сторона привязки',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('симметричное имя с двумя записями набора типа и без живых рёбер: PUT без side проходит', async () => {
      const ctx = await buildRestContext();
      try {
        // Симметричный тип связи: привязка source у родительского типа и
        // материализованное target-зеркало у дочернего дают ДВЕ записи
        // эффективного набора с одним ключом ещё до появления рёбер.
        const parent = createThoughtType(ctx.ndb, { name: 'Тема-родитель' }, USER);
        const child = createThoughtType(
          ctx.ndb,
          { name: 'Тема-потомок', parent_id: parent.id },
          USER,
        );
        const linkType = createLinkType(
          ctx.ndb,
          { name_forward: 'связано с', name_reverse: 'связано с' },
          USER,
        );
        createTypeProperty(
          ctx.ndb,
          'thought_type',
          parent.id,
          {
            key: 'связано с',
            value_type: 'link',
            side: 'source',
            config: {
              link_type_id: linkType.id,
              allowed_target_type_ids: [child.id],
            },
          },
          USER,
        );

        const effective = listEffectiveTypeProperties(ctx.ndb, 'thought_type', child.id).filter(
          (d) => d.key === 'связано с',
        );
        assert.equal(effective.length, 2, 'две записи эффективного набора (source + target)');

        const owner = await createThought(ctx, 'Потомок-владелец', child.id);
        const peer = await createThought(ctx, 'Сосед', child.id);
        // Живых рёбер нет — side не требуется, сторона выводится (config → out).
        const put = await putProperty(ctx, owner, 'связано с', peer);
        assert.equal(put.statusCode, 200, put.body);
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkType.id, 'out').map(
            (v) => v.target_id,
          ),
          [peer],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('read-time зеркало (allowed_target_type_ids включает сам тип) не требует side без живых рёбер', async () => {
      const ctx = await buildRestContext();
      try {
        // Явная привязка source + СИНТЕТИЧЕСКОЕ read-time зеркало (target,
        // config.direction: 'in') — две записи одного свойства с одним ключом.
        // Без живых рёбер 422 быть не должно: направление задаёт ЯВНАЯ запись.
        const typeId = createThoughtType(ctx.ndb, { name: 'Тип-самозеркало' }, USER).id;
        const linkType = createLinkType(
          ctx.ndb,
          { name_forward: 'связано с', name_reverse: 'связано с' },
          USER,
        );
        createTypeProperty(
          ctx.ndb,
          'thought_type',
          typeId,
          {
            key: 'связано с',
            value_type: 'link',
            side: 'source',
            config: {
              link_type_id: linkType.id,
              allowed_target_type_ids: [typeId],
            },
          },
          USER,
        );

        const effective = listEffectiveTypeProperties(ctx.ndb, 'thought_type', typeId).filter(
          (d) => d.key === 'связано с',
        );
        assert.equal(effective.length, 2, 'явная привязка + read-time зеркало');
        assert.equal(effective.filter((d) => d.mirrored === true).length, 1, 'зеркало синтетическое');

        const owner = await createThought(ctx, 'Владелец-зеркало', typeId);
        const peer = await createThought(ctx, 'Сосед-зеркало', typeId);
        const put = await putProperty(ctx, owner, 'связано с', peer);
        assert.equal(put.statusCode, 200, put.body);
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkType.id, 'out').map(
            (v) => v.target_id,
          ),
          [peer],
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('коллизия имён разных свойств: без side 422, с side выбирается свойство', async () => {
      const ctx = await buildRestContext();
      try {
        const typeId = createThoughtType(ctx.ndb, { name: 'Тип-коллизия' }, USER).id;
        // Два разных свойства с разными реестровыми именами. После переименования
        // типов связи их DISPLAY-имена сходятся в 'rel': LT1 — прямое имя
        // (source-привязка), LT2 — обратное (target-привязка).
        const rp1 = createNetworkProperty(
          ctx.ndb,
          {
            name: 'rel-prop-1',
            value_type: 'link',
            name_forward: 'rel-one-fwd',
            name_reverse: 'rel-one-rev',
          },
          USER,
        );
        const rp2 = createNetworkProperty(
          ctx.ndb,
          {
            name: 'rel-prop-2',
            value_type: 'link',
            name_forward: 'rel-two-fwd',
            name_reverse: 'rel-two-rev',
          },
          USER,
        );
        const lt1Id = rp1.config?.link_type_id as string;
        const lt2Id = rp2.config?.link_type_id as string;
        const p1 = createTypeProperty(
          ctx.ndb,
          'thought_type',
          typeId,
          { key: 'rel-one-fwd', value_type: 'link', side: 'source' },
          USER,
        );
        const p2 = createTypeProperty(
          ctx.ndb,
          'thought_type',
          typeId,
          { key: 'rel-two-fwd', value_type: 'link', side: 'target' },
          USER,
        );
        updateLinkType(ctx.ndb, lt1Id, { name_forward: 'rel' }, undefined, USER);
        updateLinkType(ctx.ndb, lt2Id, { name_reverse: 'rel' }, undefined, USER);

        const effective = listEffectiveTypeProperties(ctx.ndb, 'thought_type', typeId).filter(
          (d) => d.key === 'rel',
        );
        assert.equal(effective.length, 2, 'две записи разных свойств с одним ключом');

        const owner = await createThought(ctx, 'Владелец-коллизия', typeId);
        const peer = await createThought(ctx, 'Сосед-коллизия', typeId);

        // Без side — честный 422: авто-вывод запрещён для разных свойств.
        const ambiguous = await putProperty(ctx, owner, 'rel', peer);
        assert.equal(ambiguous.statusCode, 422, ambiguous.body);
        assert.equal(
          (ambiguous.json() as { error: { code: string; details?: { field?: string } } }).error
            .details?.field,
          'side',
        );

        // side=target выбирает P2 (target-привязка).
        const bySide = await putProperty(ctx, owner, 'rel', peer, 'target');
        assert.equal(bySide.statusCode, 200, bySide.body);
        assert.deepEqual(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, lt2Id, 'in').map((v) => v.target_id),
          [peer],
        );
        assert.equal(getLinkPropertyValues(ctx.ndb, 'thought', owner, lt1Id, 'out').length, 0);
        assert.notEqual(p1.property_id, p2.property_id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('set-запись работает по живым рёбрам: цель в корзине не восстанавливается и не удаляется', async () => {
      const ctx = await buildRestContext();
      try {
        const prop = createNetworkProperty(
          ctx.ndb,
          {
            name: 'зависит от',
            value_type: 'link',
            name_forward: 'зависит от',
            name_reverse: 'используется в',
          },
          USER,
        );
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        const owner = await createThought(ctx, 'Задача-set');
        const b = await createThought(ctx, 'Компонент B');
        const c = await createThought(ctx, 'Компонент C');

        assert.equal((await putProperty(ctx, owner, 'зависит от', [b, c])).statusCode, 200);
        // Корзина создаётся явной командой корзины: умное удаление цели в
        // основе физическое (0.14.1, ADR a967d865).
        const cLink = getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').find(
          (value) => value.target_id === c,
        );
        assert.ok(cLink !== undefined);
        const trashed = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${cLink.link_id}`,
          headers: authHeaders(ctx),
          payload: { marked_for_deletion: true },
        });
        assert.equal(trashed.statusCode, 200, trashed.body);
        // Возврат c набором: корзинная цель не восстанавливается и не удаляется.
        const again = await putProperty(ctx, owner, 'зависит от', [b, c]);
        assert.equal(again.statusCode, 200);
        assert.equal(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out').length,
          1,
          'живой набор — только b',
        );
        assert.equal(
          getLinkPropertyValues(ctx.ndb, 'thought', owner, linkTypeId, 'out')[0]?.target_id,
          b,
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

describe(
  '0.14.1 — свобода записи значений свойств и side (MCP)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('etn.thoughts.write: внетиповой скаляр у мысли с типом и без; правка; null очищает; 422 неизвестного', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const prop = createNetworkProperty(
          ndb,
          { name: 'читальный зал', value_type: 'text' },
          ctx.adminId,
        );
        const typeId = createThoughtType(ndb, { name: 'Конспект-freedom' }, ctx.adminId).id;

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const typed = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Конспект с типом',
            type_id: typeId,
          });
          const untyped = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Конспект без типа',
          });

          for (const thoughtId of [typed.id, untyped.id]) {
            const created = await handle.client.callTool({
              name: 'etn.thoughts.write',
              arguments: {
                network_id: ctx.networkId,
                thoughts: [{ thought_id: thoughtId, properties: { 'читальный зал': '№3' } }],
              },
            });
            assert.notEqual(created.isError, true, toolText(created));

            const readCard = async (): Promise<
              Array<{ property_id: string; value: unknown; outside_type?: boolean }>
            > => {
              const res = await handle.client.callTool({
                name: 'etn.thoughts.get',
                arguments: { network_id: ctx.networkId, thought_id: thoughtId },
              });
              return toolJson<{
                properties: Array<{ property_id: string; value: unknown; outside_type?: boolean }>;
              }>(res).properties;
            };

            const row = (await readCard()).find((p) => p.property_id === prop.id);
            assert.ok(row !== undefined, 'значение вне типа видно в карточке');
            assert.equal(row.value, '№3');
            assert.equal(row.outside_type, true);

            // Правка.
            const edited = await handle.client.callTool({
              name: 'etn.thoughts.write',
              arguments: {
                network_id: ctx.networkId,
                thoughts: [{ thought_id: thoughtId, properties: { 'читальный зал': '№7' } }],
              },
            });
            assert.notEqual(edited.isError, true, toolText(edited));
            assert.equal((await readCard()).find((p) => p.property_id === prop.id)?.value, '№7');

            // Удаление значения — null.
            const cleared = await handle.client.callTool({
              name: 'etn.thoughts.write',
              arguments: {
                network_id: ctx.networkId,
                thoughts: [{ thought_id: thoughtId, properties: { 'читальный зал': null } }],
              },
            });
            assert.notEqual(cleared.isError, true, toolText(cleared));
            // Запись `null` очищает значение (строка остаётся с value: null —
            // так же, как у любого скаляра после очистки).
            assert.equal(
              (await readCard()).find((p) => p.property_id === prop.id)?.value,
              null,
              'значение очищено',
            );
          }

          // Несуществующее имя — 422, неявного создания нет.
          const missing = await handle.client.callTool({
            name: 'etn.thoughts.write',
            arguments: {
              network_id: ctx.networkId,
              thoughts: [{ thought_id: typed.id, properties: { 'нет такого свойства': 'x' } }],
            },
          });
          assert.equal(missing.isError, true);
          assert.match(toolText(missing), /VALIDATION_ERROR/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('etn.properties.add: внетиповое свойство-связь создаёт ребро; side адресует сторону', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const asym = createNetworkProperty(
          ndb,
          {
            name: 'читал в',
            value_type: 'link',
            name_forward: 'читал в',
            name_reverse: 'читальный зал',
          },
          ctx.adminId,
        );
        const sym = createNetworkProperty(
          ndb,
          {
            name: 'см. также',
            value_type: 'link',
            name_forward: 'см. также',
            name_reverse: 'см. также',
          },
          ctx.adminId,
        );

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const owner = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Агентский конспект',
          });
          const hall = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Зал агента',
          });
          const sibling = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Смежная тема агента',
          });

          const add = async (key: string, value: string, side?: 'source' | 'target') =>
            handle.client.callTool({
              name: 'etn.properties.add',
              arguments: {
                network_id: ctx.networkId,
                owner_type: 'thought',
                owner_id: owner.id,
                key,
                value,
                ...(side === undefined ? {} : { side }),
              },
            });

          // Внетиповое свойство-связь — ребро создаётся, как у типового.
          const first = await add('читал в', hall.id);
          assert.notEqual(first.isError, true, toolText(first));
          assert.equal(toolJson<{ created: boolean }>(first).created, true);
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, asym.config?.link_type_id as string, 'out').map(
              (v) => v.target_id,
            ),
            [hall.id],
          );
          // Идемпотентность add.
          const second = await add('читал в', hall.id);
          assert.equal(toolJson<{ created: boolean }>(second).created, false);

          // Симметричное имя: side адресует сторону.
          const sourceSide = await add('см. также', sibling.id, 'source');
          assert.notEqual(sourceSide.isError, true, toolText(sourceSide));
          const targetSide = await add('см. также', sibling.id, 'target');
          assert.notEqual(targetSide.isError, true, toolText(targetSide));

          const symTypeId = sym.config?.link_type_id as string;
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, symTypeId, 'out').map((v) => v.target_id),
            [sibling.id],
          );
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, symTypeId, 'in').map((v) => v.target_id),
            [sibling.id],
          );

          // Обе стороны живы — без side 422.
          const ambiguous = await add('см. также', hall.id);
          assert.equal(ambiguous.isError, true, 'нужен side');
          assert.match(toolText(ambiguous), /side/);
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('etn.properties.remove: удаление цели симметричного свойства без side по живому ребру', async () => {
      const ctx = await buildMcpContext();
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const sym = createNetworkProperty(
          ndb,
          {
            name: 'см. также',
            value_type: 'link',
            name_forward: 'см. также',
            name_reverse: 'см. также',
          },
          ctx.adminId,
        );
        const linkTypeId = sym.config?.link_type_id as string;

        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const owner = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Владелец remove',
          });
          const outTarget = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Цель out',
          });
          const inTarget = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Цель in',
          });

          const add = async (value: string, side: 'source' | 'target') =>
            handle.client.callTool({
              name: 'etn.properties.add',
              arguments: {
                network_id: ctx.networkId,
                owner_type: 'thought',
                owner_id: owner.id,
                key: 'см. также',
                value,
                side,
              },
            });
          // Обе стороны живут, но к РАЗНЫМ целям: name адресует обе стороны.
          assert.notEqual((await add(outTarget.id, 'source')).isError, true);
          assert.notEqual((await add(inTarget.id, 'target')).isError, true);

          // Удаление цели без side: направление задаёт живое ребро к цели.
          const removed = await callOp(handle.client, 'properties.remove', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: owner.id,
            key: 'см. также',
            value: outTarget.id,
          });
          assert.notEqual(removed.isError, true, toolText(removed));
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'out'),
            [],
            'исходящее ребро к цели снято',
          );
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'in').map(
              (v) => v.target_id,
            ),
            [inTarget.id],
            'входящее ребро другой стороны не тронуто',
          );

          // Одна и та же цель соединена рёбрами ОБЕИХ сторон: без side — 422,
          // с side удаляется выбранная сторона.
          const both = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: 'Цель обеих сторон',
          });
          assert.notEqual((await add(both.id, 'source')).isError, true);
          assert.notEqual((await add(both.id, 'target')).isError, true);

          const ambiguous = await callOp(handle.client, 'properties.remove', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: owner.id,
            key: 'см. также',
            value: both.id,
          });
          assert.equal(ambiguous.isError, true, 'обе стороны к одной цели — нужен side');
          assert.match(toolText(ambiguous), /side/);

          const withSide = await callOp(handle.client, 'properties.remove', {
            network_id: ctx.networkId,
            owner_type: 'thought',
            owner_id: owner.id,
            key: 'см. также',
            value: both.id,
            side: 'target',
          });
          assert.notEqual(withSide.isError, true, toolText(withSide));
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'in').map(
              (v) => v.target_id,
            ),
            [inTarget.id],
            'входящее ребро к выбранной цели снято',
          );
          assert.deepEqual(
            getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'out').map(
              (v) => v.target_id,
            ),
            [both.id],
            'исходящее ребро к той же цели осталось',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
