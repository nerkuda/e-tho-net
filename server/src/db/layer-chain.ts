/**
 * Контекст слоя соединения: temp-таблица `layer_chain` и temp-представления
 * `*_v` (фаза S, задача S3, docs/13-layers.md §4.2).
 *
 * Правило разрешения (13-layers.md §4.1): для логического `id` в контексте
 * слоя `L` побеждает строка из ближайшего слоя цепочки
 * `L → parent(L) → … → base`; если победившая строка — надгробие
 * (`deleted = 1`), сущность не видна.
 *
 * Механизм. `layer_chain(layer_id, depth)` живёт в temp-зоне конкретного
 * соединения: depth = 0 у текущего слоя, растёт к основе. Каждое
 * представление `<таблица>_v` джойнит физическую таблицу с `layer_chain` и
 * оставляет строку минимальной глубины (эквивалент оконной функции
 * `ROW_NUMBER() OVER (PARTITION BY id ORDER BY depth ASC)` — почему не она
 * сама, см. {@link ensureLayerViews}), затем отбрасывает надгробия.
 *
 * Почему temp, а не view в схеме `data.db`: SQLite запрещает представлению из
 * `main` ссылаться на объекты `temp` (проверено: «view … cannot reference
 * objects in database temp»), а `layer_chain` обязана быть per-connection —
 * пул держит по соединению на пару (сеть, слой), и цепочки у них разные.
 * Поэтому представления создаются на каждом соединении (`ensureLayerViews`)
 * с явными квалификаторами `main.<таблица>` / `temp.layer_chain`. Состав
 * столбцов берётся из `PRAGMA table_info`, так что представления не могут
 * рассинхронизироваться со схемой.
 *
 * Репозитории читают только из `*_v` (линт-тест layers-s3 это требует);
 * запись идёт в физические таблицы с материализацией теневых строк/надгробий
 * текущего слоя (S4, db/layer-write.ts) — представления её немедленно видят.
 */

import type Database from 'better-sqlite3';

/**
 * Ветвимые таблицы (закрытый список, docs/13-layers.md §3 — расширение только
 * с правкой того документа). Порядок не важен; имена совпадают с физическими
 * таблицами `data.db`.
 */
export const BRANCHABLE_TABLES = [
  'thoughts',
  'thought_synonyms',
  'links',
  'thought_types',
  'link_types',
  'type_properties',
  'type_property_overrides',
  'property_values',
  'comments',
  'comment_targets',
  'attachments',
] as const;

/** Имя temp-представления ветвимой таблицы. */
export function layerViewName(table: string): string {
  return `${table}_v`;
}

/** Guard against corrupt parent cycles: цепочка не длиннее 5 уровней (§2.1). */
const MAX_CHAIN_DEPTH = 16;

/**
 * Предикат видимости конца связи: мысль `t.<col>` разрешается по той же
 * цепочке (§4.1) и обязана быть живой. Связь, у которой хотя бы один конец
 * скрыт надгробием в цепочке текущего слоя, невидима — иначе чтения начнут
 * отдавать висячие рёбра (13-layers.md §5.2: каскад удаления мысли ставит
 * надгробия её связям, но конец может быть скрыт и независимо от связи).
 * Формулировка — тот же анти-джойн «нет более близкой строки того же id»,
 * что и у самих представлений.
 */
function endpointVisiblePredicate(col: string): string {
  return `
     AND EXISTS (
       SELECT 1 FROM main.thoughts e
       JOIN temp.layer_chain elc ON elc.layer_id = e.layer_id
       WHERE e.id = t.${col} AND e.deleted = 0
         AND NOT EXISTS (
           SELECT 1 FROM main.thoughts e2
           JOIN temp.layer_chain elc2 ON elc2.layer_id = e2.layer_id
           WHERE e2.id = e.id AND elc2.depth < elc.depth
         )
     )`;
}

/**
 * Создать temp-представления всех ветвимых таблиц (идемпотентно).
 *
 * Столбцы каждого представления повторяют физические плюс `rowid` (rowid
 * физической строки — на него джойнятся FTS-индексы:
 * `comments_v.rowid = fts_thought_texts.rowid`), кроме `deleted` (после
 * фильтра она всегда 0). Победившая строка перекрытого id — другая
 * физическая строка, чем в основе, и её rowid совпадает с FTS-строкой
 * записи этого слоя (§9).
 *
 * Правило «ближайший слой» выражено `NOT EXISTS` строки того же id из более
 * близкого слоя цепочки, а не оконной `ROW_NUMBER()` из §4.2: при
 * `UNIQUE (id, layer_id)` обе формулировки эквивалентны (на логический id
 * максимум одна строка на слой, победитель — минимальная глубина), но
 * оконная функция не даёт SQLite протолкнуть предикат вызова (`WHERE id = ?`)
 * к индексу физической таблицы — каждый точечный lookup превращался в
 * полный проход с сортировкой (квадрат на bulk-записи, perf-smoke). NOT
 * EXISTS проталкивается: точечный lookup остаётся поиском по индексу.
 * Надгробия учитываются перекрытием как в §4.1: ближнее надгробие скрывает
 * дальнюю строку тем, что для неё EXISTS более близкая версия.
 */
export function ensureLayerViews(db: Database.Database): void {
  for (const table of BRANCHABLE_TABLES) {
    const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (info.length === 0) {
      throw new Error(`branchable table ${table} not found — migrations not applied?`);
    }
    const cols = info
      .map((c) => c.name)
      .filter((name) => name !== 'deleted')
      .map((name) => `t.${name}`)
      .join(', ');
    // Связи дополнительно фильтруются по видимости концов (см. выше).
    const endpoints = table === 'links' ? `${endpointVisiblePredicate('source_id')}${endpointVisiblePredicate('target_id')}` : '';
    db.exec(
      `CREATE TEMP VIEW IF NOT EXISTS ${layerViewName(table)} AS
       SELECT ${cols}, t.rowid AS rowid
       FROM main.${table} t
       JOIN temp.layer_chain lc ON lc.layer_id = t.layer_id
       WHERE t.deleted = 0${endpoints}
         AND NOT EXISTS (
           SELECT 1
           FROM main.${table} t2
           JOIN temp.layer_chain lc2 ON lc2.layer_id = t2.layer_id
           WHERE t2.id = t.id AND lc2.depth < lc.depth
         )`,
    );
  }
}

/**
 * (Пере)заполнить `layer_chain` цепочкой предков `layerId` до основы.
 *
 * Таблица создаётся при первом вызове и очищается перед заполнением, так что
 * повторный вызов атомарно меняет контекст слоя соединения.
 *
 * @throws Error если слоя с таким id нет в сети (в том числе когда миграции
 *   ещё не создали `layers`) или цепочка циклична.
 */
export function setupLayerChain(db: Database.Database, layerId: string): void {
  db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS layer_chain (
       layer_id TEXT PRIMARY KEY,
       depth    INTEGER NOT NULL
     )`,
  );
  db.prepare('DELETE FROM layer_chain').run();

  const byId = db.prepare('SELECT id, parent_id FROM layers WHERE id = ?');
  const insert = db.prepare('INSERT INTO layer_chain (layer_id, depth) VALUES (?, ?)');

  let current: string | null = layerId;
  let depth = 0;
  const seen = new Set<string>();
  while (current !== null) {
    if (depth > MAX_CHAIN_DEPTH || seen.has(current)) {
      throw new Error(`layer chain of ${layerId} is cyclic or too deep`);
    }
    seen.add(current);
    const row = byId.get(current) as { id: string; parent_id: string | null } | undefined;
    if (row === undefined) {
      throw new Error(`layer ${current} not found in layers`);
    }
    insert.run(row.id, depth);
    current = row.parent_id;
    depth += 1;
  }
}

/**
 * Полная установка контекста слоя на соединении: temp-представления (один
 * раз) + цепочка предков `layerId`. Вызывается при открытии соединения
 * (`NetworkDb`) и при смене контекста (`useLayer`).
 */
export function setupLayerContext(db: Database.Database, layerId: string): void {
  setupLayerChain(db, layerId);
  ensureLayerViews(db);
}
