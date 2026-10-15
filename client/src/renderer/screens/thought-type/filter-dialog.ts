/**
 * Диалог создания и правки отбора типа мысли (задача e37f3f04, спека e0257ca5
 * «Диалог отбора типа мысли», версия 0.7.3; пересобран на ЕДИНЫЙ редактор отбора
 * — задача cfbe8c74, требование a049bb40 «Диалог отбора типа мысли пересобран на
 * дерево (эталон)», ADR fc23f9c1 «судьба спец-секций старых панелей», ADR
 * a9336708 «очерёдность пересборки пяти мест»).
 *
 * Условия собирает ОБЩИЙ редактор (`lib/filter-editor.ts`) с профилем контекста
 * «мысли»: дерево групп И/ИЛИ/НЕ со строками `[Что][Оператор][Значение]`,
 * секция сортировки, футер с фразой-превью и общей диагностикой строк. Собственных
 * секций и парсеров у диалога больше нет — прежние «ключевые слова»,
 * «родительские мысли», «типы мыслей/связей», автор/редактор, даты, свойства и
 * «Дополнительно» стали обычными строками дерева (ADR fc23f9c1). Контекстные
 * токены `$thought.*` и `$thought.[Свойство]` — подсказки ячейки значения
 * (единый каталог `lib/filter-tokens.ts`): набор выводится по природе операнда,
 * а свойства берутся из ВСЕГО реестра сети (ошибка 50d9bf4e, пункты A3–A6);
 * своей токен-кнопочной секции у диалога нет.
 *
 * Сохранение — AST-определение (`{version, filter, sort?}`, форма 0.13.1) через
 * `etn.thoughtTypeViews.create`/`.update` по IPC. Старую плоскую `definition v1`
 * единый конструктор компилирует в дерево НА ВХОДЕ (`parseViewDefinition` →
 * `compileFlatCriteriaToAst`), поэтому сохранённый ранее отбор открывается
 * деревом с тем же результатом. Пустой отбор сохранить нельзя.
 *
 * Кнопки — модального диалога: в футере редактора стандартный набор погашен
 * (`buttons: {standard:false}`), «Отмена»/«Применить» живут в панели диалога.
 * Имя отбора — общее поле футера (элемент ca905fbc), описание и «Открывать по
 * умолчанию» — собственные поля диалога.
 */

import {
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
  type NetworkProperty,
  type ThoughtTypeView,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';
import { t } from '../../lib/i18n.js';

import { div, errText } from '../../lib/dom.js';
import { showDialog } from '../../lib/dialog.js';
import { footerErrorLine, type ErrorAddress, type FooterErrorLine } from '../../lib/ui/messages.js';
import { etn } from '../../lib/etn.js';
import { buildFilterEditor, type FilterEditorHandle } from '../../lib/filter-editor.js';
import {
  constructorFilterIssues,
  filterIssuesFromError,
  hasBlockingIssues,
  mergeFilterIssues,
  type FilterIssue,
} from '../../lib/filter-diagnostics.js';
import { type FilterCriteriaState } from '../../lib/filter-builder.js';
import type { FilterTreeData } from '../../lib/filter-tree.js';
import { notice } from '../../lib/notice.js';
import { formDirty } from '../../lib/pure.js';
import { fieldRow, fieldTextarea } from '../../lib/ui/field.js';
import { checkboxRow } from '../../lib/ui/choice-row.js';
import { store } from '../../state.js';

import {
  buildViewAst,
  buildViewAstDefinition,
  hasAnyCriteria,
  parseViewDefinition,
} from './filter-dialog-pure.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** What the dialog was opened for: a new view or an existing one. */
export interface OpenViewEditorOptions {
  networkId: string;
  /** Type the new view belongs to. */
  thoughtTypeId: string;
  /** Type display name (used in the dialog title). */
  typeName: string;
  /** `null` — create; otherwise the existing view to edit. */
  view: ThoughtTypeView | null;
  /**
   * Called after a successful save. Receives the saved view (newly created or
   * freshly updated). Errors are surfaced in-place; no callback on cancel.
   */
  onSaved?: (view: ThoughtTypeView) => void;
}

/**
 * Opens the «Создать отбор» / «Изменить отбор» dialog.
 *
 * The dialog is modal and self-contained — closing it requires no further
 * plumbing from the caller. The host should react to `onSaved` to refresh
 * its strip / list (the IPC event `thought-type-view.{created,updated}`
 * already drives the realtime repaint).
 */
export function openViewEditorDialog(opts: OpenViewEditorOptions): void {
  // The body is built lazily after the type chain is loaded (we need the
  // ancestor types' effective properties to feed the context-token source).
  void buildAndShow(opts).catch((err: unknown) => {
    notice(`Не удалось открыть диалог отбора: ${errText(err)}`, 'error');
  });
}

/** Module-scoped chain of properties is NOT kept: the context-token source is
 *  built with the loaded chain closure at dialog build time, so there is no
 *  shared mutable state to clear on close. */

function buildAndShow(opts: OpenViewEditorOptions): Promise<void> {
  return buildAndShowImpl(opts);
}

async function buildAndShowImpl(opts: OpenViewEditorOptions): Promise<void> {
  const { networkId, typeName } = opts;
  // Property registry (registry-level metadata, e.g. name and multiple flag for
  // each property). Обратные стороны свойств-связей добавляют сами модули
  // редактора (дерево/сортировка) — реестр передаётся как есть. Токены
  // `$thought.[…]` предлагаются по ВСЕМУ реестру сети (ошибка 50d9bf4e п. A6),
  // поэтому цепочка типов для подсказок больше не грузится.
  const registry = new Map<string, NetworkProperty>();
  try {
    const list = await etn.propertyRegistry.list(networkId);
    for (const row of list) registry.set(row.id, row);
  } catch {
    /* empty registry — the operand list just shows characteristics only */
  }

  // 2. Initialise the form state from the existing view (or defaults). Старая
  //    плоская `definition v1` компилируется в дерево здесь же (на входе).
  const isEdit = opts.view !== null;
  // Заголовок диалога (ошибка 23c7d3e9 п. C1): правка существующего отбора —
  // «Отбор для «<тип>»», создание нового — «Создать отбор для «<тип>»».
  const title = isEdit
    ? t('filterEditor.dialogTitleEdit', typeName)
    : t('filterEditor.dialogTitleCreate', typeName);
  const state = parseViewDefinition(opts.view, registry);
  const initialName = opts.view?.name ?? '';
  const initialDescription = opts.view?.description ?? '';
  const initialIsDefault = opts.view?.is_default ?? false;
  const initialVersion = opts.view?.version ?? 0;
  let name = initialName;

  // 3. Build the form DOM.
  const body = div('form-stack view-editor-body');
  // Ошибка отбора живёт в панели кнопок (единственное обязательное место
  // ошибки диалога, требование 397c5a56).
  const errorLine = footerErrorLine();

  // Description — optional, ≤1000.
  const descInput = fieldTextarea() as HTMLTextAreaElement;
  descInput.rows = 3;
  descInput.maxLength = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;
  descInput.value = initialDescription;
  descInput.placeholder = 'Описание (его читают и человек, и агент)';
  const descField = fieldRow({ label: 'Описание', control: descInput });

  // «Open by default» checkbox.
  const defaultRow = checkboxRow({ label: 'Открывать по умолчанию', checked: initialIsDefault });
  const defaultCheckbox = defaultRow.input;
  const defaultField = defaultRow.row;

  // --- Единый редактор условий (профиль «мысли») --------------------------
  const data: FilterTreeData = {
    registry,
    linkTypes: store.state.linkTypes,
    thoughtTypes: store.state.thoughtTypes,
    // Контекстные операнды первыми строками списка «Что» — тем же компонентом
    // списка, что и в остальных местах. «Потомки» стоят ЗДЕСЬ ЖЕ (верхняя
    // безымянная группа), а не в «Характеристиках», как было: группировка
    // списка операндов обязана совпадать во всех местах (ошибка 50d9bf4e
    // п. A2). Состав сверен со «Структурами», Дневником, картой и рецептом.
    contextual: ['keywords', 'parents', 'children', 'type', 'link_type'],
  };
  /** Записи диагностики ядра (отказ сохранения сервером) — показываются
   *  деревом и футером наравне с проверками конструктора. */
  let serverIssues: readonly FilterIssue[] = [];
  let editorRef: FilterEditorHandle | null = null;
  /**
   * Снимок определения на момент открытия — база «грязной» проверки
   * (требование b58f6aad). Снимок — тем же конвертером, поэтому нетронутая
   * форма не считается изменённой.
   *
   * Объявлен ДО сборки редактора: фабрика синхронно строит футер, его
   * `refresh` читает `host.baseline()` — обратись к `criteriaBase` из стрелки
   * `baseline` ниже по коду, получили бы TDZ-ошибку «Cannot access
   * 'criteriaBase' before initialization» при открытии диалога отбора
   * (ошибка 609deba0 п. C1).
   */
  const criteriaBase = buildViewAst(state);
  const editor = buildFilterEditor({
    profile: 'thoughts',
    networkId,
    data,
    getState: () => state,
    touch: () => editorRef?.refresh(),
    // Заголовок секции условий (ошибка 23c7d3e9 п. C2): имя типа уже несёт
    // заголовок диалога, повторять его в секции не нужно.
    title: t('filterEditor.conditionsTitle'),
    // Модальное место: кнопки — в панели диалога, стандартный набор погашен.
    buttons: { standard: false },
    host: {
      // Стандартная «Применить» погашена; кнопка живёт в панели диалога.
      apply: () => {
        if (closeDialog !== null) void onSave(saveCtx(closeDialog));
      },
      getName: () => name,
      setName: (value: string) => {
        name = value;
      },
      savedName: () => (isEdit ? initialName : null),
      baseline: () => criteriaBase,
      current: () => buildViewAst(state),
      issues: () => serverIssues,
    },
  });
  editorRef = editor;

  body.append(descField, defaultField, editor.root);
  // Имя отбора — ПЕРВЫМ полем диалога (ошибка 50d9bf4e п. A1). Строку имени
  // строит футер редактора (одна реализация), но здесь она переносится в начало
  // разметки диалога: у модального места имя — главный идентификатор отбора, и
  // оно не должно прятаться под деревом условий.
  if (editor.nameRow !== null) body.prepend(editor.nameRow);

  // 4. Show the dialog. The Save button keeps itself open on validation
  //    failure; we close only when the IPC call resolves.
  let saveBtn: HTMLButtonElement | null = null;
  let closeDialog: (() => void) | null = null;
  /** Контекст сохранения — общий для кнопки «Применить» и подтверждения
   *  «Сохранить» при закрытии «грязного» редактора (требование b58f6aad). */
  const saveCtx = (close: () => void): SaveCtx => ({
    close,
    saveBtn,
    opts,
    state,
    getName: () => name,
    getDescription: () => descInput.value,
    getIsDefault: () => defaultCheckbox.checked,
    version: initialVersion,
    errorLine,
    nameAddress: {
      // Имя отбора перенесено в начало разметки диалога (п. A1), поэтому поле
      // ищем по телу, а не по корню редактора.
      field: () => (body.querySelector('.ff-name__input') as HTMLElement | null) ?? body,
    },
    setServerIssues: (issues) => {
      serverIssues = issues;
      editor.refresh();
    },
    refreshEditor: () => editor.refresh(),
  });
  showDialog({
    title,
    body,
    size: 'l',
    // Высота диалога вдвое больше роли `l`, тело — flex-колонка: прокручивается
    // ТОЛЬКО дерево условий, а имя, описание, секция сортировки и строка полного
    // представления (футер) остаются постоянно видимыми (ошибка 50d9bf4e
    // п. A8). Модификатор на боксе задаёт высоту (CSS `view-editor-dialog`).
    fixedHeight: true,
    onMount: (_close, box) => box.classList.add('view-editor-dialog'),
    // Ошибка сохранения — строкой в панели кнопок (требование 397c5a56):
    // ошибки полей видны только на своей вкладке/месте, футер — всегда.
    footerError: errorLine,
    // Грязная форма (требование b58f6aad): Esc/крестик при изменениях имени,
    // описания, «по умолчанию» или условий отбора требуют подтверждения;
    // «Сохранить» идёт тем же путём, что «Применить».
    dirty: {
      isDirty: () =>
        name !== initialName ||
        descInput.value !== initialDescription ||
        defaultCheckbox.checked !== initialIsDefault ||
        formDirty(criteriaBase, buildViewAst(state)),
      save: (close) => void onSave(saveCtx(close)),
    },
    buttons: [
      { label: t('actions.cancel') },
      {
        label: t('actions.apply'),
        primary: true,
        keepOpen: true,
        ref: (b) => {
          saveBtn = b;
        },
        onClick: (close) => {
          closeDialog = close;
          void onSave(saveCtx(close));
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------

interface SaveCtx {
  close: () => void;
  saveBtn: HTMLButtonElement | null;
  opts: OpenViewEditorOptions;
  /** Единая модель отбора (дерево условий + сортировка). */
  state: FilterCriteriaState;
  getName: () => string;
  getDescription: () => string;
  getIsDefault: () => boolean;
  version: number;
  /** Строка ошибки в панели кнопок диалога. */
  errorLine: FooterErrorLine;
  /** Адрес ошибок имени — поле имени футера для перехода по клику на строку. */
  nameAddress: ErrorAddress;
  /** Показать записи диагностики ядра (отказ сохранения сервером). */
  setServerIssues: (issues: readonly FilterIssue[]) => void;
  /** Перерисовать редактор из модели (подсветка строк, футер). */
  refreshEditor: () => void;
}

async function onSave(ctx: SaveCtx): Promise<void> {
  const trimmedName = ctx.getName().trim();
  if (trimmedName === '') {
    showNameError(ctx, 'Укажите имя отбора.');
    return;
  }
  if (trimmedName.length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    showNameError(
      ctx,
      `Имя не должно превышать ${THOUGHT_TYPE_VIEW_NAME_MAX} символов (сейчас ${trimmedName.length}).`,
    );
    return;
  }
  const trimmedDesc = ctx.getDescription().trim();
  if (trimmedDesc.length > THOUGHT_TYPE_VIEW_DESCRIPTION_MAX) {
    showFieldError(
      ctx,
      `Описание не должно превышать ${THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов (сейчас ${trimmedDesc.length}).`,
    );
    return;
  }
  // Запрет пустого отбора (ошибка e8365d29): без условий отбор бессмыслен.
  if (!hasAnyCriteria(ctx.state)) {
    showFieldError(ctx, 'Укажите хотя бы одно условие отбора.');
    return;
  }
  // Красная диагностика (конструктор + записи ядра) запрещает сохранение
  // (требование 44d61c8a): отбор с ошибкой на хранение не пишется.
  const issues = mergeFilterIssues(constructorFilterIssues(ctx.state.tree ?? null));
  if (hasBlockingIssues(issues)) {
    showFieldError(ctx, 'В отборе есть ошибки — исправьте их перед сохранением.');
    ctx.refreshEditor();
    return;
  }

  let definitionJson: string;
  try {
    definitionJson = JSON.stringify(buildViewAstDefinition(ctx.state));
  } catch (err) {
    showFieldError(ctx, errText(err));
    return;
  }

  if (ctx.saveBtn !== null) ctx.saveBtn.disabled = true;
  ctx.errorLine.clear();

  const { networkId, thoughtTypeId, view } = ctx.opts;
  try {
    let saved: ThoughtTypeView;
    if (view === null) {
      const input: ThoughtTypeViewInput = {
        name: trimmedName,
        description: trimmedDesc === '' ? null : trimmedDesc,
        definition: definitionJson,
        is_default: ctx.getIsDefault(),
      };
      saved = await etn.thoughtTypeViews.create(networkId, thoughtTypeId, input);
    } else {
      const patch: ThoughtTypeViewUpdateInput = {
        name: trimmedName,
        description: trimmedDesc === '' ? null : trimmedDesc,
        definition: definitionJson,
        is_default: ctx.getIsDefault(),
      };
      saved = await etn.thoughtTypeViews.update(
        networkId,
        view.thought_type_id,
        view.id,
        patch,
        ctx.version,
      );
    }
    ctx.opts.onSaved?.(saved);
    ctx.close();
  } catch (err) {
    // Отказ сохранения мог прийти со структурированной диагностикой ядра
    // (красная строка удалённой сущности) — показываем её строками редактора.
    ctx.setServerIssues(filterIssuesFromError(err));
    showFieldError(ctx, errText(err));
    if (ctx.saveBtn !== null) ctx.saveBtn.disabled = false;
  }
}

function showFieldError(ctx: SaveCtx, message: string): void {
  ctx.errorLine.show(message);
}

/**
 * Ошибка поля имени: строка в панели кнопок (обязательное место) + переход к
 * полю имени футера по клику (требование 397c5a56).
 */
function showNameError(ctx: SaveCtx, message: string): void {
  ctx.errorLine.show(message, ctx.nameAddress);
}

// ---------------------------------------------------------------------------
// Re-exports from the pure helper module (so existing callers and tests
// can keep importing from `filter-dialog.js`).
// ---------------------------------------------------------------------------

export type { ChainProperties, DialogCriteriaState, DialogPropertyCondition, ViewToken } from './filter-dialog-pure.js';
export {
  buildTokensForField,
  buildViewAst,
  buildViewAstDefinition,
  defaultDialogCriteriaState,
  hasAnyCriteria,
  parseViewDefinition,
} from './filter-dialog-pure.js';

/** Length constants re-exported for tests. */
export const VIEW_NAME_MAX = THOUGHT_TYPE_VIEW_NAME_MAX;
export const VIEW_DESCRIPTION_MAX = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;

