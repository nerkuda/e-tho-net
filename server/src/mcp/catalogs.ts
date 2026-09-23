/**
 * Type catalogues for MCP read responses (task N6, docs/05-mcp-server.md §4.1).
 *
 * Read tools return `type_id`/`link_type_id` as bare UUIDs; these helpers build
 * the accompanying reference tables (`thought_types` / `link_types`) containing
 * **only** the types actually present in the response, each as a thin record —
 * `id` + `name` (+ `icon` for thought types) in list responses (0.8.3,
 * требование «Каталоги типов в ответах read-инструментов»). AI-facing
 * `description`, hierarchy and visual fields are not repeated per record; the
 * full catalogue lives in `etn.types.list`.
 */

import type {
  CardThoughtTypeRef,
  CompactThought,
  ListLinkTypeRef,
  ListThoughtTypeRef,
  Thought,
  ThoughtTypeRef,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getLinkType } from '../domain/link-type-service.js';
import { getThoughtType } from '../domain/thought-type-service.js';

// ---------------------------------------------------------------------------
// Icon sanitisation (bug fix, docs/05-mcp-server.md §5.1e) — image icons are
// stored as self-contained `data:image/...;base64,...` URLs up to 256 KiB
// (docs/02-data-model.md §3.1 «Мысли», §3.3 «thought_types»; the client's
// «Файл» icon-picker tab inlines the picked file this way, `icon_attachment_id`
// only points at the *original* attachment for the human «Ctrl+hover» preview).
// That payload is essential for the desktop client to *render* the icon, but
// pure noise to an MCP agent that cannot see images — one type used across a
// response added ~3 KB per occurrence, a single 50 KiB SVG thought icon added
// ~50 KiB to one `search` call, both burning the `max_chars` budget instead of
// carrying knowledge (§5.1e already promises the agent only the *semantic*
// icon — an emoji or a short path/URL). Icons picked via the «URL» tab (a real
// `http(s)://…` link, still `icon_kind: 'image'`) are short and are passed
// through unchanged; only the inline `data:` payload is ever replaced.
// ---------------------------------------------------------------------------

/** Placeholder returned instead of an inline `data:` icon URL (see above). */
export const ICON_DATA_URL_PLACEHOLDER = '(image icon omitted by MCP — inline data URL, not resolvable)';

/** Replace an inline `data:` icon URL with {@link ICON_DATA_URL_PLACEHOLDER};
 *  `null`, an emoji or a real `http(s)://` URL pass through unchanged. */
export function sanitizeIcon(icon: string | null): string | null {
  return icon !== null && icon.startsWith('data:') ? ICON_DATA_URL_PLACEHOLDER : icon;
}

/** {@link sanitizeIcon} applied in place to any object carrying an
 *  `icon: string | null` field (thoughts, thought types, thought refs). */
export function withSanitizedIcon<T extends { icon: string | null }>(obj: T): T {
  const sanitized = sanitizeIcon(obj.icon);
  return sanitized === obj.icon ? obj : { ...obj, icon: sanitized };
}

/**
 * Thin catalogue of thought types keyed by type id for the reference tables of
 * every list response: `{ [type_id]: {id, name, icon} }` (0.8.3, требование
 * «Каталоги типов в ответах read-инструментов»). Only the fields an agent
 * needs to recognise a type and follow its id; the full AI-facing
 * `description`/`parent_id`/`is_root` live in `etn.types.list`. Unknown/removed
 * ids are skipped (`thoughts.type_id` has no SQL FK).
 */
export function thoughtTypeCatalog(
  ndb: NetworkDb,
  ids: ReadonlyArray<string | null>,
): Record<string, ListThoughtTypeRef> {
  const out: Record<string, ListThoughtTypeRef> = {};
  for (const id of new Set(ids.filter((x): x is string => x !== null))) {
    const type = getThoughtType(ndb, id);
    if (type !== null) {
      out[id] = { id: type.id, name: type.name, icon: sanitizeIcon(type.icon) };
    }
  }
  return out;
}

/**
 * Thin catalogue of link types keyed by type id for the reference tables of
 * every list response: `{ [link_type_id]: {id, name_forward, name_reverse} }`
 * (0.8.3). Both names are kept so the agent picks by edge direction; the
 * AI-facing `description` lives in `etn.types.list`. Unknown/removed ids are
 * skipped (`links.type_id` has no SQL FK).
 */
export function linkTypeCatalog(
  ndb: NetworkDb,
  ids: ReadonlyArray<string | null>,
): Record<string, ListLinkTypeRef> {
  const out: Record<string, ListLinkTypeRef> = {};
  for (const id of new Set(ids.filter((x): x is string => x !== null))) {
    const type = getLinkType(ndb, id);
    if (type !== null) {
      out[id] = {
        id: type.id,
        name_forward: type.name_forward,
        name_reverse: type.name_reverse,
      };
    }
  }
  return out;
}

/**
 * Thin nested type for a card (`etn.thoughts.get`/`resolve`, 0.8.3): `id`,
 * `name` and the AI-facing `description` only — no visual fields. `null` in,
 * `null` out.
 */
export function toCardThoughtType(type: ThoughtTypeRef | null): CardThoughtTypeRef | null {
  return type === null ? null : { id: type.id, name: type.name, description: type.description };
}

// ---------------------------------------------------------------------------
// Compact projection (task O12, docs/05-mcp-server.md §4.1)
// ---------------------------------------------------------------------------

/**
 * Project a {@link Thought} into the compact shape used by the point read
 * `etn.thoughts.get` under `view: 'compact'` (task O12). Drops the visual/
 * service fields the agent never consumes (colours, font-style flags, icon
 * attachment id, `is_protected`/`is_root`); keeps `icon` (the emoji / image
 * reference itself) because it carries semantic information the agent uses to
 * recognise a node, and keeps the service fields (`version`, authorship) —
 * the point read preserves the full projection.
 *
 * Списочные ответы идут через `projection.ts` (`projectThoughtRow`), где
 * сервисные поля снимаются; точечный `get` остаётся полным.
 */
export function toCompactThought(thought: Thought): CompactThought {
  return {
    id: thought.id,
    title: thought.title,
    type_id: thought.type_id,
    icon: sanitizeIcon(thought.icon),
    active: thought.active,
    marked_for_deletion: thought.marked_for_deletion,
    marked_for_deletion_at: thought.marked_for_deletion_at,
    marked_for_deletion_by: thought.marked_for_deletion_by,
    synonyms: thought.synonyms,
    version: thought.version,
    created_at: thought.created_at,
    updated_at: thought.updated_at,
    ...(thought.created_by !== undefined ? { created_by: thought.created_by } : {}),
    ...(thought.updated_by !== undefined ? { updated_by: thought.updated_by } : {}),
  };
}
