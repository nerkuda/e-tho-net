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
 * Вход в флоу — ветка «ни одной мысли» развилки; контекст владельца (родитель
 * новой мысли) — из реестра `lib/wiki-create-context.ts`, куда поверхность
 * привязывает свой корень (`commentContext`-опция `editor/markdown-field.ts`
 * либо прямая привязка статичного просмотра, например ленты «Дневника»).
 * Контекста нет — диалог всё равно открывается, мысль создаётся без родителя:
 * клик в просмотре никогда не отказывает уведомлением «мысль не найдена».
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
 * Runs the create flow for an unresolvable legacy link. Always takes the click
 * over — no caller-side «мысль не найдена» notice remains (дефект визуальной
 * проверки, задача 8e4e3dc5): диалог открывается на ЛЮБОЙ поверхности, где
 * клик в просмотре не нашёл ни одного кандидата. Контекст владельца лишь
 * уточняет родителя создаваемой мысли; его отсутствие (статичный просмотр без
 * привязанного корня) даёт мысль без родителя, а не отказ.
 *
 * `options.onCreated` — что сделать с первым успешно созданной/связанной
 * мыслью (её id): открыть (просмотр) или заменить ссылку в буфере (правка).
 */
export async function tryCreateThoughtFromLegacyLink(
  linkEl: HTMLElement,
  name: string,
  options: { onCreated: (thoughtId: string) => Promise<void> | void },
): Promise<void> {
  if (!canSave()) {
    offlineNotice();
    return;
  }

  let networkId: string;
  try {
    networkId = requireNetworkId();
  } catch {
    return; // no network open — nothing sensible to do either way
  }

  // Alias: the legacy span's visible text is `alias ?? target`, so a label
  // differing from the target name is the link's own synonym (карточка: текст
  // после `|` автоматически добавляется в синонимы).
  const label = linkEl.textContent?.trim() ?? '';
  const alias = label !== '' && label !== name ? label : null;

  // Parent: the surface's owner (comment owner; for a link's comment — the
  // link's source). No bound owner — the thought is created without a parent.
  const ctx = findWikiCreateContext(linkEl);
  let parentId: string | null = null;
  let parentTitle: string | undefined;
  if (ctx !== null) {
    try {
      const parent = await resolveParentThought(networkId, ctx);
      parentId = parent.id;
      parentTitle = parent.title;
    } catch (err) {
      notice(`Не удалось определить родителя для новой мысли: ${errText(err)}`, 'error');
      return;
    }
  }

  const result = await pickThoughtsDialog({
    networkId,
    anchor: parentId !== null ? { id: parentId, direction: 'child' } : null,
    ...(parentTitle !== undefined ? { anchorTitle: parentTitle } : {}),
    allowCreate: true,
    allowLinkType: true,
    // Single mode with the name in the input: `имя|алиас` — the existing
    // input parsing turns the alias into a synonym on add (карточка: текст
    // после `|` автоматически добавляется в синонимы).
    prefillText: alias !== null ? `${name}|${alias}` : name,
  });
  if (result === null) return; // cancelled — nothing changes

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
        // Без родителя связывать не с чем — мысль просто выбрана.
        if (parentId !== null) {
          throwOnFailures(await ensureLink(networkId, parentId, item.id, result.linkTypeId));
        }
        if (firstAddedId === null) firstAddedId = item.id;
      } else {
        const newThought = await etn.thoughts.create(networkId, {
          title: item.title,
          synonyms: item.synonyms,
          type_id: result.thoughtTypeId,
          // REST semantics (03-server-api.md §6.3): 'parent' — parentId (the
          // target) becomes the parent of the new thought, i.e. the new
          // thought is attached UNDER parentId as its child. Без родителя
          // (просмотр без владельца) мысль создаётся корневой.
          ...(parentId !== null
            ? {
                create_link: {
                  direction: 'parent' as const,
                  target_thought_id: parentId,
                  type_id: result.linkTypeId,
                },
              }
            : {}),
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

  if (firstAddedId === null) return; // every creation failed — nothing to do
  try {
    await options.onCreated(firstAddedId);
  } catch (err) {
    notice(`Не удалось обновить ссылку: ${errText(err)}`, 'error');
  }
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
