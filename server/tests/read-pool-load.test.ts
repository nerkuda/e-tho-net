/**
 * Нагрузочная приёмка точечных тяжёлых чтений в reader-пуле (задача 514dc30f,
 * ошибка 49e05ea0, ADR bec191e6).
 *
 * Эталон — `write-pool-load.test.ts`: критерий тот же (лаг главного потока на
 * синхронном пути блокируется, через пул — нет), но нагрузка — чтение:
 * «волна» из 10 батчей `etn.thoughts.resolve` по 100 карточек. Каждая карточка
 * тянет синонимы, свойства/мета и постоянный комментарий, а мета считает
 * счётчики связей — на большой сети это ровно тот путь, что на проде занимал
 * до 295 мс и удлинял очереди GUI-клиенту.
 *
 * Синхронный ориентир исполняет 10 батчей подряд в одном тике — главный поток
 * занят суммарно; пул те же 10 батчей считает в воркерах, а главный поток
 * отвечает на пинги. Порог относительный (`pingP99Ceiling`), как в эталоне.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, THOUGHT_RESOLVE_MAX_IDS } from '@etn/shared';

import { closeAll, openNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  closeReaderPool,
  configureReaderPool,
  getReaderPool,
} from '../src/db/reader-pool.js';
import { resolveThoughtCardsAsync } from '../src/domain/heavy-read.js';
import { getThoughtsByIdsResolved } from '../src/domain/thought-service.js';
import { PING_P99_CEIL_MS, pingP99Ceiling, startPingLag } from './ping-lag.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'read-load-user';
const TARGETS = THOUGHT_RESOLVE_MAX_IDS;
const FILLERS = 3_000;
const WILDCARDS = 1_500;
/** Сколько батчей в «волне» (клиент шлёт десятки GET/мин). */
const ROUNDS = 10;
/** Связей на целевую мысль — чтобы `meta.link_stats` был непустым. */
const LINKS_PER_TARGET = 60;

/** Заполнить сеть формой большой сети + 100 «тяжёлых» целевых мыслей. */
function fillLargeNetwork(ndb: NetworkDb): string[] {
  const now = '2026-01-01T00:00:00Z';
  const insertThought = ndb.prepare(
    `INSERT INTO thoughts
       (id, layer_id, title, title_norm, type_id, active, is_root, marked_for_deletion,
        version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, NULL, 1, 0, 0, 1, ?, ?, ?, ?, 0, 0)`,
  );
  const insertSynonym = ndb.prepare(
    'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm, layer_id) VALUES (?, ?, ?, ?)',
  );
  const insertLink = ndb.prepare(
    `INSERT INTO links
       (id, layer_id, source_id, target_id, type_id, position, active, marked_for_deletion,
        version, created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, NULL, ?, 1, 0, 1, ?, ?, ?, ?, 0, 0)`,
  );
  const insertComment = ndb.prepare(
    `INSERT INTO comments
       (id, layer_id, deleted, base_version, owner_type, owner_id, kind, title,
        body_md, body_html, valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 0, 0, 'thought', ?, 'permanent', NULL, ?, ?, ?, NULL, 1, ?, ?, ?, ?)`,
  );
  const targets = Array.from({ length: TARGETS }, () => randomUUID());
  const fillers = Array.from({ length: FILLERS }, () => randomUUID());
  ndb.transaction(() => {
    for (const [i, id] of targets.entries()) {
      const title = `Цель ${i}`;
      insertThought.run(id, BASE_LAYER_ID, title, title.toLowerCase(), now, USER, now, USER);
      for (let s = 0; s < 40; s += 1) {
        const synonym = `цель-${i}-терм-${s}`;
        insertSynonym.run(id, synonym, synonym.toLowerCase(), BASE_LAYER_ID);
      }
      insertComment.run(
        `target-comment-${i}`,
        BASE_LAYER_ID,
        id,
        `Постоянный комментарий цели ${i}`,
        `<p>Постоянный комментарий цели ${i}</p>`,
        now,
        now,
        now,
        USER,
        USER,
      );
    }
    for (const [i, id] of fillers.entries()) {
      const title = `Наполнитель ${i}`;
      insertThought.run(id, BASE_LAYER_ID, title, title.toLowerCase(), now, USER, now, USER);
    }
    let seq = 0;
    for (const [i, id] of targets.entries()) {
      for (let l = 0; l < LINKS_PER_TARGET; l += 1) {
        const filler = fillers[(i * LINKS_PER_TARGET + l) % fillers.length]!;
        insertLink.run(randomUUID(), BASE_LAYER_ID, id, filler, seq++, now, now, USER, USER);
      }
    }
    for (let i = 0; i < WILDCARDS; i += 1) {
      const synonym = `терм${i}*`;
      insertSynonym.run(fillers[i % fillers.length]!, synonym, synonym.toLowerCase(), BASE_LAYER_ID);
    }
  });
  return targets;
}

describe(
  'read-пул: нагрузочная приёмка (514dc30f)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let dataDir: string;
    let ndb: NetworkDb;
    let ids: string[] = [];

    before(() => {
      dataDir = mkdtempSync(path.join(tmpdir(), 'etn-read-load-'));
      ndb = openNetworkDb(dataDir, randomUUID());
      ids = fillLargeNetwork(ndb);
    });

    after(async () => {
      await closeReaderPool();
      closeAll();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('волна resolve не блокирует главный поток (p99 пинга не хуже эталона)', async () => {
      // 1. Синхронный ориентир: пула нет, 10 батчей подряд занимают поток.
      assert.equal(getReaderPool(), null, 'перед синхронным замером пула нет');
      const stopSyncPing = startPingLag();
      const syncStarted = Date.now();
      let syncItems = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        syncItems += getThoughtsByIdsResolved(ndb, ids).items.length;
      }
      const syncMs = Date.now() - syncStarted;
      const syncLag = await stopSyncPing();

      // 2. Та же волна через пул. Разогрев — подъём воркеров не входит в замер.
      configureReaderPool({ size: 2, taskTimeoutMs: 60_000 });
      await resolveThoughtCardsAsync(ndb, ids.slice(0, 2));

      const stopPoolPing = startPingLag(() => (getReaderPool()?.pending ?? 0) > 0);
      const poolStarted = Date.now();
      const results = await Promise.all(
        Array.from({ length: ROUNDS }, () => resolveThoughtCardsAsync(ndb, ids)),
      );
      const poolMs = Date.now() - poolStarted;
      const poolLag = await stopPoolPing();

      console.log(
        `[read-pool-load] resolve ${ROUNDS}×${TARGETS}: синхронно=${syncMs} мс ` +
          `(p99 пинга=${syncLag.p99.toFixed(1)} мс, пингов=${syncLag.pings}); ` +
          `через пул=${poolMs} мс (p99 пинга=${poolLag.p99.toFixed(1)} мс, ` +
          `пингов=${poolLag.pings}, при занятом воркере=${poolLag.busy})`,
      );

      assert.equal(syncItems, ROUNDS * TARGETS, 'синхронный путь вернул все карточки');
      for (const result of results) assert.equal(result.items.length, TARGETS);
      // Синхронная волна блокирует поток дольше периода пинга: часть тиков
      // просрочена, а один отчитывается всей длительностью блока. Пяти пингов
      // здесь быть не может — важен сам факт блокировки (p99 ниже).
      assert.ok(syncLag.pings >= 1, `синхронный замер накопил пинги (${syncLag.pings})`);
      assert.ok(
        syncLag.p99 >= PING_P99_CEIL_MS,
        `синхронный путь обязан блокировать главный поток (p99 ${syncLag.p99.toFixed(1)} мс)`,
      );
      assert.ok(poolLag.busy > 0, 'пинги через пул приходятся на занятый воркер');
      const ceiling = pingP99Ceiling(syncLag.p99);
      assert.ok(
        poolLag.p99 <= ceiling,
        `p99 задержки пинга ${poolLag.p99.toFixed(1)} мс > потолка ${ceiling.toFixed(1)} мс ` +
          `(синхронный ориентир ${syncLag.p99.toFixed(1)} мс) — главный поток блокируется`,
      );
    });
  },
);
