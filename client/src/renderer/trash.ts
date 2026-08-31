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
  type TrashLinkEntry,
  type TrashThoughtEntry,
} from '@etn/shared';

import { onThoughtDeleted, scheduleRefresh } from './app.js';
import {
  applyCloudStyle,
  applyThoughtIcon,
  invalidateRef,
  resolveCloudStyle,
} from './canvas/canvas.js';
import { reflectThoughtUpdate } from './editor/editor.js';
import { refreshSearchIfVisible } from './search/search.js';
import { scheduleStructuresRefresh } from './screens/structures/structures.js';
import { refreshSelectionPanel } from './selection/selection.js';
import { patchFocusEdge, store } from './state.js';
import { errorDialog, showDialog, type DialogButton } from './lib/dialog.js';
import { button, div, el, setTooltip, span } from './lib/dom.js';
import { etn } from './lib/etn.js';
import { svgIcon } from './lib/icons.js';
import { notice } from './lib/notice.js';

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

/** Resolve the current version of a link (for If-Match). */
async function linkVersion(networkId: string, id: string): Promise<number> {
  return (await etn.links.get(networkId, id)).version;
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
      label: 'Удалить совсем',
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
      label: alreadyMarked ? 'Вернуть из корзины' : 'Поместить в корзину',
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
    { label: 'Отмена' },
  ];

  showDialog({
    title: `Удаление мысли «${target.title}»`,
    body,
    buttons,
    onMount: () => deleteBtn?.focus(),
  });
}

/**
 * Single-delete dialog for a link (08-ui-spec.md §5a.1). Links have no property
 * usage and no children, so only the layer arm can block — the base entry when
 * the link lives in the base and the session works in a layer, or other layers
 * that changed the link.
 */
export async function openLinkDeleteDialog(
  networkId: string,
  linkId: string,
  onDeleted?: () => void,
): Promise<void> {
  let link: Link;
  let blocked: boolean;
  let blocking: LinkDeletionBlocking;
  try {
    link = await etn.links.get(networkId, linkId);
    const result = (await etn.links.deletionCheck(networkId, [linkId]))[linkId] ?? {
      blocked: false,
      blocking: { layers: [] },
    };
    blocked = result.blocked;
    blocking = result.blocking;
  } catch (err) {
    errorDialog('Удалить связь', err);
    return;
  }

  const alreadyMarked = link.marked_for_deletion;
  const body = div('form-stack');
  if (blocked) {
    for (const reason of blockingReasons('связь', blocking)) {
      body.append(el('p', 'dialog-text', `Нельзя удалить совсем — ${reason}.`));
    }
  }

  showDialog({
    title: 'Удаление связи',
    body,
    buttons: [
      {
        label: 'Удалить совсем',
        danger: true,
        ref: (btn) => {
          btn.disabled = blocked;
        },
        keepOpen: true,
        onClick: async (close) => {
          try {
            await etn.links.remove(networkId, linkId, await linkVersion(networkId, linkId));
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
        label: alreadyMarked ? 'Вернуть из корзины' : 'Поместить в корзину',
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
      { label: 'Отмена' },
    ],
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
export const trashInternals = { defaultChoice, applyMassToggle, splitChoice, blockingReasons };

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
  toolbar.append(span('Переключить:', 'group-delete-toolbar-label'));
  toolbar.append(
    button('все в корзину', () => massToggle('all-trash'), 'btn small', 'Все строки — «В корзину»'),
    button(
      'удалять возможное',
      () => massToggle('delete-possible'),
      'btn small',
      'Незаблокированные строки — «Удалить», заблокированные — «В корзину»',
    ),
  );

  /** Sets every row at once (§5a.2 semantics) and syncs the radio inputs. */
  const massToggle = (mode: 'all-trash' | 'delete-possible'): void => {
    applyMassToggle(choice, ids, checks, mode);
    syncRadios();
  };

  const table = div('group-delete-table');
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
   * real colors/fonts (the same `applyCloudStyle`/`applyThoughtIcon` pair the
   * pinned/history chips use), dimmed and marked with a red trash glyph when
   * the thought is already in the trash (§2.2 marks, mini version).
   */
  const buildCloudCell = (id: string): HTMLElement => {
    const ref = refById.get(id);
    const cloud = div('group-delete-cloud');
    if (ref !== undefined) {
      applyCloudStyle(cloud, resolveCloudStyle(ref));
      if (!ref.active || ref.marked_for_deletion) cloud.classList.add('dim');
    }
    const icon = el('span', 'mini-icon');
    if (ref !== undefined) {
      applyThoughtIcon(icon, ref);
    } else {
      icon.textContent = '💭';
    }
    cloud.append(icon, span(ref?.title ?? id, 'group-delete-cloud-title'));
    setTooltip(cloud, ref?.title ?? id);
    if (ref?.marked_for_deletion === true) {
      const mark = span('', 'list-trash-mark');
      mark.append(svgIcon('trash', 13));
      setTooltip(mark, 'Мысль уже находится в корзине');
      cloud.append(mark);
    }
    return cloud;
  };

  /** Builds the toggle cell — the «Удалить»/«В корзину» radio pair. */
  const buildToggleCell = (id: string): HTMLElement => {
    const blocked = checks[id]?.blocked ?? false;
    const toggle = div('group-delete-toggle');
    const purgeRadio = el('input') as HTMLInputElement;
    purgeRadio.type = 'radio';
    purgeRadio.name = `gd-${id}`;
    purgeRadio.checked = choice.get(id) === true;
    purgeRadio.disabled = blocked;
    const blockedTooltip = `Нельзя удалить совсем — ${blockingReasons(
      'мысль',
      checks[id]?.blocking ?? { properties: 0, layers: [] },
    ).join('; ')}`;
    setTooltip(purgeRadio, blocked ? blockedTooltip : 'Удалить совсем');
    purgeRadio.addEventListener('change', () => {
      if (purgeRadio.checked) choice.set(id, true);
    });
    const trashRadio = el('input') as HTMLInputElement;
    trashRadio.type = 'radio';
    trashRadio.name = `gd-${id}`;
    trashRadio.checked = choice.get(id) !== true;
    setTooltip(trashRadio, 'Поместить в корзину');
    trashRadio.addEventListener('change', () => {
      if (trashRadio.checked) choice.set(id, false);
    });
    const purgeLabel = el('label', 'group-delete-option');
    purgeLabel.append(purgeRadio, span(blocked ? 'Удалить (недост.)' : 'Удалить'));
    const trashLabel = el('label', 'group-delete-option');
    trashLabel.append(trashRadio, span('В корзину'));
    toggle.append(purgeLabel, trashLabel);
    radiosById.set(id, { purge: purgeRadio, trash: trashRadio });
    return toggle;
  };

  const renderTable = (): void => {
    table.replaceChildren();
    radiosById.clear();
    const head = div('group-delete-row group-delete-head');
    head.append(
      span('Мысль', 'group-delete-head-cloud'),
      span('Действие', 'group-delete-head-toggle'),
    );
    table.append(head);
    for (const id of ids) {
      const row = div('group-delete-row');
      row.append(buildCloudCell(id), buildToggleCell(id));
      table.append(row);
    }
  };
  renderTable();

  body.append(toolbar, table);
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
    body,
    boxClass: 'group-delete-box',
    buttons: [
      {
        label: 'Применить',
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
      { label: 'Отмена' },
    ],
  });
}

/**
 * The trash dialog (08-ui-spec.md §5a.4): every marked thought/link with its
 * precomputed blocking. Rows offer restore / delete / (purge-all at the footer).
 */
export async function openTrashDialog(networkId: string): Promise<void> {
  const body = div('trash-list');
  const empty = el('p', 'dialog-text', 'Корзина пуста.');
  body.append(empty);

  const render = async (): Promise<void> => {
    let trash: { thoughts: TrashThoughtEntry[]; links: TrashLinkEntry[] };
    try {
      trash = await etn.trash.list(networkId);
    } catch (err) {
      errorDialog('Корзина', err);
      return;
    }
    while (body.firstChild !== null) body.removeChild(body.firstChild);

    if (trash.thoughts.length === 0 && trash.links.length === 0) {
      body.append(empty.cloneNode(true));
      return;
    }

    const renderRow = (
      label: string,
      locked: boolean,
      reason: string,
      onRestore: () => Promise<void>,
      onDelete: () => Promise<void>,
    ): HTMLElement => {
      const row = div('trash-row');
      const title = span(label, 'trash-row-title');
      if (locked) title.append(span(' 🔒', 'trash-row-lock'));
      row.append(title);
      const actions = div('trash-row-actions');
      actions.append(button('↩ Вернуть', () => void onRestore(), 'link-btn', 'Вернуть из корзины'));
      const delBtn = button('🗑 Удалить', () => void onDelete(), 'link-btn danger', 'Удалить');
      delBtn.disabled = locked;
      if (locked) setTooltip(delBtn, `Удалить нельзя — ${reason || 'заблокировано'}`);
      actions.append(delBtn);
      row.append(actions);
      return row;
    };

    for (const t of trash.thoughts) {
      body.append(
        renderRow(
          `📝 ${t.title}`,
          t.blocked,
          blockingReasons('мысль', t.blocking).join('; '),
          () => restoreThought(networkId, t.id),
          () => deleteFromTrash(networkId, t.id),
        ),
      );
    }
    for (const l of trash.links) {
      body.append(
        renderRow(
          `🔗 ${l.source_id} → ${l.target_id}`,
          l.blocked,
          blockingReasons('связь', l.blocking).join('; '),
          () => restoreLink(networkId, l.id),
          () => deleteLinkFromTrash(networkId, l.id),
        ),
      );
    }
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
      errorDialog('Удалить', err);
    }
  };
  const deleteLinkFromTrash = async (networkId: string, id: string): Promise<void> => {
    try {
      await etn.links.remove(networkId, id, await linkVersion(networkId, id));
      scheduleRefresh();
      await render();
    } catch (err) {
      errorDialog('Удалить', err);
    }
  };

  showDialog({
    title: 'Корзина',
    body,
    buttons: [
      {
        label: 'Удалить всё, что возможно',
        danger: true,
        keepOpen: true,
        onClick: async () => {
          try {
            const { purged, skipped } = await etn.trash.purge(networkId);
            scheduleRefresh();
            notice(`Удалено ${purged}, осталось заблокировано ${skipped}.`);
            await render();
          } catch (err) {
            errorDialog('Очистить корзину', err);
          }
        },
      },
      { label: 'Закрыть', primary: true },
    ],
    onMount: () => void render(),
  });
}
