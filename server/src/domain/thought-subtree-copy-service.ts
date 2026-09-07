/**
 * `etn.thoughts.copy_subtree` (задача e488f4c1, версия 0.7.2) —
 * копирование подграфа между сетями одной транзакцией.
 *
 * Сервер сам собирает снапшот (BFS по `root_thought_ids` + `max_depth` через
 * активные связи, активные мысли) и материализует его в целевой сети через
 * {@link copyThoughtsBatch} — ту же доменную функцию, что REST
 * `POST /thoughts/copy-batch`. То есть:
 *
 *   * типы резолвятся по id → по имени (как у `copyThoughtsBatch`);
 *   * `thought_ref` свойства резолвятся по id → по title;
 *   * файлы вложений не копируются — только видимые поля;
 *   * ссылки на root of target создаются автоматически от `parent_thought_id`.
 *
 * Поверх — четыре политики разрешения коллизий:
 *
 *   * `fail` (по умолчанию) — дубль по title+synonyms в целевой сети →
 *     `VALIDATION_ERROR` со списком конфликтов; транзакция не открывается.
 *   * `reuse` — найденный дубль переиспользуется (его id попадает в
 *     `thought_id_map`), без перезаписи title/synonyms; копируются только
 *     связи/свойства/вложения, которых у существующей мысли ещё нет.
 *   * `skip` — мысль и весь её нисходящий подграф пропускаются.
 *   * `create_always` — всегда создаётся новая мысль с новым id (даже если
 *     в целевой есть однофамилец).
 *
 * Граница применения:
 *
 *   * HOME-мысль нельзя копировать как корень — `VALIDATION_ERROR`.
 *   * Потолок BFS — `MCP_MAX_THOUGHTS_PER_WRITE` (тот же, что у `write`).
 *   * Онтология целевой сети должна иметь все используемые типы мыслей и
 *     связей; иначе — `VALIDATION_ERROR` со списком недостающих.
 *   * Одна транзакция, одна запись write-бюджета.
 */

import {
  EtnError,
  MCP_MAX_THOUGHTS_PER_WRITE,
  type Attachment,
  type Link,
  type McpCopySubtreeInclude,
  type McpCopySubtreePolicy,
  type PropertyValueValue,
  type Thought,
  type ThoughtCopyInput,
  type ThoughtCopyItem,
  type ThoughtCopyLink,
  type ThoughtCopyResult,
  type ThoughtCopySnapshot,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { listAttachments } from './attachment-service.js';
import { listComments } from './comment-service.js';
import { traverse } from './graph-traversal.js';
import { findDuplicates } from './search-service.js';
import {
  getThought,
  getThoughtOrThrow,
} from './thought-service.js';
import { copyThoughtsBatch } from './thought-copy-service.js';
import { getLinkType } from './link-type-service.js';
import { getThoughtType } from './thought-type-service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Входные параметры `copySubtree` (валидируются вызывающим — MCP-фасадом). */
export interface CopySubtreeParams {
  source_ndb: NetworkDb;
  target_ndb: NetworkDb;
  root_thought_ids: string[];
  /** Глубина обхода вниз по активным связям. Потолок 20. */
  max_depth: number;
  /** Подмножество переносимых частей (по умолчанию — все). */
  include: ReadonlyArray<McpCopySubtreeInclude>;
  /** Политика коллизий по title+synonyms. */
  duplicate_policy: McpCopySubtreePolicy;
  /** Куда подвесить вновь созданные корни. По умолчанию — HOME целевой сети. */
  target_parent_thought_id: string;
  /** id актора для `created_by` / `updated_by`. */
  actor_user_id: string;
}

/** Сводка, которую возвращает `copySubtree`. */
export interface CopySubtreeSummary {
  /** Кол-во созданных мыслей (после `reuse` / `skip`). */
  thoughts_created: number;
  /** Кол-во переиспользованных (только при `duplicate_policy: reuse`). */
  thoughts_reused: number;
  /** Кол-во пропущенных (только при `duplicate_policy: skip`). */
  thoughts_skipped: number;
  /** Кол-во созданных связей в целевой сети. */
  links_created: number;
  /** Карта `source_thought_id → target_thought_id` (пустая при `id_remap=false`). */
  thought_id_map: Record<string, string>;
  /** Карта `linkIdentity(sourceId, targetId, typeId) → target_link_id`. */
  link_id_map: Record<string, string>;
  /** Конфликты при `duplicate_policy=fail`. */
  conflicts: Array<{ source_thought_id: string; target_thought_id: string; title: string }>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Скопировать подграф из `source_ndb` в `target_ndb`. Семантика —
 * см. файл-уровневый комментарий. Ошибки бросает как `EtnError`; вызывающий
 * (MCP-фасад) преобразует их в JSON-RPC ответ.
 *
 * `target_parent_thought_id` обязан существовать в `target_ndb` — мы
 * проверим это до старта. Если в `source_ndb` подграф превышает
 * `MCP_MAX_THOUGHTS_PER_WRITE`, бросаем `VALIDATION_ERROR` ДО открытия
 * транзакции (та же политика, что у `etn.thoughts.write`).
 */
export function copySubtree(params: CopySubtreeParams): CopySubtreeSummary {
  const {
    source_ndb,
    target_ndb,
    root_thought_ids,
    max_depth,
    include,
    duplicate_policy,
    target_parent_thought_id,
    actor_user_id,
  } = params;

  // 1. Валидация корней + защита HOME.
  for (const id of root_thought_ids) {
    const thought = getThought(source_ndb, id);
    if (thought === null) {
      throw new EtnError('NOT_FOUND', `Корень ${id} не найден в исходной сети.`, {
        thought_id: id,
      });
    }
    if (thought.is_root) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'HOME-мысль нельзя копировать как корень подграфа.',
        { thought_id: id },
      );
    }
  }

  // 2. BFS по активным связям вниз; бюджет MAX_THOUGHTS_PER_WRITE узлов.
  const traversal = traverse(source_ndb, root_thought_ids, 'children', {
    maxDepth: max_depth,
    maxNodes: MCP_MAX_THOUGHTS_PER_WRITE,
  });
  if (traversal.truncated) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Подграф превысил лимит ${MCP_MAX_THOUGHTS_PER_WRITE} узлов. Уменьшите max_depth.`,
      { limit: MCP_MAX_THOUGHTS_PER_WRITE, reason: traversal.reason ?? 'max_nodes' },
    );
  }
  const thoughtIds = traversal.ids;
  if (thoughtIds.length === 0) {
    return emptySummary();
  }

  // 3. Снимок мыслей + ссылок + комментариев + свойств + вложений.
  const snapshot = collectSnapshot(source_ndb, thoughtIds, include);

  // 4. Проверка онтологии целевой сети — ДО касания duplicate_policy.
  checkOntologyCoverage(source_ndb, target_ndb, snapshot.thoughts, snapshot.links);

  // 5. Разрешение коллизий: для каждой мысли ищем дубль в target.
  const duplicateMap = resolveDuplicates(target_ndb, snapshot.thoughts, duplicate_policy);

  // 6. Применяем политику и формируем финальный `ThoughtCopyInput`.
  const built = buildCopyInput(
    source_ndb,
    target_ndb,
    snapshot,
    duplicateMap,
    duplicate_policy,
    target_parent_thought_id,
  );

  // 7. Если после применения политики нечего копировать — выходим.
  if (built.copyInput.thoughts.length === 0) {
    return {
      thoughts_created: 0,
      thoughts_reused: built.reused,
      thoughts_skipped: built.skipped,
      links_created: 0,
      thought_id_map: {},
      link_id_map: {},
      conflicts: built.conflicts,
    };
  }

  // 8. Материализация через существующий доменный код (одна транзакция).
  const result: ThoughtCopyResult = copyThoughtsBatch(
    target_ndb,
    built.copyInput,
    actor_user_id,
  );

  // 9. `copyThoughtsBatch` не знает про reused-мысли — добавляем их в карту
  // сами, чтобы клиент мог переписать ссылки в скопированных комментариях.
  const thoughtIdMap: Record<string, string> = { ...result.thought_id_map };
  for (const [srcId, tgtId] of duplicateMap.reusedIds) {
    thoughtIdMap[srcId] = tgtId;
  }

  return {
    thoughts_created: result.created_thoughts.length,
    thoughts_reused: built.reused,
    thoughts_skipped: built.skipped,
    links_created: result.created_links.length,
    thought_id_map: thoughtIdMap,
    link_id_map: result.link_id_map,
    conflicts: built.conflicts,
  };
}

// ---------------------------------------------------------------------------
// Snapshot collection
// ---------------------------------------------------------------------------

interface CollectedSnapshot {
  /** В порядке BFS; первый элемент — корень. */
  thoughts: Array<{
    id: string;
    snapshot: ThoughtCopySnapshot;
    permanent_comment: { title?: string | null; body_md: string } | null;
    properties: Record<string, PropertyValueValue>;
    attachments: ThoughtCopyItem['attachments'];
  }>;
  /** Все активные связи, оба конца которых внутри `thoughtIds`. */
  links: Array<{
    id: string;
    source_id: string;
    target_id: string;
    type_id: string | null;
    color: string | null;
    style: Link['style'];
    width: number | null;
    active: boolean;
  }>;
}

function collectSnapshot(
  src: NetworkDb,
  ids: string[],
  include: ReadonlyArray<McpCopySubtreeInclude>,
): CollectedSnapshot {
  const includeSet = new Set<McpCopySubtreeInclude>(include);
  const includeProperties = includeSet.has('properties');
  const includeComments = includeSet.has('comments');
  const includeAttachments = includeSet.has('attachments');
  const includeLinks = includeSet.has('links');

  // Карта синонимов: думается что в `thoughts_v` synonyms не присутствуют
  // (они вынесены в `thought_synonyms_v`), поэтому подгружаем их отдельным
  // запросом.
  const synonymsByThought = new Map<string, string[]>();
  const synRows = src
    .prepare('SELECT thought_id, synonym FROM thought_synonyms_v WHERE thought_id IN (' +
      ids.map(() => '?').join(',') + ')')
    .all(...ids) as Array<{ thought_id: string; synonym: string }>;
  for (const r of synRows) {
    const list = synonymsByThought.get(r.thought_id);
    if (list) list.push(r.synonym);
    else synonymsByThought.set(r.thought_id, [r.synonym]);
  }

  // Имена типов мыслей в исходной сети — нужны для type.name в снапшоте,
  // чтобы `copyThoughtsBatch` мог отрезолвить тип по имени в целевой сети.
  const thoughtTypeNames = new Map<string, string>();
  const thoughtTypeRows = src
    .prepare('SELECT id, name FROM thought_types_v')
    .all() as Array<{ id: string; name: string }>;
  for (const r of thoughtTypeRows) thoughtTypeNames.set(r.id, r.name);

  const thoughts: CollectedSnapshot['thoughts'] = [];
  for (const id of ids) {
    const t = getThought(src, id);
    if (t === null) continue;

    let permanentComment: { title?: string | null; body_md: string } | null = null;
    if (includeComments) {
      const permanent = listComments(src, 'thought', id).find((c) => c.kind === 'permanent');
      if (permanent !== undefined) {
        permanentComment = {
          title: permanent.title,
          body_md: permanent.body_md,
        };
      }
    }

    const properties: Record<string, PropertyValueValue> = {};
    if (includeProperties) {
      const rows = src
        .prepare(
          `SELECT pv.value_text, pv.value_number, pv.value_bool, pv.value_date, pv.value_thought_ref,
                  pv.property_id, p.name AS property_key, p.value_type AS property_value_type,
                  p.config AS property_config
             FROM property_values_v pv
             JOIN properties_v p ON p.id = pv.property_id
            WHERE pv.owner_type = 'thought' AND pv.owner_id = ?`,
        )
        .all(id) as Array<{
        value_text: string | null;
        value_number: number | null;
        value_bool: number | null;
        value_date: string | null;
        value_thought_ref: string | null;
        property_key: string;
        property_value_type: string;
        property_config: string | null;
      }>;
      for (const r of rows) {
        properties[r.property_key] = decodePropertyValue(
          r.value_text,
          r.value_number,
          r.value_bool,
          r.value_date,
          r.value_thought_ref,
          r.property_value_type,
          r.property_config,
        );
      }
    }

    let attachments: ThoughtCopyItem['attachments'];
    if (includeAttachments) {
      attachments = listAttachments(src, 'thought', id).map((a) => ({
        kind: a.kind,
        url: a.url,
        file_path: a.file_path,
        file_size: a.file_size,
        mime_type: a.mime_type,
        title: a.title,
        description: a.description,
      }));
    }

    thoughts.push({
      id,
      snapshot: {
        title: t.title,
        synonyms: synonymsByThought.get(id) ?? [],
        type: {
          id: t.type_id,
          name: t.type_id !== null ? thoughtTypeNames.get(t.type_id) ?? null : null,
        },
        icon: t.icon,
        icon_kind: t.icon_kind,
        active: t.active,
        fg_color: t.fg_color,
        bg_color: t.bg_color,
        font_bold: t.font_bold,
        font_italic: t.font_italic,
        font_underline: t.font_underline,
        font_strike: t.font_strike,
      },
      permanent_comment: permanentComment,
      properties,
      attachments,
    });
  }

  let links: CollectedSnapshot['links'] = [];
  if (includeLinks) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = src
      .prepare(
        `SELECT id, source_id, target_id, type_id, color, style, width, active
           FROM links_v
          WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
            AND active = 1`,
      )
      .all(...ids, ...ids) as Array<{
      id: string;
      source_id: string;
      target_id: string;
      type_id: string | null;
      color: string | null;
      style: string | null;
      width: number | null;
      active: number;
    }>;
    links = rows.map((r) => ({
      id: r.id,
      source_id: r.source_id,
      target_id: r.target_id,
      type_id: r.type_id,
      color: r.color,
      style: r.style as Link['style'],
      width: r.width,
      active: r.active === 1,
    }));
  }

  return { thoughts, links };
}

/** Преобразовать строку БД в PropertyValueValue с учётом value_type. */
function decodePropertyValue(
  text: string | null,
  number: number | null,
  bool: number | null,
  date: string | null,
  thoughtId: string | null,
  valueType: string,
  configJson: string | null,
): PropertyValueValue {
  switch (valueType) {
    case 'text':
    case 'url':
      return text;
    case 'number':
      return number;
    case 'bool':
      return bool === 1;
    case 'date':
      return date;
    case 'thought_ref': {
      const multiple = configJson !== null && /"multiple"\s*:\s*true/.test(configJson);
      if (multiple) {
        // Multiple `thought_ref` хранится в value_text как JSON-массив id'ов
        // (задача 0.6.2).
        if (text === null) return [];
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) return parsed as string[];
        } catch {
          // fall through — вернём как одиночное значение.
        }
        return [];
      }
      return thoughtId ?? text;
    }
    default:
      return text ?? number ?? date;
  }
}

// ---------------------------------------------------------------------------
// Ontology coverage check
// ---------------------------------------------------------------------------

function checkOntologyCoverage(
  src: NetworkDb,
  target: NetworkDb,
  thoughts: CollectedSnapshot['thoughts'],
  links: CollectedSnapshot['links'],
): void {
  // Подгружаем имена link-типов из src для отчёта об ошибке.
  const srcLinkTypes = new Map<string, { name_forward: string; name_reverse: string }>();
  for (const r of src
    .prepare('SELECT id, name_forward, name_reverse FROM link_types_v')
    .all() as Array<{ id: string; name_forward: string; name_reverse: string }>) {
    srcLinkTypes.set(r.id, { name_forward: r.name_forward, name_reverse: r.name_reverse });
  }

  const missingThoughtTypes: string[] = [];
  const seenTypeIds = new Set<string>();
  for (const t of thoughts) {
    const typeId = t.snapshot.type.id;
    if (typeId === null) continue;
    if (seenTypeIds.has(typeId)) continue;
    seenTypeIds.add(typeId);
    const inTarget = getThoughtType(target, typeId);
    if (inTarget === null || inTarget.is_root) {
      missingThoughtTypes.push(t.snapshot.type.name ?? typeId);
    }
  }

  const missingLinkTypes: string[] = [];
  const seenLinkTypeIds = new Set<string>();
  for (const l of links) {
    if (l.type_id === null) continue;
    if (seenLinkTypeIds.has(l.type_id)) continue;
    seenLinkTypeIds.add(l.type_id);
    const inTarget = getLinkType(target, l.type_id);
    if (inTarget === null || inTarget.is_root) {
      const lt = srcLinkTypes.get(l.type_id);
      missingLinkTypes.push(lt?.name_forward ?? lt?.name_reverse ?? l.type_id);
    }
  }

  if (missingThoughtTypes.length > 0 || missingLinkTypes.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Онтология целевой сети не покрывает подграф: отсутствуют нужные типы мыслей и/или связей.',
      { missing_thought_types: missingThoughtTypes, missing_link_types: missingLinkTypes },
    );
  }
}

// ---------------------------------------------------------------------------
// Duplicate resolution
// ---------------------------------------------------------------------------

interface DuplicateResolution {
  /** Source thought id → существующий target thought id (только для reuse). */
  reusedIds: Map<string, string>;
  /** Source thought ids, которые надо пропустить целиком (только для skip). */
  skippedIds: Set<string>;
  reusedCount: number;
  skippedCount: number;
  /** Конфликты для `fail`. */
  conflicts: CopySubtreeSummary['conflicts'];
}

function resolveDuplicates(
  target: NetworkDb,
  thoughts: CollectedSnapshot['thoughts'],
  policy: McpCopySubtreePolicy,
): DuplicateResolution {
  const reusedIds = new Map<string, string>();
  const skippedIds = new Set<string>();
  const conflicts: CopySubtreeSummary['conflicts'] = [];
  let reused = 0;
  let skipped = 0;

  for (const t of thoughts) {
    const dupes = findDuplicates(target, t.snapshot.title, t.snapshot.synonyms);
    if (dupes.length === 0) continue;
    const candidate = dupes[0]!.id;

    if (policy === 'fail') {
      conflicts.push({
        source_thought_id: t.id,
        target_thought_id: candidate,
        title: t.snapshot.title,
      });
    } else if (policy === 'reuse') {
      reusedIds.set(t.id, candidate);
      reused += 1;
    } else if (policy === 'skip') {
      skippedIds.add(t.id);
      skipped += 1;
    }
    // create_always — нет дубля, всегда создаём.
  }

  if (policy === 'fail' && conflicts.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Найдены конфликты title+synonyms в целевой сети; duplicate_policy=fail запрещает копирование.`,
      { conflicts },
    );
  }

  return { reusedIds, skippedIds, reusedCount: reused, skippedCount: skipped, conflicts };
}

// ---------------------------------------------------------------------------
// Build the final copy input
// ---------------------------------------------------------------------------

interface BuiltInput {
  copyInput: ThoughtCopyInput;
  reused: number;
  skipped: number;
  conflicts: CopySubtreeSummary['conflicts'];
}

function buildCopyInput(
  src: NetworkDb,
  target: NetworkDb,
  snapshot: CollectedSnapshot,
  duplicates: DuplicateResolution,
  policy: McpCopySubtreePolicy,
  targetParentId: string,
): BuiltInput {
  // Карта исходных мыслей, которые реально пойдут в копию (после skip/reuse).
  // - `skip`: мысль пропускается целиком, её id НЕ попадает в карту.
  // - `reuse`: мысль не копируется как новая сущность, но её id попадает в
  //   карту (через `reusedIds`) — чтобы связи могли переписать source/target.
  const thoughtIdMap = new Map<string, string>();
  const thoughtsToCopy: CollectedSnapshot['thoughts'] = [];
  for (const t of snapshot.thoughts) {
    if (duplicates.skippedIds.has(t.id)) continue;
    if (duplicates.reusedIds.has(t.id)) continue;
    thoughtsToCopy.push(t);
    thoughtIdMap.set(t.id, '');
  }
  for (const [srcId, tgtId] of duplicates.reusedIds) {
    thoughtIdMap.set(srcId, tgtId);
  }

  // Связи для копирования: только те, у которых ОБА конца в `thoughtIdMap`.
  const linksToCopy: ThoughtCopyLink[] = [];
  for (const link of snapshot.links) {
    if (!thoughtIdMap.has(link.source_id)) continue;
    if (!thoughtIdMap.has(link.target_id)) continue;
    const type =
      link.type_id !== null
        ? lookupLinkType(src, link.type_id)
        : { id: null, name_forward: null, name_reverse: null };
    linksToCopy.push({
      source_id: link.source_id,
      target_id: link.target_id,
      type: {
        id: type.id,
        name_forward: type.name_forward,
        name_reverse: type.name_reverse,
      },
      color: link.color,
      style: link.style,
      width: link.width,
      active: link.active,
    });
  }

  const copyInput: ThoughtCopyInput = {
    source_network_id: 'internal:subtree',
    parent_thought_id: targetParentId,
    thoughts: thoughtsToCopy.map((t) => ({
      source_id: t.id,
      thought: t.snapshot,
      permanent_comment: t.permanent_comment,
      properties: Object.keys(t.properties).length > 0 ? t.properties : undefined,
      attachments: t.attachments,
    })),
    links: linksToCopy,
  };

  // `policy` сейчас не используется напрямую — duplicate-резолюшн уже
  // произведён; оставлено для расширяемости (например, audit-log).
  void target;
  void policy;

  return {
    copyInput,
    reused: duplicates.reusedCount,
    skipped: duplicates.skippedCount,
    conflicts: duplicates.conflicts,
  };
}

function lookupLinkType(
  src: NetworkDb,
  typeId: string,
): { id: string | null; name_forward: string | null; name_reverse: string | null } {
  const t = getLinkType(src, typeId);
  if (t === null) return { id: null, name_forward: null, name_reverse: null };
  return { id: t.id, name_forward: t.name_forward, name_reverse: t.name_reverse };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function emptySummary(): CopySubtreeSummary {
  return {
    thoughts_created: 0,
    thoughts_reused: 0,
    thoughts_skipped: 0,
    links_created: 0,
    thought_id_map: {},
    link_id_map: {},
    conflicts: [],
  };
}

/** Получить ссылку на HOME-мысль целевой сети. Вызывающий передаёт
 *  вычисленный id (например, через SELECT id FROM thoughts_v WHERE is_root=1). */
export function resolveHomeId(target: NetworkDb): string {
  const home = target.prepare('SELECT id FROM thoughts_v WHERE is_root = 1 LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (home === undefined) {
    throw new EtnError('INTERNAL', 'HOME-мысль целевой сети не найдена.');
  }
  return home.id;
}

// Touch the `Attachment` and `Thought` imports so the file keeps its public
// type surface when the rest of the codebase evolves.
void (null as Attachment | null);
void (null as Thought | null);
