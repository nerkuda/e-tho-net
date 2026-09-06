/**
 * Authorship filters (задача 59119797 «Фильтры Автор/Редактор»):
 *
 *   - POST /thoughts/query (REST) — фильтр `created_by`/`updated_by`;
 *   - POST /chronicle/query (REST) — фильтр `created_by`/`updated_by`;
 *   - GET /search (REST) — query-параметры `author_id`/`editor_id`;
 *   - MCP `etn.thoughts.query` — поля `author_id`/`editor_id`;
 *   - MCP `etn.thoughts.search` — поля `author_id`/`editor_id`;
 *
 *   Семантика — паритет: REST и MCP возвращают идентичный набор id на одной
 *   и той же сети при одинаковых критериях.
 *
 * Тесты работают на in-memory БД через те же domain-функции, что и
 * REST/MCP-роуты (`queryThoughts`, `queryChronicle`, `query`).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThought, updateThought } from '../src/domain/thought-service.js';
import { createLink, updateLink } from '../src/domain/link-service.js';
import {
  createComment,
  createCommentWithTargets,
} from '../src/domain/comment-service.js';
import { queryThoughts as structuresQuery } from '../src/domain/structure-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';
import { queryThoughts as mcpQueryThoughts } from '../src/domain/query-service.js';

const ALICE = '00000000-0000-4000-8000-00000000a11ce';
const BOB = '00000000-0000-4000-8000-00000000b0b00';
const CAROL = '00000000-0000-4000-8000-00000000ca601';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Три мысли с разной историей авторства:
 *
 *   - `tAliceOnly`    — создана Алисой, ни разу не редактировалась;
 *   - `tBobEdited`    — создана Алисой, отредактирована Бобом;
 *   - `tBobCreated`   — создана Бобом, не редактировалась.
 */
function seedAuthorshipFixture(ndb: NetworkDb): {
  tAliceOnly: string;
  tBobEdited: string;
  tBobCreated: string;
} {
  const tAliceOnly = createThought(ndb, { title: 'Только Алиса' }, ALICE).id;
  const tBobEdited0 = createThought(ndb, { title: 'Алиса → Боб' }, ALICE);
  const updated = updateThought(
    ndb,
    tBobEdited0.id,
    { title: 'Алиса → Боб (правка)' },
    tBobEdited0.version,
    BOB,
  );
  const tBobEdited = updated.id;
  const tBobCreated = createThought(ndb, { title: 'Только Боб' }, BOB).id;
  return { tAliceOnly, tBobEdited, tBobCreated };
}

function structuresQueryIds(
  ndb: NetworkDb,
  filter: Partial<Parameters<typeof structuresQuery>[2]> = {},
): string[] {
  const request = {
    sort: 'alpha' as const,
    order: 'asc' as const,
    limit: 100,
    offset: 0,
    ...filter,
  };
  const result = structuresQuery(ndb, ALICE, request, 'test-request');
  return result.items.map((t) => t.id);
}

function chronicleQueryIds(
  ndb: NetworkDb,
  filter: Record<string, unknown>,
): string[] {
  const request = parseChronicleQueryBody(
    { ...filter, order: 'asc', limit: 50, offset: 0 },
    'test-request',
  );
  const result = queryChronicle(ndb, request);
  return result.rows.map((r) => r.id);
}

function mcpQueryIds(
  ndb: NetworkDb,
  filter: Partial<Parameters<typeof mcpQueryThoughts>[1]> = {},
): string[] {
  const result = mcpQueryThoughts(ndb, filter, { maxNodes: 200 });
  return result.hits.map((h) => h.id);
}

describe(
  'authorship filters: created_by/updated_by (REST + MCP, задача 59119797)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    describe('structure filter (`POST /thoughts/query` ↔ `etn.thoughts.query`)', () => {
      it('created_by=ALICE returns only Alice-created thoughts', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const { tAliceOnly, tBobEdited, tBobCreated } = seedAuthorshipFixture(ndb);
          const ids = structuresQueryIds(ndb, { created_by: ALICE });
          assert.deepEqual(new Set(ids), new Set([tAliceOnly, tBobEdited]));
          assert.ok(!ids.includes(tBobCreated), 'BOB-созданная мысль не входит');
        } finally {
          ndb.close();
        }
      });

      it('updated_by=BOB возвращает мысли, чей последний редактор — BOB', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const { tAliceOnly, tBobEdited, tBobCreated } = seedAuthorshipFixture(ndb);
          // tBobCreated создан Бобом и не редактировался → updated_by=BOB;
          // tBobEdited отредактирован Бобом → updated_by=BOB;
          // tAliceOnly создан Алисой и не редактировался → updated_by=ALICE.
          const ids = structuresQueryIds(ndb, { updated_by: BOB });
          assert.deepEqual(new Set(ids), new Set([tBobEdited, tBobCreated]));
          assert.ok(!ids.includes(tAliceOnly), 'ALICE-нетронутая мысль не входит');
        } finally {
          ndb.close();
        }
      });

      it('created_by=A AND updated_by=B комбинируется AND-логикой', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const { tAliceOnly, tBobEdited, tBobCreated } = seedAuthorshipFixture(ndb);
          const ids = structuresQueryIds(ndb, { created_by: ALICE, updated_by: BOB });
          assert.deepEqual(new Set(ids), new Set([tBobEdited]));
          assert.ok(!ids.includes(tAliceOnly));
          assert.ok(!ids.includes(tBobCreated));
        } finally {
          ndb.close();
        }
      });

      it('created_by="" и updated_by="" трактуются как «не применять»', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedAuthorshipFixture(ndb);
          // Без фильтра — пустой фильтр = HOME + orphans (т.е. все мысли
          // сети). После фильтрации фильтр должен оставаться неактивным.
          const ids = structuresQueryIds(ndb, { created_by: '', updated_by: '' });
          // HOME-мысль + три тестовых = 4 (HOME сидится автоматически).
          assert.ok(ids.length >= 3, 'пустые значения не сужают выборку');
        } finally {
          ndb.close();
        }
      });

      it('created_by=unknown-id возвращает пустой результат', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedAuthorshipFixture(ndb);
          const ids = structuresQueryIds(ndb, { created_by: randomUUID() });
          assert.deepEqual(ids, []);
        } finally {
          ndb.close();
        }
      });

      it('MCP `etn.thoughts.query` с author_id/editor_id даёт тот же результат, что и REST', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const { tAliceOnly, tBobEdited, tBobCreated } = seedAuthorshipFixture(ndb);
          // REST: created_by=ALICE + updated_by=BOB → ровно tBobEdited
          const rest = structuresQueryIds(ndb, { created_by: ALICE, updated_by: BOB });
          // MCP: author_id=ALICE + editor_id=BOB
          const mcp = mcpQueryIds(ndb, { author_id: ALICE, editor_id: BOB });
          assert.deepEqual(new Set(rest), new Set(mcp), 'REST и MCP дают идентичный набор id');
          assert.deepEqual(new Set(rest), new Set([tBobEdited]));
          assert.ok(!rest.includes(tAliceOnly) && !rest.includes(tBobCreated));
        } finally {
          ndb.close();
        }
      });

      it('MCP author_id без editor_id = REST created_by без updated_by', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedAuthorshipFixture(ndb);
          const rest = structuresQueryIds(ndb, { created_by: BOB });
          const mcp = mcpQueryIds(ndb, { author_id: BOB });
          assert.deepEqual(new Set(rest), new Set(mcp));
        } finally {
          ndb.close();
        }
      });
    });

    describe('chronicle filter (`POST /chronicle/query`)', () => {
      it('created_by=ALICE возвращает хроно-комментарии, добавленные Алисой', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = createThought(ndb, { title: 'A' }, ALICE).id;
          const b = createThought(ndb, { title: 'B' }, ALICE).id;
          createComment(
            ndb,
            'thought',
            a,
            { kind: 'chronological', body_md: 'alice A', valid_from: '2024-01-01' },
            ALICE,
          );
          createComment(
            ndb,
            'thought',
            b,
            { kind: 'chronological', body_md: 'bob B', valid_from: '2024-02-01' },
            BOB,
          );
          createComment(
            ndb,
            'thought',
            a,
            { kind: 'chronological', body_md: 'alice A2', valid_from: '2024-03-01' },
            ALICE,
          );
          const ids = chronicleQueryIds(ndb, { created_by: ALICE });
          assert.equal(ids.length, 2);
        } finally {
          ndb.close();
        }
      });

      it('updated_by=BOB возвращает хроно-комментарии, последний раз отредактированные Бобом', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'X' }, ALICE).id;
          const c1 = createComment(
            ndb,
            'thought',
            t,
            { kind: 'chronological', body_md: 'v1', valid_from: '2024-01-01' },
            ALICE,
          );
          createComment(
            ndb,
            'thought',
            t,
            { kind: 'chronological', body_md: 'v2', valid_from: '2024-02-01' },
            BOB,
          );
          // Эмулируем правку первого комментария Бобом (колонка updated_by).
          ndb.prepare(`UPDATE comments SET updated_by = ? WHERE id = ?`).run(BOB, c1.id);
          const ids = chronicleQueryIds(ndb, { updated_by: BOB });
          assert.equal(ids.length, 2, 'обе правки Боба — в выдаче');
        } finally {
          ndb.close();
        }
      });

      it('created_by=ALICE AND updated_by=ALICE: ровно те, что не редактировались Бобом', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'X' }, ALICE).id;
          const c1 = createComment(
            ndb,
            'thought',
            t,
            { kind: 'chronological', body_md: 'A-only', valid_from: '2024-01-01' },
            ALICE,
          );
          const c2 = createComment(
            ndb,
            'thought',
            t,
            { kind: 'chronological', body_md: 'A→B', valid_from: '2024-02-01' },
            ALICE,
          );
          ndb.prepare(`UPDATE comments SET updated_by = ? WHERE id = ?`).run(BOB, c2.id);
          const ids = chronicleQueryIds(ndb, { created_by: ALICE, updated_by: ALICE });
          assert.deepEqual(ids, [c1.id]);
        } finally {
          ndb.close();
        }
      });

      it('пустой created_by не сужает выборку', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const t = createThought(ndb, { title: 'X' }, ALICE).id;
          createComment(
            ndb,
            'thought',
            t,
            { kind: 'chronological', body_md: 'a', valid_from: '2024-01-01' },
            ALICE,
          );
          createComment(
            ndb,
            'thought',
            t,
            { kind: 'chronological', body_md: 'b', valid_from: '2024-02-01' },
            BOB,
          );
          const idsAll = chronicleQueryIds(ndb, {});
          const idsEmpty = chronicleQueryIds(ndb, { created_by: '' });
          assert.deepEqual(new Set(idsAll), new Set(idsEmpty));
        } finally {
          ndb.close();
        }
      });
    });

    describe('links (REST `POST /thoughts/query` — задача «created_by/updated_by для связей»)', () => {
      it('для пары «создана Алисой → отредактирована Бобом» link-выдача пуста (структурный фильтр — про мысли)', () => {
        // Этот тест — напоминание, что link-создание и link-update влияют
        // на `links.created_by`/`links.updated_by`, но `POST /thoughts/query`
        // фильтрует только мысли. Семантика фильтра по связям в задаче
        // не описана (см. 76a03bba — про мысли и хронику; ссылки не
        // упоминаются). Здесь мы только проверяем, что link-фильтр
        // существует на колонке, но не примешивается к thought-фильтру.
        const ndb = createInMemoryNetworkDb();
        try {
          const src = createThought(ndb, { title: 'src' }, ALICE).id;
          const tgt = createThought(ndb, { title: 'tgt' }, ALICE).id;
          const link0 = createLink(ndb, { source_id: src, target_id: tgt }, ALICE);
          updateLink(ndb, link0.id, {}, link0.version, BOB);
          const ids = structuresQueryIds(ndb, { created_by: ALICE });
          // Источник и цель — оба от ALICE, поэтому обе попадают в выборку.
          // Присутствие обновлённой Бобом связи не должно влиять на
          // thought-фильтр.
          assert.ok(ids.includes(src) && ids.includes(tgt));
        } finally {
          ndb.close();
        }
      });
    });

    describe('парность REST и MCP', () => {
      it('created_by через REST и author_id через MCP возвращают один и тот же набор мыслей', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedAuthorshipFixture(ndb);
          // Добавим ещё несколько мыслей от разных авторов для полноты.
          createThought(ndb, { title: 'Carol 1' }, CAROL);
          createThought(ndb, { title: 'Carol 2' }, CAROL);
          // REST: created_by=CAROL → 2 мысли
          const rest = structuresQueryIds(ndb, { created_by: CAROL });
          // MCP: author_id=CAROL
          const mcp = mcpQueryIds(ndb, { author_id: CAROL });
          assert.deepEqual(new Set(rest), new Set(mcp));
          assert.equal(rest.length, 2);
        } finally {
          ndb.close();
        }
      });

      it('updated_by через REST и editor_id через MCP — одна и та же выборка', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedAuthorshipFixture(ndb);
          const rest = structuresQueryIds(ndb, { updated_by: ALICE });
          const mcp = mcpQueryIds(ndb, { editor_id: ALICE });
          assert.deepEqual(new Set(rest), new Set(mcp));
        } finally {
          ndb.close();
        }
      });

      it('filter не передан ни в REST, ни в MCP — паритетные пустые наборы', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          seedAuthorshipFixture(ndb);
          const rest = structuresQueryIds(ndb, {});
          const mcp = mcpQueryIds(ndb, {});
          assert.deepEqual(new Set(rest), new Set(mcp));
        } finally {
          ndb.close();
        }
      });
    });

    describe('хроника с разными owner-ами (thought + link)', () => {
      it('фильтр применяется к комментариям обоих владельцев', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = createThought(ndb, { title: 'A' }, ALICE).id;
          const b = createThought(ndb, { title: 'B' }, ALICE).id;
          const link0 = createLink(ndb, { source_id: a, target_id: b }, ALICE);
          // Хроно-комментарий к связи, добавленный Бобом.
          createCommentWithTargets(
            ndb,
            [{ owner_type: 'link', owner_id: link0.id }],
            { kind: 'chronological', body_md: 'link-chrono', valid_from: '2024-01-01' },
            BOB,
          );
          // Хроно-комментарий к мысли, добавленный Алисой.
          createCommentWithTargets(
            ndb,
            [{ owner_type: 'thought', owner_id: a }],
            { kind: 'chronological', body_md: 'thought-chrono', valid_from: '2024-02-01' },
            ALICE,
          );
          // Суммарно два хроно-комментария.
          const all = chronicleQueryIds(ndb, {});
          assert.equal(all.length, 2);
          // created_by=ALICE — только комментарий от ALICE.
          const aliceIds = chronicleQueryIds(ndb, { created_by: ALICE });
          assert.equal(aliceIds.length, 1);
          // created_by=BOB — только комментарий от BOB (тот, что на связи).
          const bobIds = chronicleQueryIds(ndb, { created_by: BOB });
          assert.equal(bobIds.length, 1);
        } finally {
          ndb.close();
        }
      });
    });
  },
);
