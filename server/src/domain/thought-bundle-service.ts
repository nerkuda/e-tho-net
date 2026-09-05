/**
 * Composite "unit of knowledge" bundle service (task O1, docs/05-mcp-server.md
 * §4.2a).
 *
 * {@link upsertThoughtBundle} writes a thought (new, matched-and-reused,
 * matched-and-updated, or explicitly addressed) together with its permanent
 * comment, a map of property values, links and attachments in a single SQL
 * transaction. It is a thin orchestrator over the existing single-purpose
 * domain services — no new tables, no duplicated validation logic. Any error
 * raised by a step (missing target, duplicate link, invalid property value,
 * …) aborts the whole transaction, so the caller never observes a half-written
 * bundle.
 */

import type {
  Attachment,
  Comment,
  Link,
  PropertyValue,
  Thought,
  ThoughtBundleInput,
  ThoughtBundleResult,
  ThoughtBundleThoughtAction,
} from '@etn/shared';
import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { createAttachment } from './attachment-service.js';
import { createComment, listComments, updateComment } from './comment-service.js';
import { createLink } from './link-service.js';
import { computeThoughtCardWarnings, setPropertyValue } from './property-service.js';
import { findDuplicates } from './search-service.js';
import { createThought, getThoughtOrThrow, updateThought } from './thought-service.js';

/** Resolve the bundle's thought: explicit `thought_id`, or find-or-create-or-match. */
function resolveThought(
  ndb: NetworkDb,
  input: ThoughtBundleInput,
  actorUserId: string,
): {
  thought: Thought;
  action: ThoughtBundleThoughtAction;
  matchedOn: 'title' | 'synonym' | 'partial' | null;
} {
  if (input.thought_id !== undefined) {
    let thought = getThoughtOrThrow(ndb, input.thought_id);
    let action: ThoughtBundleThoughtAction = 'reused';
    if (input.thought !== undefined) {
      thought = updateThought(
        ndb,
        thought.id,
        {
          title: input.thought.title,
          ...(input.thought.synonyms === undefined ? {} : { synonyms: input.thought.synonyms }),
          ...(input.thought.type_id === undefined ? {} : { type_id: input.thought.type_id }),
          ...(input.thought.active === undefined ? {} : { active: input.thought.active }),
        },
        undefined,
        actorUserId,
      );
      action = 'updated';
    }
    return { thought, action, matchedOn: null };
  }

  const spec = input.thought;
  if (spec === undefined) {
    throw new EtnError('VALIDATION_ERROR', 'either thought_id or thought must be provided');
  }
  const policy = input.on_duplicate ?? 'fail';
  const hits = findDuplicates(ndb, spec.title, spec.synonyms ?? []);
  if (hits.length === 0) {
    const thought = createThought(
      ndb,
      {
        title: spec.title,
        ...(spec.synonyms === undefined ? {} : { synonyms: spec.synonyms }),
        ...(spec.type_id === undefined ? {} : { type_id: spec.type_id }),
        ...(spec.active === undefined ? {} : { active: spec.active }),
      },
      actorUserId,
    );
    return { thought, action: 'created', matchedOn: null };
  }

  const topHit = hits[0];
  if (topHit === undefined) {
    // Unreachable (hits.length > 0 guaranteed above); satisfies noUncheckedIndexedAccess.
    throw new EtnError('INTERNAL', 'find_duplicates returned an empty hit unexpectedly');
  }
  if (policy === 'fail') {
    throw new EtnError('DUPLICATE', 'a matching thought already exists', { candidates: hits });
  }
  const matched = getThoughtOrThrow(ndb, topHit.id);
  if (policy === 'update') {
    const thought = updateThought(
      ndb,
      matched.id,
      {
        title: spec.title,
        ...(spec.synonyms === undefined ? {} : { synonyms: spec.synonyms }),
        ...(spec.type_id === undefined ? {} : { type_id: spec.type_id }),
        ...(spec.active === undefined ? {} : { active: spec.active }),
      },
      undefined,
      actorUserId,
    );
    return { thought, action: 'updated', matchedOn: topHit.matched_on };
  }
  // policy === 'reuse': attach the bundle's other parts without touching the thought itself.
  return { thought: matched, action: 'reused', matchedOn: topHit.matched_on };
}

/** Create-or-update the bundle owner's permanent comment (like `etn.comments.upsert`). */
function upsertPermanentComment(
  ndb: NetworkDb,
  thoughtId: string,
  input: NonNullable<ThoughtBundleInput['comment']>,
  actorUserId: string,
): { comment: Comment; action: 'created' | 'updated' } {
  const existing = listComments(ndb, 'thought', thoughtId).find((c) => c.kind === 'permanent');
  if (existing !== undefined) {
    const comment = updateComment(
      ndb,
      existing.id,
      {
        ...(input.title === undefined ? {} : { title: input.title }),
        body_md: input.body_md,
      },
      undefined,
      actorUserId,
    );
    return { comment, action: 'updated' };
  }
  const comment = createComment(
    ndb,
    'thought',
    thoughtId,
    {
      kind: 'permanent',
      title: input.title ?? null,
      body_md: input.body_md,
      ...(input.valid_from === undefined ? {} : { valid_from: input.valid_from }),
      ...(input.valid_to === undefined ? {} : { valid_to: input.valid_to }),
    },
    actorUserId,
  );
  return { comment, action: 'created' };
}

/**
 * Write a "unit of knowledge" bundle in one transaction (docs/05-mcp-server.md
 * §4.2a). See the module doc for the overall shape.
 */
export function upsertThoughtBundle(
  ndb: NetworkDb,
  input: ThoughtBundleInput,
  actorUserId: string,
): ThoughtBundleResult {
  return ndb.transaction(() => {
    const { thought, action, matchedOn } = resolveThought(ndb, input, actorUserId);

    let comment: Comment | undefined;
    let commentAction: 'created' | 'updated' | undefined;
    if (input.comment !== undefined) {
      const upserted = upsertPermanentComment(ndb, thought.id, input.comment, actorUserId);
      comment = upserted.comment;
      commentAction = upserted.action;
    }

    let properties: Record<string, PropertyValue> | undefined;
    if (input.properties !== undefined) {
      properties = {};
      for (const [key, value] of Object.entries(input.properties)) {
        properties[key] = setPropertyValue(ndb, 'thought', thought.id, key, value);
      }
    }

    let links: Link[] | undefined;
    if (input.links !== undefined) {
      links = input.links.map((l) => {
        // parent: target sources a link to the bundle thought (bundle thought
        // hangs under target). child: the bundle thought sources a link to
        // target. Unified with the MCP `links[].direction` semantics
        // (docs/03-server-api.md §6.3, docs/05-mcp-server.md §5.2).
        const [sourceId, targetId] =
          l.direction === 'parent'
            ? [l.target_thought_id, thought.id]
            : [thought.id, l.target_thought_id];
        return createLink(
          ndb,
          { source_id: sourceId, target_id: targetId, type_id: l.type_id ?? null },
          actorUserId,
        );
      });
    }

    let attachments: Attachment[] | undefined;
    if (input.attachments !== undefined) {
      attachments = input.attachments.map((a) => createAttachment(ndb, 'thought', thought.id, a, actorUserId));
    }

    // Task O6: "card completeness" warnings — computed against the freshly
    // written card so the agent learns about unfilled `required` properties
    // (own or inherited via L21) before assuming the bundle is "done".
    const warnings = computeThoughtCardWarnings(ndb, thought.id);

    return {
      thought,
      thought_action: action,
      matched_on: matchedOn,
      comment,
      comment_action: commentAction,
      properties,
      links,
      attachments,
      warnings,
    } satisfies ThoughtBundleResult;
  });
}
