/**
 * «Создание отсутствующих мыслей по legacy-ссылкам на них» (карточка ETN
 * 34ffbd75, критерии приёмки согласованы с пользователем).
 *
 * Клик по legacy-ссылке `[[имя|текст]]` в режиме ПРОСМОТРА комментария, чья
 * цель не резолвится поиском по именам, открывает диалог добавления мысли:
 * предзаполнено имя из ссылки (текст после `|` — в синонимы), родитель —
 * владелец комментария (для комментария связи — её источник, source). После
 * успешного создания ВСЕ legacy-ссылки с тем же именем цели в исходнике
 * (body_md) этого комментария заменяются на id-ссылки `[[#<id>|<текст>]]`
 * (каждая сохраняет свой текст; без `|` — `[[#<id>]]`), комментарий
 * перерисовывается, пользователь остаётся в текущем контексте.
 *
 * Вход в флоу — ветка «не найдено» в `openWikiTarget` (editor/wiki-link.ts);
 * контекст комментария (владелец, вид, id, перерисовка) — из реестра
 * `lib/wiki-create-context.ts`, куда поле привязывает себя при создании
 * (`commentContext`-опция `editor/markdown-field.ts`).
 */

import type { Comment } from '@etn/shared';

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { pickThoughtsDialog } from '../canvas/add-dialog.js';
import { invalidateIndicators } from '../canvas/canvas.js';
import { canSave, offlineNotice } from '../drafts.js';
import { applyCommentTemplateIfEmpty } from '../lib/comment-template.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { replaceLegacyWikiLinks } from '../lib/pure.js';
import { findWikiCreateContext, type WikiCreateCommentContext } from '../lib/wiki-create-context.js';

/**
 * Runs the create flow for an unresolvable legacy link. Returns `true` when
 * the flow took the click over (a comment context was found — the caller must
 * NOT show its «мысль не найдена» notice), `false` when the element is not
 * inside an opted-in comment field (the caller falls back to the notice).
 */
export async function tryCreateThoughtFromLegacyLink(
  linkEl: HTMLElement,
  name: string,
): Promise<boolean> {
  const ctx = findWikiCreateContext(linkEl);
  if (ctx === null) return false;
  if (!canSave()) {
    offlineNotice();
    return true;
  }

  let networkId: string;
  try {
    networkId = requireNetworkId();
  } catch {
    return true; // no network open — nothing sensible to do either way
  }

  // Alias: the legacy span's visible text is `alias ?? target`, so a label
  // differing from the target name is the link's own synonym (карточка: текст
  // после `|` автоматически добавляется в синонимы).
  const label = linkEl.textContent?.trim() ?? '';
  const alias = label !== '' && label !== name ? label : null;

  // Parent: the comment owner; for a link's comment — the link's source.
  let parentId: string;
  let parentTitle: string;
  try {
    const parent = await resolveParentThought(networkId, ctx);
    parentId = parent.id;
    parentTitle = parent.title;
  } catch (err) {
    notice(`Не удалось определить родителя для новой мысли: ${errText(err)}`, 'error');
    return true;
  }

  const result = await pickThoughtsDialog({
    networkId,
    anchor: { id: parentId, direction: 'child' },
    anchorTitle: parentTitle,
    allowCreate: true,
    allowLinkType: true,
    // Single mode with the name in the input: `имя|алиас` — the existing
    // input parsing turns the alias into a synonym on add (карточка: текст
    // после `|` автоматически добавляется в синонимы).
    prefillText: alias !== null ? `${name}|${alias}` : name,
  });
  if (result === null) return true; // cancelled — nothing changes

  // Create/link everything the user queued; the FIRST successfully added
  // thought (new or existing — an exact candidate may have been picked) is the
  // replacement target for the links (карточка: несколько — первая).
  let created = 0;
  let failed = 0;
  let firstAddedId: string | null = null;
  for (const item of result.items) {
    try {
      if (item.kind === 'existing') {
        await etn.links.create(networkId, {
          source_id: parentId,
          target_id: item.id,
          type_id: result.linkTypeId,
        });
        if (firstAddedId === null) firstAddedId = item.id;
      } else {
        const newThought = await etn.thoughts.create(networkId, {
          title: item.title,
          synonyms: item.synonyms,
          type_id: result.thoughtTypeId,
          // REST semantics (03-server-api.md §6.3): 'child' — the new thought
          // becomes the TARGET of a link from the parent, i.e. its child.
          create_link: {
            direction: 'child',
            target_thought_id: parentId,
            type_id: result.linkTypeId,
          },
        });
        if (result.thoughtTypeId !== null) {
          await applyCommentTemplateIfEmpty(networkId, newThought.id, result.thoughtTypeId);
        }
        if (firstAddedId === null) firstAddedId = newThought.id;
      }
      created++;
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    notice(`Создано/связано: ${created}, ошибок: ${failed}`, 'error');
  } else if (created > 0) {
    notice(`Готово: ${created}.`);
  }
  // New thoughts show up in the canvas zones without moving the focus — the
  // user stays in the current context (карточка: без перехода/фокуса).
  scheduleRefresh();

  if (firstAddedId === null) return true; // every creation failed — nothing to replace

  try {
    await replaceLinksInComment(networkId, ctx, name, firstAddedId);
  } catch (err) {
    notice(`Не удалось обновить ссылки в комментарии: ${errText(err)}`, 'error');
  }
  return true;
}

/** The comment owner as the parent thought for the created ones. */
async function resolveParentThought(
  networkId: string,
  ctx: WikiCreateCommentContext,
): Promise<{ id: string; title: string }> {
  if (ctx.ownerType === 'thought') {
    const thought = await etn.thoughts.get(networkId, ctx.ownerId);
    return { id: thought.id, title: thought.title };
  }
  const link = await etn.links.get(networkId, ctx.ownerId);
  const source = await etn.thoughts.get(networkId, link.source_id);
  return { id: source.id, title: source.title };
}

/**
 * Rewrites every same-named legacy link in the comment's body_md to the
 * `[[#<id>]]` form and repaints the field. The fresh body/version are read via
 * the API (never from a cached DOM/store state), so a concurrent edit simply
 * fails the version check instead of silently losing changes.
 */
async function replaceLinksInComment(
  networkId: string,
  ctx: WikiCreateCommentContext,
  name: string,
  thoughtId: string,
): Promise<void> {
  let fresh: Comment | null = null;
  const commentId = ctx.getCommentId();
  if (commentId !== null) {
    fresh = await etn.comments.get(networkId, commentId);
  } else if (ctx.commentKind === 'permanent') {
    // Permanent upsert semantics: the id may legitimately be unknown to the
    // field (built before the comment was loaded) — find it by owner+kind.
    const list = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
    fresh = list.find((c) => c.kind === 'permanent') ?? null;
  }
  if (fresh === null) return; // nothing saved to rewrite (e.g. an unsaved new chrono entry)

  const { md, count } = replaceLegacyWikiLinks(fresh.body_md, name, thoughtId);
  if (count === 0) return;

  const updated = await etn.comments.update(networkId, fresh.id, { body_md: md }, fresh.version);
  invalidateIndicators(ctx.ownerId);
  ctx.refresh(updated.body_md, updated.body_html);
  ctx.afterLinksReplaced?.();
}
