/**
 * Контекст слоя соединения (фаза S, задача S3, docs/13-layers.md §4.2; этап 3
 * тех.проекта e29c0f00, ADR 6582c287).
 *
 * Правило разрешения (13-layers.md §4.1): для логического `id` в контексте
 * слоя `L` побеждает строка из ближайшего слоя цепочки
 * `L → parent(L) → … → base`; если победившая строка — надгробие
 * (`deleted = 1`), сущность не видна.
 *
 * Механизм — **temp-снапшот видимости на соединение**:
 *   * `layer_chain(layer_id, depth)` — цепочка предков слоя (depth = 0 у
 *     текущего слоя, растёт к основе), per-connection;
 *   * `<таблица>_snap(src_rowid, id)` — материализованный набор строк-
 *     победителей: один проход по цепочке (`rebuildLayerSnapshot`) записывает
 *     `rowid` живой ближайшей версии каждого логического `id`;
 *   * `<таблица>_v` — тонкое представление `main.<таблица> t JOIN
 *     temp.<таблица>_snap s ON s.src_rowid = t.rowid AND s.id = t.id WHERE
 *     t.deleted = 0`: строка читается из живой таблицы (значения всегда
 *     актуальны), а отбор победителя — поиск по `INTEGER PRIMARY KEY`, а не
 *     анти-джойн на каждую строку и каждый коррелированный подзапрос.
 *
 * **Контекст основы — без снапшота.** Если в цепочке только основа (самый
 * частый случай: работа на «степной» базе, массовые импорты), конкурирующих
 * версий нет, и представление читает живую таблицу напрямую с предикатом
 * `t.layer_id = <основа>` (`ensureLayerViews`). Это не только корректно, но и
 * снимает стоимость снапшота там, где он не нужен: запись в основу не требует
 * пересборки, а bulk-сценарии не платят сигнальную проверку на каждом чтении.
 * Смена режима (выбор слоя) пересоздаёт представления.
 *
 * Чем это снимает исходную проблему. Раньше `<таблица>_v` содержала анти-джойн
 * «нет более близкой версии» и вычисляла его при каждом обращении — включая
 * коррелированные проверки концов связи, — то есть O(строк × версий) на запрос
 * (исследование 603a8bcb). Теперь разрешение выполняется один раз при сборке
 * снапшота, а чтения идут по снапшоту.
 *
 * Контракт `rowid` (на него джойнятся FTS-индексы, §9): снапшот хранит
 * физический `rowid` победившей строки, а представление экспонирует
 * `t.rowid AS rowid` — то есть ровно тот же `rowid`, что и до снапшота
 * (`comments_v.rowid = fts_thought_texts.rowid` продолжает работать, в т.ч.
 * при перекрытии записи тенью слоя). Джойн снапшота проверяет и `rowid`, и
 * логический `id` — см. {@link ensureLayerViews}.
 *
 * Актуальность снапшота. Снапшот пересобирается (а) при установке контекста
 * слоя (`setupLayerContext`) и (б) перед чтением, если изменился сигнал
 * соединения — число изменённых строк (`total_changes()`) плюс
 * `PRAGMA data_version` (ловят и свои записи, и коммиты других соединений).
 * Сигнальная проверка живёт в {@link NetworkDb.prepare} на пути чтения; запись
 * отдельной точки инвалидации не требует — см. комментарий там же.
 *
 * Почему temp, а не объекты в схеме `data.db`: (1) SQLite запрещает
 * представлению из `main` ссылаться на объекты `temp` («view … cannot
 * reference objects in database temp»), а контекст обязан быть per-connection —
 * пул держит по соединению на пару (сеть, слой), и цепочки у них разные;
 * (2) служебная глобальная live-таблица видимости отклонена ADR 6582c287.
 * Поэтому и `layer_chain`, и снапшот, и представления создаются на каждом
 * соединении. Состав столбцов берётся из `PRAGMA table_info`, так что
 * представления не могут рассинхронизироваться со схемой.
 *
 * Репозитории читают только из `*_v` (линт-тест layers-s3 это требует);
 * запись идёт в физические таблицы с материализацией теневых строк/надгробий
 * текущего слоя (S4, db/layer-write.ts) — снапшот обновится на ближайшем
 * чтении по сигналу соединения.
 */

import type Database from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

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
  'thought_type_views',
  'link_types',
  'properties',
  'type_properties',
  'type_property_overrides',
  'property_values',
  'comments',
  'comment_targets',
  'attachments',
  'publications',
  'publication_order',
  'publication_exclusions',
  'shelves',
  'shelf_items',
] as const;

/** Имя temp-представления ветвимой таблицы. */
export function layerViewName(table: string): string {
  return `${table}_v`;
}

/** Имя temp-снапшота видимости ветвимой таблицы. */
export function layerSnapshotName(table: string): string {
  return `${table}_snap`;
}

/**
 * True when the physical table exists in the connection's schema.
 *
 * Ветвимые таблицы добавляются разными миграциями (например, `publications` —
 * миграция 047, тогда как ядро слоёв — 025). Соединение, чья схема ещё не
 * доведена до версии с таблицей (тесты, воспроизводящие промежуточные
 * состояния БД; мигратор на живой сети применяет файлы по порядку до запуска
 * сервера), не должно падать на построении представлений для таблицы,
 * которой в этой схеме ещё нет, — представление появится при следующей
 * установке контекста после применения миграции.
 */
function branchableTableExists(db: Database.Database, table: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).length > 0;
}

/** Guard against corrupt parent cycles: цепочка не длиннее 5 уровней (§2.1). */
const MAX_CHAIN_DEPTH = 16;

/**
 * `SELECT` набора строк-победителей ветвимой таблицы: живая ближайшая версия
 * каждого логического `id` по цепочке соединения (результат: `src_rowid`, `id`).
 * Один и тот же отбор питает снапшот {@link rebuildLayerSnapshot} и (исторически)
 * был телом представления — поэтому правило «ближайший слой» остаётся ровно в
 * одном месте.
 */
function winnerRowSelect(table: string): string {
  return `
    SELECT t.rowid AS src_rowid, t.id AS id
    FROM main.${table} t
    JOIN temp.layer_chain lc ON lc.layer_id = t.layer_id
    WHERE t.deleted = 0
      AND NOT EXISTS (
        SELECT 1
        FROM main.${table} t2
        JOIN temp.layer_chain lc2 ON lc2.layer_id = t2.layer_id
        WHERE t2.id = t.id AND lc2.depth < lc.depth
      )`;
}

/**
 * Предикат видимости конца связи: логическая мысль `t.<col>` обязана иметь
 * живую строку-победителя в контексте слоя. Связь, у которой хотя бы один
 * конец скрыт надгробием в цепочке текущего слоя, невидима — иначе чтения
 * начнут отдавать висячие рёбра (13-layers.md §5.2: каскад удаления мысли
 * ставит надгробия её связям, но конец может быть скрыт и независимо от
 * связи).
 *
 * В режиме снапшота проверка идёт по снапшоту мыслей (только живые
 * победители — один поиск по индексу `id`); в режиме основы (см.
 * {@link ensureLayerViews}) — по физической строке основы, потому что в
 * цепочке нет ни одного слоя поверх неё.
 */
function endpointVisiblePredicate(col: string, suffix: number, useSnapshot: boolean): string {
  if (useSnapshot) {
    const alias = `ts${suffix}`;
    return `
     AND EXISTS (
       SELECT 1 FROM temp.${layerSnapshotName('thoughts')} ${alias}
       WHERE ${alias}.id = t.${col}
     )`;
  }
  return `
     AND EXISTS (
       SELECT 1 FROM main.thoughts e
       WHERE e.id = t.${col} AND e.layer_id = '${BASE_LAYER_ID}' AND e.deleted = 0
     )`;
}

/**
 * Создать temp-снапшоты всех ветвимых таблиц (идемпотентно): таблица
 * `(src_rowid, id)` с `UNIQUE(id)` — победитель один на логический `id`, а
 * индекс по `id` обслуживает проверки концов связи.
 */
export function ensureLayerSnapshots(db: Database.Database): void {
  for (const table of BRANCHABLE_TABLES) {
    db.exec(
      `CREATE TEMP TABLE IF NOT EXISTS ${layerSnapshotName(table)} (
         src_rowid INTEGER PRIMARY KEY,
         id        TEXT NOT NULL UNIQUE
       )`,
    );
  }
}

/**
 * Создать temp-представления всех ветвимых таблиц в нужном режиме (идемпотентно).
 *
 * Режимы:
 *   * `useSnapshot = true` — цепочка содержит слои поверх основы: строка
 *     выбирается джойном со снапшотом видимости (`s.src_rowid = t.rowid AND
 *     s.id = t.id`), см. {@link rebuildLayerSnapshot};
 *   * `useSnapshot = false` — контекст основы (в цепочке только она): снапшот
 *     не нужен, представление читает живую таблицу напрямую с предикатом
 *     `layer_id = <основа>`. Это и корректно (в цепочке нет конкурирующих
 *     версий), и снимает со «степной» основы стоимость снапшота: запись в
 *     основу не требует пересборки, а bulk-сценарии (10k мыслей) не платят за
 *     сигнальную проверку вообще.
 *
 * Представления пересоздаются при смене режима (смена слоя меняет и форму
 * представления), поэтому `DROP VIEW` + `CREATE VIEW`, а не `IF NOT EXISTS`.
 *
 * Столбцы каждого представления повторяют физические плюс `rowid` (rowid
 * физической строки — на него джойнятся FTS-индексы: `comments_v.rowid =
 * fts_thought_texts.rowid`), кроме `deleted` (после фильтра она всегда 0).
 * Строка берётся из живой таблицы (`t`), поэтому значения всегда актуальны;
 * снапшот отвечает только за состав видимых строк.
 *
 * Джойн снапшота проверяет и `rowid`, и логический `id`: это страховка
 * целостности «снапшот ↔ живая строка» и одновременно условие плана — без
 * ссылки на `id` запрос со связанным предикатом (`WHERE l.target_id = t.id`)
 * целиком покрывался бы индексом `idx_links_source_live`, и планировщик
 * предпочитал бы его полный скан поиску по `idx_links_target_live` — возврат
 * O(мысли × рёбра) (проверено на perf-стенде). В режиме основы тот же эффект
 * даёт константный предикат `t.layer_id = <основа>`.
 */
export function ensureLayerViews(db: Database.Database, useSnapshot: boolean): void {
  for (const table of BRANCHABLE_TABLES) {
    const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (info.length === 0) {
      // Таблица добавлена миграцией, ещё не применённой к этой схеме —
      // представление для неё не создаётся (см. branchableTableExists).
      continue;
    }
    const cols = info
      .map((c) => c.name)
      .filter((name) => name !== 'deleted')
      .map((name) => `t.${name}`)
      .join(', ');
    // Связи дополнительно фильтруются по видимости концов (см. выше).
    const endpoints =
      table === 'links'
        ? `${endpointVisiblePredicate('source_id', 1, useSnapshot)}${endpointVisiblePredicate('target_id', 2, useSnapshot)}`
        : '';
    const source = useSnapshot
      ? `main.${table} t
       JOIN temp.${layerSnapshotName(table)} s
         ON s.src_rowid = t.rowid AND s.id = t.id
       WHERE t.deleted = 0${endpoints}`
      : `main.${table} t
       WHERE t.deleted = 0 AND t.layer_id = '${BASE_LAYER_ID}'${endpoints}`;
    db.exec(
      `DROP VIEW IF EXISTS temp.${layerViewName(table)};
       CREATE TEMP VIEW ${layerViewName(table)} AS
       SELECT ${cols}, t.rowid AS rowid
       FROM ${source}`,
    );
  }
}

/**
 * Пересобрать снапшот видимости: по одному проходу на ветвимую таблицу
 * (см. {@link winnerRowSelect}). Вызывается при установке контекста слоя и по
 * сигналу соединения перед чтением (ADR 6582c287: инвалидация при смене слоя
 * и при изменении версий слоя в рамках соединения).
 *
 * Идёт через `db.exec` (не через `NetworkDb.prepare`) — снапшот обслуживает
 * сам себя и не должен попадать под сигнальную проверку пути чтения.
 */
export function rebuildLayerSnapshot(db: Database.Database): void {
  for (const table of BRANCHABLE_TABLES) {
    if (!branchableTableExists(db, table)) {
      // Схема ещё не знает таблицу (не применена создающая её миграция).
      continue;
    }
    db.exec(
      `DELETE FROM temp.${layerSnapshotName(table)};
       INSERT INTO temp.${layerSnapshotName(table)} (src_rowid, id)
       ${winnerRowSelect(table)}`,
    );
  }
}

/**
 * (Пере)заполнить `layer_chain` цепочкой предков `layerId` до основы и вернуть
 * её (от текущего слоя к основе), чтобы вызывающий мог понять, изменилась ли
 * цепочка.
 *
 * Таблица создаётся при первом вызове и очищается перед заполнением, так что
 * повторный вызов атомарно меняет контекст слоя соединения.
 *
 * @throws Error если слоя с таким id нет в сети (в том числе когда миграции
 *   ещё не создали `layers`) или цепочка циклична.
 */
export function setupLayerChain(db: Database.Database, layerId: string): string[] {
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
  const chain: string[] = [];
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
    chain.push(row.id);
    current = row.parent_id;
    depth += 1;
  }
  return chain;
}

/** Установленный контекст слоя соединения. */
export interface LayerContext {
  /** Подпись контекста (режим + цепочка) — для пропуска повторной установки. */
  readonly key: string;
  /** Цепочка предков от текущего слоя к основе. */
  readonly chain: readonly string[];
  /** Чтения идут по снапшоту видимости (в цепочке есть слои поверх основы). */
  readonly usesSnapshot: boolean;
  /** Снапшот пересобран этим вызовом. */
  readonly rebuilt: boolean;
}

/**
 * Полная установка контекста слоя на соединении: цепочка предков `layerId`,
 * представления и (при необходимости) снапшот видимости. Вызывается при
 * открытии соединения (`NetworkDb`) и при смене контекста (`useLayer`).
 *
 * `knownKey` — подпись уже установленного контекста. Если она совпала
 * (например, reader-воркер переустанавливает тот же слой на каждой задаче),
 * ничего не пересобирается: свежесть данных сторожит сигнал соединения на
 * пути чтения (`NetworkDb.prepare`), который и пересоберёт снапшот, если
 * коммит другого соединения или своя запись того потребуют. Смена слоя,
 * перевешивание слоя или переход «основа ↔ слой» меняют подпись — контекст
 * переустанавливается безусловно.
 */
export function setupLayerContext(
  db: Database.Database,
  layerId: string,
  knownKey?: string,
): LayerContext {
  const chain = setupLayerChain(db, layerId);
  const usesSnapshot = chain.length > 1;
  const key = `${usesSnapshot ? 'snapshot' : 'base'}\u0000${chain.join('>')}`;
  if (key === knownKey) {
    return { key, chain, usesSnapshot, rebuilt: false };
  }
  if (usesSnapshot) {
    ensureLayerSnapshots(db);
  }
  ensureLayerViews(db, usesSnapshot);
  if (usesSnapshot) {
    rebuildLayerSnapshot(db);
  }
  return { key, chain, usesSnapshot, rebuilt: true };
}
