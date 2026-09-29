/**
 * Editor tab «Дневник (N)» — chronological comments (H9 → L7,
 * 08-ui-spec.md §6.6; переименование «Хроника» → «Дневник» — требование
 * 80b31f7a, ревизия 0.10.1).
 *
 * Two areas separated by a splitter:
 *  - the table of chronological records: three columns «Период» / «Заголовок» /
 *    «Редактор», built on the shared list facade `lib/ui/table.ts` (keyboard
 *    navigation, row context menu, one-line ellipsis cells with a full-text
 *    tooltip). Click selects a record for viewing, double click (or Enter)
 *    selects and enters edit mode; «Добавить» starts a new one and immediately
 *    opens it for editing. The row menu offers «Открыть в дневнике» (switch to
 *    the diary screen on this record) and «Удалить» (with confirmation).
 *  - the inline editor area: a one-line record header (period value — click
 *    opens the shared «Дата/период» dialog — and a title input filling the rest
 *    of the width) plus a markdown field that behaves exactly like the permanent
 *    comment — HTML view, double-click edits, blur autosaves and returns to the
 *    view, Esc reverts. The first non-empty blur (title or text) of a new record
 *    creates it — the same content rule as the diary screen (`hasRecordContent`,
 *    requirement 26f0aa52); metadata edits of an existing record save on blur.
 *    With nothing selected the area shows a hint.
 *
 * Даты записи — полные UTC-инстансы с миллисекундами (требование d58aa1a4);
 * `valid_to` непуст (незаполненное = `valid_from`). Смена только даты сохраняет
 * время суток, правка часов:минут — секунды/мс (ADR времени 994d076a). Флаг
 * `use_time` (показ времени) задаётся диалогом «Дата/период» (его `hasTime`) и
 * управляет показом времени через единый помощник `formatRecordPeriod`
 * (`lib/date-period-dialog.ts`) — тем же, что и в ленте экрана «Дневник».
 *
 * The tab content is built only when the tab is active; the `(N)` badge in the
 * tab title is refreshed after every change.
 */

import type { Comment } from '@etn/shared';
import { t } from '../lib/i18n.js';

import { requireNetworkId } from '../app.js';
import { invalidateIndicators } from '../canvas/canvas.js';
import { confirmDialog } from '../lib/dialog.js';
import { div, errText } from '../lib/dom.js';
import { MENU_SEPARATOR, menuAction, type MenuItem } from '../lib/menu.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { ensureLoaded, resolve as resolveUser } from '../lib/users.js';
import { notice } from '../lib/notice.js';
import { refreshTabCount, registerTabContent, registerTabCount, type EditorContext } from './editor.js';
import { createMarkdownField, editMarkdownField } from './markdown-field.js';
import { rowSplitter } from './splitter.js';
import { commentShell } from '../lib/ui/comment.js';
import { uiButton } from '../lib/ui/button.js';
import { fieldInput } from '../lib/ui/field.js';
import { createTable, type TableHandle } from '../lib/ui/table.js';
import {
  datePeriodValueFromInstants,
  formatRecordPeriod,
  openDatePeriodDialog,
  resolveDatePeriodInstants,
} from '../lib/date-period-dialog.js';

/** Сколько символов первой непустой строки заметки берём в колонку «Заголовок». */
const TITLE_FROM_BODY_MAX = 250;

/** Registers the «Дневник» tab content and its badge counter (L7). */
export function registerChronoTab(): void {
  registerTabContent('chrono', buildChronoTab);
  registerTabCount('chrono', async (ctx) => {
    try {
      const comments = await etn.comments.list(
        requireNetworkId(),
        ctx.ownerType,
        ctx.ownerId,
      );
      return comments.filter((c) => c.kind === 'chronological').length;
    } catch {
      return undefined;
    }
  });
}

/** Builds the whole «Дневник» tab pane content for the entity. */
function buildChronoTab(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const root = div('chrono-tab');
  // Имена «Редактор»/авторов берём из кэша пользователей (best-effort): пока он
  // не загружен, ячейка показывает id в скобках, после — имя.
  ensureLoaded();

  const top = div('chrono-top');
  const toolbar = div('chrono-toolbar');
  toolbar.append(uiButton({
    label: 'Добавить',
    role: 'secondary',
    size: 's',
    onClick: () => startNew(),
  }));
  const tableWrap = div('admin-table-wrap chrono-table');
  top.append(toolbar, tableWrap);

  const bottom = div('chrono-editor');
  root.append(
    top,
    // The drag is remembered as the table's exact fixed height (ee745368,
    // 4cc6248c) — it never depends on the current row count.
    rowSplitter(() => tableWrap, {
      min: 34,
      persistKey: 'chrono',
    }),
    bottom,
  );

  let selectedId: string | null = null;
  /** Markdown field of the record currently shown below (for Enter/dblclick edit). */
  let activeWidget: HTMLElement | null = null;
  /** Row id the active editor area belongs to; `null` for a brand-new record. */
  let activeRowId: string | null = null;
  /**
   * Авто-выбор верхней строки выполняется один раз при открытии вкладки
   * (0.10.2, задача 41ed99ab): поздние перезагрузки (правка, добавление) выбор
   * пользователя не перебивают.
   */
  let autoSelectDone = false;

  // Таблица — единый фасад списков `lib/ui/table.ts`: колонки, сортировка,
  // клавиатурная навигация (стрелки, Home/End, PgUp/PgDn, Enter), контекстное
  // меню строки и подсказка с полным текстом обрезанной ячейки — из коробки.
  const table: TableHandle<Comment> = createTable<Comment>({
    columns: [
      {
        key: 'period',
        header: t('chrono.col.period'),
        sortable: true,
        sortValue: (c) => c.valid_from,
        render: (c) => formatRecordPeriod(c.valid_from, c.valid_to, c.use_time === true),
      },
      {
        key: 'title',
        header: t('chrono.col.title'),
        render: (c) => recordTitle(c),
      },
      {
        key: 'editor',
        header: t('chrono.col.editor'),
        render: (c) => userLabel(c.updated_by),
      },
    ],
    rows: [],
    rowKey: (c) => c.id,
    emptyText: t('chrono.empty'),
    emptyHint: t('chrono.emptyHint'),
    ariaLabel: t('chrono.aria'),
    sortMode: 'toggle',
    defaultSort: { key: 'period', dir: 'desc' },
    onCurrentChange: (key, row) => {
      selectedId = key;
      if (row !== null) buildEditor(row);
    },
    // Enter и двойной клик — «выбрать и перевести в редактирование».
    onActivate: (row) => {
      selectedId = row.id;
      if (activeRowId === row.id && activeWidget !== null) editMarkdownField(activeWidget);
      else buildEditor(row, true);
    },
    rowMenu: (row) => recordMenuItems(row),
  });
  tableWrap.append(table.element);

  void reload();
  // The tab opens with an empty editor area — a comment is picked by a click
  // on a table row, a new one starts via «Добавить» (08-ui-spec.md §6.6).
  showEmptyEditor();

  /** Loads and renders the chronological table. */
  async function reload(keepSelection = true): Promise<void> {
    let comments: Comment[];
    try {
      comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
    } catch (err) {
      table.element.hidden = true;
      tableWrap.replaceChildren(operationError(err));
      return;
    }
    const chrono = comments.filter((c) => c.kind === 'chronological');
    if (!keepSelection || !chrono.some((c) => c.id === selectedId)) {
      selectedId = null;
    }
    refreshTabCount('chrono');
    tableWrap.replaceChildren(table.element);
    table.element.hidden = false;
    table.setRows(chrono);
    if (selectedId !== null) table.setCurrent(selectedId);
    // При открытии вкладки текущей становится САМАЯ ВЕРХНЯЯ строка (порядок —
    // обратный хронологический, `defaultSort: period desc`), чтобы сразу
    // показался текст её комментария (0.10.2, задача 41ed99ab). Авто-выбор — при
    // отсутствии выбора и только однократно: явно выбранную строку возврат на
    // ту же мысль не сбрасывает.
    if (!autoSelectDone) {
      autoSelectDone = true;
      if (selectedId === null && chrono.length > 0) {
        const top = table.getRows()[0];
        if (top !== undefined) {
          selectedId = top.id;
          table.setCurrent(top.id);
          buildEditor(top);
        }
      }
    }
  }

  /** Opens the diary screen on this record (calendar date + current record). */
  async function openInDiary(comment: Comment): Promise<void> {
    // Ленивый импорт: статический замкнул бы цикл editor → chronicle → editor.
    const { openChronicleRecord } = await import('../screens/chronicle/chronicle.js');
    await openChronicleRecord({
      id: comment.id,
      valid_from: comment.valid_from,
      valid_to: comment.valid_to,
    });
  }

  /** Row context menu: open the record in the diary screen, or delete it. */
  function recordMenuItems(comment: Comment): MenuItem[] {
    return [
      menuAction(t('chrono.menu.openInDiary'), () => void openInDiary(comment)),
      MENU_SEPARATOR,
      menuAction(t('actions.delete'), () => void removeComment(comment), { danger: true }),
    ];
  }

  /** Resets the editor area for a brand-new comment (edit mode at once). */
  function startNew(): void {
    selectedId = null;
    activeRowId = null;
    table.setCurrent(null);
    buildEditor(null, true);
  }

  /** Shows an empty editor area — nothing is selected yet (§6.6). */
  function showEmptyEditor(): void {
    selectedId = null;
    activeRowId = null;
    activeWidget = null;
    const shell = commentShell({
      variant: 'fill',
      state: { kind: 'empty', text: t('chrono.emptyEditor') },
    });
    bottom.replaceChildren(shell.root);
  }

  /**
   * Builds the inline editor area: one-line record header (period + title) and
   * markdown field. `existing` is null for a new comment; the first non-empty
   * text blur creates it.
   */
  function buildEditor(existing: Comment | null, startEdit = false): void {
    const titleInput = fieldInput({ extraClass: 'chrono-meta-input' });
    titleInput.type = 'text';
    titleInput.value = existing?.title ?? '';
    titleInput.maxLength = 200;
    titleInput.placeholder = 'Заголовок';

    // Даты записи — полные UTC-инстансы (требование d58aa1a4). У новой записи
    // «С = По = сегодня»: текущий момент (дата + текущее время, ADR 994d076a).
    const now = new Date().toISOString();
    let fromInstant = existing?.valid_from ?? now;
    let toInstant = existing?.valid_to ?? fromInstant;
    // Показ времени записью; задаётся ответом диалога «Дата/период» (hasTime).
    let useTime = existing?.use_time === true;

    let commentId: string | null = existing?.id ?? null;
    let version = existing?.version ?? 0;

    /** Подпись периода записи — единый помощник (одна точка правды с лентой). */
    const refreshDateLabel = (): void => {
      dateBtn.textContent = formatRecordPeriod(fromInstant, toInstant, useTime);
    };

    /** Открыть диалог «Дата/период» (период и время разрешены). */
    const openPeriodDialog = async (): Promise<void> => {
      const result = await openDatePeriodDialog({
        allowPeriod: true,
        allowTime: true,
        initial: datePeriodValueFromInstants(fromInstant, toInstant, useTime, true),
      });
      if (result === null) return;
      const next = resolveDatePeriodInstants(result, { from: fromInstant, to: toInstant });
      fromInstant = next.from;
      toInstant = next.to;
      // Ответ диалога задаёт показ времени (отдельного флажка в шапке нет).
      useTime = result.hasTime === true;
      refreshDateLabel();
      commitMeta();
    };

    // Дата/период правятся диалогом (0.10.1): значение — кликабельная подпись,
    // инлайн-контрол периода упразднён.
    const dateBtn = uiButton({
      label: '',
      role: 'ghost',
      size: 's',
      class: 'chrono-date-value',
      title: 'Дата записи',
      onClick: () => void openPeriodDialog(),
    });
    refreshDateLabel();

    // Шапка записи — одна строка: период (клик — диалог) и заголовок во всю
    // оставшуюся ширину. Удаление — в контекстном меню строки таблицы.
    const metaRow = div('chrono-meta-row');
    metaRow.append(dateBtn, titleInput);

    /**
     * Сохраняет метаданные записи (заголовок, даты, показ времени). У
     * псевдо-записи (`commentId === null`) непустой заголовок сам по себе —
     * содержание: запись создаётся (паритет с экраном «Дневник», правило
     * `hasRecordContent`, требование 26f0aa52). Пустой заголовок и одни даты
     * запись не создают. Иначе метаданные существующей записи обновляются.
     */
    const commitMeta = (): void => {
      void (async () => {
        try {
          const title = titleInput.value.trim() || null;
          if (commentId === null) {
            if (title === null) return;
            const created = await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
              kind: 'chronological',
              title,
              body_md: '',
              valid_from: fromInstant,
              valid_to: toInstant,
              use_time: useTime,
            });
            commentId = created.id;
            version = created.version;
            selectedId = created.id;
            activeRowId = created.id;
          } else {
            const id = commentId;
            const updated = await etn.comments.update(networkId, id, {
              title,
              valid_from: fromInstant,
              valid_to: toInstant,
              use_time: useTime,
            }, version);
            version = updated.version;
          }
          invalidateIndicators(ctx.ownerId);
          await reload();
        } catch (err) {
          notice(`Не удалось сохранить: ${errText(err)}`, 'error');
        }
      })();
    };

    titleInput.addEventListener('blur', commitMeta);

    // Оболочка комментария: панель действий — шапка записи, тело — встроенное
    // поле markdown, режим зеркалится в `data-mode` (задача 9cb87c42).
    const shell = commentShell({ variant: 'fill', tools: [metaRow] });

    const widget = createMarkdownField({
      md: existing?.body_md ?? '',
      html: existing?.body_html ?? '',
      attachmentsOwner: { ownerType: ctx.ownerType, ownerId: ctx.ownerId },
      // Контекст комментария для флоу «создать мысль по legacy-ссылке»
      // (карточка ETN 34ffbd75): после замены ссылок поле перерисовывается,
      // а таблица — обновляет колонку «Заголовок».
      commentContext: {
        ownerType: ctx.ownerType,
        ownerId: ctx.ownerId,
        commentKind: 'chronological',
        getCommentId: () => commentId,
        onLinksReplaced: () => void reload(),
      },
      onSave: async (md) => {
        if (md.trim() === '' && commentId === null) return '';
        let html: string;
        if (commentId === null) {
          const created = await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
            kind: 'chronological',
            title: titleInput.value.trim() || null,
            body_md: md,
            valid_from: fromInstant,
            valid_to: toInstant,
            use_time: useTime,
          });
          commentId = created.id;
          version = created.version;
          selectedId = created.id;
          activeRowId = created.id;
          html = created.body_html;
        } else {
          const updated = await etn.comments.update(networkId, commentId, {
            body_md: md,
            valid_from: fromInstant,
            valid_to: toInstant,
            use_time: useTime,
          }, version);
          version = updated.version;
          html = updated.body_html;
        }
        invalidateIndicators(ctx.ownerId);
        await reload();
        return html;
      },
      onEditChange: (editing) => shell.setMode(editing ? 'edit' : 'view'),
    });

    shell.setField(widget);
    shell.setState({ kind: 'ready' });
    bottom.replaceChildren(shell.root);
    activeWidget = widget;
    activeRowId = existing?.id ?? null;
    if (startEdit) editMarkdownField(widget);
  }

  /** Deletes the given record (confirmation) and clears the editor area. */
  async function removeComment(comment: Comment): Promise<void> {
    const ok = await confirmDialog(
      t('diary.deleteTitle'),
      t('diary.deleteQuestion'),
      true,
    );
    if (!ok) return;
    try {
      // Remove by id: the version is re-read to survive intermediate autosaves.
      const comments = await etn.comments.list(networkId, ctx.ownerType, ctx.ownerId);
      const current = comments.find((c) => c.id === comment.id);
      if (current === undefined) return;
      await etn.comments.remove(networkId, current.id, current.version);
      invalidateIndicators(ctx.ownerId);
      if (selectedId === comment.id) showEmptyEditor();
      await reload();
    } catch (err) {
      notice(`Не удалось удалить: ${errText(err)}`, 'error');
    }
  }

  return root;
}

/** Title for the «Заголовок» cell: `title`, else the first non-empty body line. */
function recordTitle(comment: Comment): string {
  const title = (comment.title ?? '').trim();
  if (title !== '') return title;
  for (const line of comment.body_md.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '') continue;
    return text.length > TITLE_FROM_BODY_MAX ? `${text.slice(0, TITLE_FROM_BODY_MAX)}…` : text;
  }
  return '';
}

/** Author name for the «Редактор» cell (falls back to the raw id in brackets). */
function userLabel(userId: string | null): string {
  if (userId === null || userId === '') return '';
  return resolveUser(userId) ?? `(${userId})`;
}
