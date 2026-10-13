/**
 * Идентичность отбора событий до/после перевода на AST на РЕАЛЬНЫХ сетях
 * (задача 2b230e8e, требование 3c91f418). Новый путь (`listActivity`, AST)
 * сверяется с независимой сыро-SQL реализацией ПРЕЖНЕЙ плоской семантики
 * (тот же WHERE/ORDER BY, что был до задачи).
 *
 * Работает на КОПИЯХ `data.db(+wal+shm)`; каталог данных —
 * `ETN_MIGRATION_PARITY_DIR` (по умолчанию `C:/zSpace/ETN_data`). Нет каталога
 * или сетей — тест SKIP (CI-безопасно).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { ACTIVITY_LIMIT_MAX, listActivity } from '../src/domain/activity-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const DATA_DIR = process.env['ETN_MIGRATION_PARITY_DIR'] ?? 'C:/zSpace/ETN_data';

function discoverNetworks(): string[] {
  const root = path.join(DATA_DIR, 'networks');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'data.db')))
    .map((d) => d.name);
}

const NETS = nativeAvailable() ? discoverNetworks() : [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-activity-ast-'));
const opened: Array<{ dataDir: string; id: string }> = [];

function openCopy(id: string): NetworkDb {
  const dstDir = path.join(tmpRoot, 'networks', id);
  fs.mkdirSync(path.join(dstDir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(dstDir, 'snapshots'), { recursive: true });
  const srcDir = path.join(DATA_DIR, 'networks', id);
  for (const f of ['data.db', 'data.db-wal', 'data.db-shm']) {
    if (fs.existsSync(path.join(srcDir, f))) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
  }
  const ndb = openNetworkDb(tmpRoot, id);
  opened.push({ dataDir: tmpRoot, id });
  return ndb;
}

after(() => {
  for (const { dataDir, id } of opened) {
    try {
      closeNetworkDb(dataDir, id);
    } catch {
      /* уже закрыта */
    }
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* Windows может держать файл — не критично */
  }
});

/** Параметры одного прогона (плоские; `networkId` добавляется отдельно). */
interface FlatCase {
  from_ms?: number;
  to_ms?: number;
  user_id?: string;
  entity_type?: string;
  entity_id?: string;
}

/** Независимая сыро-SQL реализация прежней плоской семантики ленты. */
function legacyIds(ndb: NetworkDb, networkId: string, c: FlatCase): string[] {
  const where = ['network_id = ?'];
  const args: unknown[] = [networkId];
  if (c.from_ms !== undefined) {
    where.push('occurred_at_ms >= ?');
    args.push(c.from_ms);
  }
  if (c.to_ms !== undefined) {
    where.push('occurred_at_ms <= ?');
    args.push(c.to_ms);
  }
  if (c.user_id !== undefined && c.user_id !== '') {
    where.push('user_id = ?');
    args.push(c.user_id);
  }
  if (c.entity_type !== undefined && c.entity_type !== '') {
    where.push('entity_type = ?');
    args.push(c.entity_type);
  }
  if (c.entity_id !== undefined && c.entity_id !== '') {
    where.push('entity_id = ?');
    args.push(c.entity_id);
  }
  return (
    ndb
      .prepare(
        `SELECT id FROM activity_log WHERE ${where.join(' AND ')}
         ORDER BY occurred_at_ms DESC, id DESC LIMIT ?`,
      )
      .all(...args, ACTIVITY_LIMIT_MAX) as Array<{ id: string }>
  ).map((r) => r.id);
}

describe(
  '2b230e8e: отбор событий на AST на реальных сетях — идентичность прежней плоской семантике',
  nativeAvailable() && NETS.length > 0
    ? {}
    : { skip: `нет реальных сетей (${DATA_DIR}); задайте ETN_MIGRATION_PARITY_DIR` },
  () => {
    it('listActivity (AST) = прежний плоский SQL на реальных activity_log (0 расхождений)', () => {
      let checked = 0;
      const divergences: string[] = [];

      for (const id of NETS) {
        const ndb = openCopy(id);
        const total = (ndb.prepare('SELECT COUNT(*) c FROM activity_log WHERE network_id = ?').get(id) as { c: number }).c;
        if (total === 0) continue;

        const firstUser = (
          ndb.prepare('SELECT user_id FROM activity_log WHERE network_id = ? ORDER BY occurred_at_ms ASC LIMIT 1').get(id) as
            | { user_id: string }
            | undefined
        )?.user_id;
        const firstType = (
          ndb.prepare("SELECT entity_type FROM activity_log WHERE network_id = ? AND entity_type <> '' LIMIT 1").get(id) as
            | { entity_type: string }
            | undefined
        )?.entity_type;
        const firstEntity = (
          ndb.prepare("SELECT entity_id FROM activity_log WHERE network_id = ? AND entity_id <> '' LIMIT 1").get(id) as
            | { entity_id: string }
            | undefined
        )?.entity_id;
        const midMs = (
          ndb.prepare('SELECT occurred_at_ms m FROM activity_log WHERE network_id = ? ORDER BY occurred_at_ms DESC LIMIT 1 OFFSET 1').get(id) as
            | { m: number }
            | undefined
        )?.m;

        const cases: FlatCase[] = [{}, ...(firstType !== undefined ? [{ entity_type: firstType }] : [])];
        if (firstUser !== undefined) cases.push({ user_id: firstUser });
        if (firstEntity !== undefined) cases.push({ entity_id: firstEntity });
        if (midMs !== undefined) cases.push({ from_ms: midMs });

        for (const c of cases) {
          checked += 1;
          const expected = legacyIds(ndb, id, c);
          const actual = listActivity(ndb, { networkId: id, ...c, limit: ACTIVITY_LIMIT_MAX }).data.map((r) => r.id);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            divergences.push(
              `${id} [${JSON.stringify(c)}]: AST ≠ плоский SQL (${actual.length} vs ${expected.length})`,
            );
          }
        }
      }

      assert.deepEqual(divergences, [], `расхождения:\n${divergences.join('\n')}`);
      assert.ok(checked > 0, 'должен быть проверен хотя бы один прогон');
      console.log(`[activity-ast.real] сетей=${NETS.length} прогонов=${checked} расхождений=0`);
    });
  },
);
