/**
 * Идентичность рецепта заголовков публикаций на РЕАЛЬНЫХ сетях (задача
 * ef37b01e; требование e090a63c, ADR 2ef3ed7e; сценарий b0a50833).
 *
 * Для каждой публикации с сохранённым рецептом сверяются id разделов,
 * полученные новым путём (`selectRecipeIds`), и НЕЗАВИСИМОЙ копией ПРЕЖНЕГО
 * плоского конвейера (тот же `parseStructureFilter` →
 * `structureRequestToQuery` → `queryThoughtIds`, keyset-страницами) — заголовок
 * до/после обязан совпасть. AST-рецепты (новая форма) в сверке пропускаются
 * (прежний путь их не знает) — для них проверяется только исполняемость.
 *
 * Работает на КОПИЯХ `data.db(+wal+shm)`; каталог данных —
 * `ETN_MIGRATION_PARITY_DIR` (по умолчанию `C:/zSpace/ETN_data`). Нет каталога
 * или публикаций — тест SKIP (CI-безопасно).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { isPublicationTitleRecipeAst, type PublicationTitleRecipe } from '@etn/shared';

import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { isStructureFilterEmpty, selectRecipeIds } from '../src/domain/publication-recipe.js';
import { queryThoughtIds, structureRequestToQuery } from '../src/domain/query-service.js';
import { parseStructureFilter } from '../src/domain/structure-service.js';

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
const PAGE_SIZE = 20;

function discoverNetworks(): string[] {
  const root = path.join(DATA_DIR, 'networks');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'data.db')))
    .map((d) => d.name);
}

const NETS = nativeAvailable() ? discoverNetworks() : [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-recipe-ast-'));
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

/** Публикации сети с непустым рецептом. */
function recipesOf(ndb: NetworkDb): Array<{ id: string; recipe: PublicationTitleRecipe }> {
  const rows = ndb
    .prepare('SELECT id, title_recipe FROM publications_v WHERE title_recipe IS NOT NULL')
    .all() as Array<{ id: string; title_recipe: string }>;
  const out: Array<{ id: string; recipe: PublicationTitleRecipe }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.title_recipe) as PublicationTitleRecipe;
      if (parsed !== null && typeof parsed === 'object') out.push({ id: row.id, recipe: parsed });
    } catch {
      /* битый рецепт — вне сверки */
    }
  }
  return out;
}

/** Независимая копия ПРЕЖНЕГО плоского конвейера рецепта. */
function legacyIds(ndb: NetworkDb, recipe: Record<string, unknown>): string[] {
  const filter = parseStructureFilter(recipe);
  if (isStructureFilterEmpty(filter)) return [];
  // Сортировка — из самого рецепта, как в домене (иначе сверка порядка ложна).
  const rawSort = recipe['sort'];
  const rawOrder = recipe['order'];
  const sort =
    rawSort === 'alpha' || rawSort === 'created' || rawSort === 'viewed' || rawSort === 'updated'
      ? rawSort
      : 'alpha';
  const order = rawOrder === 'desc' ? 'desc' : 'asc';
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query = structureRequestToQuery({
      ...filter,
      sort,
      order,
      limit: PAGE_SIZE,
      offset: 0,
      cursor,
    });
    const page = queryThoughtIds(ndb, '', query, {
      emptyFilterMode: 'all',
      maxLimit: PAGE_SIZE,
      profile: 'publications',
    });
    ids.push(...page.ids);
    if (!page.has_more || page.next_cursor === null) return ids;
    cursor = page.next_cursor;
  }
}

describe('идентичность рецепта заголовков на реальных сетях (задача ef37b01e)', () => {
  it('id разделов совпадают с прежним плоским конвейером', () => {
    if (NETS.length === 0) return; // нет данных — нечего сверять (CI)
    let compared = 0;
    let idsCompared = 0;
    let astRecipes = 0;
    for (const net of NETS) {
      const ndb = openCopy(net);
      for (const { recipe } of recipesOf(ndb)) {
        if (isPublicationTitleRecipeAst(recipe)) {
          // Новая форма: прежний путь её не знает — проверяем только исполняемость.
          astRecipes += 1;
          assert.ok(Array.isArray(selectRecipeIds(ndb, '', recipe, [])), 'AST-рецепт исполняется');
          continue;
        }
        const warnings: string[] = [];
        const got = selectRecipeIds(ndb, '', recipe, warnings);
        const legacy = legacyIds(ndb, recipe as unknown as Record<string, unknown>);
        assert.deepEqual(got, legacy, `сеть ${net}: рецепт публикации дал другой заголовок`);
        compared += 1;
        idsCompared += got.length;
      }
    }
    // Наблюдаемость: сколько реально сверено (0 — данных без рецептов, не ошибка).
    assert.ok(compared >= 0 && idsCompared >= 0);
    if (compared === 0 && astRecipes === 0) {
      console.log(`[publication-recipe-ast.real] сетей=${NETS.length}, публикаций с плоским рецептом нет`);
    } else {
      console.log(
        `[publication-recipe-ast.real] сетей=${NETS.length} сверено рецептов=${compared} id=${idsCompared} ast-рецептов=${astRecipes} расхождений=0`,
      );
    }
  });
});
