/**
 * MCP resources (task F3, docs/05-mcp-server.md §3).
 *
 * All `etn://` URIs from the spec are exposed: the static `etn://networks`
 * list plus templated per-network URIs for network meta, thoughts, neighbours,
 * comments (Markdown, `text/markdown`), attachments, links, type catalogues
 * and single type definitions (including `description` — the AI-facing type
 * context, 05 §3). Content is JSON (`application/json`) except comments.
 *
 * Every network-scoped resource re-checks membership through
 * {@link openMemberNetwork}, so the agent can only read networks of its key's
 * user (05 §2.1).
 *
 * Веха 9 (задача 937480ca): ресурсы — тонкие обёртки над теми же доменными
 * функциями, что у инструментов-близнецов. Третья копия логики чтения
 * исчезла: `etn.thought` считает метрику чтения (`recordReads`) и отдаёт
 * полный постоянный комментарий (`getThoughtMeta { fullPermanent: true }`)
 * ровно так же, как `etn.thoughts.get`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import type { Comment } from '@etn/shared';

import { getThoughtOrThrow } from '../domain/thought-service.js';
import { getThoughtMeta } from '../domain/thought-meta.js';
import { findThoughtUsage } from '../domain/property-service.js';
import { findBacklinks } from '../domain/backlinks-service.js';
import { getLink } from '../domain/link-service.js';
import { listTrash } from '../domain/trash-service.js';
import { createBodyExpander } from '../domain/transclusion-service.js';
import { listCommentsAsync, neighborsWithTotalAsync } from '../domain/heavy-read.js';
import { listAttachments } from '../domain/attachment-service.js';
import { getPublication } from '../domain/publication-service.js';
import { getThoughtType, listThoughtTypes } from '../domain/thought-type-service.js';
import { getLinkType, listLinkTypes } from '../domain/link-type-service.js';
import {
  getPropertyValuesResolved,
  listEffectiveTypeProperties,
} from '../domain/property-service.js';
import { recordReads } from '../domain/read-metrics-service.js';
import { linkTypeCatalog, thoughtTypeCatalog, withSanitizedIcon } from './catalogs.js';
import { etnErrorText, openMemberNetwork, type McpRuntime } from './context.js';

/** JSON content of one resource read (pretty-printed for the agent). */
function jsonContents(uri: string, value: unknown): ReadResourceResult {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  };
}

/** Markdown content for a resource read (used by the comments resource). */
function markdownContents(uri: string, text: string): ReadResourceResult {
  return { contents: [{ uri, mimeType: 'text/markdown', text }] };
}

/** Wrap a resource read so domain errors surface as clean MCP errors. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new Error(etnErrorText(err));
  }
}

/** Асинхронный вариант: чтение идёт в reader-пул (задача 514dc30f). */
async function guardedAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(etnErrorText(err));
  }
}

/** MIME type for JSON resources (constant kept in one place). */
const JSON_MIME = 'application/json';

/** Render a thought's comments as Markdown (05 §3: comments as Markdown). */
function commentsMarkdown(title: string, comments: Comment[]): string {
  const lines: string[] = [`# Comments: ${title}`, ''];
  if (comments.length === 0) {
    lines.push('_No comments._');
    return lines.join('\n');
  }
  for (const c of comments) {
    const heading = c.title ?? (c.kind === 'permanent' ? 'Permanent' : 'Chronological');
    lines.push(`## ${heading}`);
    const range =
      c.kind === 'chronological'
        ? c.valid_to
          ? `${c.valid_from} — ${c.valid_to}`
          : c.valid_from
        : c.created_at;
    lines.push(`*${range} — ${c.created_by}*`, '', c.body_md, '');
  }
  return lines.join('\n');
}

/**
 * Register every `etn://` resource (05 §3). `mcp` must be a freshly built
 * {@link McpServer}; handlers close over the runtime for auth/membership.
 */
export function registerResources(mcp: McpServer, rt: McpRuntime): void {
  // --- etn://networks (static list, 05 §3) ----------------------------------
  mcp.registerResource(
    'etn.networks',
    'etn://networks',
    {
      title: 'Available networks',
      description:
        'The networks the key user is a member of, with the role in each.',
      mimeType: JSON_MIME,
    },
    (uri) =>
      jsonContents(
        uri.href,
        guarded(() => rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId)),
      ),
  );

  // --- etn://networks/{network_id} (network meta) ----------------------------
  mcp.registerResource(
    'etn.network.meta',
    new ResourceTemplate('etn://networks/{network_id}', { list: undefined }),
    {
      title: 'Network metadata',
      description: 'The network registry record and the key user role in it.',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        openMemberNetwork(rt, networkId);
        const network = rt.deps.systemDb.getNetworkById(networkId);
        if (network === null) {
          throw new Error(`ETN error [NOT_FOUND]: network ${networkId} not found`);
        }
        const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, networkId);
        return jsonContents(uri.href, { ...network, role });
      }),
  );

  // --- etn://networks/{network_id}/thoughts/{thought_id} ----------------------
  mcp.registerResource(
    'etn.thought',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}', { list: undefined }),
    {
      title: 'Thought (full)',
      description:
        'The thought in full: properties, synonyms, type (with AI description), styles and property values. ' +
        'The `meta` block — link/attachment/chronicle counters and the **full** text of the permanent ' +
        'comment (same as `etn.thoughts.get`).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        const rawThought = getThoughtOrThrow(ndb, thoughtId);
        const rawType = rawThought.type_id === null ? null : getThoughtType(ndb, rawThought.type_id);
        // Задача 7849008a, требование 6d4ad9ac: фильтр прав для
        // `cross_network_ref` — пользователь видит только значения в доступных сетях.
        const accessibleNetworkIds = new Set(
          rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId).map((n) => n.id),
        );
        const properties = getPropertyValuesResolved(ndb, 'thought', thoughtId, accessibleNetworkIds);
        // O10: метрика чтения — как у инструмента `etn.thoughts.get`.
        recordReads(ndb, [rawThought.id], { now: new Date().toISOString() });
        // Bug fix (docs/05-mcp-server.md §5.1e): drop an inline `data:` icon
        // URL — see `withSanitizedIcon` in ./catalogs.ts for the rationale.
        // Полный постоянный комментарий — как у `etn.thoughts.get`
        // (`getThoughtMeta { fullPermanent: true }`).
        return jsonContents(uri.href, {
          ...withSanitizedIcon(rawThought),
          type: rawType === null ? null : withSanitizedIcon(rawType),
          properties,
          meta: getThoughtMeta(ndb, thoughtId, { fullPermanent: true }),
        });
      }),
  );

  // --- neighbours ------------------------------------------------------------
  mcp.registerResource(
    'etn.thought.neighbors',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/neighbors', {
      list: undefined,
    }),
    {
      title: 'Thought neighbors',
      description:
        'Parents, children and siblings of the thought (as on the focus canvas), plus the catalogues ' +
        'of the types used (`link_types`/`thought_types` with AI descriptions).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guardedAsync(async () => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        const thought = getThoughtOrThrow(ndb, thoughtId);
        // Bug fix (§5.1e): sanitize each neighbour's `icon` — `FocusNeighbor`
        // is not gated by a `view` param, a `data:` URL would otherwise leak.
        // Три направления — три задачи reader-пула (задача 514dc30f).
        const opts = { userId: rt.deps.auth.userId };
        const [parentsPage, childrenPage, siblingsPage] = await Promise.all([
          neighborsWithTotalAsync(ndb, thoughtId, 'parents', opts),
          neighborsWithTotalAsync(ndb, thoughtId, 'children', opts),
          neighborsWithTotalAsync(ndb, thoughtId, 'siblings', opts),
        ]);
        const parents = parentsPage.neighbors.map((n) => withSanitizedIcon(n));
        const children = childrenPage.neighbors.map((n) => withSanitizedIcon(n));
        const siblings = siblingsPage.neighbors.map((n) => withSanitizedIcon(n));
        const all = [...parents, ...children, ...siblings];
        return jsonContents(uri.href, {
          thought: { id: thought.id, title: thought.title },
          parents,
          children,
          siblings,
          link_types: linkTypeCatalog(ndb, all.map((n) => n.link_type_id)),
          thought_types: thoughtTypeCatalog(ndb, all.map((n) => n.type_id)),
        });
      }),
  );

  // --- usage (reverse link-property lookup, 03-server-api.md §9.1) ------------
  mcp.registerResource(
    'etn.thought.usage',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/usage', {
      list: undefined,
    }),
    {
      title: 'Thought usage',
      description:
        'Thoughts referencing this one through link properties (formal links, ' +
        '"Usage" in the editor), grouped by property.',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        getThoughtOrThrow(ndb, thoughtId);
        return jsonContents(uri.href, findThoughtUsage(ndb, thoughtId));
      }),
  );

  // --- backlinks (explicit ID-based wiki references, 03-server-api.md §13a) --
  mcp.registerResource(
    'etn.thought.backlinks',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/backlinks', {
      list: undefined,
    }),
    {
      title: 'References to the thought',
      description:
        'Comments whose body_md contains an explicit ID reference [[#<id>]] or ' +
        '[[n:<net>#<id>]] to this thought (phase R). Semantically different from ' +
        'mentions by name/synonym (`etn.ops { action: "thoughts.mentions" }`, ' +
        'FTS over title/synonyms) — here it is an explicit UUID. ' +
        'Returns a MentionHit array (one item per (owner_type, owner_id)).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        getThoughtOrThrow(ndb, thoughtId);
        return jsonContents(uri.href, findBacklinks(ndb, thoughtId));
      }),
  );

  // --- comments (Markdown) ----------------------------------------------------
  mcp.registerResource(
    'etn.thought.comments',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/comments', {
      list: undefined,
    }),
    {
      title: 'Thought comments (Markdown)',
      description: 'The permanent and chronological comments of the thought as Markdown.',
      mimeType: 'text/markdown',
    },
    (uri, vars) =>
      guardedAsync(async () => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        const thought = getThoughtOrThrow(ndb, thoughtId);
        // MCP-ресурс комментариев разворачивает трансклюзии (ТП2, задача
        // bcfc7eb7, ADR 85a7a01e): в базе хранится исходная ссылка. Само
        // чтение — в reader-пуле (задача 514dc30f); разворот остаётся здесь:
        // у него своя семантика (маркеры границ) на весь набор.
        const expand = createBodyExpander(ndb);
        const comments = (await listCommentsAsync(ndb, 'thought', thoughtId)).map((c) => ({
          ...c,
          body_md: expand(c.body_md),
        }));
        return markdownContents(uri.href, commentsMarkdown(thought.title, comments));
      }),
  );

  // --- attachments -------------------------------------------------------------
  mcp.registerResource(
    'etn.thought.attachments',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/attachments', {
      list: undefined,
    }),
    {
      title: 'Thought attachments',
      description: 'The list of thought attachments (url/file).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        getThoughtOrThrow(ndb, thoughtId);
        return jsonContents(uri.href, listAttachments(ndb, 'thought', thoughtId));
      }),
  );

  // Вложения публикации (0.11.1, задача 46cf4bcb) — паритет REST
  // `GET /publications/{id}/attachments` и с ресурсом вложений мысли.
  mcp.registerResource(
    'etn.publication.attachments',
    new ResourceTemplate('etn://networks/{network_id}/publications/{publication_id}/attachments', {
      list: undefined,
    }),
    {
      title: 'Publication attachments',
      description: 'The list of publication attachments (url/file).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const publicationId = requireVar(vars, 'publication_id');
        const ndb = openMemberNetwork(rt, networkId);
        if (getPublication(ndb, publicationId) === null) {
          throw new Error(`ETN error [NOT_FOUND]: publication ${publicationId} not found`);
        }
        return jsonContents(uri.href, listAttachments(ndb, 'publication', publicationId));
      }),
  );

  // --- etn://networks/{network_id}/links/{link_id} ------------------------------
  mcp.registerResource(
    'etn.link',
    new ResourceTemplate('etn://networks/{network_id}/links/{link_id}', { list: undefined }),
    {
      title: 'Link (with metadata)',
      description: 'A link between thoughts with its type (including the type description).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const linkId = requireVar(vars, 'link_id');
        const ndb = openMemberNetwork(rt, networkId);
        const link = getLink(ndb, linkId);
        if (link === null) {
          throw new Error(`ETN error [NOT_FOUND]: link ${linkId} not found`);
        }
        const type = link.type_id === null ? null : getLinkType(ndb, link.type_id);
        return jsonContents(uri.href, { ...link, type });
      }),
  );

  // --- trash (S13, 03-server-api.md §14b) ------------------------------------
  mcp.registerResource(
    'etn.trash',
    new ResourceTemplate('etn://networks/{network_id}/trash', { list: undefined }),
    {
      title: 'Network basket',
      description:
        'Thoughts and links of the network marked for deletion, each with a precomputed block ' +
        '(S13; call — `etn.ops { action: "trash.list" }`).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const ndb = openMemberNetwork(rt, requireVar(vars, 'network_id'));
        return jsonContents(uri.href, listTrash(ndb));
      }),
  );

  // --- type catalogues -----------------------------------------------------------
  mcp.registerResource(
    'etn.thought-types',
    new ResourceTemplate('etn://networks/{network_id}/thought-types', { list: undefined }),
    {
      title: 'Thought types',
      description: 'All thought type definitions of the network (with description for AI).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const ndb = openMemberNetwork(rt, requireVar(vars, 'network_id'));
        // Bug fix (§5.1e): drop inline `data:` icon URLs from every type.
        return jsonContents(uri.href, listThoughtTypes(ndb).map((t) => withSanitizedIcon(t)));
      }),
  );

  mcp.registerResource(
    'etn.link-types',
    new ResourceTemplate('etn://networks/{network_id}/link-types', { list: undefined }),
    {
      title: 'Link types',
      description: 'All link type definitions of the network (with description for AI).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const ndb = openMemberNetwork(rt, requireVar(vars, 'network_id'));
        return jsonContents(uri.href, listLinkTypes(ndb));
      }),
  );

  mcp.registerResource(
    'etn.thought-type',
    new ResourceTemplate('etn://networks/{network_id}/thought-types/{type_id}', {
      list: undefined,
    }),
    {
      title: 'Thought type (properties and description)',
      description:
        'One thought type: the definition, `description` for AI context and the **effective** property ' +
        'bindings — own plus inherited from ancestors (L21, 02-data-model.md §3.4.1). ' +
        'Each record carries the `property_id` of the registry property, `defined_on` (on which type ' +
        'the binding is declared), `inherited`, `default_value` with the override chain and ' +
        '`description_overridden` (the description override of this type). This is the same shape ' +
        'that `etn.types.list` returns — the resource is kept for compatibility.',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const typeId = requireVar(vars, 'type_id');
        const ndb = openMemberNetwork(rt, networkId);
        const type = getThoughtType(ndb, typeId);
        if (type === null) {
          throw new Error(`ETN error [NOT_FOUND]: thought type ${typeId} not found`);
        }
        // Bug fix (§5.1e): drop an inline `data:` icon URL.
        // 0.6.5 (f14cd5f1): use effective bindings (L21) instead of the type's
        // own ones — an agent reading «what properties does this type expose?»
        // expects inherited properties too. Same shape as `etn.types.list`'s
        // `properties` block, so a tool/resource reader can share code.
        return jsonContents(uri.href, {
          ...withSanitizedIcon(type),
          properties: listEffectiveTypeProperties(ndb, 'thought_type', typeId),
        });
      }),
  );
}

/** Read a required template variable; internal (vars are runtime-typed). */
function requireVar(vars: Record<string, string | string[]>, name: string): string {
  const raw = vars[name];
  const value = Array.isArray(raw) ? (raw[0] ?? '') : raw;
  if (typeof value !== 'string' || value === '') {
    throw new Error(`ETN error [VALIDATION_ERROR]: resource URI variable {${name}} is missing`);
  }
  return value;
}
