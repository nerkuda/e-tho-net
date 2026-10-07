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
 *   * ссылки — рёбра снапшота: их типы резолвятся по id → по имени в целевой
 *     сети (включая рёбра свойств-связей, 0.8.1 — thought_ref упразднён
 *     миграцией 040);
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
  type ThoughtCopyAttachment,
  type ThoughtCopyInput,
  type ThoughtCopyItem,
  type ThoughtCopyLink,
  type ThoughtCopyResult,
  type ThoughtCopySnapshot,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { createAttachment, listAttachments } from './attachment-service.js';
import { listComments } from './comment-service.js';
import { traverse } from './graph-traversal.js';
import { createLink, findLinksBetween } from './link-service.js';
import { getPropertyValues, setPropertyValue } from './property-service.js';
import { findDuplicates } from './search-service.js';
import { getThought } from './thought-service.js';
import { copyThoughtsBatch, linkIdentity, resolveCopyLinkTypeId } from './thought-copy-service.js';
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
  /**
   * id РЕАЛЬНО созданных в целевой сети мыслей. `thought_id_map` несёт две
   * роли — remap для клиента и источник событий для `ops.ts`; вторая требует
   * отличать созданное от переиспользованного (ошибка 0a30c5e4), поэтому
   * фасад эмитит `thought.created` строго по этому списку.
   */
  created_thought_ids: string[];
  /** id РЕАЛЬНО созданных в целевой сети связей (см. `created_thought_ids`). */
  created_link_ids: string[];
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

  // 7. Материализация и докопирование одной транзакцией. Созданные мысли
  // идут через `copyThoughtsBatch`; у переиспользованных докопируется то,
  // чего у них ещё нет (связи/свойства/вложения), иначе `reuse` не
  // выполнял бы обещанного политикой (ошибка af4f6568 «reuse не докопирует
  // недостающее»). Транзакция вложена в `runWrite`-транзакцию фасада —
  // savepoint откатывает всё вместе при ошибке.
  return target_ndb.transaction(() => {
    const base: ThoughtCopyResult =
      built.copyInput.thoughts.length > 0
        ? copyThoughtsBatch(target_ndb, built.copyInput, actor_user_id)
        : emptyCopyResult();

    // Полная карта адресации: созданные (`base`) + переиспользованные.
    const thoughtIdMap: Record<string, string> = { ...base.thought_id_map };
    for (const [srcId, tgtId] of duplicateMap.reusedIds) thoughtIdMap[srcId] = tgtId;

    const fill = fillReusedThoughts(
      target_ndb,
      built.reusePlans,
      built.reuseLinks,
      thoughtIdMap,
      actor_user_id,
    );

    return {
      thoughts_created: base.created_thoughts.length,
      thoughts_reused: built.reused,
      thoughts_skipped: built.skipped,
      links_created: base.created_links.length + fill.created_link_ids.length,
      thought_id_map: thoughtIdMap,
      link_id_map: { ...base.link_id_map, ...fill.link_id_map },
      created_thought_ids: base.created_thoughts.map((t) => t.id),
      created_link_ids: [...base.created_links.map((l) => l.id), ...fill.created_link_ids],
      conflicts: built.conflicts,
    };
  });
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
          `SELECT pv.value_text, pv.value_number, pv.value_bool, pv.value_date,
                  pv.property_id, p.name AS property_key, p.value_type AS property_value_type
             FROM property_values_v pv
             JOIN properties_v p ON p.id = pv.property_id
            WHERE pv.owner_type = 'thought' AND pv.owner_id = ?`,
        )
        .all(id) as Array<{
        value_text: string | null;
        value_number: number | null;
        value_bool: number | null;
        value_date: string | null;
        property_key: string;
        property_value_type: string;
      }>;
      for (const r of rows) {
        properties[r.property_key] = decodePropertyValue(
          r.value_text,
          r.value_number,
          r.value_bool,
          r.value_date,
          r.property_value_type,
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
        icon_color: t.icon_color,
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

/** Преобразовать строку БД в PropertyValueValue с учётом value_type.
 *  Свойства-связи (`link`) значений в `property_values` не хранят — их
 *  рёбра копируются механикой рёбер снапшота (0.8.1). */
function decodePropertyValue(
  text: string | null,
  number: number | null,
  bool: number | null,
  date: string | null,
  valueType: string,
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
    case 'link':
      // строка-призрак (остаток миграции 040) — в копию не переносится
      return null;
    case 'cross_network_ref':
      // Кросс-сетевая ссылка (задача 7849008a, требование 717ca2cb):
      // адрес уже указывает конкретную сеть, перезапись/резолв не нужны —
      // копируем как есть. Снапшот имени — служебные данные, в копии
      // останется прежним до явного `cross-resolve` в новой сети.
      return text;
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
  /** Что докопировать переиспользованным мыслям (свойства/вложения). */
  reusePlans: ReusePlan[];
  /**
   * Связи снапшота, у которых хотя бы один конец переиспользован. Их создаёт
   * не `copyThoughtsBatch` (он не знает про reused-мысли), а
   * {@link fillReusedThoughts}: существующая связь переиспользуется, отсутствующая
   * создаётся.
   */
  reuseLinks: ThoughtCopyLink[];
  reused: number;
  skipped: number;
  conflicts: CopySubtreeSummary['conflicts'];
}

/** Недостающие части для переиспользованной мысли из снапшота. */
interface ReusePlan {
  target_id: string;
  properties: Record<string, PropertyValueValue>;
  attachments: ReadonlyArray<ThoughtCopyAttachment>;
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

  // Связи: те, у которых ОБА конца создаются, отдаём `copyThoughtsBatch`;
  // остальные (хотя бы один конец переиспользован) — на докопирование.
  const createdSourceIds = new Set(thoughtsToCopy.map((t) => t.id));
  const linksToCopy: ThoughtCopyLink[] = [];
  const reuseLinks: ThoughtCopyLink[] = [];
  for (const link of snapshot.links) {
    if (!thoughtIdMap.has(link.source_id)) continue;
    if (!thoughtIdMap.has(link.target_id)) continue;
    const type =
      link.type_id !== null
        ? lookupLinkType(src, link.type_id)
        : { id: null, name_forward: null, name_reverse: null };
    const builtLink: ThoughtCopyLink = {
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
    };
    if (createdSourceIds.has(link.source_id) && createdSourceIds.has(link.target_id)) {
      linksToCopy.push(builtLink);
    } else {
      reuseLinks.push(builtLink);
    }
  }

  // Планы докопирования для переиспользованных мыслей: свойства и вложения,
  // которых у существующей мысли ещё нет.
  const snapshotById = new Map(snapshot.thoughts.map((t) => [t.id, t]));
  const reusePlans: ReusePlan[] = [];
  for (const [srcId, tgtId] of duplicates.reusedIds) {
    const t = snapshotById.get(srcId);
    if (t === undefined) continue;
    reusePlans.push({
      target_id: tgtId,
      properties: t.properties,
      attachments: t.attachments ?? [],
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
    reusePlans,
    reuseLinks,
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

/**
 * Докопировать переиспользованным мыслям то, чего у них ещё нет (ошибка
 * «reuse не докопирует недостающее»): отсутствующие связи, свойства и
 * вложения. Уже существующее не дублируется и не перезаписывается —
 * повторное копирование идемпотентно.
 *
 *  * **Свойства** — по ключу: если у целевой мысли ключ уже есть, значение не
 *    трогаем (политика `reuse` не перезаписывает существующее); отсутствующий
 *    ключ записываем.
 *  * **Вложения** — сравнение по видимым полям (`kind` + `url`/`file_path` +
 *    `title`/`description`): совпадающее вложение не создаётся повторно.
 *  * **Связи** — для каждого ребра снапшота, у которого хотя бы один конец
 *    переиспользован: ищем эквивалент по `(source, target, type)` в целевой
 *    сети; нашли — кладём в `link_id_map`; нет — создаём (это и есть
 *    докопирование отсутствующей связи).
 *
 * `combinedMap` — полная карта адресации `source → target` (созданные +
 * переиспользованные); по ней разрешаются концы рёбер. Всё выполняется в
 * транзакции вызывающего.
 */
function fillReusedThoughts(
  target: NetworkDb,
  plans: ReadonlyArray<ReusePlan>,
  links: ReadonlyArray<ThoughtCopyLink>,
  combinedMap: Record<string, string>,
  actorUserId: string,
): { link_id_map: Record<string, string>; created_link_ids: string[] } {
  for (const plan of plans) {
    const existingKeys = new Set(
      getPropertyValues(target, 'thought', plan.target_id).map((p) => p.property_name),
    );
    for (const [key, value] of Object.entries(plan.properties)) {
      if (existingKeys.has(key)) continue;
      try {
        setPropertyValue(target, 'thought', plan.target_id, key, value, actorUserId);
      } catch (err) {
        // Значение, не подходящее типу целевой сети, не должен ронять всю копию
        // (та же деградация, что у `copyThoughtsBatch`).
        if (!(err instanceof EtnError)) throw err;
      }
    }

    const existingAttachments = listAttachments(target, 'thought', plan.target_id);
    for (const a of plan.attachments) {
      if (existingAttachments.some((e) => sameVisibleAttachment(e, a))) continue;
      try {
        createAttachment(
          target,
          'thought',
          plan.target_id,
          {
            kind: a.kind,
            url: a.url ?? null,
            file_path: a.file_path ?? null,
            file_size: a.file_size ?? null,
            mime_type: a.mime_type ?? null,
            title: a.title ?? null,
            description: a.description ?? null,
          },
          actorUserId,
        );
      } catch (err) {
        if (!(err instanceof EtnError)) throw err;
      }
    }
  }

  const linkIdMap: Record<string, string> = {};
  const createdLinkIds: string[] = [];
  for (const link of links) {
    const sourceId = combinedMap[link.source_id];
    const targetId = combinedMap[link.target_id];
    if (sourceId === undefined || targetId === undefined) continue;
    if (sourceId === targetId) continue;
    const typeId = resolveCopyLinkTypeId(target, link.type);
    const existing = findLinksBetween(target, sourceId, targetId, typeId).find((l) => l.active);
    if (existing !== undefined) {
      linkIdMap[linkIdentity(link)] = existing.id;
      continue;
    }
    try {
      const created = createLink(
        target,
        {
          source_id: sourceId,
          target_id: targetId,
          type_id: typeId,
          color: link.color,
          style: link.style,
          width: link.width,
          active: link.active,
        },
        actorUserId,
      );
      linkIdMap[linkIdentity(link)] = created.id;
      createdLinkIds.push(created.id);
    } catch (err) {
      if (!(err instanceof EtnError)) throw err;
    }
  }
  return { link_id_map: linkIdMap, created_link_ids: createdLinkIds };
}

/** Совпадают ли видимые поля вложения снапшота и уже существующего. */
function sameVisibleAttachment(existing: Attachment, wanted: ThoughtCopyAttachment): boolean {
  return (
    existing.kind === wanted.kind &&
    (existing.url ?? null) === (wanted.url ?? null) &&
    (existing.file_path ?? null) === (wanted.file_path ?? null) &&
    (existing.title ?? null) === (wanted.title ?? null) &&
    (existing.description ?? null) === (wanted.description ?? null)
  );
}

/** Пустой результат материализации (когда создавать нечего). */
function emptyCopyResult(): ThoughtCopyResult {
  return {
    thought_id_map: {},
    link_id_map: {},
    created_thoughts: [],
    created_links: [],
    created_attachments: [],
  };
}

function emptySummary(): CopySubtreeSummary {
  return {
    thoughts_created: 0,
    thoughts_reused: 0,
    thoughts_skipped: 0,
    links_created: 0,
    thought_id_map: {},
    link_id_map: {},
    created_thought_ids: [],
    created_link_ids: [],
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
