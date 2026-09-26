/**
 * Сторож чистоты схемы связей (задача ddc614f9, этап 1 тех.проекта e29c0f00;
 * ADR 6e4fef59, требования 7da6de92 и 42fb69a4).
 *
 * Миграция 045 меняет набор индексов связей: удаляет неселективные
 * `idx_links_active`/`idx_thoughts_active` и добавляет целевые частичные
 * покрывающие индексы. Правило «индекс только дописывается» держалось бы на
 * дисциплине, поэтому схема после миграций проверяется здесь:
 *
 *   1. неселективных `idx_links_active`/`idx_thoughts_active` в схеме НЕТ —
 *      планировщик не должен иметь возможности их выбрать;
 *   2. целевые частичные индексы `idx_links_target_live` и
 *      `idx_links_source_live` ПРИСУТСТВУЮТ и устроены как требует ADR
 *      (колонки и предикат `deleted = 0`, оба покрывающие);
 *   3. UNIQUE живых троек `idx_links_triple_live` сохранён (снос был бы
 *      потерей уникальности тройки в слое);
 *   4. после применения миграций собрана статистика планировщика
 *      (`sqlite_stat1` — требование 239be851).
 *
 * Сторож гоняется на свежей in-memory базе после всех миграций и входит в
 * обычный `npm -w @etn/server test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';

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

/** Строка `sqlite_master` с определением индекса. */
interface IndexRow {
  name: string;
  sql: string | null;
}

/** Определения индексов указанной таблицы (`index`-объекты `sqlite_master`). */
function indexDefs(ndb: ReturnType<typeof createInMemoryNetworkDb>, table: string): IndexRow[] {
  return ndb
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    )
    .all(table) as IndexRow[];
}

describe(
  'guard: схема индексов связей после миграции 045',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('неселективные idx_links_active/idx_thoughts_active отсутствуют', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const names = new Set(
          (ndb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
            (r) => r.name,
          ),
        );
        assert.equal(names.has('idx_links_active'), false, 'idx_links_active должен быть удалён миграцией 045');
        assert.equal(
          names.has('idx_thoughts_active'),
          false,
          'idx_thoughts_active должен быть удалён миграцией 045',
        );
      } finally {
        ndb.close();
      }
    });

    it('целевые частичные покрывающие индексы связей на месте и устроены по ADR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const defs = new Map(indexDefs(ndb, 'links').map((r) => [r.name, r.sql ?? '']));

        const target = defs.get('idx_links_target_live');
        assert.ok(target, 'idx_links_target_live должен существовать (требование 7da6de92)');
        assert.match(target!, /target_id,\s*type_id,\s*source_id/i, 'колонки покрывающего in-индекса');
        assert.match(target!, /WHERE\s+deleted\s*=\s*0/i, 'индекс обязан быть частичным по deleted = 0');

        const source = defs.get('idx_links_source_live');
        assert.ok(source, 'idx_links_source_live должен существовать (парный по source_id)');
        assert.match(
          source!,
          /source_id,\s*target_id,\s*type_id,\s*active,\s*marked_for_deletion/i,
          'колонки покрывающего out-индекса',
        );
        assert.match(source!, /WHERE\s+deleted\s*=\s*0/i, 'индекс обязан быть частичным по deleted = 0');

        assert.ok(defs.has('idx_links_triple_live'), 'UNIQUE живых троек слоя сохраняется');
      } finally {
        ndb.close();
      }
    });

    it('после миграций собрана статистика планировщика (sqlite_stat1)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const row = ndb
          .prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'")
          .get() as { name: string } | undefined;
        assert.ok(row, 'ANALYZE в конце миграций обязан создать sqlite_stat1 (требование 239be851)');
      } finally {
        ndb.close();
      }
    });
  },
);
