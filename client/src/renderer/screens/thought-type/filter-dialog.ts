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
  type ThoughtCustomView,
  type ThoughtCustomViewInput,
  type ThoughtCustomViewUpdateInput,
  type ThoughtTypeView,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';
import { t } from '../../lib/i18n.js';

import { div, el, errText } from '../../lib/dom.js';
import { showDialog } from '../../lib/dialog.js';
import { footerErrorLine, type ErrorAddress, type FooterErrorLine } from '../../lib/ui/messages.js';
import { etn } from '../../lib/etn.js';
import { buildFilterEditor, type FilterEditorHandle } from '../../lib/filter-editor.js';
import { propertyCatalogueRows, reloadPropertyCatalogue } from '../../lib/property-catalogue.js';
import {
  constructorFilterIssues,
  filterIssuesFromError,
  hasBlockingIssues,
  lostConditionIssues,
  mergeFilterIssues,
  type FilterIssue,
} from '../../lib/filter-diagnostics.js';
import {
  readFilterDefinitionDetailed,
  type FilterCriteriaState,
} from '../../lib/filter-builder.js';
import type { FilterTreeData } from '../../lib/filter-tree.js';
import { isInBaseLayer } from '../../lib/layer-base.js';
import { notice } from '../../lib/notice.js';
import { formDirty } from '../../lib/pure.js';
import { FIELD_HINT_CLASS, fieldRow, fieldTextarea } from '../../lib/ui/field.js';
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
  /** Владелец-тип: отбор типа мысли. Взаимоисключим с `ownerThoughtId`. */
  thoughtTypeId?: string;
  /** Имя типа-владельца (для заголовка и предупреждения). */
  typeName?: string;
  /** Владелец-мысль: внетиповой отбор (0.14.1, спека e0257ca5). */
  ownerThoughtId?: string;
  /** Имя мысли-владельца (для заголовка и предупреждения). */
  thoughtName?: string;
  /** `null` — create; otherwise the existing view to edit. */
  view: ViewEditorView | null;
  /**
   * Called after a successful save. Receives the saved view (newly created or
   * freshly updated). Errors are surfaced in-place; no callback on cancel.
   */
  onSaved?: (view: ThoughtTypeView | ThoughtCustomView) => void;
}

/**
 * Поля существующего отбора, которые нужны диалогу. Общая структурная форма
 * для типового (`ThoughtTypeView`) и внетипового (`ThoughtCustomView`) отбора:
 * владельца задаёт `OpenViewEditorOptions`, а не сама карточка.
 */
export interface ViewEditorView {
  id: string;
  name: string;
  description: string | null;
  definition: string;
  is_default: boolean;
  version: number;
}

/** Владелец отбора, разобранный из опций диалога (ровно один). */
type ViewOwner =
  | { kind: 'type'; typeId: string; typeName: string }
  | { kind: 'thought'; thoughtId: string; thoughtName: string };

/**
 * Причина, по которой запись отбора могла бы молча потерять условия по
 * свойствам (ошибка 071acfc2). Причина обязана называться ПО ФАКТУ: после
 * успешного повтора чтения реестра «реестр не прочитан» — ложь.
 *
 * - `registryPending` — реестр сети ещё не прочитан, определение разобрано без
 *   него, ждём повтор чтения на тике store;
 * - `conditionsLost` — реестр прочитан, но форму правили до него: условия из
 *   сохранённого определения в состоянии отсутствуют, запись потеряет их;
 * - `null` — потерь нет, сохранение разрешено.
 */
type LossRisk = 'registryPending' | 'conditionsLost' | null;

/** Ровно один владелец: тип XOR мысль (спека e0257ca5). */
function resolveOwner(opts: OpenViewEditorOptions): ViewOwner {
  const typed = opts.thoughtTypeId !== undefined;
  const owned = opts.ownerThoughtId !== undefined;
  if (typed === owned) {
    throw new Error('OpenViewEditorOptions: exactly one owner — thoughtTypeId or ownerThoughtId.');
  }
  if (typed) {
    return {
      kind: 'type',
      typeId: opts.thoughtTypeId as string,
      typeName: opts.typeName ?? '',
    };
  }
  return {
    kind: 'thought',
    thoughtId: opts.ownerThoughtId as string,
    thoughtName: opts.thoughtName ?? '',
  };
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
    notice(t('filterEditor.openFailed', errText(err)), 'error');
  });
}

/** Module-scoped chain of properties is NOT kept: the context-token source is
 *  built with the loaded chain closure at dialog build time, so there is no
 *  shared mutable state to clear on close. */

function buildAndShow(opts: OpenViewEditorOptions): Promise<void> {
  return buildAndShowImpl(opts);
}

/** Разобранный объект сохранённого определения (`undefined` — нет/битый JSON). */
function parseSavedDefinition(view: ViewEditorView | null): unknown {
  if (view === null) return undefined;
  try {
    return JSON.parse(view.definition) as unknown;
  } catch {
    return undefined;
  }
}

async function buildAndShowImpl(opts: OpenViewEditorOptions): Promise<void> {
  const { networkId } = opts;
  const owner = resolveOwner(opts);
  // Property registry (registry-level metadata, e.g. name and multiple flag for
  // each property). Обратные стороны свойств-связей добавляют сами модули
  // редактора (дерево/сортировка) — реестр передаётся как есть. Токены
  // `$thought.[…]` предлагаются по ВСЕМУ реестру сети (ошибка 50d9bf4e п. A6),
  // поэтому цепочка типов для подсказок больше не грузится.
  //
  // Отказ чтения реестра — «неотработанный вход» (ошибка db42100b, механика
  // 77f18626): прежняя плоская `definition v1` без реестра теряет условия по
  // свойствам, поэтому отказ отличается от успешного чтения, а диалог
  // повторяет чтение на тике store и переразбирает определение до правки
  // пользователя. Молчаливая перезапись потерянного определения запрещена.
  //
  // Источник реестра — ОБЩИЙ живой справочник свойств (`lib/property-catalogue.ts`,
  // ошибка 6d25c224): карта обновляется на месте, поэтому открытый диалог видит
  // созданное/переименованное/удалённое свойство без перезапуска клиента.
  const registry = propertyCatalogueRows(networkId);
  let registryOk = await reloadPropertyCatalogue(networkId, { fresh: true });
  /** Определение сохранённого отбора (объект JSON) — вход диагностики потерь. */
  const savedDefinition = parseSavedDefinition(opts.view);
  /**
   * Потери, которые даёт разбор С пустым реестром: если реестр не прочитан, это
   * условия по свойствам, которые ещё могут вернуться повтором (не «свойства
   * больше нет в сети» — та формулировка была бы ложной, ошибка 3bf62fd7).
   */
  const lossesWithoutRegistry =
    !registryOk && savedDefinition !== undefined
      ? readFilterDefinitionDetailed(savedDefinition, {
          activeMode: 'view',
          registry: new Map(),
        }).lost
      : [];
  /** Отказ реестра мог стоить условий по свойствам — сохранение блокируется. */
  let lossRiskReason: LossRisk = lossesWithoutRegistry.length > 0 ? 'registryPending' : null;
  /** Жёлтая диагностика отбора: потеря из-за отказа реестра либо настоящая. */
  let lossIssues: readonly FilterIssue[] =
    lossesWithoutRegistry.length > 0
      ? [
          {
            severity: 'warning',
            source: 'constructor',
            code: 'build_warning',
            path: '',
            message: t('filterEditor.registryPending'),
          },
        ]
      : registryOk && savedDefinition !== undefined
        ? lostConditionIssues(
            readFilterDefinitionDetailed(savedDefinition, {
              activeMode: 'view',
              registry,
            }).lost,
          )
        : [];

  // 2. Initialise the form state from the existing view (or defaults). Старая
  //    плоская `definition v1` компилируется в дерево здесь же (на входе).
  const isEdit = opts.view !== null;
  // Заголовок явно называет вид владельца (спека e0257ca5, решение
  // пользователя 2026-10-23): «Создать/Отбор типа «X»» и
  // «Создать/Отбор мысли «Y»».
  const ownerName = owner.kind === 'type' ? owner.typeName : owner.thoughtName;
  const title = owner.kind === 'type'
    ? (isEdit
        ? t('filterEditor.dialogTitleEdit', ownerName)
        : t('filterEditor.dialogTitleCreate', ownerName))
    : (isEdit
        ? t('filterEditor.dialogTitleEditThought', ownerName)
        : t('filterEditor.dialogTitleCreateThought', ownerName));
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

  // Предупреждение об общности отбора — по владельцу (спека e0257ca5):
  // типовой действует на все мысли типа, внетиповой виден всем, но действует
  // только у этой мысли.
  const warning = el(
    'p',
    FIELD_HINT_CLASS,
    owner.kind === 'type'
      ? t('filterEditor.typeViewWarning')
      : t('filterEditor.thoughtViewWarning'),
  );

  // Description — optional, ≤1000.
  const descInput = fieldTextarea() as HTMLTextAreaElement;
  descInput.rows = 3;
  descInput.maxLength = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;
  descInput.value = initialDescription;
  descInput.placeholder = t('filterEditor.descriptionPlaceholder');
  const descField = fieldRow({ label: t('filterEditor.descriptionLabel'), control: descInput });

  // «Open by default» checkbox.
  const defaultRow = checkboxRow({
    label: t('filterEditor.openByDefault'),
    checked: initialIsDefault,
  });
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
   * ПРИ ПЕРЕРАЗБОРЕ на повторе чтения реестра база пересчитывается вместе с
   * заменой состояния: иначе восстановленные условия выглядели бы правкой
   * пользователя и диалог без правок спрашивал бы подтверждение закрытия
   * (ошибка 071acfc2, п. б).
   *
   * Объявлен ДО сборки редактора: фабрика синхронно строит футер, его
   * `refresh` читает `host.baseline()` — обратись к `criteriaBase` из стрелки
   * `baseline` ниже по коду, получили бы TDZ-ошибку «Cannot access
   * 'criteriaBase' before initialization» при открытии диалога отбора
   * (ошибка 609deba0 п. C1).
   */
  let criteriaBase = buildViewAst(state);
  const editor = buildFilterEditor({
    profile: 'thoughts',
    networkId,
    // Функция, а не снимок: календарь точной даты читает настройку в момент
    // открытия (ошибка b5278f9a).
    firstDayOfWeek: () => store.state.network?.first_day_of_week,
    data,
    // ЕДИНСТВЕННОЕ фокусное место (требование 3697eb65): отбор типа мысли
    // исполняется сервером ОТНОСИТЕЛЬНО мысли-контекста, поэтому подсказки
    // токенов `$thought*` здесь уместны. Прочие точки профиля `thoughts`
    // (панель «Структур», строка поиска) и другие экраны признак не ставят.
    withFocusThought: true,
    getState: () => state,
    touch: () => editorRef?.refresh(),
    // Набор текста в поле значения (ошибка 7d36f439): диалог не пересобирается —
    // поле ввода сохраняет фокус и каретку (фразу футера обновляет фабрика).
    touchValue: () => undefined,
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
      // Диагностика потерь при чтении определения — рядом с записями ядра:
      // потеря из-за отказа реестра видна строкой, а не молчит (db42100b).
      issues: () => mergeFilterIssues(lossIssues, serverIssues),
    },
  });
  editorRef = editor;

  body.append(warning, descField, defaultField, editor.root);
  // Имя отбора — ПЕРВЫМ полем диалога (ошибка 50d9bf4e п. A1). Строку имени
  // строит футер редактора (одна реализация), но здесь она переносится в начало
  // разметки диалога: у модального места имя — главный идентификатор отбора, и
  // оно не должно прятаться под деревом условий.
  if (editor.nameRow !== null) body.prepend(editor.nameRow);

  // 4. Show the dialog. The Save button keeps itself open on validation
  //    failure; we close only when the IPC call resolves.
  let saveBtn: HTMLButtonElement | null = null;
  let closeDialog: (() => void) | null = null;
  /** Диалог показан: повтору чтения реестра есть куда применить результат. */
  let dialogOpen = false;
  /** Отписка от тиков store — повтор чтения реестра свойств (ошибка db42100b). */
  let unsubscribeRegistry: (() => void) | null = null;
  /** Сторож гонки: тики store чаще, чем чтение реестра. */
  let registryRetryInFlight = false;
  /** Контекст сохранения — общий для кнопки «Применить» и подтверждения
   *  «Сохранить» при закрытии «грязного» редактора (требование b58f6aad). */
  const saveCtx = (close: () => void): SaveCtx => ({
    close,
    saveBtn,
    opts,
    owner,
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
    lossRiskReason: () => lossRiskReason,
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
    // Диалог закрыт любой кнопкой/Esc/крестиком — редактор размонтируем:
    // его дерево снимает клавиатурные контексты из реестра `lib/keymap`.
    onClose: () => {
      dialogOpen = false;
      unsubscribeRegistry?.();
      unsubscribeRegistry = null;
      editor.destroy();
    },
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
  dialogOpen = true;

  // Отказ чтения реестра — «неотработанный вход»: следующий тик store (в т.ч.
  // восстановление связи) повторяет чтение, а определение ПЕРЕРАЗБИРАЕТСЯ —
  // условия по свойствам возвращаются в дерево до сохранения (db42100b,
  // механика 77f18626). Правку пользователя переразбор не перетирает.
  if (!registryOk) {
    const retryRegistry = (): void => {
      if (registryOk || registryRetryInFlight || !dialogOpen) return;
      registryRetryInFlight = true;
      void reloadPropertyCatalogue(networkId, { fresh: true })
        .then((ok) => {
          // Отказ — ожидание остаётся до следующего тика store.
          if (!ok || !dialogOpen) return;
          registryOk = true;
          const nextLosses =
            savedDefinition === undefined
              ? []
              : readFilterDefinitionDetailed(savedDefinition, {
                  activeMode: 'view',
                  registry,
                }).lost;
          // Отказ реестра больше не причина потери: остаются только настоящие
          // потери (свойства действительно нет) — их показывает общий каркас.
          lossIssues = lostConditionIssues(nextLosses);
          if (!formDirty(criteriaBase, buildViewAst(state))) {
            Object.assign(state, parseViewDefinition(opts.view, registry));
            // База пересчитывается ВМЕСТЕ с состоянием: восстановленные условия —
            // не правка пользователя, иначе диалог сразу «грязный»
            // (ошибка 071acfc2, п. б).
            criteriaBase = buildViewAst(state);
            // Реестр прочитан и состояние переразобрано — потерь нет.
            lossRiskReason = null;
          } else {
            // Пользователь правил отбор без реестра: переразбор перетёр бы его
            // правку. Если реестр вернул условия, которых в состоянии нет, —
            // сохранять нельзя: перезапись потеряет их молча. Причина — именно
            // потеря условий, а не «реестр не прочитан»: он уже прочитан
            // (ошибка 071acfc2, п. а).
            lossRiskReason =
              nextLosses.length < lossesWithoutRegistry.length ? 'conditionsLost' : null;
          }
          editor.refresh();
        })
        .catch(() => {
          // Отказ — ожидание остаётся до следующего тика store.
        })
        .finally(() => {
          registryRetryInFlight = false;
        });
    };
    unsubscribeRegistry = store.subscribe(retryRegistry);
  }
}

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------

interface SaveCtx {
  close: () => void;
  saveBtn: HTMLButtonElement | null;
  opts: OpenViewEditorOptions;
  /** Владелец отбора (разрешён при открытии диалога). */
  owner: ViewOwner;
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
  /**
   * Причина возможной потери условий по свойствам: реестр не прочитан либо
   * правка шла без реестра и условия не восстановлены (`null` — потерь нет).
   */
  lossRiskReason: () => LossRisk;
}

async function onSave(ctx: SaveCtx): Promise<void> {
  // Только Основа (спека e0257ca5): все правки отборов — в Основе. Гейт стоит
  // ДО записи; диалог, открытый в Основе, после переключения слоя сохранить не
  // может — иначе правка молча уехала бы в рабочий слой.
  if (!isInBaseLayer()) {
    notice(t('filterEditor.baseLayerGuard'), 'info');
    return;
  }
  const trimmedName = ctx.getName().trim();
  if (trimmedName === '') {
    showNameError(ctx, t('filterEditor.nameRequired'));
    return;
  }
  if (trimmedName.length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    showNameError(
      ctx,
      t('filterEditor.nameTooLong', [THOUGHT_TYPE_VIEW_NAME_MAX, trimmedName.length]),
    );
    return;
  }
  const trimmedDesc = ctx.getDescription().trim();
  if (trimmedDesc.length > THOUGHT_TYPE_VIEW_DESCRIPTION_MAX) {
    showFieldError(
      ctx,
      t('filterEditor.descriptionTooLong', [
        THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
        trimmedDesc.length,
      ]),
    );
    return;
  }
  // Запись перезаписала бы условия по свойствам молча — ждём либо повтора
  // чтения реестра, либо переоткрытия отбора: причина называется ПО ФАКТУ
  // (реестр не прочитан / условия не восстановлены после его чтения), чтобы
  // не отправлять пользователя ждать уже прочитанный реестр (ошибка 071acfc2).
  // Стоит ДО запрета пустого отбора: без реестра дерево выглядит пустым именно
  // из-за потери, и сообщение обязано называть причину.
  const lossRiskReason = ctx.lossRiskReason();
  if (lossRiskReason !== null) {
    showFieldError(
      ctx,
      t(
        lossRiskReason === 'registryPending'
          ? 'filterEditor.registryPendingSave'
          : 'filterEditor.conditionsLostSave',
      ),
    );
    return;
  }
  // Запрет пустого отбора (ошибка e8365d29): без условий отбор бессмыслен.
  if (!hasAnyCriteria(ctx.state)) {
    showFieldError(ctx, t('filterEditor.noCriteria'));
    return;
  }
  // Красная диагностика (конструктор + записи ядра) запрещает сохранение
  // (требование 44d61c8a): отбор с ошибкой на хранение не пишется.
  const issues = mergeFilterIssues(constructorFilterIssues(ctx.state.tree ?? null));
  if (hasBlockingIssues(issues)) {
    showFieldError(ctx, t('filterEditor.blockingIssues'));
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

  const { networkId, view } = ctx.opts;
  const input: ThoughtTypeViewInput = {
    name: trimmedName,
    description: trimmedDesc === '' ? null : trimmedDesc,
    definition: definitionJson,
    is_default: ctx.getIsDefault(),
  };
  try {
    let saved: ThoughtTypeView | ThoughtCustomView;
    if (ctx.owner.kind === 'type') {
      if (view === null) {
        saved = await etn.thoughtTypeViews.create(networkId, ctx.owner.typeId, input);
      } else {
        const patch: ThoughtTypeViewUpdateInput = input;
        saved = await etn.thoughtTypeViews.update(
          networkId,
          ctx.owner.typeId,
          view.id,
          patch,
          ctx.version,
        );
      }
    } else {
      const customInput: ThoughtCustomViewInput = input;
      if (view === null) {
        saved = await etn.thoughtCustomViews.create(
          networkId,
          ctx.owner.thoughtId,
          customInput,
        );
      } else {
        const patch: ThoughtCustomViewUpdateInput = customInput;
        saved = await etn.thoughtCustomViews.update(
          networkId,
          ctx.owner.thoughtId,
          view.id,
          patch,
          ctx.version,
        );
      }
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

