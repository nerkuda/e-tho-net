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
import type { CrossNetworkAccessContext } from './cross-network-ref-service.js';
import { createLink } from './link-service.js';
import {
  computeThoughtCardWarnings,
  getPropertyValues,
  setPropertyValue,
} from './property-service.js';
import { findDuplicates } from './search-service.js';
import { projectThoughtRows } from './response-projection.js';
import { createThought, getThoughtOrThrow, updateThought } from './thought-service.js';

/** Resolve the bundle's thought: explicit `thought_id`, or find-or-create-or-match. */
function resolveThought(
  ndb: NetworkDb,
  input: ThoughtBundleInput,
  actorUserId: string,
  defaultLinkIds: string[],
): {
  thought: Thought;
  action: ThoughtBundleThoughtAction;
  matchedOn: 'title' | 'synonym' | 'partial' | null;
} {
  if (input.thought_id !== undefined) {
    let thought = getThoughtOrThrow(ndb, input.thought_id);
    let action: ThoughtBundleThoughtAction = 'reused';
    // Item-level thought fields (`active`, absorbed from
    // `etn.thoughts.set_active`, bug faf56a02-e884-488b-9b7b-39dfd5d5b275;
    // `title`/`synonyms`/`type_id`, the rename half of `etn.thoughts.update`,
    // bug 870c0c0d-dd2d-46b1-a498-780edcf8e18a) are applied even when
    // `thought` is absent: the contract claims those tools are absorbed by
    // `etn.thoughts.write`, so the item-level fields must take effect on
    // existing thoughts. When both the item-level field and its `thought.*`
    // counterpart are present, the item-level one wins — it's the more
    // specific intent ("just patch this field for this existing thought").
    const mergedActive = input.active !== undefined ? input.active : input.thought?.active;
    const mergedTitle = input.title !== undefined ? input.title : input.thought?.title;
    const mergedSynonyms =
      input.synonyms !== undefined ? input.synonyms : input.thought?.synonyms;
    const mergedTypeId = input.type_id !== undefined ? input.type_id : input.thought?.type_id;
    if (
      input.thought !== undefined ||
      mergedActive !== undefined ||
      mergedSynonyms !== undefined ||
      mergedTypeId !== undefined ||
      input.title !== undefined
    ) {
      thought = updateThought(
        ndb,
        thought.id,
        {
          ...(mergedTitle === undefined ? {} : { title: mergedTitle }),
          ...(mergedSynonyms === undefined ? {} : { synonyms: mergedSynonyms }),
          ...(mergedTypeId === undefined ? {} : { type_id: mergedTypeId }),
          ...(mergedActive === undefined ? {} : { active: mergedActive }),
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
  // Item-level `active` applies to a NEW thought too and wins over
  // `thought.active` (bug 21cbafb8), mirroring the existing-thought branch
  // above. The other item-level fields (`title`/`synonyms`/`type_id`) are
  // rejected up front for a `thought` item (see `validateEnvelope`).
  const mergedActive = input.active !== undefined ? input.active : spec.active;
  const policy = input.on_duplicate ?? 'fail';
  const hits = findDuplicates(ndb, spec.title, spec.synonyms ?? []);
  if (hits.length === 0) {
    const thought = createThought(
      ndb,
      {
        title: spec.title,
        ...(spec.synonyms === undefined ? {} : { synonyms: spec.synonyms }),
        ...(spec.type_id === undefined ? {} : { type_id: spec.type_id }),
        ...(mergedActive === undefined ? {} : { active: mergedActive }),
      },
      actorUserId,
      // Рёбра link-дефолтов типа — в результат и события (ошибка 8655842b).
      defaultLinkIds,
    );
    return { thought, action: 'created', matchedOn: null };
  }

  const topHit = hits[0];
  if (topHit === undefined) {
    // Unreachable (hits.length > 0 guaranteed above); satisfies noUncheckedIndexedAccess.
    throw new EtnError('INTERNAL', 'find_duplicates returned an empty hit unexpectedly');
  }
  if (policy === 'fail') {
    // Кандидаты в ответе той же формы, что и у `etn.thoughts.find_duplicates`:
    // снимаем визуальные/сервисные поля (fg_color, font_*, …) единым
    // compact-сериализатором (мелкий дефект превью, 0.8.3).
    throw new EtnError('DUPLICATE', 'a matching thought already exists', {
      candidates: projectThoughtRows(hits),
    });
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
        ...(mergedActive === undefined ? {} : { active: mergedActive }),
      },
      undefined,
      actorUserId,
    );
    return { thought, action: 'updated', matchedOn: topHit.matched_on };
  }
  // policy === 'reuse': attach the bundle's other parts without touching the thought itself.
  return { thought: matched, action: 'reused', matchedOn: topHit.matched_on };
}

/** Create-or-update the bundle owner's permanent comment (как удалённый `etn.comments.upsert`). */
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
  crossNetworkAccess?: CrossNetworkAccessContext,
): ThoughtBundleResult {
  return ndb.transaction(() => {
    // Коллектор рёбер, созданных link-дефолтами типа при создании мысли —
    // возвращаются в результате, чтобы фасад опубликовал `link.created`
    // (ошибка 8655842b).
    const defaultLinkIds: string[] = [];
    const { thought, action, matchedOn } = resolveThought(ndb, input, actorUserId, defaultLinkIds);

    let comment: Comment | undefined;
    let commentAction: 'created' | 'updated' | undefined;
    if (input.comment !== undefined) {
      const upserted = upsertPermanentComment(ndb, thought.id, input.comment, actorUserId);
      comment = upserted.comment;
      commentAction = upserted.action;
    }

    // Chronicle entries — appended AFTER the permanent comment write so the
    // chronology shares the same `created_at` timeline as the rest of the
    // bundle. Each entry becomes its own dated `chronological` comment row
    // (семантика удалённого `etn.comments.upsert` для `kind: 'chronological'`).
    let chronicle: Comment[] | undefined;
    if (input.chronicle !== undefined && input.chronicle.length > 0) {
      chronicle = input.chronicle.map((c) =>
        createComment(
          ndb,
          'thought',
          thought.id,
          {
            kind: 'chronological',
            title: c.title ?? null,
            body_md: c.body_md,
            ...(c.valid_from === undefined ? {} : { valid_from: c.valid_from }),
            ...(c.valid_to === undefined ? {} : { valid_to: c.valid_to }),
            ...(c.use_time === undefined ? {} : { use_time: c.use_time }),
          },
          actorUserId,
        ),
      );
    }

    let properties: Record<string, PropertyValue> | undefined;
    if (input.properties !== undefined) {
      properties = {};
      for (const [key, value] of Object.entries(input.properties)) {
        // `crossNetworkAccess` пробрасывается в том числе ради значений вида
        // `cross_network_ref`: без него запись такого значения отвергается
        // (задача 7849008a, требование aa89940c).
        properties[key] = setPropertyValue(
          ndb,
          'thought',
          thought.id,
          key,
          value,
          actorUserId,
          crossNetworkAccess,
        );
      }
    }

    // Links with optional inline knowledge (properties / permanent comment).
    // Task 053751b5 (0.7.2) — createLink itself now accepts `properties` and
    // `comment` and writes them inside its own transaction arm, so the whole
    // bundle stays atomic on a property write failure (the link insert rolls
    // back too).
    let linkResults:
      | Array<{ link: Link; properties?: Record<string, PropertyValue>; comment?: Comment }>
      | undefined;
    if (input.links !== undefined) {
      linkResults = input.links.map((l) => {
        // parent: target sources a link to the bundle thought (bundle thought
        // hangs under target). child: the bundle thought sources a link to
        // target. Unified with the MCP `links[].direction` semantics
        // (docs/03-server-api.md §6.3, docs/05-mcp-server.md §5.2).
        const [sourceId, targetId] =
          l.direction === 'parent'
            ? [l.target_thought_id, thought.id]
            : [thought.id, l.target_thought_id];
        const link = createLink(
          ndb,
          {
            source_id: sourceId,
            target_id: targetId,
            type_id: l.type_id ?? null,
            ...(l.properties === undefined ? {} : { properties: l.properties }),
            ...(l.comment === undefined ? {} : { comment: l.comment }),
          },
          actorUserId,
        );
        // Read back the link's properties + permanent comment when the bundle
        // attached any, so the caller (and the audit/event payload) sees the
        // full picture. Re-reading the freshly written values is cheaper than
        // threading them through createLink's return, which intentionally
        // stays a `Link` to keep its public contract.
        let writtenProps: Record<string, PropertyValue> | undefined;
        let writtenComment: Comment | undefined;
        if (l.properties !== undefined && Object.keys(l.properties).length > 0) {
          const all = getPropertyValues(ndb, 'link', link.id);
          writtenProps = {};
          for (const key of Object.keys(l.properties)) {
            const found = all.find((pv) => pv.property_name === key);
            if (found !== undefined) writtenProps[key] = found;
          }
        }
        if (l.comment !== undefined) {
          const permanent = listComments(ndb, 'link', link.id).find((c) => c.kind === 'permanent');
          writtenComment = permanent;
        }
        return {
          link,
          ...(writtenProps !== undefined ? { properties: writtenProps } : {}),
          ...(writtenComment !== undefined ? { comment: writtenComment } : {}),
        };
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

    // Части бандла пишутся ПОСЛЕ мысли и могли сдвинуть её `updated_at`
    // (комментарии/хроника — ошибка 228df7a4; значения свойств — требование
    // e6d4165e). Возвращаем свежую форму, чтобы DTO не отставал от карточки.
    const freshThought = getThoughtOrThrow(ndb, thought.id);

    return {
      thought: freshThought,
      thought_action: action,
      matched_on: matchedOn,
      comment,
      comment_action: commentAction,
      ...(chronicle !== undefined ? { chronicle } : {}),
      properties,
      ...(linkResults !== undefined ? { links: linkResults } : {}),
      ...(defaultLinkIds.length > 0 ? { default_link_ids: defaultLinkIds } : {}),
      attachments,
      warnings,
    } satisfies ThoughtBundleResult;
  });
}
