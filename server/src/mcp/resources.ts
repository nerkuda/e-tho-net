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
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { getThoughtOrThrow } from '../domain/thought-service.js';
import { getThoughtMeta } from '../domain/thought-meta.js';
import { findThoughtUsage } from '../domain/property-service.js';
import { findBacklinks } from '../domain/backlinks-service.js';
import { getNeighbors } from '../domain/thought-service.js';
import { getLink } from '../domain/link-service.js';
import { listComments } from '../domain/comment-service.js';
import { listAttachments } from '../domain/attachment-service.js';
import { getThoughtType, listThoughtTypes } from '../domain/thought-type-service.js';
import { getLinkType, listLinkTypes } from '../domain/link-type-service.js';
import { getPropertyValuesResolved, listTypeProperties } from '../domain/property-service.js';
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

/** MIME type for JSON resources (constant kept in one place). */
const JSON_MIME = 'application/json';

/** Render a thought's comments as Markdown (05 §3: comments as Markdown). */
function commentsMarkdown(title: string, comments: ReturnType<typeof listComments>): string {
  const lines: string[] = [`# Комментарии: ${title}`, ''];
  if (comments.length === 0) {
    lines.push('_Комментариев нет._');
    return lines.join('\n');
  }
  for (const c of comments) {
    const heading = c.title ?? (c.kind === 'permanent' ? 'Постоянный' : 'Хронология');
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
      title: 'Доступные сети',
      description:
        'Список сетей, участником которых является пользователь ключа, с ролью в каждой.',
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
      title: 'Метаданные сети',
      description: 'Реестровая запись сети и роль пользователя ключа в ней.',
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
      title: 'Мысль (полная)',
      description:
        'Мысль целиком: свойства, синонимы, тип (с описанием для AI), стили и значения свойств. ' +
        'Блок `meta` — счётчики связей/вложений/хроники и превью постоянного комментария.',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        const rawThought = getThoughtOrThrow(ndb, thoughtId);
        const rawType = rawThought.type_id === null ? null : getThoughtType(ndb, rawThought.type_id);
        const properties = getPropertyValuesResolved(ndb, 'thought', thoughtId);
        // Bug fix (docs/05-mcp-server.md §5.1e): drop an inline `data:` icon
        // URL — see `withSanitizedIcon` in ./catalogs.ts for the rationale.
        return jsonContents(uri.href, {
          ...withSanitizedIcon(rawThought),
          type: rawType === null ? null : withSanitizedIcon(rawType),
          properties,
          meta: getThoughtMeta(ndb, thoughtId),
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
      title: 'Соседи мысли',
      description:
        'Родители, дети и «братья/сёстры» мысли (как на канве фокуса), плюс каталоги ' +
        'использованных типов (`link_types`/`thought_types` с описаниями для AI).',
      mimeType: JSON_MIME,
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        const thought = getThoughtOrThrow(ndb, thoughtId);
        // Bug fix (§5.1e): sanitize each neighbour's `icon` — `FocusNeighbor`
        // is not gated by a `view` param, a `data:` URL would otherwise leak.
        const parents = getNeighbors(ndb, thoughtId, 'parents', { userId: rt.deps.auth.userId }).map(
          (n) => withSanitizedIcon(n),
        );
        const children = getNeighbors(ndb, thoughtId, 'children', {
          userId: rt.deps.auth.userId,
        }).map((n) => withSanitizedIcon(n));
        const siblings = getNeighbors(ndb, thoughtId, 'siblings', {
          userId: rt.deps.auth.userId,
        }).map((n) => withSanitizedIcon(n));
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

  // --- usage (reverse thought_ref lookup, 03-server-api.md §9.1) --------------
  mcp.registerResource(
    'etn.thought.usage',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/usage', {
      list: undefined,
    }),
    {
      title: 'Использование мысли',
      description:
        'Мысли, ссылающиеся на эту как на значение thought_ref-свойства (формальные связи, ' +
        '«Использование» в редакторе), сгруппированные по свойству.',
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
      title: 'Ссылки на мысль',
      description:
        'Комментарии, в body_md которых есть явная ID-ссылка [[#<id>]] или ' +
        '[[n:<net>#<id>]] на эту мысль (фаза R). Семантически отличается от ' +
        'etn.thought.mentions (FTS5 по title/synonyms) — здесь явный UUID. ' +
        'Возвращает массив MentionHit (один элемент на (owner_type, owner_id)).',
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
      title: 'Комментарии мысли (Markdown)',
      description: 'Постоянный и хронологические комментарии мысли в виде Markdown.',
      mimeType: 'text/markdown',
    },
    (uri, vars) =>
      guarded(() => {
        const networkId = requireVar(vars, 'network_id');
        const thoughtId = requireVar(vars, 'thought_id');
        const ndb = openMemberNetwork(rt, networkId);
        const thought = getThoughtOrThrow(ndb, thoughtId);
        return markdownContents(
          uri.href,
          commentsMarkdown(thought.title, listComments(ndb, 'thought', thoughtId)),
        );
      }),
  );

  // --- attachments -------------------------------------------------------------
  mcp.registerResource(
    'etn.thought.attachments',
    new ResourceTemplate('etn://networks/{network_id}/thoughts/{thought_id}/attachments', {
      list: undefined,
    }),
    {
      title: 'Вложения мысли',
      description: 'Список вложений (url/file) мысли.',
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

  // --- etn://networks/{network_id}/links/{link_id} ------------------------------
  mcp.registerResource(
    'etn.link',
    new ResourceTemplate('etn://networks/{network_id}/links/{link_id}', { list: undefined }),
    {
      title: 'Связь (с метаданными)',
      description: 'Связь между мыслями с её типом (включая описание типа).',
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

  // --- type catalogues -----------------------------------------------------------
  mcp.registerResource(
    'etn.thought-types',
    new ResourceTemplate('etn://networks/{network_id}/thought-types', { list: undefined }),
    {
      title: 'Типы мыслей',
      description: 'Все определения типов мыслей сети (с description для AI).',
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
      title: 'Типы связей',
      description: 'Все определения типов связей сети (с description для AI).',
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
      title: 'Тип мысли (свойства и описание)',
      description:
        'Один тип мысли: определение, `description` для AI-контекста и определения его свойств.',
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
        return jsonContents(uri.href, {
          ...withSanitizedIcon(type),
          properties: listTypeProperties(ndb, 'thought_type', typeId),
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
