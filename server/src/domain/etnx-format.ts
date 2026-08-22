/**
 * .etnx manifest format (phase P, tasks P1–P3).
 *
 * The manifest is the JSON document at the root of a `.etnx` zip archive —
 * `02-data-model.md` §9 is the source of truth for its shape, fields, and
 * import-time invariants. This module owns:
 *
 *   * The `EtnxManifest` TypeScript shape (mirrors the JSON one-to-one).
 *   * `buildManifest` — server-side builder that reads from `NetworkDb` and
 *     assembles the full graph slice requested by the caller.
 *   * `parseManifest` — defensive JSON parser used by the importer (P3). It
 *     only validates structure, not semantics (e.g. foreign-key integrity
 *     between `thoughts[].id` and `links[].source_id`) — that lives in the
 *     commit pipeline (`upsertThoughtBundle`).
 *
 * Versioning policy: the writer stamps `version = ETNX_VERSION`; the reader
 * reads it back and logs it. There is no automated compatibility gate at
 * v.1.0 — bumps will be wired up by the first task that actually changes the
 * shape (`02-data-model.md` §9.4).
 */

import {
  EtnError,
  ETNX_VERSION,
  type Comment,
  type CommentTarget,
  type EtnxManifestSource,
  type EtnxManifest,
  type EtnxManifestType,
  type ExportEtnxOptions,
  type Link,
  type PropertyValue,
  type Thought,
  type ThoughtSynonym,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import type { Logger } from '../logger.js';

import { getThought, getThoughtOrThrow } from './thought-service.js';
import { listComments } from './comment-service.js';
import { listAttachments } from './attachment-service.js';
import { listThoughtTypes, getThoughtType } from './thought-type-service.js';
import { listLinkTypes, getLinkType } from './link-type-service.js';
import { listTypeProperties } from './property-service.js';
import { traverse } from './graph-traversal.js';

/**
 * Maximum number of nodes an export may pull in. Bounded so that a runaway
 * `include_subtree: true` does not freeze the synchronous export loop — the
 * hard limit mirrors `MCP_DEFAULTS.MAX_NODES_PER_SUBGRAPH` and surfaces as
 * `LIMIT_EXCEEDED` when exceeded.
 */
const ETNX_EXPORT_MAX_NODES = 1000;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the manifest payload for a `.etnx` export.
 *
 * Algorithm:
 *   1. Validate options (depth bounds, mutually-exclusive toggles).
 *   2. BFS-expand `rootIds` along outgoing links when `include_subtree`;
 *      collect the closed set of thought ids.
 *   3. Pull `thoughts`, `thought_synonyms`, `links` among those ids.
 *   4. Pull `comments` (permanent + chronological when requested) and
 *      `comment_targets` for those ids.
 *   5. Pull `property_values` whose `owner_id IN (ids)` for thoughts.
 *   6. Pull `attachments` for thoughts (`kind = 'url'` always, `kind = 'file'`
 *      only when `include_attachments`).
 *   7. Pull `thought_types`/`link_types` that are actually referenced —
 *      plus the root types, so the imported graph always has a base.
 *   8. Pull `type_properties` for those types (so imported thoughts carry
 *      the property schema).
 *
 * @throws EtnError `VALIDATION_ERROR` for bad option combinations.
 * @throws EtnError `LIMIT_EXCEEDED` when the node cap is hit.
 * @throws EtnError `NOT_FOUND` when a root id does not exist.
 */
export function buildManifest(
  ndb: NetworkDb,
  rootIds: string[],
  opts: ExportEtnxOptions | undefined,
  source: EtnxManifestSource,
  logger?: Logger,
): EtnxManifest {
  const options = normaliseOptions(opts);

  // 1+2. Closed thought set
  const allIds = collectThoughtIds(ndb, rootIds, options);

  // 3. Thoughts + synonyms
  const thoughts: Thought[] = [];
  const synonymRows: ThoughtSynonym[] = [];
  for (const id of allIds) {
    const t = getThoughtOrThrow(ndb, id);
    thoughts.push(stripInternalFields(t));
    synonymRows.push(...listSynonyms(ndb, id));
  }

  // 4. Links among the set
  const links = collectLinks(ndb, allIds);

  // 5. Comments (permanent always; chronological when requested)
  const { comments, commentTargets } = collectComments(ndb, allIds, options.include_chronology);

  // 6. Property values (only for thoughts — link-typed properties stay; the
  //    importer will rebind `owner_id` after link creation)
  const propertyValues = collectPropertyValues(ndb, allIds);

  // 7. Attachments (only thought attachments; only file binaries on request)
  const attachments = collectAttachments(ndb, allIds);

  // 8. Type graph: referenced types + root types
  const referencedThoughtTypeIds = collectThoughtTypeIds(ndb, thoughts);
  const referencedLinkTypeIds = collectLinkTypeIds(ndb, links);
  const thoughtTypes = collectThoughtTypes(ndb, referencedThoughtTypeIds);
  const linkTypes = collectLinkTypes(ndb, referencedLinkTypeIds);

  // 9. Property definitions for the included types
  const typeProperties = collectTypeProperties(ndb, thoughtTypes, linkTypes);

  const manifest: EtnxManifest = {
    format: 'etnx',
    version: ETNX_VERSION,
    exported_at: new Date().toISOString(),
    source,
    thought_types: thoughtTypes,
    link_types: linkTypes,
    type_properties: typeProperties,
    thoughts,
    thought_synonyms: synonymRows,
    links,
    comments,
    comment_targets: commentTargets,
    property_values: propertyValues,
    attachments,
  };

  if (logger !== undefined) {
    logger.info(
      {
        version: manifest.version,
        thoughts: thoughts.length,
        links: links.length,
        comments: comments.length,
        attachments: attachments.length,
      },
      'etnx manifest built',
    );
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Parser (used by P3 importer)
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a manifest. Validates structure (object shape,
 * required top-level fields, types of `format`/`version`). Does NOT validate
 * cross-references (e.g. that every `link.source_id` exists in
 * `thoughts[].id`) — that is the importer's job.
 *
 * @throws EtnError `VALIDATION_ERROR` when the document is not a valid
 *   `.etnx` manifest of the expected shape.
 */
export function parseManifest(json: unknown): EtnxManifest {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new EtnError('VALIDATION_ERROR', 'Корень манифеста должен быть объектом.');
  }
  const obj = json as Record<string, unknown>;
  if (obj.format !== 'etnx') {
    throw new EtnError('VALIDATION_ERROR', `Неизвестный format: ${String(obj.format)}.`, {
      expected: 'etnx',
    });
  }
  if (typeof obj.version !== 'string' || obj.version === '') {
    throw new EtnError('VALIDATION_ERROR', 'Поле version обязательно и должно быть строкой.');
  }
  for (const key of [
    'exported_at',
    'source',
    'thought_types',
    'link_types',
    'type_properties',
    'thoughts',
    'thought_synonyms',
    'links',
    'comments',
    'comment_targets',
    'property_values',
    'attachments',
  ]) {
    if (!(key in obj)) {
      throw new EtnError('VALIDATION_ERROR', `Отсутствует обязательное поле манифеста: ${key}.`, {
        field: key,
      });
    }
  }
  if (typeof obj.exported_at !== 'string') {
    throw new EtnError('VALIDATION_ERROR', 'exported_at должен быть строкой ISO-8601.', {
      field: 'exported_at',
    });
  }
  if (typeof obj.source !== 'object' || obj.source === null) {
    throw new EtnError('VALIDATION_ERROR', 'source должен быть объектом.', { field: 'source' });
  }
  for (const key of ['thought_types', 'link_types', 'type_properties', 'thoughts', 'thought_synonyms', 'links', 'comments', 'comment_targets', 'property_values', 'attachments']) {
    if (!Array.isArray(obj[key])) {
      throw new EtnError('VALIDATION_ERROR', `${key} должен быть массивом.`, { field: key });
    }
  }
  return obj as unknown as EtnxManifest;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function normaliseOptions(opts: ExportEtnxOptions | undefined): Required<ExportEtnxOptions> {
  return {
    include_types: opts?.include_types ?? true,
    include_attachments: opts?.include_attachments ?? true,
    include_chronology: opts?.include_chronology ?? true,
    include_subtree: opts?.include_subtree ?? false,
    subtree_depth: opts?.subtree_depth ?? 1,
  };
}

function collectThoughtIds(
  ndb: NetworkDb,
  rootIds: string[],
  options: Required<ExportEtnxOptions>,
): string[] {
  for (const id of rootIds) {
    if (getThought(ndb, id) === null) {
      throw new EtnError('NOT_FOUND', `Мысль ${id} не найдена.`);
    }
  }
  if (!options.include_subtree) {
    return [...rootIds];
  }
  const result = traverse(ndb, rootIds, 'children', {
    maxDepth: options.subtree_depth,
    maxNodes: ETNX_EXPORT_MAX_NODES,
  });
  if (result.truncated) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Подграф превысил лимит ${ETNX_EXPORT_MAX_NODES} узлов. Уменьшите subtree_depth или разбейте экспорт.`,
      { limit: ETNX_EXPORT_MAX_NODES },
    );
  }
  return result.ids;
}

/** Strip fields that are internal-only / per-network — the importer rebuilds them. */
function stripInternalFields(t: Thought): Thought {
  // Per §9.3: `is_root`/`is_protected` get reset, `created_by`/`updated_by`
  // get rewritten by the importer. We still send them so the manifest is
  // round-trippable for `02-data-model.md` §9.3 «На экспорте» (kept as-is).
  // `synonyms` is a JOIN of `thought_synonyms` and lives in its own array —
  // remove it from the per-thought record to avoid duplication.
  const { synonyms: _synonyms, ...rest } = t;
  void _synonyms;
  return { ...rest, synonyms: [], is_root: false, is_protected: false };
}

function listSynonyms(ndb: NetworkDb, thoughtId: string): ThoughtSynonym[] {
  return (
    ndb
      .prepare(
        'SELECT thought_id, synonym, synonym_norm FROM thought_synonyms WHERE thought_id = ? ORDER BY synonym_norm',
      )
      .all(thoughtId) as ThoughtSynonym[]
  );
}

function collectLinks(ndb: NetworkDb, ids: string[]): Link[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return ndb
    .prepare(
      `SELECT * FROM links WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders}) ORDER BY created_at`,
    )
    .all(...ids, ...ids) as Link[];
}

function collectComments(
  ndb: NetworkDb,
  ids: string[],
  includeChronology: boolean,
): { comments: Comment[]; commentTargets: CommentTarget[] } {
  const comments: Comment[] = [];
  const commentTargets: CommentTarget[] = [];
  for (const id of ids) {
    const all = listComments(ndb, 'thought', id);
    for (const c of all) {
      if (c.kind === 'chronological' && !includeChronology) continue;
      comments.push(c);
      // m2m targets — primary is c.owner_type/c.owner_id; the rest come from
      // comment_targets rows.
      for (const t of c.targets) {
        commentTargets.push({ owner_type: t.owner_type, owner_id: t.owner_id });
      }
    }
  }
  return { comments, commentTargets };
}

function collectPropertyValues(ndb: NetworkDb, ids: string[]): PropertyValue[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return ndb
    .prepare(
      `SELECT * FROM property_values
        WHERE owner_type = 'thought' AND owner_id IN (${placeholders})
        ORDER BY owner_id, property_id`,
    )
    .all(...ids) as PropertyValue[];
}

function collectAttachments(ndb: NetworkDb, ids: string[]): EtnxManifest['attachments'] {
  const rows: EtnxManifest['attachments'] = [];
  for (const id of ids) {
    const atts = listAttachments(ndb, 'thought', id);
    for (const a of atts) {
      rows.push({
        id: a.id,
        owner_type: a.owner_type,
        owner_id: a.owner_id,
        kind: a.kind,
        url: a.url,
        file_path: a.file_path,
        file_size: a.file_size,
        mime_type: a.mime_type,
        title: a.title,
        description: a.description,
        icon: a.icon,
        position: a.position,
        created_at: a.created_at,
        created_by: a.created_by,
      });
    }
  }
  return rows;
}

function collectThoughtTypeIds(ndb: NetworkDb, thoughts: Thought[]): Set<string> {
  const ids = new Set<string>();
  for (const t of thoughts) {
    if (t.type_id !== null) ids.add(t.type_id);
  }
  // Always include the root thought type so the imported graph is anchored.
  const root = ndb.prepare('SELECT id FROM thought_types WHERE is_root = 1 LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (root !== undefined) ids.add(root.id);
  return ids;
}

function collectLinkTypeIds(ndb: NetworkDb, links: Link[]): Set<string> {
  const ids = new Set<string>();
  for (const l of links) {
    if (l.type_id !== null) ids.add(l.type_id);
  }
  const root = ndb.prepare('SELECT id FROM link_types WHERE is_root = 1 LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (root !== undefined) ids.add(root.id);
  return ids;
}

function collectThoughtTypes(ndb: NetworkDb, typeIds: Set<string>): EtnxManifestType['thoughts'] {
  const out: EtnxManifestType['thoughts'] = [];
  for (const id of typeIds) {
    const t = getThoughtType(ndb, id);
    if (t !== null) out.push(t);
  }
  return out;
}

function collectLinkTypes(ndb: NetworkDb, typeIds: Set<string>): EtnxManifestType['links'] {
  const out: EtnxManifestType['links'] = [];
  for (const id of typeIds) {
    const t = getLinkType(ndb, id);
    if (t !== null) out.push(t);
  }
  return out;
}

function collectTypeProperties(
  ndb: NetworkDb,
  thoughtTypes: EtnxManifestType['thoughts'],
  linkTypes: EtnxManifestType['links'],
): EtnxManifest['type_properties'] {
  const out: EtnxManifest['type_properties'] = [];
  for (const t of thoughtTypes) {
    out.push(...listTypeProperties(ndb, 'thought_type', t.id));
  }
  for (const t of linkTypes) {
    out.push(...listTypeProperties(ndb, 'link_type', t.id));
  }
  return out;
}
