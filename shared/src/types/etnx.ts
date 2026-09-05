/**
 * `.etnx` manifest DTOs (phase P, tasks P1–P3, docs/02-data-model.md §9).
 *
 * The manifest is the JSON document at the root of a `.etnx` zip archive. The
 * shape mirrors what the importer expects to read: flat arrays of every
 * entity that participates in the exported subgraph, plus the per-row
 * foreign-key targets (`type_id`, `source_id`, `owner_id`, …). UUIDs are
 * preserved as-is; the importer resolves conflicts through its policy
 * (`02-data-model.md` §9.3 «На импорте»).
 *
 * Server-side construction lives in
 * `server/src/domain/etnx-format.ts` (`buildManifest` / `parseManifest`).
 */

import type { Comment, CommentTarget } from './comment.js';
import type { Link } from './link.js';
import type { LinkType } from './link-type.js';
import type {
  NetworkProperty,
  PropertyDefinition,
  PropertyValue,
} from './thought-type.js';
import type { Thought } from './thought.js';
import type { ThoughtType } from './thought-type.js';

/** Provenance block written into every exported manifest. */
export interface EtnxManifestSource {
  /** UUID of the source network (`networks.id`). */
  network_id: string;
  /** `display_name` of the source network at export time (informational). */
  network_name: string;
  /** UUID of the user who triggered the export. */
  user_id: string;
}

/** Row of `thought_synonyms` (02-data-model.md §3.2). */
export interface ThoughtSynonym {
  thought_id: string;
  synonym: string;
  /** Normalised form (NFC + trim + lowercase) used by `findDuplicates`. */
  synonym_norm: string;
}

/**
 * Minimal attachment record written into `manifest.attachments` — the on-disk
 * shape is identical to {@link import('../../shared/types/attachment').Attachment}
 * but `kind = 'file'` rows carry a relative path under `attachments/` inside
 * the zip instead of an absolute OS path.
 */
export interface EtnxAttachment {
  id: string;
  owner_type: 'thought' | 'link';
  owner_id: string;
  kind: 'url' | 'file';
  url: string | null;
  /** Relative to `attachments/` inside the zip for `kind = 'file'`. */
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  title: string | null;
  description: string | null;
  /** data: URL preview icon (L1); kept inline. */
  icon: string | null;
  position: number;
  created_at: string;
  created_by: string;
}

/** Type-graph slice of the manifest — discriminated by the inner collection. */
export interface EtnxManifestType {
  /** Thought types referenced by the exported thoughts (plus the root type). */
  thoughts: ThoughtType[];
  /** Link types referenced by the exported links (plus the root type). */
  links: LinkType[];
}

/**
 * Full manifest object. The server writes this verbatim as `manifest.json`
 * inside the `.etnx` archive; the importer reads it back through
 * `parseManifest`.
 */
export interface EtnxManifest {
  /** Always `'etnx'`; the importer rejects anything else. */
  format: 'etnx';
  /** Format version (matches `ETNX_VERSION`); written for future migrations. */
  version: string;
  /** ISO-8601 UTC of the export. */
  exported_at: string;
  /** Provenance of the export. */
  source: EtnxManifestSource;
  thought_types: ThoughtType[];
  link_types: LinkType[];
  /** Property registry (`properties` table, 0.6.5): the network-wide nature
   *  of each property referenced by the included bindings. Unique by `name`
   *  case-insensitively — the importer merges duplicates on import. */
  properties: NetworkProperty[];
  /** Property bindings (per-type role: required, position). The
   *  `property_id` of every entry references one of the rows above. */
  type_properties: PropertyDefinition[];
  /** Exported thoughts; `is_root` and `is_protected` are stripped on export. */
  thoughts: Thought[];
  /** Synonyms belonging to the exported thoughts. */
  thought_synonyms: ThoughtSynonym[];
  /** Active links among the exported thoughts (both endpoints inside the set). */
  links: Link[];
  /** Permanent comments always; chronological comments only when
   *  `include_chronology` was true on the export. */
  comments: Comment[];
  /** Flattened m2m attachments for the exported comments (L20). */
  comment_targets: CommentTarget[];
  /** EAV values for the exported thoughts (link-typed values follow once
   *  the importer rebinds the `owner_id` of imported links). */
  property_values: PropertyValue[];
  /** Thought attachments — `kind = 'file'` rows reference paths inside the
   *  zip's `attachments/` directory. */
  attachments: EtnxAttachment[];
}
