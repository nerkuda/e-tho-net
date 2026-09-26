/**
 * Mark-for-deletion and trash UI (task S13, docs/08-ui-spec.md §5a).
 *
 * Two-phase deletion: the single-delete dialog refuses to "Удалить совсем" while
 * the entity is blocked, offering "Поместить в корзину" as the safe default.
 * The blocking check is layer-aware (0.5.4): the session's own layer never
 * holds, but a live base row does while working in a layer — «удалить совсем»
 * there is only a tombstone, so the dialog offers marking instead. The trash
 * dialog (`GET /trash`) lists every marked thought/link with its precomputed
 * blocking and lets the user restore, delete, or purge everything that is
 * unblocked.
 */

import {
  BASE_LAYER_ID,
  type Link,
  type LinkDeletionBlocking,
  type Thought,
  type ThoughtDeletionBlocking,
  type ThoughtDeletionCheckResult,
  type TrashListResult,
} from '@etn/shared';
import { t } from './lib/i18n.js';
import { menuAction, type MenuItem } from './lib/menu.js';

import { onThoughtDeleted, scheduleRefresh } from './app.js';
import { invalidateRef } from './canvas/canvas.js';
// Слово вместо имени типа связи, когда тип не задан, — то же, что в тултипе
// ребра локального графа (`edgeTooltip`): подпись связи обязана читаться
// одинаково в диалоге удаления связи и в строке корзины (ошибки ce687b37,
// 009784ad).
import { UNTYPED_LINK_LABEL } from './editor/mini-graph-model.js';
// Мини-облачка строк группового удаления собирает общая фабрика (профиль
// `chip`): значок, цвета, начертание, бледность и метка корзины — единообразно
// со всеми остальными списками клиента.
import { createThoughtCloud } from './lib/thought-cloud.js';
// Правило 6 требования 11ddd910: двойной клик по строке корзины открывает
// сущность в редакторе (мысль — редактором мысли, связь — редактором связи).
import { openLinkInEditor, openThoughtInEditor, reflectThoughtUpdate } from './editor/editor.js';
import { refreshSearchIfVisible } from './search/search.js';
import { scheduleStructuresRefresh } from './screens/structures/structures.js';
import { refreshSelectionPanel } from './selection/selection.js';
import { patchFocusEdge, store } from './state.js';
import { errorDialog, showDialog, type DialogButton } from './lib/dialog.js';
import { div, el, setTooltip, span } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { notice } from './lib/notice.js';
import { acquireOrShowBlocked, lockHandleFromOutcome, releaseHeld, type LockHandle } from './lib/lock-guard.js';
import { uiButton } from './lib/ui/button.js';
import { choiceControl } from './lib/ui/choice-row.js';
import { fieldInput } from './lib/ui/field.js';
import { createTable } from './lib/ui/table.js';

/**
 * Human-readable reasons of a blocked deletion-check (bug 0.5.4: the dialog
 * used to blame «использование в свойствах» for any block). The base-layer
 * entry means «существует в основе — в рабочем слое можно только пометить»;
 * every other entry is a layer that changed the row. `noun` matches the entity.
 */
export function blockingReasons(
  noun: 'мысль' | 'связь',
  blocking: ThoughtDeletionBlocking | LinkDeletionBlocking,
): string[] {
  const reasons: string[] = [];
  if ('properties' in blocking && blocking.properties > 0) {
    reasons.push(`${noun} используется в свойствах других мыслей`);
  }
  const layers = blocking.layers;
  if (layers.some((l) => l.id === BASE_LAYER_ID)) {
    reasons.push(`${noun} существует в основе — в слое её можно только пометить на удаление`);
  }
  const others = layers.filter((l) => l.id !== BASE_LAYER_ID);
  if (others.length > 0) {
    reasons.push(`${noun} изменена в слоях: ${others.map((l) => `«${l.title}»`).join(', ')}`);
  }
  return reasons;
}

/** Resolve the current version of a thought (for If-Match on mark/delete). */
async function thoughtVersion(networkId: string, id: string): Promise<number> {
  return (await etn.thoughts.get(networkId, id)).version;
}

/**
 * Имя типа связи «вперёд» (сторона источника) из кэша типов сети. Тип не задан
 * или не резолвится — слово-заглушка {@link UNTYPED_LINK_LABEL}: то же, что
 * показывает тултип ребра локального графа (`edgeTooltip`), поэтому подпись
 * связи читается одинаково во всех местах клиента.
 */
export function linkTypeForwardName(typeId: string | null): string {
  if (typeId === null) return UNTYPED_LINK_LABEL;
  const type = store.state.linkTypes.find((t) => t.id === typeId);
  if (type === undefined || type.name_forward.trim() === '') return UNTYPED_LINK_LABEL;
  return type.name_forward;
}

/**
 * Подпись связи «<источник> → <назначение> · <тип связи>» — так связь
 * называют диалог её удаления (ошибка ce687b37: спрашивали, не называя, какую
 * связь удаляют) и строка корзины (ошибка 009784ad: у ребра в `etn.trash.list`
 * есть только id концов).
 *
 * Названия концов резолвит вызывающий ({@link resolveThoughtTitles}) и отдаёт
 * картой; имя, которого в карте нет, заменяется самим id — подпись никогда не
 * остаётся пустой. Направление — фактическое (`source_id` → `target_id`), имя
 * типа — «вперёд» (свойство источника).
 */
export function linkCaption(
  link: { source_id: string; target_id: string; type_id: string | null },
  titles: ReadonlyMap<string, string>,
): string {
  const source = titles.get(link.source_id) ?? link.source_id;
  const target = titles.get(link.target_id) ?? link.target_id;
  return `${source} → ${target} · ${linkTypeForwardName(link.type_id)}`;
}

/**
 * Названия мыслей одним батчем (`POST /thoughts/resolve`, как в полосах
 * истории и закреплённых). Неудача резолва не должна ломать диалог — пустая
 * карта: подпись покажет id вместо имени.
 */
async function resolveThoughtTitles(
  networkId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  try {
    const refs = await etn.thoughts.resolve(networkId, unique.slice(0, 100));
    return new Map(refs.map((ref) => [ref.id, ref.title]));
  } catch {
    return new Map();
  }
}

/**
 * Число мест использования помеченного элемента — колонка «Ссылок» корзины
 * (§5a.4, ошибка 009784ad): сколько раз на мысль ссылаются свойствами
 * (`usage.total`, 03-server-api.md §9.1). У связи использования в свойствах нет
 * (§5a.3: группа «Используется в свойствах» строится только для мыслей) —
 * соответствующий аргумент равен `null`, и колонка рисует прочерк, а не ноль;
 * прочерк же встаёт, если счёт не удалось получить.
 */
export function referencesText(total: number | null): string {
  return total === null ? '—' : String(total);
}

/**
 * Модель строки корзины (§5a.4, ошибка 009784ad) — то, что видно в первых двух
 * колонках таблицы: «что в корзине» и «сколько ссылок». Вынесено из сборки DOM,
 * потому что это и есть суть исправления (id вместо названий, непонятный счёт
 * мест использования) — проверяется юнит-тестом без DOM.
 */
export interface TrashRowView {
  /** Колонка 1: название мысли либо подпись связи «источник → назначение · тип». */
  label: string;
  /** Колонка 2: мест использования; `null` — показывается прочерком. */
  count: number | null;
}

/** Строка помеченной мысли: колонка 1 — название, колонка 2 — `usage.total`. */
export function thoughtTrashRow(item: { title: string }, usageTotal: number | null): TrashRowView {
  return { label: `📝 ${item.title}`, count: usageTotal };
}

/**
 * Строка помеченного ребра: у связи нет названия, её колонка 1 — подпись
 * «источник → назначение · тип связи» (имена концов — из `titles`), а колонка 2
 * пуста: использования в свойствах у связей нет (§5a.3).
 */
export function linkTrashRow(
  link: { source_id: string; target_id: string; type_id: string | null },
  titles: ReadonlyMap<string, string>,
): TrashRowView {
  return { label: `🔗 ${linkCaption(link, titles)}`, count: null };
}

/** Resolve the current version of a link (for If-Match). */
async function linkVersion(networkId: string, id: string): Promise<number> {
  return (await etn.links.get(networkId, id)).version;
}

/**
 * 0.8.1 (ошибка 8b4b7a7e): `DELETE /links/{id}` снят (требование 3ea5c6af) —
 * физическое удаление одного ребра идёт через корзину (7c226d3e): пометка
 * «marked_for_deletion» (если ещё не стоит) + точечный purge по id. Возвращает
 * false, когда purge не смог удалить строку (заблокирована удерживающим слоем).
 */
export async function purgeLinkCompletely(
  networkId: string,
  linkId: string,
  alreadyMarked: boolean,
): Promise<boolean> {
  if (!alreadyMarked) {
    await etn.links.update(
      networkId,
      linkId,
      { marked_for_deletion: true },
      await linkVersion(networkId, linkId),
    );
  }
  const { purged } = await etn.trash.purge(networkId, [linkId]);
  return purged > 0;
}

/**
 * Single-delete dialog for a thought (08-ui-spec.md §5a.1). Fetches the blocking
 * check once, then offers «Удалить совсем» (disabled when blocked),
 * «Поместить в корзину» / «Вернуть из корзины», and «Отмена».
 */
export async function openThoughtDeleteDialog(
  networkId: string,
  target: { id: string; title: string },
  onDeleted?: () => void,
): Promise<void> {
  let thought: Thought;
  let check: ThoughtDeletionCheckResult;
  try {
    thought = await etn.thoughts.get(networkId, target.id);
    check = (await etn.thoughts.deletionCheck(networkId, [target.id]))[target.id] ?? {
      blocked: false,
      blocking: { properties: 0, layers: [] },
      orphaned_children: 0,
    };
  } catch (err) {
    errorDialog('Удалить мысль', err);
    return;
  }

  const alreadyMarked = thought.marked_for_deletion;
  const body = div('form-stack');
  if (check.blocked) {
    for (const reason of blockingReasons('мысль', check.blocking)) {
      body.append(el('p', 'dialog-text', `Нельзя удалить совсем — ${reason}.`));
    }
  }
  if (check.orphaned_children > 0) {
    body.append(
      el(
        'p',
        'dialog-text',
        `${check.orphaned_children} потомк${check.orphaned_children === 1 ? '' : 'ов'} останется без родителей.`,
      ),
    );
  }

  let deleteBtn: HTMLButtonElement | null = null;
  const buttons: DialogButton[] = [
    {
      label: t('actions.deleteForever'),
      danger: true,
      ref: (btn) => {
        deleteBtn = btn;
        btn.disabled = check.blocked;
      },
      keepOpen: true,
      onClick: async (close) => {
        try {
          await etn.thoughts.remove(
            networkId,
            target.id,
            await thoughtVersion(networkId, target.id),
          );
          close();
          await onThoughtDeleted(target.id);
          onDeleted?.();
        } catch (err) {
          errorDialog('Удалить мысль', err);
        }
      },
    },
    {
      label: alreadyMarked ? t('actions.restore') : t('actions.toTrash'),
      keepOpen: true,
      onClick: async (close) => {
        try {
          const updated = await etn.thoughts.update(
            networkId,
            target.id,
            { marked_for_deletion: !alreadyMarked },
            await thoughtVersion(networkId, target.id),
          );
          close();
          // The actor gets no realtime echo (04-realtime.md §5) — reflect the
          // fresh entity everywhere it may be shown: the focus cloud (store
          // patch), the zone clouds (invalidateRef + refresh re-resolve the
          // cached ref, so the badge and the dim style appear at once, not
          // after a focus round-trip), the editor (target passenger / focus
          // follower — trash marker in the header, struck-through title),
          // the structures list, pinned and history bars.
          reflectThoughtUpdate(updated);
          notice(alreadyMarked ? 'Мысль возвращена из корзины.' : 'Мысль помещена в корзину.');
        } catch (err) {
          errorDialog(alreadyMarked ? 'Вернуть из корзины' : 'Поместить в корзину', err);
        }
      },
    },
    { label: t('actions.cancel') },
  ];

  // Auto-acquire the thought lock for the lifetime of the delete dialog (task
  // 4f141756). Acquired BEFORE showDialog so the helper's BLOCKED toast
  // surfaces before the dialog paints; released on every close via onClose.
  let handle: LockHandle | null = null;
  void acquireOrShowBlocked('thought', target.id).then((outcome) => {
    handle = lockHandleFromOutcome('thought', target.id, outcome);
  });

  showDialog({
    title: `Удаление мысли «${target.title}»`,
    size: 's',
    body,
    buttons,
    onMount: () => deleteBtn?.focus(),
    onClose: () => void releaseHeld(handle),
  });
}

/**
 * Single-delete dialog for a link (08-ui-spec.md §5a.1). Links have no property
 * usage and no children, so only the layer arm can block — the base entry when
 * the link lives in the base and the session works in a layer, or other layers
 * that changed the link.
 *
 * Диалог обязан назвать удаляемую связь (ошибка ce687b37): подпись
 * «<источник> → <назначение> · <тип связи>» идёт первой строкой тела. Имена
 * концов резолвятся батчем (`resolveThoughtTitles`), имя типа — из кэша сети
 * (`linkTypeForwardName`) — по образцу тултипа ребра локального графа.
 */
export async function openLinkDeleteDialog(
  networkId: string,
  linkId: string,
  onDeleted?: () => void,
): Promise<void> {
  let link: Link;
  let blocked: boolean;
  let blocking: LinkDeletionBlocking;
  let caption: string;
  try {
    link = await etn.links.get(networkId, linkId);
    const result = (await etn.links.deletionCheck(networkId, [linkId]))[linkId] ?? {
      blocked: false,
      blocking: { layers: [] },
    };
    blocked = result.blocked;
    blocking = result.blocking;
    caption = linkCaption(
      link,
      await resolveThoughtTitles(networkId, [link.source_id, link.target_id]),
    );
  } catch (err) {
    errorDialog('Удалить связь', err);
    return;
  }

  const alreadyMarked = link.marked_for_deletion;
  const body = div('form-stack');
  body.append(el('p', 'dialog-text link-caption', caption));
  if (blocked) {
    for (const reason of blockingReasons('связь', blocking)) {
      body.append(el('p', 'dialog-text', `Нельзя удалить совсем — ${reason}.`));
    }
  }

  // Auto-acquire the link lock for the lifetime of the delete dialog (task
  // 4f141756) — see `openThoughtDeleteDialog` for the rationale.
  let handle: LockHandle | null = null;
  void acquireOrShowBlocked('link', linkId).then((outcome) => {
    handle = lockHandleFromOutcome('link', linkId, outcome);
  });

  showDialog({
    title: 'Удаление связи',
    size: 's',
    body,
    buttons: [
      {
        label: t('actions.deleteForever'),
        danger: true,
        ref: (btn) => {
          btn.disabled = blocked;
        },
        keepOpen: true,
        onClick: async (close) => {
          try {
            const purged = await purgeLinkCompletely(networkId, linkId, link.marked_for_deletion);
            if (!purged) {
              // Race with a layer/deletion-check change — same picture the
              // disabled button would have shown.
              notice('Связь не удалена: теперь заблокирована (удерживающий слой).', 'error');
              return;
            }
            patchFocusEdge({ ...link, active: false });
            const target = store.state.editorTarget;
            if (target !== null && target.kind === 'link' && target.id === linkId) {
              store.update({ editorTarget: null, selectedLinkId: null });
            }
            close();
            scheduleRefresh();
            onDeleted?.();
          } catch (err) {
            errorDialog('Удалить связь', err);
          }
        },
      },
      {
        label: alreadyMarked ? t('actions.restore') : t('actions.toTrash'),
        keepOpen: true,
        onClick: async (close) => {
          try {
            await etn.links.update(
              networkId,
              linkId,
              { marked_for_deletion: !alreadyMarked },
              await linkVersion(networkId, linkId),
            );
            close();
            scheduleRefresh();
            notice(alreadyMarked ? 'Связь возвращена из корзины.' : 'Связь помещена в корзину.');
          } catch (err) {
            errorDialog(alreadyMarked ? 'Вернуть из корзины' : 'Поместить в корзину', err);
          }
        },
      },
      { label: t('actions.cancel') },
    ],
    onClose: () => void releaseHeld(handle),
  });
}

/**
 * Group-delete dialog for two or more thoughts (08-ui-spec.md §5a.2). One
 * `deletion-check-batch` call up front; each row defaults to «В корзину»
 * (locked to it when blocked). The dialog is a two-column table — a mini-cloud
 * of the thought (real icon/colors/fonts, dimmed with a red trash mark when
 * already in the trash) and the «Удалить»/«В корзину» radio pair in a separate
 * column. The mass toggles («все в корзину» / «удалять возможное») live in a
 * toolbar above the table; the footer carries only «Применить» and «Отмена».
 * «Применить» splits the final choice into one `trash` and one `purge` batch
 * call, then reflects the outcome in every view (canvas, selection panel,
 * history, editor, structures) — the panel selection itself stays open.
 */

/** Safe default of every group-delete row (§5a.2): «В корзину» (`purge=false`). */
function defaultChoice(ids: string[]): Map<string, boolean> {
  return new Map(ids.map((id) => [id, false]));
}

/**
 * Writes a mass toggle into the choice map (§5a.2): `all-trash` sets every row
 * to «В корзину»; `delete-possible` sets «Удалить» only where the
 * deletion-check allows it — blocked rows stay on «В корзину».
 */
function applyMassToggle(
  choice: Map<string, boolean>,
  ids: string[],
  checks: Record<string, { blocked: boolean }>,
  mode: 'all-trash' | 'delete-possible',
): void {
  for (const id of ids) {
    choice.set(id, mode === 'delete-possible' && !(checks[id]?.blocked ?? false));
  }
}

/** Splits the final row choices into the two batch-call id lists (§5a.2). */
function splitChoice(
  ids: string[],
  choice: Map<string, boolean>,
): { trashIds: string[]; purgeIds: string[] } {
  const trashIds: string[] = [];
  const purgeIds: string[] = [];
  for (const id of ids) {
    if (choice.get(id) === true) purgeIds.push(id);
    else trashIds.push(id);
  }
  return { trashIds, purgeIds };
}

/** Pure model of the group-delete dialog (08-ui-spec.md §5a.2), unit-tested. */
export const trashInternals = {
  defaultChoice,
  applyMassToggle,
  splitChoice,
  blockingReasons,
  // Подпись связи (ошибка ce687b37) — общее правило диалога удаления связи и
  // строки корзины, тоже под тестами.
  linkCaption,
  linkTypeForwardName,
  // Число мест использования в колонке «Ссылок» корзины (ошибка 009784ad).
  referencesText,
  thoughtTrashRow,
  linkTrashRow,
};

export async function openThoughtGroupDeleteDialog(
  networkId: string,
  ids: string[],
): Promise<void> {
  let checks: Record<string, ThoughtDeletionCheckResult>;
  let refs: import('@etn/shared').ThoughtRef[];
  try {
    [checks, refs] = await Promise.all([
      etn.thoughts.deletionCheck(networkId, ids),
      etn.thoughts.resolve(networkId, ids),
    ]);
  } catch (err) {
    errorDialog('Удаление выбранного', err);
    return;
  }
  const refById = new Map(refs.map((r) => [r.id, r]));
  // `purge: true` means "Удалить"; `false` means "В корзину" (the safe default).
  const choice = defaultChoice(ids);

  const totalOrphaned = ids.reduce((sum, id) => sum + (checks[id]?.orphaned_children ?? 0), 0);

  const body = div('group-delete');

  // Mass-toggle toolbar («Переключить: …») — above the table, so the footer
  // stays reserved for the dialog-level actions only (§5a.2).
  const toolbar = div('group-delete-toolbar');
  toolbar.append(span(t('trash.group.toggle'), 'group-delete-toolbar-label'));
  toolbar.append(
    uiButton({
      label: t('trash.group.allToTrash'),
      role: 'secondary',
      size: 's',
      title: 'Все строки — «В корзину»',
      onClick: () => massToggle('all-trash'),
    }),
    uiButton({
      label: t('trash.group.deletePossible'),
      role: 'secondary',
      size: 's',
      title: 'Незаблокированные строки — «Удалить», заблокированные — «В корзину»',
      onClick: () => massToggle('delete-possible'),
    }),
  );

  /** Sets every row at once (§5a.2 semantics) and syncs the radio inputs. */
  const massToggle = (mode: 'all-trash' | 'delete-possible'): void => {
    applyMassToggle(choice, ids, checks, mode);
    syncRadios();
  };

  /** Radio inputs per row — kept so mass toggles repaint without a rebuild. */
  const radiosById = new Map<string, { purge: HTMLInputElement; trash: HTMLInputElement }>();

  /** Updates the checked state of every row radio from {@link choice}. */
  const syncRadios = (): void => {
    for (const id of ids) {
      const pair = radiosById.get(id);
      if (pair === undefined) continue;
      const purge = choice.get(id) === true;
      pair.purge.checked = purge;
      pair.trash.checked = !purge;
    }
  };

  /**
   * Builds the mini-cloud cell: the thought's icon and title rendered with its
   * real colors/fonts by the shared cloud factory, dimmed and marked with a
   * red trash glyph when the thought is already in the trash (§2.2 marks, mini
   * version).
   */
  const buildCloudCell = (id: string): HTMLElement => {
    const ref = refById.get(id);
    const cloud = createThoughtCloud(ref ?? { id, title: id }, { profile: 'chip' });
    cloud.classList.add('group-delete-cloud');
    setTooltip(cloud, ref?.title ?? id);
    return cloud;
  };

  /** Builds the toggle cell — the «Удалить»/«В корзину» radio pair. */
  const buildToggleCell = (id: string): HTMLElement => {
    const blocked = checks[id]?.blocked ?? false;
    const toggle = div('group-delete-toggle');
    const purgeRadio = choiceControl('radio', {
      name: `gd-${id}`,
      checked: choice.get(id) === true,
      disabled: blocked,
    });
    const blockedTooltip = `Нельзя удалить совсем — ${blockingReasons(
      'мысль',
      checks[id]?.blocking ?? { properties: 0, layers: [] },
    ).join('; ')}`;
    setTooltip(purgeRadio, blocked ? blockedTooltip : t('actions.deleteForever'));
    purgeRadio.addEventListener('change', () => {
      if (purgeRadio.checked) choice.set(id, true);
    });
    const trashRadio = choiceControl('radio', {
      name: `gd-${id}`,
      checked: choice.get(id) !== true,
    });
    setTooltip(trashRadio, 'Поместить в корзину');
    trashRadio.addEventListener('change', () => {
      if (trashRadio.checked) choice.set(id, false);
    });
    const purgeLabel = el('label', 'group-delete-option');
    purgeLabel.append(
      purgeRadio,
      span(blocked ? t('trash.group.purgeBlocked') : t('actions.delete')),
    );
    const trashLabel = el('label', 'group-delete-option');
    trashLabel.append(trashRadio, span(t('trash.group.toTrash')));
    toggle.append(purgeLabel, trashLabel);
    radiosById.set(id, { purge: purgeRadio, trash: trashRadio });
    return toggle;
  };

  // Список группового удаления — единая таблица фасада `lib/ui/table.ts`
  // (задача ae76b75e, требование 93115633): текущая строка, клавиатура,
  // копирование; строки — из словаря локализации. Radio-приёмка строки
  // остаётся прежней (одна модель `choice`, массовые переключатели её правят).
  const table = createTable<string>({
    ariaLabel: t('trash.group.aria'),
    columns: [
      {
        key: 'thought',
        header: t('trash.group.col.thought'),
        text: (id) => refById.get(id)?.title ?? id,
        render: (id) => buildCloudCell(id),
      },
      {
        key: 'action',
        header: t('trash.group.col.action'),
        width: '260px',
        text: (id) => (choice.get(id) === true ? t('actions.deleteForever') : t('actions.toTrash')),
        render: (id) => buildToggleCell(id),
      },
    ],
    rows: ids,
    rowKey: (id) => id,
  });
  // Сетке нужен ограниченный контейнер (прежний лимит «10 строк + шапка»).
  table.element.style.height = 'min(50vh, 420px)';

  body.append(toolbar, table.element);
  if (totalOrphaned > 0) {
    body.append(
      el(
        'p',
        'dialog-text group-delete-warning',
        `${totalOrphaned} потомк${totalOrphaned === 1 ? '' : 'ов'} лишится родителя.`,
      ),
    );
  }

  showDialog({
    title: `Удаление выбранного (${ids.length})`,
    size: 'l',
    body,
    buttons: [
      {
        label: t('actions.apply'),
        primary: true,
        keepOpen: true,
        ref: (btn) => setTooltip(btn, 'Применить указанные удаление/помещение в корзину'),
        onClick: async (close) => {
          const { trashIds, purgeIds } = splitChoice(ids, choice);
          try {
            let failures = 0;
            if (trashIds.length > 0) {
              const r = await etn.thoughts.batch(networkId, { ids: trashIds, op: 'trash' });
              const failed = new Set(r.failures.map((f) => f.id));
              failures += r.failures.length;
              const markedIds = trashIds.filter((id) => !failed.has(id));
              // The batch response carries no entities — drop the cached refs
              // of the marked ids so the refreshed focus re-resolves them and
              // the trash badges / dim style appear at once (no realtime echo
              // to the actor, 04-realtime.md §5). Then fetch the fresh rows
              // and reflect each one everywhere it may be shown: the focus
              // cloud, the zones, the editor (trash mark + struck-through
              // title), the structures list, the pinned and history bars.
              for (const id of markedIds) invalidateRef(id);
              const fresh = await Promise.all(
                markedIds.map((id) => etn.thoughts.get(networkId, id).catch(() => null)),
              );
              for (const thought of fresh) {
                if (thought !== null) reflectThoughtUpdate(thought);
              }
              // The selection panel keeps working with the marked thoughts —
              // repaint its rows so the trash marks show up there too.
              refreshSelectionPanel();
            }
            if (purgeIds.length > 0) {
              const r = await etn.thoughts.batch(networkId, { ids: purgeIds, op: 'purge' });
              const failed = new Set(r.failures.map((f) => f.id));
              failures += r.failures.length;
              // onThoughtDeleted prunes each purged id from the selection,
              // pins, history and structures individually — the selection
              // panel itself stays open with the remaining thoughts.
              for (const id of purgeIds) {
                if (!failed.has(id)) await onThoughtDeleted(id);
              }
            }
            close();
            scheduleRefresh();
            // The `trashed` filter hides marked thoughts from the structures
            // selection and the search results by default — reload both
            // alongside the canvas.
            scheduleStructuresRefresh();
            refreshSearchIfVisible();
            notice(failures > 0 ? `Применено, ошибок: ${failures}.` : 'Применено.');
          } catch (err) {
            errorDialog('Удаление выбранного', err);
          }
        },
      },
      { label: t('actions.cancel') },
    ],
    onClose: () => table.destroy(),
  });
}

/**
 * The trash dialog (08-ui-spec.md §5a.4; переделан по ошибке 009784ad, 0.8.2):
 * every marked thought/link with its precomputed blocking, laid out as a table
 * instead of a wrapping list — «что в корзине» (мысль — название, связь —
 * «источник → назначение · тип связи»), «Ссылок» (мест использования) и
 * кнопки-иконки «Восстановить»/«Удалить» с подсказками. «Удалить» активна
 * только у строки, которую действительно можно удалить физически (`blocked`
 * приходит из `GET /trash` вместе с `blocking`), у заблокированной её тултип
 * объясняет причину.
 *
 * Имена концов связей и число мест использования мыслей диалог догружает к
 * одному `GET /trash` — у ребра в ответе только id, а использования он не несёт.
 */
/** Строка диалога корзины — модель, которой живёт единая таблица фасада. */
interface TrashDialogRow {
  id: string;
  kind: 'thought' | 'link';
  label: string;
  count: number | null;
  blocked: boolean;
  reason: string;
  onRestore: () => Promise<void>;
  onDelete: () => Promise<void>;
}

export async function openTrashDialog(networkId: string): Promise<void> {
  const body = div('trash list-dialog-body');
  const listHost = div('trash-table');
  // Высоту области списка задаёт раскладка диалога-списка (`.list-dialog-body`,
  // правило 9 требования 11ddd910) — она тянется на свободную высоту роли.

  // Правило 1 требования 11ddd910: поле горячего поиска — ПЕРВАЯ строка
  // диалога, над строкой управления и списком; плейсхолдер — из словаря.
  const searchRow = div('form-row type-list-search');
  const searchInput = fieldInput({ extraClass: 'trash-search' }) as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = t('actions.search');
  searchRow.append(searchInput);

  /** Ячейка «что в корзине»: подпись строки и метка блокировки (§5a.4). */
  const buildItemCell = (row: TrashDialogRow): HTMLElement => {
    const item = div('trash-item');
    item.append(span(row.label, 'trash-item-title'));
    if (row.blocked) {
      // Замок — статичная индикация блокировки: видно, не наводя курсор.
      const lock = span('🔒', 'trash-item-lock');
      setTooltip(lock, row.reason || 'заблокировано для удаления');
      item.append(lock);
    }
    setTooltip(item, row.label);
    return item;
  };

  /** Пункты контекстного меню строки корзины (правило 8 требования 11ddd910):
   *  «Вернуть из корзины» и «Удалить совсем»; у заблокированной строки
   *  удаление погашено. Словарь подписей — `lib/i18n.ts`. */
  function trashRowMenu(row: TrashDialogRow): MenuItem[] {
    return [
      menuAction(t('actions.restore'), () => void row.onRestore()),
      menuAction(t('actions.deleteForever'), () => void row.onDelete(), {
        danger: true,
        disabled: row.blocked,
      }),
    ];
  }

  // Единая таблица корзины (задача ae76b75e, требование 93115633): текущая
  // строка, клавиатура, копирование; строки — из словаря локализации.
  // Правило 6 требования 11ddd910 (список, не выбор): клик делает строку
  // текущей, двойной клик открывает сущность в редакторе.
  const table = createTable<TrashDialogRow>({
    ariaLabel: t('trash.aria'),
    columns: [
      {
        key: 'item',
        header: t('trash.col.item'),
        text: (row) => row.label,
        render: (row) => buildItemCell(row),
      },
      {
        key: 'count',
        header: t('trash.col.count'),
        width: '90px',
        align: 'end',
        text: (row) => referencesText(row.count),
        render: (row) => span(referencesText(row.count), 'trash-count'),
      },
    ],
    rows: [],
    rowKey: (row) => row.id,
    emptyText: t('trash.empty'),
    emptyHint: t('trash.emptyHint'),
    onCurrentChange: () => updateButtons(),
    onDblActivate: (row) => openRowInEditor(row),
    // Правило 8 требования 11ddd910: команды над строкой — в её контекстном
    // меню (построчных крестиков «Восстановить»/«Удалить» в строках нет).
    rowMenu: (row) => trashRowMenu(row),
  });
  listHost.append(table.element);

  // Правило 2 требования 11ddd910: строка управления НАД списком. «Вернуть из
  // корзины» и «Удалить совсем» действуют на ТЕКУЩУЮ строку и гаснут без неё
  // (`updateButtons`); «Удалить всё, что возможно» — массовое действие над
  // списком (прежде стояло в футере, который правило 3 оставляет решению).
  const toolbar = div('form-row type-list-toolbar trash-toolbar');
  const restoreBtn = uiButton({
    label: t('trash.action.restore'),
    role: 'secondary',
    size: 's',
    title: 'Вернуть текущую строку из корзины',
    disabled: true,
    onClick: () => void currentRow()?.onRestore(),
  });
  const deleteBtn = uiButton({
    label: t('actions.deleteForever'),
    role: 'secondary',
    size: 's',
    title: 'Удалить текущую строку совсем',
    disabled: true,
    onClick: () => void currentRow()?.onDelete(),
  });
  const purgeAllBtn = uiButton({
    label: 'Удалить всё, что возможно',
    role: 'danger',
    size: 's',
    title: 'Физически удалить все незаблокированные строки корзины',
    onClick: () => void purgeAll(),
  });
  toolbar.append(restoreBtn, deleteBtn, purgeAllBtn);

  // Правила 1–2: поиск (первая строка), под ним управление, затем список.
  body.append(searchRow, toolbar, listHost);

  /** Строки всей корзины до фильтра поиска (правило 1, клиентский фильтр). */
  let allRows: TrashDialogRow[] = [];

  /** Закрытие диалога; присваивается сразу после `showDialog`. */
  let closeDialog: () => void = () => undefined;

  /** Текущая строка списка — на неё действует строка управления (правило 2). */
  function currentRow(): TrashDialogRow | null {
    return table.getCurrent()?.row ?? null;
  }

  /** Гасит кнопки текущей строки без неё (и «Удалить совсем» — у заблокированной). */
  function updateButtons(): void {
    const row = currentRow();
    restoreBtn.disabled = row === null;
    deleteBtn.disabled = row === null || row.blocked;
  }

  /** Правило 6: двойной клик по строке открывает сущность в редакторе. */
  function openRowInEditor(row: TrashDialogRow): void {
    if (row.kind === 'thought') {
      closeDialog();
      openThoughtInEditor(row.id);
      return;
    }
    void etn.links
      .get(networkId, row.id)
      .then((link) => {
        closeDialog();
        openLinkInEditor(link);
      })
      .catch(() => undefined);
  }

  /** Клиентский фильтр по подписи строки; пустой запрос — вся корзина. */
  function applyFilter(): void {
    const query = searchInput.value.trim().toLowerCase();
    const visible =
      query === '' ? allRows : allRows.filter((row) => row.label.toLowerCase().includes(query));
    table.setEmpty(
      allRows.length === 0
        ? { title: t('trash.empty'), hint: t('trash.emptyHint') }
        : { title: t('trash.emptySearch'), hint: t('trash.emptySearchHint') },
    );
    table.setRows(visible);
    updateButtons();
  }
  searchInput.addEventListener('input', () => applyFilter());

  /** Полная физическая очистка корзины (массовое управление над списком). */
  async function purgeAll(): Promise<void> {
    try {
      const { purged, skipped } = await etn.trash.purge(networkId);
      scheduleRefresh();
      notice(`Удалено ${purged}, осталось заблокировано ${skipped}.`);
      await render();
    } catch (err) {
      errorDialog('Очистить корзину', err);
    }
  }

  const render = async (): Promise<void> => {
    let trash: TrashListResult;
    try {
      trash = await etn.trash.list(networkId);
    } catch (err) {
      errorDialog('Корзина', err);
      return;
    }

    // Догрузка к одному `GET /trash`: названия концов связей (в рёбрах только
    // id) и число мест использования мыслей (`GET /thoughts/{id}/usage`).
    const titles = await resolveThoughtTitles(
      networkId,
      trash.links.flatMap((l) => [l.source_id, l.target_id]),
    );
    const usageById = new Map<string, number | null>();
    await Promise.all(
      trash.thoughts.map(async (t) => {
        try {
          usageById.set(t.id, (await etn.thoughts.usage(networkId, t.id)).total);
        } catch {
          usageById.set(t.id, null);
        }
      }),
    );

    const out: TrashDialogRow[] = [];
    for (const t of trash.thoughts) {
      const view = thoughtTrashRow(t, usageById.get(t.id) ?? null);
      out.push({
        id: t.id,
        kind: 'thought',
        label: view.label,
        count: view.count,
        blocked: t.blocked,
        reason: blockingReasons('мысль', t.blocking).join('; '),
        onRestore: () => restoreThought(networkId, t.id),
        onDelete: () => deleteFromTrash(networkId, t.id),
      });
    }
    for (const l of trash.links) {
      const view = linkTrashRow(l, titles);
      out.push({
        id: l.id,
        kind: 'link',
        label: view.label,
        count: view.count,
        blocked: l.blocked,
        reason: blockingReasons('связь', l.blocking).join('; '),
        onRestore: () => restoreLink(networkId, l.id),
        onDelete: () => deleteLinkFromTrash(networkId, l.id),
      });
    }
    allRows = out;
    applyFilter();
  };

  const restoreThought = async (networkId: string, id: string): Promise<void> => {
    try {
      const updated = await etn.thoughts.update(
        networkId,
        id,
        { marked_for_deletion: false },
        await thoughtVersion(networkId, id),
      );
      // Reflect the restore everywhere the thought may be shown (canvas badge
      // and dim style, editor, structures, pinned/history bars) — no realtime
      // echo to the actor, so the response entity is the only feedback.
      reflectThoughtUpdate(updated);
      await render();
    } catch (err) {
      errorDialog('Вернуть из корзины', err);
    }
  };
  const restoreLink = async (networkId: string, id: string): Promise<void> => {
    try {
      await etn.links.update(
        networkId,
        id,
        { marked_for_deletion: false },
        await linkVersion(networkId, id),
      );
      scheduleRefresh();
      await render();
    } catch (err) {
      errorDialog('Вернуть из корзины', err);
    }
  };
  const deleteFromTrash = async (networkId: string, id: string): Promise<void> => {
    try {
      await etn.thoughts.remove(networkId, id, await thoughtVersion(networkId, id));
      await onThoughtDeleted(id);
      await render();
    } catch (err) {
      errorDialog(t('actions.delete'), err);
    }
  };
  const deleteLinkFromTrash = async (networkId: string, id: string): Promise<void> => {
    try {
      // 0.8.1: `DELETE /links/{id}` снят (3ea5c6af) — пер-элементная чистка
      // ребра из корзины идёт точечным purge (строка уже помечена).
      await etn.trash.purge(networkId, [id]);
      scheduleRefresh();
      await render();
    } catch (err) {
      errorDialog(t('actions.delete'), err);
    }
  };

  // Правило 3 требования 11ddd910: футер — только кнопка решения. Массовое
  // «Удалить всё, что возможно» ушло в строку управления над списком.
  closeDialog = showDialog({
    title: 'Корзина',
    size: 'xl',
    body,
    // Высота диалога стабильна: задана ролью, не содержимым списка/поиска
    // (правило 9 требования 11ddd910, ошибка f68bb43c).
    fixedHeight: true,
    buttons: [{ label: t('actions.close'), primary: true }],
    onMount: () => void render(),
    onClose: () => table.destroy(),
  });
}
