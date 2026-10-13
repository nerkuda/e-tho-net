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
 * токены `$thought.*` и токены свойств цепочки типов — источник подсказок редактора
 * (`extraSuggest`); своей токен-кнопочной секции больше нет.
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
  type EffectiveTypeProperty,
  type NetworkProperty,
  type ThoughtType,
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
import { type SuggestEntry, type SuggestSource } from '../../lib/suggest-dropdown.js';
import { store } from '../../state.js';

import {
  buildTokensForField,
  buildViewAst,
  buildViewAstDefinition,
  filterTokenOptions,
  hasAnyCriteria,
  parseViewDefinition,
  type ChainProperties,
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
  const { networkId, thoughtTypeId, typeName } = opts;
  // 1. Resolve the type chain (own + ancestors). The context-token source needs
  //    every property available on this type so users can pin a condition value
  //    to, say, `$thought.[версия]`.
  const chain = await loadTypeChain(networkId, thoughtTypeId);
  const chainProps = await loadTypeChainProperties(networkId, chain);
  // Property registry (registry-level metadata, e.g. name and multiple flag for
  // each property). Обратные стороны свойств-связей добавляют сами модули
  // редактора (дерево/сортировка) — реестр передаётся как есть.
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
  const title = isEdit ? 'Изменить отбор' : 'Создать отбор';
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
    // Контекстные операнды первыми строками списка «Что» (прежний порядок
    // секций старого диалога: слова, родители, типы).
    contextual: ['keywords', 'parents', 'type', 'link_type'],
  };
  /** Записи диагностики ядра (отказ сохранения сервером) — показываются
   *  деревом и футером наравне с проверками конструктора. */
  let serverIssues: readonly FilterIssue[] = [];
  let editorRef: FilterEditorHandle | null = null;
  const editor = buildFilterEditor({
    profile: 'thoughts',
    networkId,
    data,
    getState: () => state,
    touch: () => editorRef?.refresh(),
    extraSuggest: [contextTokenSource(chainProps)],
    title: `Показать «${typeName}» по условиям:`,
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
  /** Снимок определения на момент открытия — база «грязной» проверки
   *  (требование b58f6aad). Снимок — тем же конвертером, поэтому нетронутая
   *  форма не считается изменённой. */
  const criteriaBase = buildViewAst(state);

  body.append(descField, defaultField, editor.root);

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
      field: () => (editor.root.querySelector('.ff-name__input') as HTMLElement | null) ?? body,
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
// Type chain + effective properties
// ---------------------------------------------------------------------------

/** Walks the type chain from a type up to the root, inclusive. */
async function loadTypeChain(networkId: string, typeId: string): Promise<ThoughtType[]> {
  // Prefer the store's catalogue (kept in sync by realtime-ui); fall back to
  // a single fetch when the type is not in the catalogue.
  let catalogue = store.state.thoughtTypes.slice();
  if (catalogue.length === 0) {
    try {
      catalogue = await etn.types.listThoughtTypes(networkId);
    } catch {
      catalogue = [];
    }
  }
  const byId = new Map<string, ThoughtType>();
  for (const t of catalogue) byId.set(t.id, t);

  const chain: ThoughtType[] = [];
  let current: string | null = typeId;
  const guard = new Set<string>();
  while (current !== null && !guard.has(current)) {
    guard.add(current);
    const type = byId.get(current);
    if (type === undefined) break;
    chain.push(type);
    current = type.parent_id;
  }
  return chain;
}

/** Loads the effective properties for each level of the chain. */
async function loadTypeChainProperties(
  networkId: string,
  chain: ThoughtType[],
): Promise<ChainProperties[]> {
  const out: ChainProperties[] = [];
  for (const type of chain) {
    let props: EffectiveTypeProperty[] = [];
    try {
      props = await etn.types.listTypeProperties(networkId, 'thought_type', type.id);
    } catch {
      props = [];
    }
    out.push({ type, props });
  }
  return out;
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

// ---------------------------------------------------------------------------
// Контекстные токены (задача cfbe8c74). Формат хранимых значений — как у единого
// редактора: `$token` для токена, литерал для значения. Прежний набор
// «токен-кнопок» старого диалога заменён общим списком значений контекста:
// глобальные токены (`$today`/`$now`/`$user`), поля мысли (`$thought.*`) и
// токены свойств цепочки типов (`$thought.[<ключ>]`) — источник подсказок
// редактора (`extraSuggest`), без собственных секций и кнопок.
// ---------------------------------------------------------------------------

/** Источник подсказок «токены контекста» — параметр общего редактора. */
function contextTokenSource(chainProps: readonly ChainProperties[]): SuggestSource {
  return {
    when: 'always',
    header: 'Токены контекста',
    load: (query: string): SuggestEntry[] => {
      const tokens = buildTokensForField([...chainProps], null, null);
      return filterTokenOptions(tokens, query).map((token) => ({
        value: token.text,
        label: token.label,
        ...(token.section !== undefined ? { section: token.section } : {}),
      }));
    },
  };
}
