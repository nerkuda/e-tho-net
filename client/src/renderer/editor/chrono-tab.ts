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
 *    selects and enters edit mode; «Добавить» creates an empty record at once
 *    and immediately opens it for editing. The row menu offers «Открыть в
 *    дневнике» (switch to the diary screen on this record) and «Удалить»
 *    (with confirmation).
 *  - the inline editor area: a one-line record header (period value — click
 *    opens the shared «Дата/период» dialog — and the title, shown as text in
 *    the view and as an input in the edit) plus a markdown field. Editing is
 *    UNIFIED (ТП «Дневник без псевдослота», requirement 26f0aa52): entering the
 *    edit of either field opens both; Ctrl+Enter / «Записать» / click outside
 *    the record write title and body in ONE PATCH; Esc / «Отменить» revert both;
 *    Enter in the title focuses the body at position 0; moving focus between the
 *    title and the body does not close the edit. With nothing selected the area
 *    shows a hint.
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
import { invalidateQueries, queryKeys } from '../lib/live/index.js';
import { confirmDialog } from '../lib/dialog.js';
import { div, el, errText } from '../lib/dom.js';
import { defineKeyContext, pushKeyContext } from '../lib/keymap.js';
import { modifierChordVariants } from '../lib/keymap-chords.js';
import { MENU_SEPARATOR, menuAction, type MenuItem } from '../lib/menu.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { ensureLoaded, resolve as resolveUser } from '../lib/users.js';
import { notice } from '../lib/notice.js';
import { refreshTabCount, registerTabContent, registerTabCount, type EditorContext } from './editor.js';
import {
  cancelMarkdownFieldEdit,
  commitMarkdownField,
  createMarkdownField,
  editMarkdownField,
  focusMarkdownFieldStart,
} from './markdown-field.js';
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
import { EDITOR_RECORD_TITLE_MAX, recordDisplayTitle } from '../lib/record-title.js';

/** Счётчик контекстов клавиатуры поля заголовка вкладки (уникальный id). */
let chronoTitleEditSeq = 0;

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
    onClick: () => void startNew(),
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
  /** Войти в единую правку тела текущей записи (Enter/двойной клик по строке). */
  let activeOpen: (() => void) | null = null;
  /** Row id the active editor area belongs to. */
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
      if (activeRowId === row.id && activeOpen !== null) activeOpen();
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

  /**
   * «Добавить»: СРАЗУ создаёт обычную пустую хроно-запись владельца вкладки
   * (дата — текущий момент), выбирает её строку и открывает редактор в единой
   * правке (требование 26f0aa52, модель немедленного создания).
   */
  async function startNew(): Promise<void> {
    const now = new Date().toISOString();
    try {
      const created = await etn.comments.create(networkId, ctx.ownerType, ctx.ownerId, {
        kind: 'chronological',
        title: null,
        body_md: '',
        valid_from: now,
        valid_to: now,
        use_time: false,
      });
      invalidateQueries(queryKeys.indicators(ctx.ownerId));
      selectedId = created.id;
      await reload();
      table.setCurrent(created.id);
      buildEditor(created, true);
    } catch (err) {
      notice(`Не удалось создать запись: ${errText(err)}`, 'error');
    }
  }

  /** Shows an empty editor area — nothing is selected yet (§6.6). */
  function showEmptyEditor(): void {
    selectedId = null;
    activeRowId = null;
    activeOpen = null;
    const shell = commentShell({
      variant: 'fill',
      state: { kind: 'empty', text: t('chrono.emptyEditor') },
    });
    bottom.replaceChildren(shell.root);
  }

  /**
   * Inline-редактор записи: шапка (период + заголовок) и общее поле markdown.
   *
   * Единая правка (ТП «Дневник без псевдослота»): заголовок и тело правятся
   * ВМЕСТЕ; Ctrl+Enter / «Записать» / клик вне редактора пишут оба одним PATCH;
   * Esc / «Отменить» откатывают оба; Enter в заголовке ставит фокус в тело
   * (позиция 0); переход фокуса заголовок↔тело правку не закрывает. В просмотре
   * заголовок — текст, в правке — поле ввода (требование 26f0aa52).
   */
  function buildEditor(existing: Comment, startEdit = false): void {
    // Даты записи — полные UTC-инстансы (требование d58aa1a4); `valid_to` непуст.
    let fromInstant = existing.valid_from;
    let toInstant = existing.valid_to ?? fromInstant;
    let useTime = existing.use_time === true;
    const commentId = existing.id;
    let titleValue = existing.title ?? '';
    let bodyDraft = existing.body_md;
    let editing = false;
    let widget: HTMLElement | null = null;

    // Дата/период правятся диалогом (0.10.1): значение — кликабельная подпись.
    const dateBtn = uiButton({
      label: formatRecordPeriod(fromInstant, toInstant, useTime),
      role: 'ghost',
      size: 's',
      class: 'chrono-date-value',
      title: 'Дата записи',
      onClick: () => void openPeriodDialog(),
    });
    const refreshDateLabel = (): void => {
      dateBtn.textContent = formatRecordPeriod(fromInstant, toInstant, useTime);
    };

    /** Открыть диалог «Дата/период» (период и время разрешены). */
    async function openPeriodDialog(): Promise<void> {
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
      await saveDates();
    }

    // --- Заголовок: в просмотре — текст, в правке — поле ввода ----------------
    const titleView = el('span', 'chrono-title-view');
    const titleBox = div('chrono-title');
    const titleInput = fieldInput({ extraClass: 'chrono-meta-input' });
    titleInput.type = 'text';
    titleInput.maxLength = 200;
    titleInput.placeholder = 'Заголовок';
    let releaseTitleKeys: (() => void) | null = null;

    /** Надпись заголовка в просмотре; пустая — «Пустая запись». */
    const titleLabel = (): string =>
      recordDisplayTitle(
        titleValue === '' ? null : titleValue,
        bodyDraft,
        EDITOR_RECORD_TITLE_MAX,
      ) || t('diary.emptyTitle');

    /** Показать заголовок в просмотре (текст) и снять контекст клавиатуры. */
    function showTitleView(): void {
      releaseTitleKeys?.();
      releaseTitleKeys = null;
      titleView.textContent = titleLabel();
      titleBox.replaceChildren(titleView);
    }

    /** Показать заголовок полем ввода; клавиши — через диспетчер контекстов. */
    function showTitleEdit(focus: boolean): void {
      titleInput.value = titleValue;
      titleBox.replaceChildren(titleInput);
      if (releaseTitleKeys === null) {
        const contextId = `chrono-title-edit-${(chronoTitleEditSeq += 1)}`;
        defineKeyContext({
          id: contextId,
          bindings: [
            ...modifierChordVariants('Enter').map((chord) => ({
              command: 'chronoTitle.enter',
              chord,
              run: (event: KeyboardEvent) =>
                event.key === 'Enter' ? onTitleEnter(event) : false,
            })),
            {
              command: 'chronoTitle.cancel',
              chord: 'Escape',
              run: (event) => (event.key === 'Escape' ? (cancelEdit(), true) : false),
            },
          ],
        });
        releaseTitleKeys = pushKeyContext(contextId);
      }
      if (focus) {
        titleInput.focus();
        titleInput.select();
      }
    }
    // Двойной клик по заголовку-тексту входит в единую правку.
    titleView.addEventListener('dblclick', () => enterBodyEdit('title'));

    /** Живое значение заголовка: в правке — поле, иначе сохранённое. */
    const currentTitle = (): string =>
      titleBox.contains(titleInput) ? titleInput.value : titleValue;

    const ensureWidget = (): HTMLElement => {
      if (widget !== null) return widget;
      widget = createMarkdownField({
        md: bodyDraft,
        html: existing.body_html,
        // Каретка/выделение при входе в правку — в месте клика в просмотре
        // (требование bac754e4, задача 189da39e).
        sourceMapView: true,
        // Группа единой правки — весь редактор записи: переход фокуса
        // заголовок↔тело и клик по шапке правку не закрывают.
        editGroup: () => bottom,
        // Заголовок пишется тем же PATCH: коммит уходит и без правки тела.
        saveUnchanged: true,
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
        onInput: (md) => {
          bodyDraft = md;
        },
        onSave: (md) => saveBoth(md),
        onEditChange: (isEdit) => {
          editing = isEdit;
          shell.setMode(isEdit ? 'edit' : 'view');
          // Единая правка: вход в тело открывает и заголовок (без кражи фокуса).
          if (isEdit) showTitleEdit(false);
          else showTitleView();
        },
      });
      shell.setField(widget);
      return widget;
    };

    /** ЕДИНАЯ запись обоих полей одним PATCH (требование 26f0aa52). */
    const saveBoth = async (md: string): Promise<string> => {
      const nextTitle = currentTitle().trim();
      const fresh = await etn.comments.get(networkId, commentId);
      const updated = await etn.comments.update(
        networkId,
        commentId,
        {
          title: nextTitle === '' ? null : nextTitle,
          body_md: md,
          valid_from: fromInstant,
          valid_to: toInstant,
          use_time: useTime,
        },
        fresh.version,
      );
      titleValue = updated.title ?? '';
      bodyDraft = updated.body_md;
      if (titleBox.contains(titleInput)) showTitleEdit(false);
      invalidateQueries(queryKeys.indicators(ctx.ownerId));
      await reload();
      return updated.body_html;
    };

    /** Запись дат диалога (правку текстовых полей не закрывает). */
    const saveDates = async (): Promise<void> => {
      try {
        const fresh = await etn.comments.get(networkId, commentId);
        await etn.comments.update(
          networkId,
          commentId,
          { valid_from: fromInstant, valid_to: toInstant, use_time: useTime },
          fresh.version,
        );
        invalidateQueries(queryKeys.indicators(ctx.ownerId));
        await reload();
      } catch (err) {
        notice(`Не удалось сохранить: ${errText(err)}`, 'error');
      }
    };

    /** Откат ОБОИХ полей к сохранённым значениям (Esc / «Отменить»). */
    function cancelEdit(): void {
      if (widget !== null) cancelMarkdownFieldEdit(widget);
      if (titleBox.contains(titleInput)) showTitleView();
      editing = false;
    }

    /** Enter в заголовке: Ctrl/Cmd — запись обоих, иначе — фокус в тело (0). */
    function onTitleEnter(event: KeyboardEvent): boolean {
      const w = ensureWidget();
      if (event.ctrlKey || event.metaKey) commitMarkdownField(w);
      else focusMarkdownFieldStart(w);
      return true;
    }

    /** Войти в единую правку с фокусом в заголовке или теле. */
    const enterBodyEdit = (focus: 'title' | 'body'): void => {
      const w = ensureWidget();
      if (editing) {
        if (focus === 'title') showTitleEdit(true);
        else focusMarkdownFieldStart(w);
        return;
      }
      editMarkdownField(w);
      if (focus === 'title') showTitleEdit(true);
    };

    // Шапка записи — одна строка: период (клик — диалог) и заголовок во всю
    // оставшуюся ширину. Удаление — в контекстном меню строки таблицы.
    const metaRow = div('chrono-meta-row');
    metaRow.append(dateBtn, titleBox);

    // Оболочка комментария: панель действий — шапка записи, тело — встроенное
    // поле markdown, режим зеркалится в `data-mode` (задача 9cb87c42).
    const shell = commentShell({ variant: 'fill', tools: [metaRow] });

    shell.setState({ kind: 'ready' });
    bottom.replaceChildren(shell.root);
    showTitleView();
    activeRowId = commentId;
    activeOpen = () => enterBodyEdit('body');
    if (startEdit) enterBodyEdit('title');
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
      invalidateQueries(queryKeys.indicators(ctx.ownerId));
      if (selectedId === comment.id) showEmptyEditor();
      await reload();
    } catch (err) {
      notice(`Не удалось удалить: ${errText(err)}`, 'error');
    }
  }

  return root;
}

/**
 * Title for the «Заголовок» cell: `title`, else the derived title from the body
 * (first non-empty line with leading markdown markers stripped and HTML entities
 * decoded), truncated to {@link EDITOR_RECORD_TITLE_MAX}. Parsing is shared with
 * the diary feed (`lib/record-title.ts`, задача 8e4a965f): no cross-screen
 * dependency `editor/` ← `screens/`, no second implementation.
 */
function recordTitle(comment: Comment): string {
  return recordDisplayTitle(comment.title, comment.body_md, EDITOR_RECORD_TITLE_MAX);
}

/** Author name for the «Редактор» cell (falls back to the raw id in brackets). */
function userLabel(userId: string | null): string {
  if (userId === null || userId === '') return '';
  return resolveUser(userId) ?? `(${userId})`;
}
