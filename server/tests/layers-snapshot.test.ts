/**
 * Снапшот видимости слоя на соединение (задача 1a84d141, этап 3 тех.проекта
 * e29c0f00; ADR 6582c287, требование cd6dcc43).
 *
 * Проверяется контракт снапшота поверх обычной семантики слоёв (регресс-сетка
 * семантики — `layers-s2`/`s3`/`s11`/`s12`/`s14`):
 *
 *   1. запись в текущем слое видна тому же соединению сразу (снапшот
 *      инвалидируется по сигналу соединения) — и через представления, и через
 *      доменный сервис;
 *   2. запись в соседнем слое (не в цепочке предков) не видна;
 *   3. смена слоя (`useLayer`) пересобирает снапшот: разрешение «ближайший
 *      слой» и надгробия работают как раньше;
 *   4. коммит ДРУГОГО соединения (WAL) виден читателю — сигнал
 *      `PRAGMA data_version`, а не только `total_changes()` своего соединения;
 *   5. контракт `rowid`: представление экспонирует физический `rowid`
 *      победителя (на него джойнятся FTS-индексы).
 *
 * Пропускается, если нативный биндинг `better-sqlite3` недоступен.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import {
  closeAll,
  closeNetworkDb,
  createInMemoryNetworkDb,
  openNetworkDb,
  type NetworkDb,
} from '../src/db/network-db.js';
import { layerSnapshotName } from '../src/db/layer-chain.js';
import { createThought, getThought } from '../src/domain/thought-service.js';

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

/** Layer ids used by the snapshot tests (siblings A and B over the base). */
const LAYER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const LAYER_B = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Insert a layer row (child of `parentId`). */
function insertLayer(ndb: NetworkDb, id: string, parentId: string, depth: number): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
    )
    .run(id, parentId, `Слой ${id.slice(0, 4)}`, depth, now, now);
}

/** Insert a raw thought row into `layerId` (a shadow/tombstone). */
function insertThoughtRow(
  ndb: NetworkDb,
  id: string,
  layerId: string,
  title: string,
  deleted = false,
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, active, deleted, version,
         created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, 2, ?, 'u', ?, 'u')`,
    )
    .run(id, layerId, title, title.toLowerCase(), deleted ? 1 : 0, now, now);
}

/** Title of `id` as the connection's layer context resolves it. */
function titleOf(ndb: NetworkDb, id: string): string | null {
  return (
    (ndb.prepare('SELECT title FROM thoughts_v WHERE id = ?').get(id) as { title: string } | undefined)
      ?.title ?? null
  );
}

describe(
  'снапшот слоя — инвалидация по сигналу соединения',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('запись в текущем слое видна тому же соединению сразу (INSERT/UPDATE/надгробие)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        ndb.useLayer(LAYER_A);

        // INSERT новой теневой строки — снапшот, собранный при useLayer, её
        // ещё не знает; сигнал соединения (total_changes) обязан её открыть.
        insertThoughtRow(ndb, 'sh1', LAYER_A, 'из слоя');
        assert.equal(titleOf(ndb, 'sh1'), 'из слоя');

        // UPDATE значений той же физической строки — читается живая таблица.
        ndb.prepare('UPDATE thoughts SET title = ? WHERE id = ? AND layer_id = ?').run(
          'правка',
          'sh1',
          LAYER_A,
        );
        assert.equal(titleOf(ndb, 'sh1'), 'правка');

        // Надгробие прячет строку немедленно.
        ndb.prepare('UPDATE thoughts SET deleted = 1 WHERE id = ? AND layer_id = ?').run('sh1', LAYER_A);
        assert.equal(titleOf(ndb, 'sh1'), null);

        // Доменный сервис видит запись, сделанную сервисом же.
        const created = createThought(ndb, { title: 'сервисная' }, 'u');
        assert.equal(getThought(ndb, created.id)?.title, 'сервисная');
      } finally {
        ndb.close();
      }
    });

    it('запись в соседнем слое не видна; смена слоя пересобирает снапшот', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // A и B — братья (оба дети основы), не предки друг друга.
        insertLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        insertLayer(ndb, LAYER_B, BASE_LAYER_ID, 1);

        // Строка основы и её тень в A.
        insertThoughtRow(ndb, 'twin', BASE_LAYER_ID, 'основа');
        insertThoughtRow(ndb, 'twin', LAYER_A, 'тень A');
        // Строка только в B.
        insertThoughtRow(ndb, 'onlyB', LAYER_B, 'только B');

        ndb.useLayer(LAYER_A);
        assert.equal(titleOf(ndb, 'twin'), 'тень A');
        assert.equal(titleOf(ndb, 'onlyB'), null, 'соседний слой не попадает в цепочку');

        // Надгробие в A поверх живой основы — прячет сущность.
        ndb.prepare('UPDATE thoughts SET deleted = 1 WHERE id = ? AND layer_id = ?').run('twin', LAYER_A);
        assert.equal(titleOf(ndb, 'twin'), null);

        // Основа: тень A вне цепочки, строка основы снова видна (надгробие —
        // приватное расхождение слоя, §4.1).
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(titleOf(ndb, 'twin'), 'основа');
        assert.equal(titleOf(ndb, 'onlyB'), null);

        // Возврат в A: снапшот пересобран, тень и надгробие снова решают.
        ndb.useLayer(LAYER_A);
        assert.equal(titleOf(ndb, 'twin'), null);
      } finally {
        ndb.close();
      }
    });

    it('тень в промежуточном слое видна потомку сразу после записи', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        insertLayer(ndb, LAYER_B, LAYER_A, 2);
        insertThoughtRow(ndb, 'deep', BASE_LAYER_ID, 'основа');
        insertThoughtRow(ndb, 'deep', LAYER_A, 'A');
        insertThoughtRow(ndb, 'deep', LAYER_B, 'B');

        ndb.useLayer(LAYER_B);
        assert.equal(titleOf(ndb, 'deep'), 'B');

        // Тень в промежуточном слое A появилась уже после сборки снапшота B.
        insertThoughtRow(ndb, 'later', LAYER_A, 'позже в A');
        // Чтение из B обязано увидеть строку предка A (сигнал соединения).
        assert.equal(titleOf(ndb, 'later'), 'позже в A');
      } finally {
        ndb.close();
      }
    });

    it('представление экспонирует физический rowid победителя (контракт FTS)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        insertThoughtRow(ndb, 'r1', BASE_LAYER_ID, 'основа');
        insertThoughtRow(ndb, 'r1', LAYER_A, 'слой');

        const physical = ndb
          .prepare('SELECT rowid AS rid FROM thoughts WHERE id = ? AND layer_id = ?')
          .get('r1', LAYER_A) as { rid: number };
        ndb.useLayer(LAYER_A);
        const viaView = ndb.prepare('SELECT rowid AS rid FROM thoughts_v WHERE id = ?').get('r1') as {
          rid: number;
        };
        assert.equal(viaView.rid, physical.rid, 'views обязан отдавать rowid победителя');

        // Снапшот — temp-таблица соединения, а не глобальное состояние.
        const snapshotTables = ndb
          .prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = ?")
          .all(layerSnapshotName('thoughts')) as Array<{ name: string }>;
        assert.equal(snapshotTables.length, 1, 'снапшот thoughts_snap живёт в temp-зоне соединения');
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'снапшот слоя — свежесть между соединениями (WAL)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    let tmpDataDir: string;

    before(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-layers-snap-'));
    });

    after(() => {
      closeAll();
      if (tmpDataDir) {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      }
    });

    it('коммит другого соединения виден: сигнал data_version, а не только total_changes', () => {
      const networkId = randomUUID();
      const ndbBase = openNetworkDb(tmpDataDir, networkId);
      try {
        insertLayer(ndbBase, LAYER_A, BASE_LAYER_ID, 1);
        // Второе соединение на тот же файл, контекст слоя A.
        const ndbA = openNetworkDb(tmpDataDir, networkId, undefined, LAYER_A);

        // Общая основа: строка, записанная соединением A, видна основе только
        // через сигнал data_version (total_changes у основы не менялся).
        insertThoughtRow(ndbA, 'cross', BASE_LAYER_ID, 'из A');
        assert.equal(titleOf(ndbBase, 'cross'), 'из A');

        // Тень в A, записанная соединением A, видна ему; основа её не видит
        // (A не предок основы) — даже после пересборки по сигналу.
        insertThoughtRow(ndbA, 'cross', LAYER_A, 'тень');
        assert.equal(titleOf(ndbA, 'cross'), 'тень');
        assert.equal(titleOf(ndbBase, 'cross'), 'из A');

        // Свежесть в обратную сторону: запись основы (чужое соединение) видна
        // соединению A — это ловит `PRAGMA data_version`, своего `total_changes`
        // у A не изменилось.
        insertThoughtRow(ndbBase, 'baseOnly', BASE_LAYER_ID, 'базовая');
        assert.equal(titleOf(ndbA, 'baseOnly'), 'базовая');

        ndbBase
          .prepare('UPDATE thoughts SET title = ? WHERE id = ? AND layer_id = ?')
          .run('правка основы', 'baseOnly', BASE_LAYER_ID);
        assert.equal(titleOf(ndbA, 'baseOnly'), 'правка основы');
      } finally {
        closeNetworkDb(networkId);
      }
    });
  },
);
