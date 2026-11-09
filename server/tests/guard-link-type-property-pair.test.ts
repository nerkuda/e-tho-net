/**
 * Сторож инварианта «один живой тип связи = ровно одно живое парное
 * свойство-связь» (0.15.4, ошибка 117a999a; требование 09f692ff «Свойство-связь
 * и тип связи — единый жизненный цикл»).
 *
 * Зачем. GUI редактирует тип связи ТОЛЬКО через парное свойство реестра
 * (`value_type = 'link'`, `config.link_type_id`). Пока `etn.ontology.write`
 * создавал строку `link_types` без свойства, тип был виден в дереве «Типы
 * связей», но «Правка» не активировалась — ошибка 117a999a. Автосоздание пары
 * живёт в путях, которые создают тип САМИ (`link_types[]`, `.etnx`-импорт), а
 * не в общем `createLinkType`: обратный путь `properties[]` создаёт тип ИЗ
 * свойства, и пара там — само свойство.
 *
 * Что проверяется:
 *   1. Рантайм: после произвольной серии `etn.ontology.write` каждый живой
 *      нерутовой тип связи имеет ровно одно живое (не структурное)
 *      свойство-связь, и ни одно парное свойство не висит на пропавшем типе.
 *   2. Статика: `createLinkType(` вызывается только из известных мест —
 *      определение (`link-type-service.ts`), `link_types[]`
 *      (`ontology-write-service.ts`, пара обеспечивается тут же) и
 *      `properties[]` (`property-service.ts`, свойство само и есть пара).
 *      Новая точка создания обязана идти через
 *      `ensureLinkPropertyForLinkType` либо получить обоснование исключения
 *      здесь.
 *   3. Статика: обе точки автосоздания пары (`link_types[]` и импорт архива)
 *      действительно зовут `ensureLinkPropertyForLinkType` — иначе одна из
 *      них тихо перестанет чинить «голые» типы.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openNetworkDb } from '../src/db/network-db.js';
import { collectViolations, formatViolations } from './guard-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
} from './mcp-helpers.js';

/** Корень исходников сервера (`server/src`). */
const SERVER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Файлы, которым разрешено звать `createLinkType(` (см. шапку). */
const CREATE_LINK_TYPE_ALLOWED = new Set([
  'domain/link-type-service.ts',
  'domain/ontology-write-service.ts',
  'domain/property-service.ts',
]);

/** Пути автосоздания пары, обязанные звать `ensureLinkPropertyForLinkType`. */
const PAIR_ENSURERS = ['domain/ontology-write-service.ts', 'domain/import-service.ts'];

/** Минимальная форма ответа `etn.ontology.write`, нужная сторожу. */
interface OntologyWriteResult {
  link_types: Array<{ id: string; action: string; property_id: string | null }>;
}

describe('guard-link-type-property-pair (0.15.4, ошибка 117a999a)', () => {
  it('createLinkType вызывается только из известных мест', () => {
    const violations = collectViolations(SERVER_SRC, [
      {
        name: 'create-link-type-pair',
        description:
          'новая точка создания типа связи: обеспечьте парное свойство ' +
          '(ensureLinkPropertyForLinkType) или обоснуйте исключение здесь',
        pattern: /\bcreateLinkType\(/,
        allow: (rel) => CREATE_LINK_TYPE_ALLOWED.has(rel),
      },
    ]);
    assert.deepEqual(violations, [], formatViolations(violations));
  });

  it('обе точки автосоздания пары зовут ensureLinkPropertyForLinkType', () => {
    for (const rel of PAIR_ENSURERS) {
      const source = fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');
      assert.ok(
        source.includes('ensureLinkPropertyForLinkType('),
        `${rel} обязан вызывать ensureLinkPropertyForLinkType — иначе его типы снова станут «голыми»`,
      );
    }
  });

  it(
    'после ontology.write у каждого живого нерутового типа ровно одна пара',
    { skip: !nativeAvailable() },
    async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          // Произвольная серия: создание через `link_types[]`, пара из
          // `properties[]` (создаёт тип из свойства), затем переименование.
          const created = toolJson<OntologyWriteResult>(
            await handle.client.callTool({
              name: 'etn.ontology.write',
              arguments: {
                network_id: ctx.networkId,
                link_types: [
                  { ref: 'a', name_forward: 'сторож-а', name_reverse: 'сторож-а-обр' },
                  { ref: 'b', name_forward: 'сторож-б', name_reverse: 'сторож-б-обр' },
                ],
                properties: [
                  {
                    ref: 'p',
                    name: 'Сторож-свойство',
                    value_type: 'link',
                    name_forward: 'сторож-из-свойства',
                    name_reverse: 'сторож-из-свойства-обр',
                  },
                ],
              },
            }),
          );
          for (const type of created.link_types) {
            assert.ok(type.property_id !== null, `тип ${type.id} создан без пары`);
          }
          await handle.client.callTool({
            name: 'etn.ontology.write',
            arguments: {
              network_id: ctx.networkId,
              link_types: [{ id: created.link_types[0]!.id, name_forward: 'сторож-а-новый' }],
            },
          });

          const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
          const types = ndb
            .prepare(
              `SELECT lt.id, lt.name_forward,
                      (SELECT COUNT(*) FROM properties_v p
                        WHERE p.value_type = 'link'
                          AND (json_extract(p.config, '$.structural') IS NULL
                               OR json_extract(p.config, '$.structural') = 0)
                          AND json_extract(p.config, '$.link_type_id') = lt.id) AS pairs
                 FROM link_types_v lt
                WHERE lt.is_root = 0
                ORDER BY lt.name_forward`,
            )
            .all() as Array<{ id: string; name_forward: string; pairs: number }>;
          assert.ok(types.length >= 3, `ожидались созданные типы, получено ${types.length}`);
          for (const type of types) {
            assert.equal(
              type.pairs,
              1,
              `у типа «${type.name_forward}» (${type.id}) пар: ${type.pairs}, нужна ровно одна`,
            );
          }

          const orphans = ndb
            .prepare(
              `SELECT p.id, json_extract(p.config, '$.link_type_id') AS link_type_id
                 FROM properties_v p
                WHERE p.value_type = 'link'
                  AND (json_extract(p.config, '$.structural') IS NULL
                       OR json_extract(p.config, '$.structural') = 0)
                  AND json_extract(p.config, '$.link_type_id') IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM link_types_v lt
                     WHERE lt.id = json_extract(p.config, '$.link_type_id')
                  )`,
            )
            .all() as Array<{ id: string; link_type_id: string }>;
          assert.deepEqual(orphans, [], 'парное свойство не должно висеть на пропавшем типе');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    },
  );
});
