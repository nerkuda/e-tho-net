/**
 * A reusable markdown view/edit field (08-ui-spec.md §6.4, §6.6).
 *
 * Shows server-rendered HTML by default; a double-click switches to a
 * CodeMirror 6 markdown editor (task M2). Leaving the field (blur) commits the
 * change through `onSave` (which returns the freshly rendered HTML) and
 * returns to the view; `Esc` cancels, restoring the previous text.
 *
 * With `sourceMapView` the view is rendered by the single `@etn/markdown`
 * renderer with source-position annotations, so a double-click enters editing
 * with the caret (and the double-clicked word's selection) at the click place
 * (task 189da39e, ADR ee4e721b).
 *
 * `onSave` may be omitted (e.g. a "new" form whose text is committed together
 * with the rest of the dialog): blur then just switches back to the view.
 */

import type { MentionsScanThought } from '@etn/shared';
import {
  parseTransclusions,
  renderMarkdown,
  sourceOffsetFromCaret,
  type SourceMapNode,
} from '@etn/markdown';

import { requireNetworkId } from '../app.js';
import { invalidateQueries, queryKeys } from '../lib/live/index.js';
import { div, el, errText, renderHtml } from '../lib/dom.js';
import { pickEntitiesModal } from '../lib/entity-picker.js';
import { t } from '../lib/i18n.js';
import { etn } from '../lib/etn.js';
import { wireCommentLinksInDom } from '../lib/hover-preview.js';
import { showMenuAt, menuAction, MENU_SEPARATOR, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { bindWikiCreateContext } from '../lib/wiki-create-context.js';
import {
  buildCommentMenuItems,
  buildCommentToolbar,
  createCommentModeActions,
  enterCommentEdit,
  guardCommentMenuFocus,
  type CommentCommandHost,
} from './comment-commands.js';
import { commentFieldKeymapExtension } from './comment-format.js';
import {
  commentCollapseExtension,
  createCommentCollapseState,
  decorateCommentView,
} from './comment-collapse.js';
import { createCommentSearch } from './comment-search.js';
import { createMdEditor, type MdEditor } from './md-editor.js';
import { annotateMentions } from './mentions-annotate.js';
import { renderMermaidBlocks } from './md-mermaid.js';
import { transclusionEditHostExtension, renderTransclusionView } from './transclusion.js';
import { resolveWikiLinksInDom } from './wiki-link-resolver.js';
import {
  buildCommentPasteLinks,
  getClipboard,
  systemClipboardMatchesText,
} from '../canvas/clipboard.js';
import { store } from '../state.js';
import {
  applyMdZoom,
  currentMdZoom,
  loadMdZoom,
  persistMdZoom,
  zoomByWheel,
} from './md-zoom.js';

/** Owner entity for pasted-image attachments ('thought' | 'link' | 'publication'). */
export interface AttachmentsOwner {
  ownerType: 'thought' | 'link' | 'publication';
  ownerId: string;
}

/** Internal control surface of a built field (WeakMap keyed by root). */
interface MarkdownFieldHandle {
  showEdit(md?: string): void;
  set(md: string, html: string): void;
  /**
   * Переключает поле в правку и ставит каретку: по вхождению `findText` в
   * исходнике markdown (вхождение выделяется — слово, кликнутое в ленте
   * публикаций, остаётся выделенным), а если его нет — в начало документа.
   * Нужно двойному клику по тексту публикации (задача ea1b5f14, пункт 4;
   * уточнено задачей 189da39e): точный офсет рендер-узла ленты к markdown
   * недостижим — курсор идёт по вхождению кликнутого слова.
   */
  focusAt(findText?: string): void;
}

/**
 * Диапазон исходника markdown, который надо выделить при входе в правку
 * (позиции каретки для CodeMirror 6). `anchor` — начало, `head` — конец.
 */
export interface MdSourceSelection {
  anchor: number;
  head: number;
}

/**
 * Переводит выделение в просмотре (узлы и смещения DOM) в диапазон исходника
 * markdown через разметку позиций единого рендерера `@etn/markdown`
 * (`sourceOffsetFromCaret`, ADR ee4e721b). `null` — узлы вне размеченного
 * рендера (просмотр без `sourceMap`): вызывающий откатывается к прежнему
 * поведению. Экспортируется для юнит-тестов (задача 189da39e).
 */
export function sourceRangeFromSelection(
  anchor: { node: Node | null; offset: number },
  focus: { node: Node | null; offset: number },
): MdSourceSelection | null {
  if (anchor.node === null || focus.node === null) return null;
  const from = sourceOffsetFromCaret(anchor.node as unknown as SourceMapNode, anchor.offset);
  const to = sourceOffsetFromCaret(focus.node as unknown as SourceMapNode, focus.offset);
  if (from === null || to === null) return null;
  return { anchor: from, head: to };
}

const handles = new WeakMap<HTMLElement, MarkdownFieldHandle>();

/**
 * Узел DOM ли `target` (`Window` — нет). Без `instanceof Node`: в тестовом
 * DOM-шиме глобального `Node` нет, а `root.contains` на не-узле бросает
 * `TypeError`.
 */
function isDomNode(target: EventTarget | null): target is Node {
  return target !== null && typeof (target as Node).nodeType === 'number';
}

/**
 * Решает, коммитить ли правку при уходе фокуса из редактора: если фокус ушёл
 * на собственный элемент поля (`root` — панель поиска/замены, тулбар, кнопки
 * режима), правку НЕ коммитим. Иначе открытие панели поиска (`Ctrl+F`/`Ctrl+H`
 * ставит фокус в её поле) выбивало поле из правки: `onBlur` → `commitOrRevert`
 * → `showView`, и поиск начинал идти по тексту просмотра, а замена блокировалась
 * (ошибка 3eb4d1d5). Экспортируется для юнит-тестов (задача 045f98db).
 */
export function editorBlurCommits(root: Node, related: EventTarget | null): boolean {
  return !isDomNode(related) || !root.contains(related);
}

/** Builds a markdown view/edit field. */
export function createMarkdownField(opts: {
  md: string;
  html: string;
  /** Persist the markdown; resolves the updated HTML to display. */
  onSave?: (md: string) => Promise<string>;
  /** Live text changes (e.g. to mirror a draft). */
  onInput?: (md: string) => void;
  /**
   * Fired when Esc cancels a non-empty edit — the caller may drop its draft
   * mirror of the cancelled text.
   */
  onCancel?: () => void;
  /**
   * Fired when the field switches between edit and view modes. The boolean is
   * the NEW mode (`true` = edit, `false` = view). Used by callers that need
   * to gate external content updates (e.g. realtime `comment.*` events must
   * not clobber an in-progress edit; bug 206e33a1).
   */
  onEditChange?: (editing: boolean) => void;
  /**
   * When set, pasting an image from the clipboard saves it as an attachment of
   * this entity and inserts the markdown image reference at the caret.
   */
  attachmentsOwner?: AttachmentsOwner;
  /**
   * Резолвер шаблона комментария типа (08-ui-spec.md §8.1, §6.4). Когда
   * задан, контекстное меню редактора (правый клик) предлагает пункт
   * «Вставить текст шаблона из типа мысли», если колбэк возвращает
   * непустую строку. Клик вставляет её в позицию курсора через
   * `MdEditor.insertAtCaret`.
   */
  onInsertTemplate?: () => string | null;
  /**
   * Thought never offered as an auto-mention match (L24): its own name and
   * synonyms must not be underlined in its own comment text. Evaluated on
   * every view render — the chronicle desktop passes a getter because a
   * record's thought targets can change after the field is built. Falls back
   * to the `attachmentsOwner` thought when omitted.
   */
  getMentionsExcludeThoughtId?: () => string | undefined;
  /**
   * Контекст комментария для флоу «создать отсутствующую мысль по
   * legacy-ссылке» (карточка ETN 34ffbd75): клик по неразолвленной ссылке
   * `[[имя|текст]]` в view-режиме открывает диалог добавления мысли с
   * родителем-владельцем комментария. Передаётся вкладками комментариев
   * (постоянный `comments.ts`, хроно `chrono-tab.ts`); без опции клик по
   * отсутствующей цели остаётся прежним поведением (notice «не найдена»).
   */
  commentContext?: {
    ownerType: 'thought' | 'link';
    ownerId: string;
    commentKind: 'permanent' | 'chronological';
    getCommentId: () => string | null;
    /** Вызывается после успешной замены ссылок (обновить таблицу хроно и т.п.). */
    onLinksReplaced?: () => void;
  };
  /**
   * Плейсхолдер для пустого комментария (задача 8ab775d9). Показывается
   * серым курсивом поверх пустого view-поля; исчезает при первом
   * редактировании или при сохранении непустого значения.
   */
  placeholder?: string;
  /**
   * Просмотр рендерит сам единый рендерер `@etn/markdown` с разметкой позиций
   * (`renderMarkdown(md, { sourceMap: true })`), а не серверный HTML: узлы
   * несут диапазоны исходных смещений, поэтому двойной клик в просмотре
   * входит в правку с кареткой и выделением в месте клика (требование
   * bac754e4, ADR ee4e721b). Включать только для markdown-исходников: для
   * plain-text (просмотр вложений) — оставить выключенным.
   */
  sourceMapView?: boolean;
  minRows?: number;
}): HTMLElement {
  const root = div('md-field');
  const view = div('md-field-view comment-view');
  // Просмотр фокусируем по клику (но не добавляем в порядок табуляции): поле —
  // текущий элемент для сочетаний, поэтому Ctrl+F открывает поиск и в
  // просмотре (элемент b8eabc22, требование d72ea6eb).
  view.tabIndex = -1;
  const area = div('md-field-area');
  area.tabIndex = -1;
  area.setAttribute('aria-label', 'Текст комментария');

  let currentMd = opts.md;
  let currentHtml = opts.html;
  let cancelled = false;
  /** Guards against a focusout fired while the editor is being rebuilt. */
  let mounting = false;
  let editor: MdEditor | null = null;
  /** Поле сейчас в режиме правки (для контекста сочетаний команд). */
  let editing = false;
  /**
   * Коммит правки уже запущен (асинхронный `onSave`): до `showView()` поле
   * формально ещё «в правке», поэтому второй `focusout` (редактор → наружу
   * всплывает до `root`) не должен коммитить повторно — иначе два
   * `comments.update`/`comments.create` (ошибка 3eb4d1d5).
   */
  let commitPending = false;
  /** Счётчик рендеров просмотра — защита от гонок асинхронной развёртки трансклюзий (a2b68d72). */
  let renderSeq = 0;
  /** Снятие контекста сочетаний поля; `null` — контекст не активен. */
  let releaseCommentKeys: (() => void) | null = null;

  /**
   * Состояние свёрнутости разделов комментария (0.12.1, задача 634f1412):
   * локальное на клиенте, ключ «владелец поля + раздел». Владелец — комментарий
   * (постоянный/хроно), когда он известен, иначе сущность-владелец поля; без
   * владельца состояние живёт только в памяти поля.
   */
  const collapseOwnerKey = ((): string | undefined => {
    const cc = opts.commentContext;
    if (cc !== undefined) {
      const commentId = cc.getCommentId();
      return commentId !== null ? `comment:${commentId}` : `${cc.ownerType}:${cc.ownerId}`;
    }
    const owner = opts.attachmentsOwner;
    return owner !== undefined ? `${owner.ownerType}:${owner.ownerId}` : undefined;
  })();
  const collapseState = createCommentCollapseState(requireNetworkId(), collapseOwnerKey);

  /**
   * Панель поиска и замены поля (0.12.1, задача 045f98db): открывается по
   * Ctrl+F и в просмотре, и в правке, замена — только в правке.
   */
  const search = createCommentSearch({
    root,
    view,
    getEditor: () => (editing ? editor : null),
    isEditing: () => editing,
    restoreFocus: () => {
      if (editing) editor?.focus();
      else view.focus();
    },
  });

  /**
   * Хост команд поля (ТП1 «Команды редактирования комментария», задача
   * 3d6f98cb): тулбар и контекстное меню применяют команды к этому полю, а
   * команды уровня поля (поиск, отмена/сохранение) исполняет сам каркас правки.
   */
  const commandHost: CommentCommandHost = {
    getEditor: () => (editing ? editor : null),
    root,
    runFieldCommand: (command) => {
      // Поиск открывается в обоих режимах; замена — только в правке
      // (элемент b8eabc22, требование d72ea6eb).
      if (command === 'comment.find') {
        search.open('find');
        return true;
      }
      if (command === 'comment.replace') {
        if (!editing) return false;
        search.open('replace');
        return true;
      }
      if (command === 'comment.findNext') return search.next();
      if (command === 'comment.findPrevious') return search.previous();
      if (command === 'comment.edit') {
        // Вход в правку кнопкой под полем — тот же путь, что и двойной клик
        // (элемент a0e5bc2e). Действует в просмотре; в правке не нужен.
        if (editing) return false;
        showEdit();
        return true;
      }
      if (!editing || editor === null) return false;
      if (command === 'comment.cancel') {
        cancelled = true;
        editor.blur();
        return true;
      }
      if (command === 'comment.save') {
        cancelled = false;
        editor.blur();
        return true;
      }
      // Кнопки «Отменить/Сохранить трансклюзию» под полем (элемент 2b116d37,
      // задача f59d24e1): выход из правки блока; запись в источник — e2c14673.
      if (command === 'transclusion.cancel' || command === 'transclusion.save') {
        editor.exitTransclusionEdit();
        return true;
      }
      return false;
    },
    // Состояние кнопок тулбара обновляется по изменениям выделения/текста.
    subscribe: (listener) => editor?.subscribe(listener) ?? (() => {}),
  };

  /**
   * Кнопки режима под полем (элемент a0e5bc2e, задача 3901f07e): в просмотре —
   * всплывающая «Редактировать», в правке — «Отменить»/«Сохранить». Вид
   * переключает `showView`/`showEdit`, действия идут командой поля (тот же путь,
   * что Esc/Ctrl+Enter).
   */
  const modeActions = createCommentModeActions(commandHost);

  /**
   * Включает контекст сочетаний поля, пока поле — текущий элемент (фокус).
   * Действует и в просмотре: команды без редактора — no-op, но Ctrl+F открывает
   * панель поиска (требование d72ea6eb).
   */
  const activateFieldKeys = (): void => {
    releaseCommentKeys ??= enterCommentEdit(commandHost);
  };
  /** Снимает контекст сочетаний поля. */
  const deactivateFieldKeys = (): void => {
    releaseCommentKeys?.();
    releaseCommentKeys = null;
  };
  root.addEventListener('focusin', (event) => {
    const target = event.target;
    // Фокус в панели поиска — её контекст поверх: команды форматирования из
    // поля поиска срабатывать не должны.
    if (target instanceof Node && search.element.contains(target)) {
      deactivateFieldKeys();
      search.enterKeys();
      return;
    }
    search.leaveKeys();
    activateFieldKeys();
  });
  root.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    deactivateFieldKeys();
    search.leaveKeys();
    // Фокус ушёл из поля целиком. Если правка была открыта и редактор уже не
    // в фокусе (его `focusout` пропущен — фокус держала панель поиска), коммит
    // иначе не случится. Обычный уход из редактора наружу сюда уже приходит с
    // `editing === false` (commitOrRevert отработал в `onBlur` редактора) —
    // повторного коммита нет.
    if (editing) commitOrRevert();
  });

  // Масштаб документа (M9): Ctrl+колесо над полем меняет глобальный
  // `--md-font-size` — действует на все md-поля; значение сохраняется на сеть.
  const networkId = requireNetworkId();
  void loadMdZoom(networkId);
  root.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const next = zoomByWheel(currentMdZoom(), event.deltaY);
    applyMdZoom(next);
    persistMdZoom(networkId, next);
  }, { passive: false });

  const excludeThoughtId = (): string | undefined =>
    opts.getMentionsExcludeThoughtId?.() ??
    (opts.attachmentsOwner?.ownerType === 'thought' ? opts.attachmentsOwner.ownerId : undefined);

  /**
   * «Вставить ссылку» (L24): replaces the first occurrence of the matched
   * plain text in the markdown source with a wiki-link and saves — or, when
   * the field has no `onSave` (e.g. a "new" form), stages the change by
   * switching into edit mode so the caller's own save flow picks it up.
   */
  const insertMentionLink = (thought: MentionsScanThought, matchedText: string): void => {
    const idx = currentMd.indexOf(matchedText);
    if (idx === -1) {
      notice(
        `Не удалось вставить ссылку: текст «${matchedText}» не найден в исходнике (изменён форматированием).`,
        'error',
      );
      return;
    }
    const newMd =
      currentMd.slice(0, idx) + `[[${thought.title}|${matchedText}]]` + currentMd.slice(idx + matchedText.length);
    if (opts.onSave === undefined) {
      showEdit(newMd);
      return;
    }
    void opts
      .onSave(newMd)
      .then((html) => {
        currentMd = newMd;
        currentHtml = html;
        showView();
      })
      .catch((err) => {
        notice(`Не удалось сохранить ссылку: ${errText(err)}`, 'error');
      });
  };

  /**
   * HTML просмотра: с `sourceMapView` — единый рендерер с разметкой позиций
   * (`sourceMap`), чтобы клик в просмотре отображался в смещение исходника;
   * иначе (или при пустом/слишком большом исходнике) — серверный HTML.
   */
  const viewHtml = (): string => {
    if (opts.sourceMapView !== true || currentMd.trim() === '') return currentHtml;
    try {
      return renderMarkdown(currentMd, { sourceMap: true });
    } catch {
      return currentHtml;
    }
  };

  /** Рисует просмотр из готового HTML (общий путь обычного и трансклюзийного рендера). */
  const paintView = (html: string): void => {
    view.replaceChildren();
    if (html.trim() !== '') {
      renderHtml(view, html);
      renderMermaidBlocks(view);
      annotateMentions(view, {
        excludeThoughtId: excludeThoughtId(),
        onInsertLink: insertMentionLink,
      });
      // ID-based wiki-links are emitted as empty <span data-wiki-id> by
      // @etn/markdown; resolve them to titles asynchronously (R7).
      void resolveWikiLinksInDom(view, networkId);
      // Ctrl+hover preview on wiki-links/file-links/URLs inside the comment
      // text (task «Предпросмотр содержимого с зажатым Ctrl», stage 2/3).
      // Marking does not need to wait for the wiki-link resolution above —
      // the wiki resolvers re-check the live DOM (title text, the
      // `wiki-link-deleted` class) lazily at hover time, well after that
      // promise settles.
      wireCommentLinksInDom(view);
      // Сворачивание разделов комментария (0.12.1, задача 634f1412): индикаторы
      // и восстановление свёрнутости в просмотре.
      decorateCommentView(view, collapseState);
    } else if (opts.placeholder !== undefined && opts.placeholder !== '') {
      // Пустой комментарий — показываем плейсхолдер (задача 8ab775d9).
      const ph = el('div', 'md-field-placeholder', opts.placeholder);
      view.append(ph);
    }
  };

  const renderView = (): void => {
    // Развёртка трансклюзий в просмотре (задача a2b68d72): ссылки-трансклюзии
    // разворачиваются общим механизмом `@etn/markdown`, а рендер рисует блоки с
    // фоном по уровням и плашками ошибок источника. Асинхронно (нужны тексты
    // источников) — с защитой от гонок по счётчику и режиму правки.
    if (opts.sourceMapView === true && parseTransclusions(currentMd).length > 0) {
      const seq = ++renderSeq;
      view.replaceChildren();
      void renderTransclusionView(currentMd, networkId)
        .then((html) => {
          if (seq === renderSeq && !editing && html !== null) paintView(html);
        })
        .catch(() => {
          if (seq === renderSeq && !editing) paintView(currentHtml);
        });
      return;
    }
    renderSeq += 1;
    paintView(viewHtml());
  };

  const showView = (): void => {
    const wasEditing = editor !== null && !area.classList.contains('hidden');
    // Выход из правки поля снимает и режим правки блока трансклюзии (её захват
    // источника) — иначе захват висел бы до пересборки редактора (f59d24e1).
    if (wasEditing) editor?.exitTransclusionEdit();
    editing = false;
    deactivateFieldKeys();
    root.classList.remove('md-field--editing');
    modeActions.setEditing(false);
    area.classList.add('hidden');
    view.classList.remove('hidden');
    renderView();
    search.refresh();
    if (wasEditing) opts.onEditChange?.(false);
  };

  const commitOrRevert = (): void => {
    if (mounting || editor === null || commitPending) return;
    const md = editor.getValue();
    if (cancelled) {
      // Esc: the edit is dropped; restore the saved text so the field returns
      // to the view unchanged.
      if (md !== currentMd) opts.onCancel?.();
      editor.setValue(currentMd);
      showView();
      return;
    }
    if (md === currentMd) {
      showView();
      return;
    }
    if (opts.onSave === undefined) {
      // No autosave: without a client renderer we cannot preview unsaved md.
      editor.setValue(currentMd);
      showView();
      return;
    }
    // Флаг ставится СИНХРОННО: пока `onSave` не разрешится, `editing` ещё
    // true, и повторный коммит (см. `commitPending`) надо отсечь.
    commitPending = true;
    void opts
      .onSave(md)
      .then((html) => {
        currentMd = md;
        currentHtml = html;
        showView();
      })
      .catch(() => {
        // Save failed: revert.
        editor?.setValue(currentMd);
        showView();
      })
      .finally(() => {
        commitPending = false;
      });
  };

  /** Mounts a fresh editor for the current markdown. */
  const mountEditor = (locate?: MdSourceSelection): void => {
    mounting = true;
    editor?.destroy();
    cancelled = false;
    editor = createMdEditor(currentMd, {
      onInput: (md) => opts.onInput?.(md),
      onEscape: () => {
        cancelled = true;
        editor?.blur();
      },
      // Ctrl+Enter (M10): обычный коммит через blur-обработчик.
      onCommit: () => {
        cancelled = false;
        editor?.blur();
      },
      onBlur: (event) => {
        // Фокус ушёл на элемент самого поля (панель поиска и т.п.) — правка
        // остаётся открытой; коммит только при уходе фокуса наружу.
        if (editorBlurCommits(root, event.relatedTarget)) commitOrRevert();
      },
      // Точечное Prec.high-перекрытие сочетаний команд, которые иначе
      // «съедает» CM6 (Ctrl+I/U, Ctrl+Shift+K, Tab/Shift+Tab, Alt+↑/↓).
      extraExtensions: [
        commentFieldKeymapExtension(),
        commentCollapseExtension(collapseState),
        // Хост правки блока трансклюзии (задача f59d24e1): пока блок в правке,
        // под полем — кнопки «Отменить/Сохранить трансклюзию».
        transclusionEditHostExtension({
          onBlockEditChange: (editing) => modeActions.setBlockEditing(editing),
        }),
      ],
    });
    // Pasting files (screenshots / copied files) saves them as server-stored
    // attachments of the owner entity and inserts a markdown reference at the
    // caret: images embed as `![alt](etnimg:…)`, other files as a link.
    // Pasting an internal clipboard of thoughts inserts wiki-link references
    // (workplan L26) — checked first so the file path doesn't run.
    //
    // Capture phase: CodeMirror handles `paste` on its contentDOM (a child of
    // `editor.dom`), so a bubble-phase listener here would run *after* CM6
    // had already inserted the system-clipboard text — our preventDefault
    // could no longer undo that and the paste produced "text + wiki-link"
    // (bug 731a9d16). In capture we run first; CM6 skips events that are
    // already defaultPrevented, so exactly one of the two inserts happens.
    editor.dom.addEventListener(
      'paste',
      (event) => {
        if (editor === null) return;
        if (handleClipboardThoughtsPaste(event, editor)) return;
        const owner = opts.attachmentsOwner;
        if (owner === undefined) return;
        const files = event.clipboardData?.files;
        if (files === undefined || files.length === 0) return;
        event.preventDefault();
        void insertClipboardFiles(editor, owner, Array.from(files));
      },
      true,
    );
    // Контекстное меню редактора: команды форматирования поля (ТП1 «Команды
    // редактирования комментария», задача 3d6f98cb) плюс «Вставить текст
    // шаблона из типа мысли» (08-ui-spec.md §6.4) и «Вставить ссылку на
    // публикацию…» (0.11.1, задача 3275fd8d, требование 7f583ef9). Раскладка
    // команд повторяет тулбар; подменю настроек поля в меню нет (элемент
    // 0562e0e3).
    editor.dom.addEventListener('contextmenu', (event) => {
      if (editor === null) return;
      const items: MenuItem[] = buildCommentMenuItems(commandHost);
      const extras: MenuItem[] = [];
      const template = opts.onInsertTemplate?.() ?? null;
      if (template !== null && template.trim() !== '') {
        extras.push(
          menuAction('Вставить текст шаблона из типа мысли', () => {
            if (editor === null) return;
            if (area.classList.contains('hidden')) {
              // Поле в view-режиме: переключаем в edit и подставляем текст.
              showEdit(template);
            } else {
              editor.insertAtCaret(template);
            }
          }),
        );
      }
      extras.push(
        menuAction(t('publications.link.insert'), () => {
          if (editor === null) return;
          void pickEntitiesModal({
            networkId,
            kind: 'publications',
            title: t('publications.field.pickerTitle'),
            single: true,
          }).then((ids) => {
            const id = ids?.[0];
            if (id === undefined || editor === null) return;
            void etn.publications
              .get(networkId, id)
              .then((pub) => {
                if (editor === null) return;
                editor.insertAtCaret(`[[#pub:${pub.id}|${pub.title}]]`);
              })
              .catch(() => undefined);
          });
        }),
      );
      items.push(MENU_SEPARATOR, ...extras);
      event.preventDefault();
      const menuRoot = showMenuAt(event.clientX, event.clientY, items);
      // Клик по пункту меню не должен снимать фокус/выделение редактора —
      // иначе поле выйдет из правки и команда не применится к выделению.
      guardCommentMenuFocus(menuRoot);
    });
    // Тулбар — верхняя панель поля; живёт внутри `area`, поэтому виден только в
    // правке (`area` скрыта в просмотре) — требование 6f8575a5. Собирается
    // после редактора: кнопки сразу отражают состояние текущего выделения.
    area.replaceChildren(buildCommentToolbar(commandHost), editor.dom);
    mounting = false;
    // Вход по клику в просмотре — каретка/выделение в месте клика; программный
    // вход (кнопка, восстановление черновика) — каретка в конец (как раньше).
    if (locate !== undefined) editor.setSelection(locate.anchor, locate.head);
    else editor.focusToEnd();
  };

  const showEdit = (md?: string, locate?: MdSourceSelection): void => {
    if (md !== undefined) currentMd = md;
    view.classList.add('hidden');
    area.classList.remove('hidden');
    editing = true;
    root.classList.add('md-field--editing');
    modeActions.setEditing(true);
    mountEditor(locate);
    activateFieldKeys();
    search.refresh();
    opts.onEditChange?.(true);
  };

  // Programmatic focus (e.g. the editor rebuild refocus, editor.ts) lands on
  // the wrapper and is delegated to the editor.
  area.addEventListener('focus', () => editor?.focus());
  /**
   * Выделение в просмотре → диапазон исходника (задача 189da39e): двойной
   * клик по слову переводит выделение браузера в позиции markdown через
   * разметку позиций рендерера. `undefined` — разметки нет (просмотр без
   * `sourceMapView`) или выделение вне поля — тогда вход в правку без офсета.
   */
  const selectionInView = (): MdSourceSelection | undefined => {
    const selection = view.ownerDocument.getSelection?.() ?? null;
    if (selection === null || selection.rangeCount === 0) return undefined;
    if (
      selection.anchorNode === null ||
      selection.focusNode === null ||
      !view.contains(selection.anchorNode) ||
      !view.contains(selection.focusNode)
    ) {
      return undefined;
    }
    return (
      sourceRangeFromSelection(
        { node: selection.anchorNode, offset: selection.anchorOffset },
        { node: selection.focusNode, offset: selection.focusOffset },
      ) ?? undefined
    );
  };
  view.addEventListener('dblclick', () => showEdit(undefined, selectionInView()));

  handles.set(root, {
    showEdit,
    set: (md, html) => {
      currentMd = md;
      currentHtml = html;
      renderView();
      if (editor !== null && !area.classList.contains('hidden')) {
        editor.setValue(md);
      }
      search.refresh();
    },
    focusAt: (findText) => {
      showEdit();
      if (editor === null) return;
      const needle = findText ?? '';
      const position = needle !== '' ? editor.getValue().indexOf(needle) : -1;
      // Найдено — выделяем вхождение: слово, по которому кликнули в ленте
      // публикаций, остаётся выделенным (задача 189da39e); иначе — каретка в
      // начало (вхождения нет: текст изменён форматированием).
      if (position >= 0) editor.setSelection(position, position + needle.length);
      else editor.setCaret(0);
    },
  });

  // Комментарийный контекст (карточка ETN 34ffbd75): после замены legacy-ссылок
  // на [[#<id>]] поле перерисовывается через тот же handle, что и внешние
  // обновления (setMarkdownField).
  if (opts.commentContext !== undefined) {
    const cc = opts.commentContext;
    bindWikiCreateContext(root, {
      ownerType: cc.ownerType,
      ownerId: cc.ownerId,
      commentKind: cc.commentKind,
      getCommentId: cc.getCommentId,
      refresh: (md, html) => setMarkdownField(root, md, html),
      afterLinksReplaced: cc.onLinksReplaced,
    });
  }

  root.append(search.element, view, area, modeActions.root);
  showView();
  return root;
}

/** Switches an already-built field into edit mode (e.g. to restore a draft). */
export function editMarkdownField(root: HTMLElement, md?: string): void {
  handles.get(root)?.showEdit(md);
}

/**
 * Переключает поле в правку и ставит каретку по вхождению `findText` в
 * исходнике markdown (вхождение выделяется; нет вхождения — начало
 * документа). Точка входа двойного клика по тексту публикации
 * (задача ea1b5f14, пункт 4; уточнено задачей 189da39e).
 */
export function focusMarkdownFieldAt(root: HTMLElement, findText?: string): void {
  handles.get(root)?.focusAt(findText);
}

/** Updates an already-built field's content (e.g. after an external change). */
export function setMarkdownField(root: HTMLElement, md: string, html: string): void {
  handles.get(root)?.set(md, html);
}

/**
 * Uploads pasted files to the server (which stores them under the network's
 * `attachments/` directory next to `data.db`) and inserts markdown references
 * at the caret: `![alt](…)` for images, `[name](…)` links for other files.
 */
async function insertClipboardFiles(
  editor: MdEditor,
  owner: AttachmentsOwner,
  files: File[],
): Promise<void> {
  const networkId = requireNetworkId();
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    const comma = dataUrl.indexOf(',');
    const dataBase64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
    const title = file.name.trim() !== '' ? file.name.trim() : 'file';
    const mime = file.type || guessMimeFromName(file.name) || 'application/octet-stream';
    let attachment;
    try {
      attachment = await etn.attachments.uploadFile(networkId, owner.ownerType, owner.ownerId, {
        title,
        mime_type: mime,
        data_base64: dataBase64,
      });
    } catch {
      notice('Не удалось добавить вложение.', 'error');
      continue;
    }
    invalidateQueries(queryKeys.indicators(owner.ownerId));
    // Tell the editor chrome the owner's attachment set changed: the
    // «Вложения» tab (if built) reloads its list, the tab badge re-counts —
    // without this a paste from the comment field left a stale empty list
    // until the editor target changed. Кэш-путь слоя (G4): ключ списка вложений
    // владельца гасится, подписчики (вкладка/бейдж) перечитывают список.
    invalidateQueries(queryKeys.attachments(owner.ownerType, owner.ownerId));
    const filePath = attachment.file_path;
    if (filePath === null || filePath === '') continue;
    const url = etnimgUrl(filePath);
    const ref = mime.startsWith('image/')
      ? `![${sanitizeAlt(title)}](${url})`
      : `[${sanitizeAlt(title)}](${url})`;
    editor.insertAtCaret(ref);
  }
}

/** Rough MIME guess for files without a type (by extension). */
export function guessMimeFromName(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
  };
  return map[ext] ?? null;
}

/** Reads a File into a `data:` URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')));
    reader.readAsDataURL(file);
  });
}

/**
 * Absolute server file path → `etnimg://` URL. The `etnimg` scheme is a
 * privileged protocol served by the Electron main process (works both from the
 * dev http origin and from the packaged file:// page, unlike raw file://).
 */
export function etnimgUrl(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const encoded = segments.map((seg, i) => {
    // A Windows drive segment ("C:") becomes the URL host — a bare letter,
    // because ':' would parse as a port separator.
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg[0]!.toLowerCase();
    return encodeURIComponent(seg);
  });
  return `etnimg://${encoded.join('/')}`;
}

/** Markdown image alt text must not contain brackets. */
function sanitizeAlt(text: string): string {
  return text.replace(/[[\]]/g, '').trim() || 'изображение';
}

/**
 * Pasting an internal clipboard of thoughts into a comment inserts a
 * comma-separated list of wiki-link references (workplan L26, task
 * bb8277f6) — the same format the comment editor already accepts.
 *
 * Bug 290a50c0 («Не работает вставка текста, скопированного из другой
 * программы»): the internal snapshot is only valid while the SYSTEM
 * clipboard still carries the wiki-links ETN wrote at copy time. The text
 * of this very paste event is compared against that string — when it
 * differs, the user copied something else later (typically in another
 * program) and the event is left alone so the editor's native paste inserts
 * that text. A file payload (screenshots) outranks the thought links.
 *
 * Returns `true` when the handler consumed the event so the caller can
 * skip the file-handling fallback.
 */
function handleClipboardThoughtsPaste(event: ClipboardEvent, editor: MdEditor): boolean {
  const networkId = store.state.networkId;
  if (networkId === null) return false;
  if (!getClipboard()) return false;
  // Only intercept when the clipboard carries no file payload — the file
  // path has higher priority (screenshots are usually intended as images).
  const files = event.clipboardData?.files;
  if (files !== undefined && files.length > 0) return false;
  // The system clipboard must still hold what our last thought copy wrote;
  // anything else means a later copy superseded the snapshot.
  const systemText = event.clipboardData?.getData('text/plain') ?? '';
  if (!systemClipboardMatchesText(systemText)) return false;
  const links = buildCommentPasteLinks(networkId);
  if (links === '') return false;
  event.preventDefault();
  editor.insertAtCaret(links);
  return true;
}

/** Test seam: the comment-paste decision of bug 290a50c0. */
export const mdFieldInternals = { handleClipboardThoughtsPaste };
