/**
 * Миграция `definition v1` → AST на РЕАЛЬНЫХ сетях (задача 4be62d42, 0.13.1).
 *
 * Идентичность до/после единственного входа движка (сдача c13762b1 / T7)
 * доказана A/B-прогоном «старый движок (плоский) ↔ новый (компиляция в AST)»
 * (отчёт в карточке задачи). Здесь закрепляется наблюдаемое поведение на
 * реальных телах сохранённых отборов:
 *
 *   1. Каждое сохранённое v1-тело (`thought_type_views` + `saved_filters`
 *      «Структур») исполняется `queryThoughts` без ошибок.
 *   2. Плоское `type_ids:[X]` даёт то же множество, что явный список
 *      «X + все потомки» из СЫРОГО SQL по `thought_types_v` (независимая от
 *      `expandTypeIdsToSubtree` перечислимость) — конверсия в «Тип в иерархии».
 *   3. Сохранённые v1-тела «Хроники» исполняются `queryChronicle` без ошибок.
 *
 * Отборы не копируют данные — работают на КОПИЯХ `data.db(+wal+shm)` во
 * временном каталоге, пользовательские БД не трогаются. Каталог данных —
 * `ETN_MIGRATION_PARITY_DIR` (по умолчанию `C:/zSpace/ETN_data`); нет каталога
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
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';
import { queryThoughts, structureRequestToQuery } from '../src/domain/query-service.js';

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

/** Найти сети с `data.db` в каталоге данных. */
function discoverNetworks(): string[] {
  const networksRoot = path.join(DATA_DIR, 'networks');
  if (!fs.existsSync(networksRoot)) return [];
  return fs
    .readdirSync(networksRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(networksRoot, d.name, 'data.db')))
    .map((d) => d.name);
}

const NETS = nativeAvailable() ? discoverNetworks() : [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-migration-parity-'));
const opened: Array<{ dataDir: string; id: string }> = [];

/** Скопировать `db+wal+shm` сети в изолированный каталог и открыть копию. */
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

const MAX_LIMIT = 2000;

/** Явное поддерево типа (тип + потомки) сырым SQL — независимо от движка. */
function rawSubtree(ndb: NetworkDb, typeIds: string[]): string[] {
  const out = new Set<string>();
  for (const tid of typeIds) {
    const rows = ndb
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM thought_types_v WHERE id = ?
           UNION
           SELECT t.id FROM thought_types_v t JOIN sub s ON t.parent_id = s.id
         ) SELECT id FROM sub`,
      )
      .all(tid) as Array<{ id: string }>;
    for (const r of rows) out.add(r.id);
  }
  return [...out];
}

/** Канонический плоский запрос из сохранённого v1-тела (ручной резолв `$thought`). */
function mkReq(def: Record<string, unknown>, ctxId: string | null, ctxTypeId: string | null, typeOverride?: string[]) {
  const resolve = (v: unknown): unknown =>
    v === '$thought' ? ctxId : v === '$thought.[ID типа]' || v === '$thought.[ID типа мысли]' ? ctxTypeId : v;
  const active =
    def['active'] === true ? 'true' : def['active'] === false ? 'false' : def['show_inactive'] === true ? 'any' : undefined;
  const parentIds = Array.isArray(def['parent_ids']) ? (def['parent_ids'] as unknown[]).map(resolve) : undefined;
  const rawProps = Array.isArray(def['properties']) ? (def['properties'] as Array<Record<string, unknown>>) : [];
  return structureRequestToQuery({
    keywords: def['keywords'] as string | undefined,
    keyword_scope: def['keyword_scope'] as never,
    type_ids: (typeOverride ?? (Array.isArray(def['type_ids']) ? (def['type_ids'] as unknown[]).map(resolve) : undefined)) as never,
    properties: rawProps.map((c) => ({ property_id: c['property_id'] as string, op: c['op'] as never, value: resolve(c['value']) as never })) as never,
    active: active as never,
    trashed: (def['trashed'] === true ? 'any' : 'false') as never,
    parent_ids: parentIds as never,
    sort: (def['sort'] as string | undefined) as never,
    order: (def['order'] as string | undefined) as never,
    limit: MAX_LIMIT,
    offset: 0,
    count: true,
  });
}

describe(
  '4be62d42: миграция definition v1 → AST на реальных сетях',
  nativeAvailable() && NETS.length > 0
    ? {}
    : { skip: `нет реальных сетей (${DATA_DIR}); задайте ETN_MIGRATION_PARITY_DIR` },
  () => {
    it('все сохранённые v1-отборы исполняются; type_ids раскрываются в подтипы (0 расхождений)', () => {
      let checked = 0;
      let subtreeChecked = 0;
      const divergences: string[] = [];

      for (const id of NETS) {
        const ndb = openCopy(id);
        const userId = ((ndb.prepare('SELECT created_by u FROM thoughts_v LIMIT 1').get() as { u?: string }) ?? {}).u ?? 'u-admin';
        const views = ndb
          .prepare('SELECT name, thought_type_id, definition FROM thought_type_views WHERE deleted = 0')
          .all() as Array<{ name: string; thought_type_id: string; definition: string }>;
        const saved = ndb
          .prepare("SELECT name, definition FROM saved_filters WHERE view = 'structures'")
          .all() as Array<{ name: string; definition: string }>;

        const cases = [
          ...views.map((v) => ({ kind: 'view', name: v.name, def: JSON.parse(v.definition) as Record<string, unknown>, typeId: v.thought_type_id as string | null })),
          ...saved.map((s) => ({ kind: 'saved_filter', name: s.name, def: JSON.parse(s.definition) as Record<string, unknown>, typeId: null })),
        ];

        for (const c of cases) {
          if (c.def['version'] !== undefined) continue; // AST-форма — вне v1-миграции
          let ctx = c.typeId
            ? (ndb.prepare('SELECT id, type_id FROM thoughts_v WHERE type_id = ? LIMIT 1').get(c.typeId) as { id: string; type_id: string | null } | undefined)
            : undefined;
          ctx ??= ndb.prepare('SELECT id, type_id FROM thoughts_v LIMIT 1').get() as { id: string; type_id: string | null } | undefined;

          checked += 1;
          let flat;
          try {
            flat = queryThoughts(ndb, userId, mkReq(c.def, ctx?.id ?? null, ctx?.type_id ?? null), { emptyFilterMode: 'all', maxLimit: MAX_LIMIT });
          } catch (e) {
            divergences.push(`${id}/${c.kind}/${c.name}: исполнение упало — ${String(e)}`);
            continue;
          }

          // Раскрытие подтипов: сравниваем с явным списком потомков из сырого SQL.
          if (Array.isArray(c.def['type_ids']) && c.def['type_ids'].length > 0) {
            const resolved = (c.def['type_ids'] as string[]).map((v) => (v === '$thought.[ID типа]' ? ctx?.type_id ?? v : v));
            const explicit = rawSubtree(ndb, resolved);
            if (explicit.length > 0) {
              subtreeChecked += 1;
              const exp = queryThoughts(ndb, userId, mkReq(c.def, ctx?.id ?? null, ctx?.type_id ?? null, explicit), { emptyFilterMode: 'all', maxLimit: MAX_LIMIT });
              const a = [...new Set(flat.items.map((i) => i.id))].sort();
              const b = [...new Set(exp.items.map((i) => i.id))].sort();
              if (JSON.stringify(a) !== JSON.stringify(b) || flat.total !== exp.total) {
                divergences.push(`${id}/${c.kind}/${c.name}: type_ids ≠ явное поддерево (${flat.total} vs ${exp.total})`);
              }
            }
          }
        }

        // Хроника v1 — быстрая и структурная формы.
        const chron = ndb.prepare("SELECT name, definition FROM saved_filters WHERE view = 'chronicle'").all() as Array<{ name: string; definition: string }>;
        for (const s of chron) {
          checked += 1;
          try {
            const req = parseChronicleQueryBody({ ...(JSON.parse(s.definition) as Record<string, unknown>), limit: 50, offset: 0 }, 'parity');
            queryChronicle(ndb, req);
          } catch (e) {
            divergences.push(`${id}/chronicle/${s.name}: исполнение упало — ${String(e)}`);
          }
        }
      }

      assert.deepEqual(divergences, [], `расхождения на реальных данных:\n${divergences.join('\n')}`);
      assert.ok(checked > 0, 'должен быть проверен хотя бы один отбор');
      assert.ok(subtreeChecked > 0, 'должна быть проверена хотя бы одна выборка по типу');
      // Диагностика объёма — в вывод теста.
      console.log(`[migration-parity.real] сетей=${NETS.length} отборов=${checked} выборок-по-типу=${subtreeChecked} расхождений=0`);
    });
  },
);
