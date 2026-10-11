/**
 * «Создание отсутствующих мыслей по legacy-ссылкам на них» (карточка ETN
 * 34ffbd75; уточнено задачей 8e4e3dc5, 0.12.2).
 *
 * Клик по legacy-ссылке `[[имя|текст]]`, чья цель не резолвится (ни одной
 * актуальной мысли с таким названием/синонимом), открывает диалог добавления
 * мысли: предзаполнено имя из ссылки (текст после `|` — в синонимы), родитель —
 * владелец комментария (для комментария связи — её источник, source).
 *
 * Что делать после создания, решает ВЫЗЫВАЮЩИЙ через `onCreated`: развилка
 * клика (`editor/wiki-link.ts`) в ПРОСМОТРЕ открывает созданную мысль, в
 * ПРАВКЕ — заменяет ссылку в буфере редактора (в т.ч. вложенного редактора
 * трансклюзии). Сам этот модуль текст комментария НЕ трогает: автопереписывание
 * `body_md` из просмотра отменено решением пользователя 2026-10-11 (вечер).
 *
 * Вход в флоу — ветка «ни одной мысли» развилки; контекст комментария
 * (владелец, вид) — из реестра `lib/wiki-create-context.ts`, куда поле
 * привязывает себя при создании (`commentContext`-опция
 * `editor/markdown-field.ts`).
 */

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { pickThoughtsDialog } from '../canvas/add-dialog.js';
import { canSave, offlineNotice } from '../drafts.js';
import { applyCommentTemplateIfEmpty } from '../lib/comment-template.js';
import { errText } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { ensureLink, throwOnFailures } from '../lib/link-ops.js';
import { notice } from '../lib/notice.js';
import { findWikiCreateContext, type WikiCreateCommentContext } from '../lib/wiki-create-context.js';

/**
 * Runs the create flow for an unresolvable legacy link. Returns `true` when
 * the flow took the click over (a comment context was found — the caller must
 * NOT show its «мысль не найдена» notice), `false` when the element is not
 * inside an opted-in comment field (the caller falls back to the notice).
 *
 * `options.onCreated` — что сделать с первым успешно созданной/связанной
 * мыслью (её id): открыть (просмотр) или заменить ссылку в буфере (правка).
 */
export async function tryCreateThoughtFromLegacyLink(
  linkEl: HTMLElement,
  name: string,
  options: { onCreated: (thoughtId: string) => Promise<void> | void },
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
        // 0.8.1 (6dcd6db7): `POST /links` снят — связь с существующей мыслью
        // создаётся пакетной операцией (уже связанная пара не дублируется).
        throwOnFailures(await ensureLink(networkId, parentId, item.id, result.linkTypeId));
        if (firstAddedId === null) firstAddedId = item.id;
      } else {
        const newThought = await etn.thoughts.create(networkId, {
          title: item.title,
          synonyms: item.synonyms,
          type_id: result.thoughtTypeId,
          // REST semantics (03-server-api.md §6.3): 'parent' — parentId (the
          // target) becomes the parent of the new thought, i.e. the new
          // thought is attached UNDER parentId as its child.
          create_link: {
            direction: 'parent',
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
  // Новая мысль появляется на холсте без ручной перезагрузки; открытие
  // (просмотр) или замена в буфере (правка) — за вызывающим.
  scheduleRefresh();

  if (firstAddedId === null) return true; // every creation failed — nothing to do
  try {
    await options.onCreated(firstAddedId);
  } catch (err) {
    notice(`Не удалось обновить ссылку: ${errText(err)}`, 'error');
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
